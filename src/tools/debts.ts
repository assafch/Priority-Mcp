import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { ODataBuilder } from '../client/odata-builder.js';
import { toMcpError } from '../client/errors.js';
import { sanitizeODataValue } from '../lib/sanitize.js';
import { checkWriteAllowed, dryRunResult, textResult } from '../lib/write-guard.js';

export function registerDebtTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_get_open_debts',
    `Get all open accounts receivable (AR) debts.

Filterable by aging bucket, minimum amount, and salesperson.
Returns invoices that have an outstanding balance. Sorted by amount descending by default.
Use this for collection workflows and AR management.`,
    {
      minAmount: z.number().optional().describe('Minimum outstanding amount'),
      salesRep: z.string().optional().describe('Filter by sales rep name'),
      agingBucket: z.enum(['0-30', '31-60', '61-90', '90+']).optional().describe('Filter by aging bucket'),
      top: z.number().int().min(1).max(500).default(100),
      skip: z.number().int().min(0).default(0),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().top(params.top).skip(params.skip).orderBy('DEBIT', 'desc');
        if (params.minAmount !== undefined) qb.ge('DEBIT', params.minAmount);
        if (params.salesRep) qb.contains('SNAME', sanitizeODataValue(params.salesRep));
        const result = await client.list('OPENDEBT', qb.build());
        return textResult({ debts: result.value, pagination: { returned: result.value.length, top: params.top, skip: params.skip } });
      } catch (err) { throw toMcpError(err); }
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
    async (params) => {
      try {
        const result = await client.list('AGED_BALANCES', new ODataBuilder().top(params.top).skip(params.skip).build());
        return textResult({ agingReport: result.value, pagination: { returned: result.value.length, top: params.top, skip: params.skip } });
      } catch (err) { throw toMcpError(err); }
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
    async (params) => {
      try {
        const today = new Date().toISOString().split('T')[0];
        const qb = new ODataBuilder()
          .filter(`PAYDATE lt '${today}'`)
          .top(params.top).skip(params.skip)
          .orderBy('PAYDATE', 'asc');
        if (params.minAmount !== undefined) qb.ge('DEBIT', params.minAmount);
        const result = await client.list('OPENDEBT', qb.build());
        return textResult({ overdueInvoices: result.value, pagination: { returned: result.value.length, top: params.top, skip: params.skip } });
      } catch (err) { throw toMcpError(err); }
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
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .eq('CUSTNAME', params.customerId)
          .top(params.top)
          .orderBy('PAYDATE', 'desc');
        const result = await client.list('PAYMENTHIST', qb.build());
        return textResult({ customerId: params.customerId, payments: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
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
        const qb = new ODataBuilder()
          .gt('CUSTBALANCE', 0)
          .select('CUSTNAME', 'CUSTDES', 'CUSTBALANCE', 'CREDITLIMIT', 'SNAME')
          .orderBy('CUSTBALANCE', 'desc')
          .top(params.top);
        const result = await client.list('CUSTOMERS', qb.build());
        return textResult({ topDebtors: result.value });
      } catch (err) { throw toMcpError(err); }
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
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body: Record<string, unknown> = {
          CUSTNAME: params.customerId,
          TYPEDES: 'Payment Promise',
          SUBJECT: `Payment promise: ${params.promisedDate}${params.amount ? ` for ${params.amount}` : ''}`,
          EXPIRYDATE: params.promisedDate,
          CURDATE: new Date().toISOString().split('T')[0],
        };
        if (params.notes) body.DETAILS = params.notes;

        if (params.dryRun) return dryRunResult('RECORD PAYMENT PROMISE', body);

        const result = await client.create('PHONEBOOK', body);
        return textResult({ recorded: true, activity: result });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_mark_invoice_disputed',
    `Flag an invoice as disputed with a reason.

⚠️ WRITE OPERATION — marks invoice with dispute status. Use dryRun=true (default) to preview.`,
    {
      invoiceNumber: z.string().min(1).describe('IVNUM'),
      reason: z.string().min(1).describe('Dispute reason'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body = { STATDES: 'disputed', DETAILS: params.reason };
        if (params.dryRun) return dryRunResult('MARK DISPUTED ' + params.invoiceNumber, body);

        const result = await client.update('AINVOICES', params.invoiceNumber, body);
        return textResult({ disputed: true, invoiceNumber: params.invoiceNumber, result });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
