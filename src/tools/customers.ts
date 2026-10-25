import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { getSchema } from '../lib/priority-schema.js';
import { escapeODataString, sanitizeODataValue } from '../lib/sanitize.js';
import { searchForm } from '../lib/search.js';
import type { PriorityCustomer } from '../lib/types.js';
import { previewOrBlock, textResult, unavailableHere } from '../lib/write-guard.js';
import { verifyRecordCreate, verifyRecordUpdate } from '../lib/write-verification.js';
import { currentOperation } from '../runtime/operation-context.js';

const CUSTOMERS = getSchema('CUSTOMERS');
const CUST_SEARCH_FIELDS = CUSTOMERS?.searchFields ?? ['CUSTDES', 'CUSTNAME'];
const CUST_SELECT = CUSTOMERS?.defaultSelect ?? ['CUSTNAME', 'CUSTDES'];

function paginationMeta(count: number, top: number, skip: number) {
  return {
    returned: count,
    skip,
    top,
    hasMore: count === top,
    nextSkip: count === top ? skip + top : null,
  };
}

/** Map a raw CUSTOMERS row to the compact shape the list/search tools return. */
function mapCustomer(c: PriorityCustomer) {
  return {
    id: c.CUSTNAME,
    name: c.CUSTDES,
    status: c.STATDES,
    balance: c.CUSTBALANCE,
    creditLimit: c.CREDITLIMIT,
    // Sales rep is AGENTNAME on this install (legacy SNAME kept as a fallback).
    salesRep: (c.AGENTNAME as string | undefined) ?? c.SNAME,
    phone: c.PHONE,
    email: c.EMAIL,
  };
}

export function registerCustomerTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_customers',
    `List customers from Priority ERP with optional filters.

Use this to get a list of customers, optionally filtered by status, sales rep, or minimum balance.
Returns paginated results — use top/skip for pagination.
Default: first 50 customers sorted by customer name.

Example queries an AI might need:
- "Show me all active customers" → status: "active"
- "Customers with balance over 10000" → minBalance: 10000
- "First 10 customers for sales rep Dan" → salesRep: "Dan", top: 10`,
    {
      cursor: z
        .string()
        .optional()
        .describe('Server-owned search continuation; repeat the same search arguments.'),
      status: z
        .string()
        .optional()
        .describe('Filter by status description (e.g. "active", "frozen")'),
      salesRep: z.string().optional().describe('Filter by sales rep name (AGENTNAME field)'),
      minBalance: z
        .number()
        .optional()
        .describe(
          'NOTE: balance is not on CUSTOMERS here — this is ignored. Use priority_get_top_debtors (OBLIGO).',
        ),
      search: z.string().optional().describe('Search in customer name (CUSTDES)'),
      top: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(50)
        .describe('Number of records to return (max 500)'),
      skip: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe('Number of records to skip (for pagination)'),
      orderBy: z.enum(['CUSTNAME', 'CUSTDES']).default('CUSTNAME').describe('Field to sort by'),
      orderDir: z.enum(['asc', 'desc']).default('asc').describe('Sort direction'),
    },
    async (params, extra) => {
      try {
        const baseFilters: string[] = [];
        if (params.status) baseFilters.push(`STATDES eq '${escapeODataString(params.status)}'`);

        // Name search / sales-rep matching go through the capability-aware helper, which
        // falls back to server-side matching when this install rejects contains().
        if (params.search || params.salesRep) {
          const usingSearch = Boolean(params.search);
          // When BOTH a name search and a salesRep are given, the name is the fuzzy query and
          // the rep becomes an exact server-side filter — otherwise it was silently dropped.
          if (usingSearch && params.salesRep) {
            baseFilters.push(`AGENTNAME eq '${escapeODataString(params.salesRep)}'`);
          }
          const { value, meta } = await searchForm<PriorityCustomer>(client, {
            signal: extra?.signal ?? currentOperation()?.signal,
            deadlineAt: currentOperation()?.deadlineAt,
            cursor: params.cursor,
            form: 'CUSTOMERS',
            query: (params.search ?? params.salesRep) as string,
            fields: usingSearch ? CUST_SEARCH_FIELDS : ['AGENTNAME'],
            select: CUST_SELECT,
            top: params.top,
            baseFilter: baseFilters.length ? baseFilters.join(' and ') : undefined,
          });
          const customers = value.map(mapCustomer);
          // searchForm does not apply $skip, so don't advertise a skip-based cursor here
          // (a nextSkip would just re-run the same search). Mirror products/suppliers.
          return textResult({
            customers,
            pagination: { returned: customers.length, top: params.top, skip: 0 },
            search: meta,
          });
        }

        const qb = new ODataBuilder()
          .top(params.top)
          .skip(params.skip)
          .orderBy(params.orderBy, params.orderDir)
          .select(...CUST_SELECT);
        if (params.status) qb.eq('STATDES', sanitizeODataValue(params.status));
        // minBalance intentionally NOT applied: CUSTOMERS has no balance column on this install
        // (balance lives in OBLIGO). Applying it would 400; surface a note instead.

        const result = await client.list<PriorityCustomer>('CUSTOMERS', qb.build());
        const customers = result.value.map(mapCustomer);
        return textResult({
          customers,
          ...(params.minBalance !== undefined
            ? {
                ignoredFilters: [
                  'minBalance (no balance field on CUSTOMERS — see priority_get_top_debtors)',
                ],
              }
            : {}),
          pagination: paginationMeta(customers.length, params.top, params.skip),
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_customer',
    `Get a single customer's full record from Priority ERP by customer ID (CUSTNAME).

Use this when you know the exact customer ID. If you don't know it, use priority_search_customers or priority_list_customers first.
The CUSTNAME is Priority's unique identifier for the customer (e.g. "C1001", "ACME").
Returns all fields including contacts, balance, credit limit, and metadata.`,
    {
      customerId: z.string().min(1).describe('The CUSTNAME (customer ID) in Priority'),
      expand: z
        .array(z.string())
        .optional()
        .describe('Sub-forms to expand (e.g. ["CUSTPERSONNEL_SUBFORM"])'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder();
        if (params.expand?.length) qb.expand(...params.expand);
        const customer = await client.get<PriorityCustomer>(
          'CUSTOMERS',
          params.customerId,
          qb.build() || undefined,
        );
        return textResult(customer);
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_search_customers',
    `Fuzzy search for customers by name, tax ID, phone, or email.

Use this when you don't know the exact CUSTNAME. Searches across multiple fields.
Returns up to 20 matches by default. Use priority_get_customer for full details once you find the right one.`,
    {
      cursor: z
        .string()
        .optional()
        .describe('Server-owned search continuation; repeat the same search arguments.'),
      query: z.string().min(1).describe('Search term — matches against name, tax ID, phone, email'),
      top: z.number().int().min(1).max(100).default(20).describe('Max results'),
    },
    async (params, extra) => {
      try {
        const { value, meta } = await searchForm<PriorityCustomer>(client, {
          signal: extra?.signal ?? currentOperation()?.signal,
          deadlineAt: currentOperation()?.deadlineAt,
          cursor: params.cursor,
          form: 'CUSTOMERS',
          query: params.query,
          fields: CUST_SEARCH_FIELDS,
          select: ['CUSTNAME', 'CUSTDES', 'PHONE', 'EMAIL', 'STATDES'],
          top: params.top,
        });
        return textResult({ results: value, count: value.length, search: meta });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_customer_balance',
    `Get a customer's financial summary: open balance, credit limit, and available credit.

Quick way to check a customer's credit standing before placing an order or extending terms.`,
    {
      customerId: z.string().min(1).describe('The CUSTNAME'),
    },
    async (params) => {
      try {
        // CUSTOMERS has no balance/credit-limit fields on this install — the balance snapshot
        // lives in the OBLIGO form (CREDIT = open A/R balance, MAX_CREDIT = limit,
        // CREDIT_REST = available credit).
        const result = await client.list<Record<string, unknown>>(
          'OBLIGO',
          new ODataBuilder()
            .eq('CUSTNAME', sanitizeODataValue(params.customerId))
            .select('CUSTNAME', 'CUSTDES', 'CREDIT', 'MAX_CREDIT', 'CREDIT_REST', 'CODE')
            .top(1)
            .build(),
        );
        const o = result.value[0];
        if (!o) {
          return textResult({
            customerId: params.customerId,
            note: 'No OBLIGO balance row found.',
          });
        }
        return textResult({
          customerId: o.CUSTNAME,
          name: o.CUSTDES,
          balance: Number(o.CREDIT) || 0,
          creditLimit: Number(o.MAX_CREDIT) || 0,
          availableCredit: Number(o.CREDIT_REST) || 0,
          currency: o.CODE,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_customer_contacts',
    'List contacts (personnel) for a customer — names, phone numbers, emails, roles.',
    { customerId: z.string().min(1).describe('The CUSTNAME') },
    async (params) => {
      try {
        const c = await client.get<Record<string, unknown>>(
          'CUSTOMERS',
          params.customerId,
          new ODataBuilder().expand('CUSTPERSONNEL_SUBFORM').select('CUSTNAME', 'CUSTDES').build(),
        );
        return textResult({
          customerId: params.customerId,
          contacts: c.CUSTPERSONNEL_SUBFORM ?? [],
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_customer_price_list',
    'Get the price list and any discount rules assigned to a customer.',
    { customerId: z.string().min(1).describe('The CUSTNAME') },
    async (params) => {
      try {
        const c = await client.get<Record<string, unknown>>(
          'CUSTOMERS',
          params.customerId,
          new ODataBuilder().select('CUSTNAME', 'CUSTDES', 'PLNAME', 'PLDES', 'DISCOUNT').build(),
        );
        return textResult(c);
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_customer_documents',
    `List all documents (invoices, orders, quotes) for a customer.

Useful for getting a complete picture of a customer's transaction history.
Internally queries multiple entities filtered by CUSTNAME.`,
    {
      customerId: z.string().min(1).describe('The CUSTNAME'),
      docType: z
        .enum(['orders', 'invoices', 'all'])
        .default('all')
        .describe('Which document types to fetch'),
      top: z.number().int().min(1).max(200).default(50),
    },
    async (params) => {
      try {
        const docs: Record<string, unknown[]> = {};
        // Sort/project per form — ORDERS dates live in CURDATE, AINVOICES in IVDATE.
        const buildFor = (form: string) => {
          const s = getSchema(form);
          const qb = new ODataBuilder().eq('CUSTNAME', params.customerId).top(params.top);
          if (s?.dateField) qb.orderBy(s.dateField, 'desc');
          if (s?.defaultSelect) qb.select(...s.defaultSelect);
          return qb.build();
        };

        if (params.docType === 'orders' || params.docType === 'all') {
          const orders = await client.list('ORDERS', buildFor('ORDERS'));
          docs.orders = orders.value;
        }
        if (params.docType === 'invoices' || params.docType === 'all') {
          const invoices = await client.list('AINVOICES', buildFor('AINVOICES'));
          docs.invoices = invoices.value;
        }
        return textResult({ customerId: params.customerId, documents: docs });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_customer_aging',
    `Get aging buckets (0-30, 31-60, 61-90, 90+ days) for a single customer.

Shows how much debt falls in each aging bucket. Useful for collection prioritization.
Note: This calculates from open invoice data — for the company-wide aging report, use priority_get_aging_report.`,
    { customerId: z.string().min(1).describe('The CUSTNAME') },
    async (_params) => {
      // CUST_AGED_BALANCES is not exposed as an OData entity on this install.
      return unavailableHere(
        'The CUST_AGED_BALANCES form is not exposed to the API on this installation.',
        'Use priority_get_customer_balance (OBLIGO) for the open balance, or priority_get_open_debts / ' +
          'priority_get_unpaid_invoices_for_customer (OPENINVOICES) for the open invoices. For true aging ' +
          'buckets, expose an aged-debts form (e.g. AGEDEBTS_WORKAREA) to the API in Priority.',
      );
    },
  );

  // --- Write Tools ---

  server.tool(
    'priority_create_customer',
    `Create a new customer in Priority ERP.

⚠️ WRITE OPERATION — creates a new customer record.
Use dryRun=true to preview what would be sent without making changes.
Required: customerId (CUSTNAME) and name (CUSTDES). All other fields are optional.
Disabled when PRIORITY_READ_ONLY=true.`,
    {
      customerId: z
        .string()
        .min(1)
        .describe('Unique customer ID (CUSTNAME) — cannot be changed later'),
      name: z.string().min(1).describe('Customer display name (CUSTDES)'),
      phone: z.string().optional().describe('Phone number'),
      email: z.string().email().optional().describe('Email address'),
      taxId: z.string().optional().describe('Tax ID (WTAXNUM)'),
      creditLimit: z.number().optional().describe('Credit limit'),
      salesRep: z.string().optional().describe('Sales rep name (AGENTNAME)'),
      dryRun: z.boolean().default(true).describe('Preview only — set false to actually create'),
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = { CUSTNAME: params.customerId, CUSTDES: params.name };
        if (params.phone) body.PHONE = params.phone;
        if (params.email) body.EMAIL = params.email;
        if (params.taxId) body.WTAXNUM = params.taxId;
        if (params.creditLimit !== undefined) body.CREDITLIMIT = params.creditLimit;
        // Sales rep is AGENTNAME on this install (SNAME does not exist here → the old write 400'd).
        if (params.salesRep) body.AGENTNAME = params.salesRep;

        const gate = previewOrBlock(config, params.dryRun, 'CREATE CUSTOMER', body);
        if (gate) return gate;

        const outcome = await verifyRecordCreate(client, 'CUSTOMERS', body);
        return textResult({ created: outcome.verified, customer: outcome.result, ...outcome });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_update_customer',
    `Update an existing customer's fields in Priority ERP.

⚠️ WRITE OPERATION — modifies customer data.
Use dryRun=true to preview. Only include fields you want to change.
Disabled when PRIORITY_READ_ONLY=true.`,
    {
      customerId: z.string().min(1).describe('The CUSTNAME of the customer to update'),
      name: z.string().optional().describe('New display name (CUSTDES)'),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      creditLimit: z.number().optional(),
      salesRep: z.string().optional(),
      dryRun: z.boolean().default(true).describe('Preview only — set false to actually update'),
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = {};
        if (params.name) body.CUSTDES = params.name;
        if (params.phone) body.PHONE = params.phone;
        if (params.email) body.EMAIL = params.email;
        if (params.creditLimit !== undefined) body.CREDITLIMIT = params.creditLimit;
        // Sales rep is AGENTNAME on this install (SNAME does not exist here → the old write 400'd).
        if (params.salesRep) body.AGENTNAME = params.salesRep;

        if (Object.keys(body).length === 0) {
          return textResult({
            error: 'No fields to update. Provide at least one field to change.',
          });
        }

        const gate = previewOrBlock(
          config,
          params.dryRun,
          `UPDATE CUSTOMER ${params.customerId}`,
          body,
        );
        if (gate) return gate;

        const outcome = await verifyRecordUpdate(client, 'CUSTOMERS', params.customerId, body);
        return textResult({
          updated: outcome.verified,
          customerId: params.customerId,
          customer: outcome.result,
          ...outcome,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
