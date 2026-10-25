import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { getSchema } from '../lib/priority-schema.js';
import { textResult, unavailableHere } from '../lib/write-guard.js';

const OBLIGO = getSchema('OBLIGO');

export function registerDebtTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_get_open_debts',
    `Get open accounts-receivable (A/R) balances by customer — "who owes us money".

Returns each customer with a positive open balance (OBLIGO.CREDIT), highest first.
Filterable by minimum amount and sales rep. For unreconciled invoice signals (not verified remaining balances) for a
customer's balance, use priority_get_unpaid_invoices_for_customer.`,
    {
      minAmount: z.number().optional().describe('Minimum open balance'),
      salesRep: z.string().optional().describe('Filter by exact sales rep name (AGENTNAME)'),
      agingBucket: z
        .enum(['0-30', '31-60', '61-90', '90+'])
        .optional()
        .describe('Filter by aging bucket (not available on this install)'),
      top: z.number().int().min(1).max(500).default(100),
      skip: z.number().int().min(0).default(0),
    },
    async (params) => {
      try {
        // Use OBLIGO, NOT OPENINVOICES. On this install OPENINVOICES holds open DELIVERY NOTES /
        // RETURNS awaiting invoicing (DOCCODE "משלק"/"החלק"), so it hides the real debt of
        // customers whose open A/R is issued-but-unreconciled invoices. OBLIGO.CREDIT is the
        // customer's open A/R balance (same source priority_get_top_debtors trusts).
        const qb = new ODataBuilder()
          .gt('CREDIT', 0)
          .orderBy('CREDIT', 'desc')
          .orderBy('CUSTNAME', 'asc')
          .top(params.top)
          .skip(params.skip);
        if (params.minAmount !== undefined) qb.ge('CREDIT', params.minAmount);
        if (params.salesRep) qb.eq('AGENTNAME', params.salesRep);
        if (OBLIGO?.defaultSelect) qb.select(...OBLIGO.defaultSelect);
        const result = await client.list<Record<string, unknown>>('OBLIGO', qb.build());
        const debts = result.value.map((o) => ({
          customerId: o.CUSTNAME,
          name: o.CUSTDES,
          openBalance: Number(o.CREDIT) || 0,
          creditLimit: Number(o.MAX_CREDIT) || 0,
          availableCredit: Number(o.CREDIT_REST) || 0,
          salesRep: o.AGENTNAME,
        }));
        const unsupported: string[] = [];
        if (params.agingBucket)
          unsupported.push(
            'agingBucket (OBLIGO carries no aging-bucket column; use priority_get_customer_aging for a single customer)',
          );
        return textResult({
          debts,
          ...(unsupported.length ? { ignoredFilters: unsupported } : {}),
          pagination: { returned: debts.length, top: params.top, skip: params.skip },
          note: 'Open A/R by customer from OBLIGO.CREDIT (positive balances only). Source corrected: OPENINVOICES, used previously, lists un-invoiced delivery notes rather than issued A/R.',
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_aging_report',
    `Get company-wide aging summary with customer-level breakdown.

Returns aggregated AR aging buckets (0-30, 31-60, 61-90, 90+ days) across all customers.
Use this for a high-level view of collection exposure. For a single customer, use priority_get_customer_aging.`,
    {
      top: z.number().int().min(1).max(500).default(200),
      skip: z.number().int().min(0).default(0),
    },
    async (_params) => {
      // AGED_BALANCES is not exposed as an OData entity on this install.
      return unavailableHere(
        'The AGED_BALANCES form is not exposed to the API on this installation.',
        'Use priority_get_open_debts (OBLIGO.CREDIT customer balances) for customer A/R balances, or expose an aged-debts ' +
          'form (e.g. AGEDEBTS_WORKAREA / ACCOUNTS_RECEIVABLE) to the API for true aging buckets.',
      );
    },
  );

  server.tool(
    'priority_get_overdue_invoices',
    `Get invoices that are past their due date, sorted by days overdue (most overdue first).

Use for collection prioritization. Returns invoice number, customer, amount, due date, and days overdue.`,
    {
      minDaysOverdue: z.number().int().min(0).default(1).describe('Minimum days past due'),
      minAmount: z.number().optional().describe('Minimum invoice amount'),
      top: z.number().int().min(1).max(500).default(100),
      skip: z.number().int().min(0).default(0),
    },
    async (_params) => {
      // OBLIGO provides customer balances, not due-dated open items; OPENDEBT is not exposed.
      return unavailableHere(
        'Overdue-by-due-date needs a due-date (PAYDATE) column. OPENDEBT is not exposed here and ' +
          'OBLIGO supplies customer balances, without verified due-dated open items. OPENINVOICES holds uninvoiced delivery documents.',
        'Use priority_get_open_debts (OBLIGO.CREDIT, sorted by amount) for customer A/R balances, or expose a ' +
          'form carrying PAYDATE (e.g. OPENDEBT) to the API to rank by days overdue.',
      );
    },
  );

  server.tool(
    'priority_get_payment_history',
    `Get historical payment behavior for a customer: average days to pay, payment patterns.

Useful for credit decisions and collection strategy. Looks at paid invoices for the customer.`,
    {
      customerId: z.string().min(1).describe('The CUSTNAME'),
      top: z.number().int().min(1).max(500).default(100),
    },
    async (_params) => {
      // PAYMENTHIST is not exposed as an OData entity on this install.
      return unavailableHere(
        'The PAYMENTHIST form is not exposed to the API on this installation.',
        'Receipt/payment forms such as TINVOICES (קבלות) or the PAYMENT* forms may be exposed — ' +
          'discover with priority_list_forms and query the right one via priority_query.',
      );
    },
  );

  server.tool(
    'priority_get_top_debtors',
    `Get the top N customers by open debt amount.

Quick view for management — who owes the most. Sorted by total open balance descending.`,
    {
      top: z.number().int().min(1).max(100).default(10).describe('Number of top debtors to return'),
    },
    async (params) => {
      try {
        // CUSTOMERS has no balance field; OBLIGO carries the open A/R balance (CREDIT).
        const qb = new ODataBuilder()
          .gt('CREDIT', 0)
          .orderBy('CREDIT', 'desc')
          .orderBy('CUSTNAME', 'asc')
          .top(params.top);
        if (OBLIGO?.defaultSelect) qb.select(...OBLIGO.defaultSelect);
        const result = await client.list<Record<string, unknown>>('OBLIGO', qb.build());
        const topDebtors = result.value.map((o) => ({
          customerId: o.CUSTNAME,
          name: o.CUSTDES,
          balance: Number(o.CREDIT) || 0,
          creditLimit: Number(o.MAX_CREDIT) || 0,
          availableCredit: Number(o.CREDIT_REST) || 0,
          salesRep: o.AGENTNAME,
        }));
        return textResult({ topDebtors });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  // --- Write Tools ---

  server.tool(
    'priority_record_payment_promise',
    `Record that a customer promised to pay by a specific date.

⚠️ WRITE OPERATION — logs a collection activity. Use dryRun=true (default) to preview.`,
    {
      customerId: z.string().min(1).describe('CUSTNAME'),
      promisedDate: z.string().min(1).describe('Date the customer promised to pay (ISO 8601)'),
      amount: z.number().positive().optional().describe('Promised payment amount'),
      notes: z.string().optional().describe('Additional notes'),
      dryRun: z.boolean().default(true),
    },
    async () =>
      // This logged the promise as a PHONEBOOK row, but PHONEBOOK is the contacts master on this
      // install (not an activity log) and lacks TYPEDES/SUBJECT/EXPIRYDATE — the write would
      // create/garble a contact. Disabled until the real CRM activity form is identified.
      unavailableHere(
        'Recording a payment promise needs a CRM activity form; PHONEBOOK here is the contacts ' +
          'master (no activity fields), so this write is disabled to avoid corrupting contact data.',
        'Identify the activity form via priority_list_forms (e.g. GENDIARY / TODOLIST / DOCUMENTS_*) ' +
          'and log it with priority_create_record.',
      ),
  );

  server.tool(
    'priority_mark_invoice_disputed',
    `Flag an invoice as disputed with a reason.

⚠️ WRITE OPERATION. NOTE: disabled on this installation — see the response for why.`,
    {
      invoiceNumber: z.string().min(1).describe('IVNUM'),
      reason: z.string().min(1).describe('Dispute reason'),
      dryRun: z.boolean().default(true),
    },
    // Disabled: PATCHed AINVOICES(invoiceNumber) — a single-value key on a COMPOSITE-keyed form
    // (404s) — and set STATDES to 'disputed', which is not a real Priority invoice status on this
    // install (statuses are טיוטא/סופית/מבוטלת). There is no native "disputed" state to set.
    async () =>
      unavailableHere(
        "Flagging an invoice 'disputed' isn't supported here: AINVOICES is composite-keyed (a " +
          "single-key PATCH 404s) and 'disputed' is not a Priority invoice status.",
        'Track disputes with a CRM activity/note form (discover via priority_list_forms) linked to the ' +
          'customer or invoice, rather than mutating the invoice status.',
      ),
  );
}
