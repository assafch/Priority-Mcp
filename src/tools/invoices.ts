import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { ODataBuilder } from '../client/odata-builder.js';
import { toMcpError } from '../client/errors.js';
import { sanitizeODataValue } from '../lib/sanitize.js';
import { checkWriteAllowed, dryRunResult, textResult } from '../lib/write-guard.js';

export function registerInvoiceTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_invoices',
    `List invoices with optional filters by date range, customer, and status.

Returns paginated invoice list. Use priority_get_invoice for full details with line items.
Status values: open, paid, partial — vary by Priority configuration.`,
    {
      customerId: z.string().optional().describe('Filter by CUSTNAME'),
      dateFrom: z.string().optional().describe('Start date (ISO 8601, e.g. "2025-01-01")'),
      dateTo: z.string().optional().describe('End date (ISO 8601)'),
      status: z.string().optional().describe('Invoice status filter'),
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).default(0),
      orderBy: z.enum(['IVNUM', 'CURDATE', 'TOTPRICE']).default('CURDATE'),
      orderDir: z.enum(['asc', 'desc']).default('desc'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().top(params.top).skip(params.skip).orderBy(params.orderBy, params.orderDir);
        if (params.customerId) qb.eq('CUSTNAME', sanitizeODataValue(params.customerId));
        if (params.dateFrom) qb.ge('CURDATE', params.dateFrom);
        if (params.dateTo) qb.le('CURDATE', params.dateTo);
        if (params.status) qb.eq('STATDES', sanitizeODataValue(params.status));
        const result = await client.list('AINVOICES', qb.build());
        return textResult({ invoices: result.value, pagination: { returned: result.value.length, top: params.top, skip: params.skip } });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_invoice',
    `Get a single invoice with full details including line items.

Use IVNUM (invoice number) as the key. Expands line items (AINVOICITEMS_SUBFORM) by default.
If you don't know the IVNUM, use priority_list_invoices to find it first.`,
    {
      invoiceNumber: z.string().min(1).describe('The IVNUM (invoice number)'),
      expand: z.array(z.string()).optional().describe('Additional sub-forms to expand'),
    },
    async (params) => {
      try {
        const expands = ['AINVOICITEMS_SUBFORM', ...(params.expand ?? [])];
        const qb = new ODataBuilder().expand(...expands);
        const invoice = await client.get('AINVOICES', params.invoiceNumber, qb.build());
        return textResult(invoice);
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_unpaid_invoices_for_customer',
    `Get all unpaid/open invoices for a specific customer.

Shortcut for collection workflows — returns only invoices with outstanding balance for the given customer.`,
    {
      customerId: z.string().min(1).describe('The CUSTNAME'),
      top: z.number().int().min(1).max(500).default(100),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .eq('CUSTNAME', params.customerId)
          .gt('DEBIT', 0)
          .top(params.top)
          .orderBy('PAYDATE', 'asc');
        const result = await client.list('OPENDEBT', qb.build());
        return textResult({ customerId: params.customerId, unpaidInvoices: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
    },
  );

  // --- Write Tools ---

  server.tool(
    'priority_create_invoice',
    `Create a new invoice in Priority ERP.

⚠️ WRITE OPERATION — creates a financial document.
Can create from scratch with line items, or reference an existing order.
Use dryRun=true (default) to preview. Disabled when PRIORITY_READ_ONLY=true.`,
    {
      customerId: z.string().min(1).describe('CUSTNAME — the customer to invoice'),
      items: z.array(z.object({
        productId: z.string().min(1).describe('PARTNAME'),
        quantity: z.number().positive().describe('Quantity'),
        price: z.number().optional().describe('Unit price override (uses price list if omitted)'),
      })).min(1).describe('Invoice line items'),
      reference: z.string().optional().describe('Reference number or order number'),
      remarks: z.string().optional().describe('Invoice remarks/notes'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body: Record<string, unknown> = {
          CUSTNAME: params.customerId,
          AINVOICITEMS_SUBFORM: params.items.map((item) => ({
            PARTNAME: item.productId,
            TQUANT: item.quantity,
            ...(item.price !== undefined ? { IPRICEDATE: item.price } : {}),
          })),
        };
        if (params.reference) body.ORDNAME = params.reference;
        if (params.remarks) body.DETAILS = params.remarks;

        if (params.dryRun) return dryRunResult('CREATE INVOICE', body);

        const result = await client.create('AINVOICES', body);
        return textResult({ created: true, invoice: result });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_void_invoice',
    `Void/cancel an invoice in Priority ERP.

⚠️ WRITE OPERATION — voids a financial document. This is typically irreversible.
Use dryRun=true (default) to preview. Disabled when PRIORITY_READ_ONLY=true.`,
    {
      invoiceNumber: z.string().min(1).describe('IVNUM to void'),
      reason: z.string().min(1).describe('Reason for voiding'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body = { STATDES: 'cancelled', DETAILS: params.reason };
        if (params.dryRun) return dryRunResult('VOID INVOICE ' + params.invoiceNumber, body);

        const result = await client.update('AINVOICES', params.invoiceNumber, body);
        return textResult({ voided: true, invoiceNumber: params.invoiceNumber, result });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_create_credit_memo',
    `Issue a credit memo against an existing invoice.

⚠️ WRITE OPERATION — creates a financial credit document.
Use dryRun=true (default) to preview. Disabled when PRIORITY_READ_ONLY=true.`,
    {
      customerId: z.string().min(1).describe('CUSTNAME'),
      originalInvoice: z.string().optional().describe('Original IVNUM being credited'),
      items: z.array(z.object({
        productId: z.string().min(1),
        quantity: z.number().positive(),
        price: z.number().optional(),
      })).min(1),
      remarks: z.string().optional(),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body: Record<string, unknown> = {
          CUSTNAME: params.customerId,
          CINVOICITEMS_SUBFORM: params.items.map((item) => ({
            PARTNAME: item.productId,
            TQUANT: item.quantity,
            ...(item.price !== undefined ? { IPRICEDATE: item.price } : {}),
          })),
        };
        if (params.originalInvoice) body.IVNUM = params.originalInvoice;
        if (params.remarks) body.DETAILS = params.remarks;

        if (params.dryRun) return dryRunResult('CREATE CREDIT MEMO', body);

        const result = await client.create('CINVOICES', body);
        return textResult({ created: true, creditMemo: result });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
