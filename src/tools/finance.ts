import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import { dateFrom, dateTo } from '../lib/dates.js';
import { fetchAllPages } from '../lib/paginate.js';
import {
  FINAL_INVOICE_STATUS,
  groupRevenueByMonth,
  rankCustomersByRevenue,
  sumInvoiceRevenue,
} from '../lib/revenue.js';
import { textResult, unavailableHere } from '../lib/write-guard.js';

// Upper bound on how many invoices the revenue/top-customer scans will page through before
// stopping. High enough to cover multi-year ranges; a hit is surfaced as an incomplete scan.
const MAX_INVOICE_SCAN = 20000;

export function registerFinanceTools(server: McpServer, client: PriorityClient) {
  server.tool(
    'priority_get_bank_balances',
    'Get current balances for all bank accounts.',
    {
      top: z.number().int().min(1).max(100).default(50),
    },
    async (params) => {
      try {
        const result = await client.list(
          'BANKACCOUNTS',
          new ODataBuilder().top(params.top).build(),
        );
        return textResult({ bankAccounts: result.value });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_cash_position',
    `Get current cash position across all bank accounts.

Aggregates all bank account balances for a quick cash snapshot.`,
    {},
    async () => {
      try {
        const result = await client.list<Record<string, unknown>>(
          'BANKACCOUNTS',
          new ODataBuilder().select('BANKACCNAME', 'BANKACCDES', 'BALANCE', 'CURRNCY').build(),
        );
        const total = result.value.reduce((sum, a) => sum + (Number(a.BALANCE) || 0), 0);
        return textResult({ accounts: result.value, totalCash: total });
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
        const scan = await fetchAllPages<Record<string, unknown>>(
          (skip, top) => {
            const qb = new ODataBuilder()
              .ge('IVDATE', dateFrom(params.dateFrom))
              .le('IVDATE', dateTo(params.dateTo))
              .eq('STATDES', FINAL_INVOICE_STATUS)
              .select('IVNUM', 'IVDATE', 'CUSTNAME', 'VAT', 'TOTPRICE')
              .orderBy('IVDATE', 'asc')
              .top(top)
              .skip(skip);
            return client
              .list<Record<string, unknown>>('AINVOICES', qb.build())
              .then((r) => r.value);
          },
          { maxRows: MAX_INVOICE_SCAN },
        );
        const totals = sumInvoiceRevenue(scan.rows);
        return textResult({
          dateRange: { from: params.dateFrom, to: params.dateTo },
          totalNetRevenue: totals.netRevenue,
          totalVat: totals.vat,
          totalWithVat: totals.grossWithVat,
          invoiceCount: totals.count,
          byMonth: groupRevenueByMonth(scan.rows),
          scan: { invoicesScanned: scan.rows.length, pages: scan.pages, complete: !scan.capped },
          ...(scan.capped
            ? {
                warning: `Only the first ${MAX_INVOICE_SCAN} final invoices in this range were summed — totals are INCOMPLETE. Narrow the date range.`,
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
        const scan = await fetchAllPages<Record<string, unknown>>(
          (skip, top) => {
            const qb = new ODataBuilder()
              .ge('IVDATE', dateFrom(params.dateFrom))
              .le('IVDATE', dateTo(params.dateTo))
              .eq('STATDES', FINAL_INVOICE_STATUS)
              .select('CUSTNAME', 'VAT', 'TOTPRICE', 'IVDATE')
              .orderBy('IVDATE', 'asc')
              .top(top)
              .skip(skip);
            return client
              .list<Record<string, unknown>>('AINVOICES', qb.build())
              .then((r) => r.value);
          },
          { maxRows: MAX_INVOICE_SCAN },
        );

        return textResult({
          topCustomers: rankCustomersByRevenue(scan.rows, params.top),
          period: { from: params.dateFrom, to: params.dateTo },
          scan: { invoicesScanned: scan.rows.length, pages: scan.pages, complete: !scan.capped },
          ...(scan.capped
            ? {
                warning: `Ranking is based on only the first ${MAX_INVOICE_SCAN} final invoices in range and may be INCOMPLETE. Narrow the date range.`,
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
        'Use priority_get_open_debts (OPENINVOICES) for open A/R, or expose AGEDEBTS_WORKAREA / ' +
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
      // not exposed here, and the exposed OPENINVOICES has no PAYDATE — so an inflow/outflow
      // projection keyed on due date can't be built.
      return unavailableHere(
        'Cashflow projection needs due-dated open A/R and A/P items (OPENDEBT / SUP_OPENDEBT), which ' +
          'are not exposed to the API on this installation, and OPENINVOICES has no PAYDATE.',
        'Use priority_get_open_debts (OPENINVOICES) for the open-A/R total, and expose OPENDEBT / ' +
          'SUP_OPENDEBT (with PAYDATE) to the API to project cashflow by due date.',
      );
    },
  );
}
