import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { dateFrom, dateTo } from '../lib/dates.js';
import { getSchema } from '../lib/priority-schema.js';
import { sanitizeODataValue } from '../lib/sanitize.js';
import { searchForm } from '../lib/search.js';
import { previewOrBlock, textResult, unavailableHere } from '../lib/write-guard.js';

const AINVOICES = getSchema('AINVOICES');

export function registerInvoiceTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_invoices',
    `List invoices with optional filters by date range, customer, and status.

Returns a paginated, compact invoice list (key fields only — use priority_get_invoice for full
detail with line items). Dates filter on IVDATE (the invoice date) and sort by it by default.
Pass either customerId (the exact CUSTNAME) or customerName (a name to resolve automatically).`,
    {
      customerId: z.string().optional().describe('Filter by exact CUSTNAME'),
      customerName: z
        .string()
        .optional()
        .describe(
          'Customer name to resolve to a CUSTNAME automatically (use instead of customerId)',
        ),
      dateFrom: z.string().optional().describe('Start date (ISO 8601, e.g. "2025-01-01")'),
      dateTo: z.string().optional().describe('End date (ISO 8601)'),
      status: z.string().optional().describe('Invoice status filter (STATDES)'),
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).default(0),
      orderBy: z.enum(['IVNUM', 'IVDATE', 'TOTPRICE']).default('IVDATE'),
      orderDir: z.enum(['asc', 'desc']).default('desc'),
    },
    async (params) => {
      try {
        let customerId = params.customerId;
        let resolvedCustomer: Record<string, unknown> | undefined;

        // Resolve a customer NAME to its CUSTNAME so callers don't need a separate lookup call.
        if (!customerId && params.customerName) {
          const { value } = await searchForm<{ CUSTNAME: string; CUSTDES: string }>(client, {
            form: 'CUSTOMERS',
            query: params.customerName,
            fields: ['CUSTDES', 'CUSTNAME'],
            select: ['CUSTNAME', 'CUSTDES'],
            top: 5,
          });
          if (value.length === 0) {
            return textResult({
              invoices: [],
              note: `No customer matched "${params.customerName}". Try priority_search_customers.`,
            });
          }
          const wanted = params.customerName.trim();
          const chosen = value.find((c) => String(c.CUSTDES).trim() === wanted) ?? value[0];
          customerId = String(chosen.CUSTNAME);
          resolvedCustomer = {
            CUSTNAME: chosen.CUSTNAME,
            CUSTDES: chosen.CUSTDES,
            ...(value.length > 1
              ? { otherMatches: value.filter((c) => c.CUSTNAME !== chosen.CUSTNAME) }
              : {}),
          };
        }

        const qb = new ODataBuilder()
          .top(params.top)
          .skip(params.skip)
          .orderBy(params.orderBy, params.orderDir);
        if (customerId) qb.eq('CUSTNAME', sanitizeODataValue(customerId));
        if (params.dateFrom) qb.ge('IVDATE', dateFrom(params.dateFrom));
        if (params.dateTo) qb.le('IVDATE', dateTo(params.dateTo));
        if (params.status) qb.eq('STATDES', sanitizeODataValue(params.status));
        if (AINVOICES?.defaultSelect) qb.select(...AINVOICES.defaultSelect);
        const result = await client.list('AINVOICES', qb.build());
        return textResult({
          invoices: result.value,
          ...(resolvedCustomer ? { resolvedCustomer } : {}),
          pagination: { returned: result.value.length, top: params.top, skip: params.skip },
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_invoice',
    `Get a single invoice with full details including line items.

Use IVNUM (invoice number). Expands line items (AINVOICEITEMS_SUBFORM) by default.
If you don't know the IVNUM, use priority_list_invoices to find it first.`,
    {
      invoiceNumber: z.string().min(1).describe('The IVNUM (invoice number)'),
      expand: z.array(z.string()).optional().describe('Additional sub-forms to expand'),
    },
    async (params) => {
      try {
        const expands = ['AINVOICEITEMS_SUBFORM', ...(params.expand ?? [])];
        // AINVOICES has a COMPOSITE key (IVNUM,DEBIT,IVTYPE) on this install, so a single-value
        // key predicate — AINVOICES('IV123') — returns 404. Query by $filter on IVNUM instead.
        const qb = new ODataBuilder()
          .eq('IVNUM', sanitizeODataValue(params.invoiceNumber))
          .expand(...expands)
          .top(5);
        const result = await client.list<Record<string, unknown>>('AINVOICES', qb.build());
        const rows = result.value ?? [];
        if (rows.length === 0) {
          return textResult({
            invoice: null,
            note: `No invoice found with IVNUM "${params.invoiceNumber}".`,
          });
        }
        // A single IVNUM normally maps to one document; surface all rows if more than one.
        return textResult(rows.length === 1 ? rows[0] : { matches: rows, count: rows.length });
      } catch (err) {
        throw toMcpError(err);
      }
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
        // NOTE: do NOT use OPENINVOICES here. On this install that form holds open
        // DELIVERY NOTES / RETURNS (DOCCODE "משלק"/"החלק") awaiting invoicing — NOT issued
        // tax invoices. Customers whose open A/R is made up of issued-but-unreconciled
        // invoices (the common case) show ZERO rows there, which silently hid real debt.
        //
        // The reliable open-invoice signal is AINVOICES.IVRECONDATE being empty: once a
        // receipt is reconciled against an invoice it gets a recon date; canceled invoices
        // also receive one (storno), so an empty IVRECONDATE means "still open". That column
        // is selectable but NOT filterable — Priority 500s ("Object reference not set") on
        // `IVRECONDATE eq null` — so we page the customer's invoices and filter client-side.
        const select = [...(AINVOICES?.defaultSelect ?? []), 'IVRECONDATE'];
        const PAGE = 200;
        const MAX_SCAN = 5000; // safety cap so a huge history can't run away
        const open: Record<string, unknown>[] = [];
        let skip = 0;
        let capped = false;
        // Page OLDEST-first: collection workflows want the most-overdue invoices, so the first
        // `top` open invoices we collect must be the oldest ones — NOT the newest (the old code
        // paged desc and kept the newest `top`, silently dropping the oldest, most-overdue debt).
        for (;;) {
          const qb = new ODataBuilder()
            .eq('CUSTNAME', sanitizeODataValue(params.customerId))
            .select(...select)
            .orderBy('IVDATE', 'asc')
            .top(PAGE)
            .skip(skip);
          const { value } = await client.list<Record<string, unknown>>('AINVOICES', qb.build());
          for (const row of value) {
            // Empty recon date = unreconciled = open. Skip un-posted drafts, which carry a
            // temporary document number (Priority prefixes those with "T") and aren't real debt.
            if (row.IVRECONDATE == null && !String(row.IVNUM ?? '').startsWith('T')) {
              open.push(row);
            }
          }
          if (open.length >= params.top) break; // oldest `top` collected
          if (value.length < PAGE) break; // exhausted the customer's invoices
          skip += PAGE;
          if (skip >= MAX_SCAN) {
            capped = true;
            break;
          }
        }
        // Already ascending, but sort defensively so the output is strictly oldest-first.
        open.sort((a, b) => String(a.IVDATE ?? '').localeCompare(String(b.IVDATE ?? '')));
        const result = open.slice(0, params.top);
        return textResult({
          customerId: params.customerId,
          unpaidInvoices: result,
          count: result.length,
          ...(capped
            ? {
                note: `Scanned the ${MAX_SCAN} oldest invoices and found at least ${params.top} open; newer open invoices beyond that were not listed.`,
              }
            : {}),
        });
      } catch (err) {
        throw toMcpError(err);
      }
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
      items: z
        .array(
          z.object({
            productId: z.string().min(1).describe('PARTNAME'),
            quantity: z.number().positive().describe('Quantity'),
            price: z
              .number()
              .optional()
              .describe('Unit price override (uses price list if omitted)'),
          }),
        )
        .min(1)
        .describe('Invoice line items'),
      reference: z.string().optional().describe('Reference number or order number'),
      remarks: z.string().optional().describe('Invoice remarks/notes'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = {
          CUSTNAME: params.customerId,
          AINVOICEITEMS_SUBFORM: params.items.map((item) => ({
            PARTNAME: item.productId,
            TQUANT: item.quantity,
            // Unit-price override goes in PRICE (the line's unit price). IPRICEDATE was a
            // phantom field — it is not on AINVOICEITEMS_SUBFORM (verified live: the line
            // price fields are PRICE / DISPRICE / QPRICE), so it was silently dropped.
            ...(item.price !== undefined ? { PRICE: item.price } : {}),
          })),
        };
        if (params.reference) body.ORDNAME = params.reference;
        if (params.remarks) body.DETAILS = params.remarks;

        const gate = previewOrBlock(config, params.dryRun, 'CREATE INVOICE', body);
        if (gate) return gate;

        const result = await client.create('AINVOICES', body);
        return textResult({ created: true, invoice: result });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_void_invoice',
    `Void/cancel an invoice in Priority ERP.

⚠️ WRITE OPERATION. NOTE: disabled on this installation — see the response for why.`,
    {
      invoiceNumber: z.string().min(1).describe('IVNUM to void'),
      reason: z.string().min(1).describe('Reason for voiding'),
      dryRun: z.boolean().default(true),
    },
    // Disabled: the old code PATCHed AINVOICES(invoiceNumber) — a single-value key on a
    // COMPOSITE-keyed form (IVNUM,DEBIT,IVTYPE), which 404s every time — and set STATDES to the
    // English 'cancelled', which never matches the Hebrew status list. Voiding a posted tax
    // invoice is a storno (reversing-document) operation with tax/accounting implications, not a
    // status PATCH, so this is disabled rather than shipped broken.
    async () =>
      unavailableHere(
        'Voiding a tax invoice via the API is not supported here: AINVOICES is composite-keyed (a ' +
          'single-key PATCH 404s) and cancelling a posted invoice is a storno operation, not a status ' +
          'change. Disabled to avoid corrupting financial/tax records.',
        'Cancel the invoice in the Priority invoices screen (which creates the proper storno), or issue ' +
          'an offsetting credit with priority_create_credit_memo.',
      ),
  );

  server.tool(
    'priority_create_credit_memo',
    `Issue a credit memo (credit invoice / חשבונית מס זיכוי) for a customer.

On this installation a credit is a regular tax invoice (form AINVOICES, sub-form
AINVOICEITEMS_SUBFORM) with NEGATIVE quantities — verified against live data (credit
documents appear in AINVOICES with negative amounts). Pass POSITIVE quantities here (the
amount to credit); the tool emits them as negative. NOTE: 'CINVOICES' on this install is
"consolidated invoices", NOT credit memos — do not use it for credits.

⚠️ WRITE OPERATION — creates a financial credit document. dryRun=true (default) previews the
exact body without sending (works even in read-only mode). Real write blocked when
PRIORITY_READ_ONLY=true.`,
    {
      customerId: z.string().min(1).describe('CUSTNAME'),
      originalInvoice: z.string().optional().describe('Original IVNUM being credited (sets IVNUM)'),
      items: z
        .array(
          z.object({
            productId: z.string().min(1).describe('PARTNAME'),
            quantity: z.number().positive().describe('Quantity to credit (emitted as negative)'),
            price: z.number().optional(),
          }),
        )
        .min(1),
      remarks: z.string().optional(),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const body: Record<string, unknown> = {
        CUSTNAME: params.customerId,
        AINVOICEITEMS_SUBFORM: params.items.map((item) => ({
          PARTNAME: item.productId,
          TQUANT: -Math.abs(item.quantity), // credit => negative quantity
          // Unit price goes in PRICE, not the phantom IPRICEDATE (see create_invoice). Getting
          // this wrong on a credit memo means crediting the customer the wrong amount.
          ...(item.price !== undefined ? { PRICE: item.price } : {}),
        })),
      };
      if (params.originalInvoice) body.IVNUM = params.originalInvoice;
      if (params.remarks) body.DETAILS = params.remarks;

      const gate = previewOrBlock(
        config,
        params.dryRun,
        'CREATE CREDIT MEMO (AINVOICES, negative qty)',
        body,
      );
      if (gate) return gate;
      try {
        const result = await client.create('AINVOICES', body);
        return textResult({ created: true, creditMemo: result });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
