import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { ODataBuilder } from '../client/odata-builder.js';
import { toMcpError } from '../client/errors.js';
import type { PriorityCustomer } from '../lib/types.js';
import { sanitizeODataValue } from '../lib/sanitize.js';
import { checkWriteAllowed, dryRunResult, textResult } from '../lib/write-guard.js';

function paginationMeta(count: number, top: number, skip: number) {
  return { returned: count, skip, top, hasMore: count === top, nextSkip: count === top ? skip + top : null };
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
      status: z.string().optional().describe('Filter by status description (e.g. "active", "frozen")'),
      salesRep: z.string().optional().describe('Filter by sales rep name (SNAME field)'),
      minBalance: z.number().optional().describe('Only customers with balance >= this amount'),
      search: z.string().optional().describe('Search in customer name (CUSTDES)'),
      top: z.number().int().min(1).max(500).default(50).describe('Number of records to return (max 500)'),
      skip: z.number().int().min(0).default(0).describe('Number of records to skip (for pagination)'),
      orderBy: z.enum(['CUSTNAME', 'CUSTDES', 'CUSTBALANCE']).default('CUSTNAME').describe('Field to sort by'),
      orderDir: z.enum(['asc', 'desc']).default('asc').describe('Sort direction'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().top(params.top).skip(params.skip).orderBy(params.orderBy, params.orderDir);
        if (params.status) qb.eq('STATDES', sanitizeODataValue(params.status));
        if (params.salesRep) qb.contains('SNAME', sanitizeODataValue(params.salesRep));
        if (params.minBalance !== undefined) qb.ge('CUSTBALANCE', params.minBalance);
        if (params.search) qb.contains('CUSTDES', sanitizeODataValue(params.search));

        const result = await client.list<PriorityCustomer>('CUSTOMERS', qb.build());
        const customers = result.value.map((c) => ({
          id: c.CUSTNAME, name: c.CUSTDES, status: c.STATDES, balance: c.CUSTBALANCE,
          creditLimit: c.CREDITLIMIT, salesRep: c.SNAME, phone: c.PHONE, email: c.EMAIL,
        }));
        return textResult({ customers, pagination: paginationMeta(customers.length, params.top, params.skip) });
      } catch (err) { throw toMcpError(err); }
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
      expand: z.array(z.string()).optional().describe('Sub-forms to expand (e.g. ["CUSTPERSONNEL_SUBFORM"])'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder();
        if (params.expand?.length) qb.expand(...params.expand);
        const customer = await client.get<PriorityCustomer>('CUSTOMERS', params.customerId, qb.build() || undefined);
        return textResult(customer);
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_search_customers',
    `Fuzzy search for customers by name, tax ID, phone, or email.

Use this when you don't know the exact CUSTNAME. Searches across multiple fields.
Returns up to 20 matches by default. Use priority_get_customer for full details once you find the right one.`,
    {
      query: z.string().min(1).describe('Search term — matches against name, tax ID, phone, email'),
      top: z.number().int().min(1).max(100).default(20).describe('Max results'),
    },
    async (params) => {
      try {
        const q = sanitizeODataValue(params.query);
        const qb = new ODataBuilder()
          .filter(`contains(CUSTDES,'${q}') or contains(CUSTNAME,'${q}') or contains(PHONE,'${q}') or contains(EMAIL,'${q}') or contains(WTAXNUM,'${q}')`)
          .select('CUSTNAME', 'CUSTDES', 'PHONE', 'EMAIL', 'STATDES')
          .top(params.top);
        const result = await client.list<PriorityCustomer>('CUSTOMERS', qb.build());
        return textResult({ results: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
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
        const c = await client.get<PriorityCustomer>('CUSTOMERS', params.customerId,
          new ODataBuilder().select('CUSTNAME', 'CUSTDES', 'CUSTBALANCE', 'CREDITLIMIT').build());
        return textResult({
          customerId: c.CUSTNAME, name: c.CUSTDES, balance: c.CUSTBALANCE ?? 0,
          creditLimit: c.CREDITLIMIT ?? 0, availableCredit: (c.CREDITLIMIT ?? 0) - (c.CUSTBALANCE ?? 0),
        });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_customer_contacts',
    `List contacts (personnel) for a customer — names, phone numbers, emails, roles.`,
    { customerId: z.string().min(1).describe('The CUSTNAME') },
    async (params) => {
      try {
        const c = await client.get<Record<string, unknown>>('CUSTOMERS', params.customerId,
          new ODataBuilder().expand('CUSTPERSONNEL_SUBFORM').select('CUSTNAME', 'CUSTDES').build());
        return textResult({ customerId: params.customerId, contacts: c['CUSTPERSONNEL_SUBFORM'] ?? [] });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_customer_price_list',
    `Get the price list and any discount rules assigned to a customer.`,
    { customerId: z.string().min(1).describe('The CUSTNAME') },
    async (params) => {
      try {
        const c = await client.get<Record<string, unknown>>('CUSTOMERS', params.customerId,
          new ODataBuilder().select('CUSTNAME', 'CUSTDES', 'PLNAME', 'PLDES', 'DISCOUNT').build());
        return textResult(c);
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_customer_documents',
    `List all documents (invoices, orders, quotes) for a customer.

Useful for getting a complete picture of a customer's transaction history.
Internally queries multiple entities filtered by CUSTNAME.`,
    {
      customerId: z.string().min(1).describe('The CUSTNAME'),
      docType: z.enum(['orders', 'invoices', 'all']).default('all').describe('Which document types to fetch'),
      top: z.number().int().min(1).max(200).default(50),
    },
    async (params) => {
      try {
        const docs: Record<string, unknown[]> = {};
        const qb = () => new ODataBuilder().eq('CUSTNAME', params.customerId).top(params.top).orderBy('CURDATE', 'desc');

        if (params.docType === 'orders' || params.docType === 'all') {
          const orders = await client.list('ORDERS', qb().build());
          docs.orders = orders.value;
        }
        if (params.docType === 'invoices' || params.docType === 'all') {
          const invoices = await client.list('AINVOICES', qb().build());
          docs.invoices = invoices.value;
        }
        return textResult({ customerId: params.customerId, documents: docs });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_customer_aging',
    `Get aging buckets (0-30, 31-60, 61-90, 90+ days) for a single customer.

Shows how much debt falls in each aging bucket. Useful for collection prioritization.
Note: This calculates from open invoice data — for the company-wide aging report, use priority_get_aging_report.`,
    { customerId: z.string().min(1).describe('The CUSTNAME') },
    async (params) => {
      try {
        const result = await client.list('CUST_AGED_BALANCES', new ODataBuilder().eq('CUSTNAME', params.customerId).build());
        return textResult({ customerId: params.customerId, aging: result.value });
      } catch (err) { throw toMcpError(err); }
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
      customerId: z.string().min(1).describe('Unique customer ID (CUSTNAME) — cannot be changed later'),
      name: z.string().min(1).describe('Customer display name (CUSTDES)'),
      phone: z.string().optional().describe('Phone number'),
      email: z.string().email().optional().describe('Email address'),
      taxId: z.string().optional().describe('Tax ID (WTAXNUM)'),
      creditLimit: z.number().optional().describe('Credit limit'),
      salesRep: z.string().optional().describe('Sales rep name (SNAME)'),
      dryRun: z.boolean().default(true).describe('Preview only — set false to actually create'),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body: Record<string, unknown> = { CUSTNAME: params.customerId, CUSTDES: params.name };
        if (params.phone) body.PHONE = params.phone;
        if (params.email) body.EMAIL = params.email;
        if (params.taxId) body.WTAXNUM = params.taxId;
        if (params.creditLimit !== undefined) body.CREDITLIMIT = params.creditLimit;
        if (params.salesRep) body.SNAME = params.salesRep;

        if (params.dryRun) return dryRunResult('CREATE CUSTOMER', body);

        const result = await client.create('CUSTOMERS', body);
        return textResult({ created: true, customer: result });
      } catch (err) { throw toMcpError(err); }
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
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body: Record<string, unknown> = {};
        if (params.name) body.CUSTDES = params.name;
        if (params.phone) body.PHONE = params.phone;
        if (params.email) body.EMAIL = params.email;
        if (params.creditLimit !== undefined) body.CREDITLIMIT = params.creditLimit;
        if (params.salesRep) body.SNAME = params.salesRep;

        if (Object.keys(body).length === 0) {
          return textResult({ error: 'No fields to update. Provide at least one field to change.' });
        }

        if (params.dryRun) return dryRunResult('UPDATE CUSTOMER ' + params.customerId, body);

        const result = await client.update('CUSTOMERS', params.customerId, body);
        return textResult({ updated: true, customerId: params.customerId, customer: result });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
