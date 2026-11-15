import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import { dateRangeFilter } from '../lib/dates.js';
import { fetchAllPages } from '../lib/paginate.js';
import {
  FINAL_INVOICE_STATUS,
  groupRevenueByMonth,
  rankCustomersByRevenue,
  sumInvoiceRevenue,
} from '../lib/revenue.js';
import { textResult, unavailableHere } from '../lib/write-guard.js';
import { scanObservation, scanOperationOptions } from '../services/reports/observations.js';

// Upper bound on how many invoices the revenue/top-customer scans will page through before
// stopping. High enough to cover multi-year ranges; a hit is surfaced as an incomplete scan.
const MAX_INVOICE_SCAN = 20000;

export function registerFinanceTools(server: McpServer, client: PriorityClient) {
  server.tool(
    'priority_get_bank_balances',
    `Get current balances for the bank / cash accounts.

Source: the GL form ACCOUNTS, restricted to accounts flagged for cash flow (CASHNAME ne '') —
that is Priority's own "bank account for cash flow" marker, so it yields the bank accounts, the
cash register and the cheque clearing accounts. There is NO bank-account master form on this kind
of installation (BANKACCOUNTS/CASHACC do not exist; BANKS/CASH/BANKPAGES exist but are usually not
API-enabled), so the GL is the authoritative readable source.

Balance fields, straight from Priority (no sign flipping — a GL credit balance is negative):
  BALANCE1 = balance in the local currency, BALANCE2 = in the foreign currency,
  BALANCE3 = in the account's own currency (CODE).`,
    {
      top: z.number().int().min(1).max(200).default(50),
      includeInactive: z
        .boolean()
        .default(false)
        .describe('include accounts marked INACTIVE / CLOSED'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .filter("CASHNAME ne ''")
          .select(
            'ACCNAME',
            'ACCDES',
            'CASHNAME',
            'CODE',
            'BALANCE1',
            'BALANCE2',
            'BALANCE3',
            'INACTIVE',
            'CLOSED',
          )
          .orderBy('ACCNAME', 'asc')
          .top(params.top);
        const result = await client.list<Record<string, unknown>>('ACCOUNTS', qb.build());
        const rows = params.includeInactive
          ? result.value
          : result.value.filter((a) => a.INACTIVE !== 'Y' && a.CLOSED !== 'Y');
        return textResult({
          source: { form: 'ACCOUNTS', filter: "CASHNAME ne ''" },
          bankAccounts: rows.map((a) => ({
            account: a.ACCNAME,
            description: a.ACCDES,
            cashFlowCode: a.CASHNAME,
            currency: a.CODE,
            balanceLocal: a.BALANCE1,
            balanceForeign: a.BALANCE2,
            balanceAccountCurrency: a.BALANCE3,
            inactive: a.INACTIVE === 'Y',
            closed: a.CLOSED === 'Y',
          })),
          count: rows.length,
          note: 'GL balances, sign as Priority stores it (credit balances are negative). Includes cash-register and cheque accounts, not just banks — they are what Priority flags for cash flow.',
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_cash_position',
    `Get the current cash position across the bank / cash accounts.

Same source as priority_get_bank_balances (GL ACCOUNTS where CASHNAME ne ''), totalled per
currency — accounts in different currencies are NOT summed into one number.`,
    {
      includeInactive: z.boolean().default(false),
    },
    async (params) => {
      try {
        const firstObservedAt = new Date().toISOString();
        const scan = await fetchAllPages<Record<string, unknown>>(
          (skip, top) =>
            client.list(
              'ACCOUNTS',
              new ODataBuilder()
                .filter("CASHNAME ne ''")
                .select('ACCNAME', 'ACCDES', 'CODE', 'BALANCE1', 'BALANCE3', 'INACTIVE', 'CLOSED')
                .orderBy('ACCNAME', 'asc')
                .top(top)
                .skip(skip)
                .build(),
            ),
          { ...scanOperationOptions(), maxRows: 10000, fetchNext: (link) => client.listNext(link) },
        );
        const rows = params.includeInactive
          ? scan.rows
          : scan.rows.filter((a) => a.INACTIVE !== 'Y' && a.CLOSED !== 'Y');
        const byCurrency: Record<string, number> = {};
        for (const a of rows) {
          const code = String(a.CODE ?? '?');
          byCurrency[code] = (byCurrency[code] ?? 0) + (Number(a.BALANCE3) || 0);
        }
        return textResult({
          source: { form: 'ACCOUNTS', filter: "CASHNAME ne ''" },
          accounts: rows.map((a) => ({
            account: a.ACCNAME,
            description: a.ACCDES,
            currency: a.CODE,
            balanceAccountCurrency: a.BALANCE3,
            balanceLocal: a.BALANCE1,
          })),
          meta: scanObservation(scan, firstObservedAt),
          scan: { ...scan, rows: undefined, accountsScanned: scan.rows.length },
          totalByCurrency: byCurrency,
          totalLocalCurrency: rows.reduce((s, a) => s + (Number(a.BALANCE1) || 0), 0),
          note: "Totals are GL balances with Priority's own sign convention (credit balances negative). totalLocalCurrency sums BALANCE1 across every account; totalByCurrency sums BALANCE3 within each currency.",
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_revenue_by_period',
    `Get revenue for a date range, broken down by calendar month.

Sums FINAL tax invoices only (drafts and cancelled invoices are excluded) and pages through
ALL matching invoices, so the totals cover the whole range — not just the first page.
totalNetRevenue is pre-VAT (the P&L figure); totalWithVat is the VAT-inclusive payable total.`,
    {
      dateFrom: z.string().describe('Start date (ISO 8601)'),
      dateTo: z.string().describe('End date (ISO 8601)'),
    },
    async (params) => {
      try {
        // AINVOICES dates live in IVDATE on this install (there is no CURDATE on the form).
        // Restrict to final invoices server-side so drafts ('טיוטא') and cancelled ('מבוטלת')
        // never count as revenue, and page through every match so the sum is complete.
        const rangeFilter = dateRangeFilter('IVDATE', params.dateFrom, params.dateTo);
        const firstObservedAt = new Date().toISOString();
        const scan = await fetchAllPages<Record<string, unknown>>(
          (skip, top) => {
            const qb = new ODataBuilder()
              .filter(rangeFilter)
              .eq('STATDES', FINAL_INVOICE_STATUS)
              .select('IVNUM', 'DEBIT', 'IVTYPE', 'IVDATE', 'CUSTNAME', 'VAT', 'TOTPRICE')
              .orderBy('IVDATE', 'asc')
              .orderBy('IVNUM', 'asc')
              .orderBy('DEBIT', 'asc')
              .orderBy('IVTYPE', 'asc')
              .top(top)
              .skip(skip);
            return client.list<Record<string, unknown>>('AINVOICES', qb.build());
          },
          {
            ...scanOperationOptions(),
            maxRows: MAX_INVOICE_SCAN,
            fetchNext: (link) => client.listNext(link),
          },
        );
        const totals = sumInvoiceRevenue(scan.rows);
        return textResult({
          dateRange: { from: params.dateFrom, to: params.dateTo },
          totalNetRevenue: totals.netRevenue,
          totalVat: totals.vat,
          totalWithVat: totals.grossWithVat,
          invoiceCount: totals.count,
          byMonth: groupRevenueByMonth(scan.rows),
          dateSemantics:
            'Date-only ranges use UTC day boundaries; monthly buckets preserve Priority IVDATE calendar dates. Explicit offsets retain their instant meaning.',
          meta: scanObservation(scan, firstObservedAt),
          scan: { ...scan, rows: undefined, invoicesScanned: scan.rows.length },
          ...(!scan.complete
            ? {
                warning: `Only ${scan.rows.length} scanned final invoices in this range were summed (${scan.stopReason}) — totals are INCOMPLETE. Narrow the date range.`,
              }
            : {}),
          note: 'Final tax invoices only (STATDES=סופית); drafts/cancelled excluded. totalNetRevenue = Σ(TOTPRICE − VAT); totalWithVat = Σ TOTPRICE.',
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_top_customers',
    `Get top customers by revenue for a given period.

Ranks customers by NET revenue (pre-VAT) over FINAL tax invoices only, pausing through ALL
matching invoices in the range — not just the first page — so the ranking is complete.`,
    {
      dateFrom: z.string().describe('Start date (ISO 8601)'),
      dateTo: z.string().describe('End date (ISO 8601)'),
      top: z.number().int().min(1).max(100).default(10),
    },
    async (params) => {
      try {
        // Page through every final invoice in the range, then aggregate by customer. The old
        // code took an unordered first-1000-row slice, so any busy year ranked on an arbitrary
        // subset. Final-only (STATDES) keeps drafts/cancelled out of the revenue.
        const rangeFilter = dateRangeFilter('IVDATE', params.dateFrom, params.dateTo);
        const firstObservedAt = new Date().toISOString();
        const scan = await fetchAllPages<Record<string, unknown>>(
          (skip, top) => {
            const qb = new ODataBuilder()
              .filter(rangeFilter)
              .eq('STATDES', FINAL_INVOICE_STATUS)
              .select('IVNUM', 'DEBIT', 'IVTYPE', 'CUSTNAME', 'VAT', 'TOTPRICE', 'IVDATE')
              .orderBy('IVDATE', 'asc')
              .orderBy('IVNUM', 'asc')
              .orderBy('DEBIT', 'asc')
              .orderBy('IVTYPE', 'asc')
              .top(top)
              .skip(skip);
            return client.list<Record<string, unknown>>('AINVOICES', qb.build());
          },
          {
            ...scanOperationOptions(),
            maxRows: MAX_INVOICE_SCAN,
            fetchNext: (link) => client.listNext(link),
          },
        );

        return textResult({
          topCustomers: rankCustomersByRevenue(scan.rows, params.top),
          period: { from: params.dateFrom, to: params.dateTo },
          meta: scanObservation(scan, firstObservedAt),
          scan: { ...scan, rows: undefined, invoicesScanned: scan.rows.length },
          ...(!scan.complete
            ? {
                warning: `Ranking is based on only ${scan.rows.length} scanned final invoices in range (${scan.stopReason}) and may be INCOMPLETE. Narrow the date range.`,
              }
            : {}),
          note: 'Ranked by netRevenue (Σ TOTPRICE − VAT) over final invoices only; grossWithVat is VAT-inclusive.',
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_top_products',
    'Get top-selling products by revenue for a given period.',
    {
      dateFrom: z.string().describe('Start date (ISO 8601)'),
      dateTo: z.string().describe('End date (ISO 8601)'),
      top: z.number().int().min(1).max(100).default(10),
    },
    // The flat sales-line form SALESINVOICEITEMS is API-blocked on this installation
    // ("לא ניתן להפעיל API למסך זה"), so a direct top-products query 400s every time. Return
    // guidance toward the tool that DOES work here rather than a raw error.
    async () =>
      unavailableHere(
        'Ranking all products by revenue needs the sales-line form SALESINVOICEITEMS, which is ' +
          'API-blocked on this installation ("לא ניתן להפעיל API למסך זה"). It cannot be computed directly.',
        'For per-product sales quantities/value over a period use priority_product_sales_by_period ' +
          '(it expands AINVOICEITEMS_SUBFORM and works here). To rank across ALL products, expose ' +
          'SALESINVOICEITEMS (or ORDERITEMS) to the OData API.',
      ),
  );

  server.tool(
    'priority_get_ar_aging_summary',
    `Get accounts receivable aging summary across all customers.

Returns totals for aging buckets (current, 30, 60, 90, 90+ days).`,
    {},
    async () => {
      // AGED_BALANCES is not exposed as an OData entity on this install.
      return unavailableHere(
        'The AGED_BALANCES form is not exposed to the API on this installation.',
        'Use priority_get_open_debts (OBLIGO.CREDIT customer balances) for open A/R, or expose AGEDEBTS_WORKAREA / ' +
          'ACCOUNTS_RECEIVABLE to the API for aged buckets.',
      );
    },
  );

  server.tool(
    'priority_get_ap_aging_summary',
    'Get accounts payable aging summary across all suppliers.',
    {},
    async () => {
      // SUP_AGED_BALANCES is not exposed as an OData entity on this install.
      return unavailableHere(
        'The SUP_AGED_BALANCES form is not exposed to the API on this installation.',
        'Expose a supplier aged-balances form (or ACCOUNTS_PAYABLE) to the API to get A/P aging buckets.',
      );
    },
  );

  server.tool(
    'priority_get_cashflow_projection',
    `Get cashflow projection based on upcoming AR (receivables) vs AP (payables).

Shows expected cash inflows and outflows to help with liquidity planning.`,
    {
      daysAhead: z
        .number()
        .int()
        .min(1)
        .max(365)
        .default(30)
        .describe('How many days ahead to project'),
    },
    async (_params) => {
      // Both due-dated open-item forms this needs (OPENDEBT for A/R, SUP_OPENDEBT for A/P) are
      // not exposed here. OBLIGO supplies customer balances rather than due-dated open items.
      return unavailableHere(
        'Cashflow projection needs due-dated open A/R and A/P items (OPENDEBT / SUP_OPENDEBT), which ' +
          'are not exposed to the API on this installation; OBLIGO supplies customer balances without due-dated open items. OPENINVOICES holds uninvoiced delivery documents.',
        'Use priority_get_open_debts (OBLIGO.CREDIT customer balances) for the open-A/R total, and expose OPENDEBT / ' +
          'SUP_OPENDEBT (with PAYDATE) to the API to project cashflow by due date.',
      );
    },
  );
}
