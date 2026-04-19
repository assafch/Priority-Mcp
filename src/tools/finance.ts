import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import { ODataBuilder } from '../client/odata-builder.js';
import { toMcpError } from '../client/errors.js';

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerFinanceTools(server: McpServer, client: PriorityClient) {
  server.tool(
    'priority_get_bank_balances',
    `Get current balances for all bank accounts.`,
    {
      top: z.number().int().min(1).max(100).default(50),
    },
    async (params) => {
      try {
        const result = await client.list('BANKACCOUNTS', new ODataBuilder().top(params.top).build());
        return textResult({ bankAccounts: result.value });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_cash_position',
    `Get current cash position across all bank accounts.

Aggregates all bank account balances for a quick cash snapshot.`,
    {},
    async () => {
      try {
        const result = await client.list<Record<string, unknown>>('BANKACCOUNTS',
          new ODataBuilder().select('BANKACCNAME', 'BANKACCDES', 'BALANCE', 'CURRNCY').build());
        const total = result.value.reduce((sum, a) => sum + (Number(a['BALANCE']) || 0), 0);
        return textResult({ accounts: result.value, totalCash: total });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_revenue_by_period',
    `Get revenue breakdown by period.

Queries invoices within a date range, grouped by the specified period.`,
    {
      dateFrom: z.string().describe('Start date (ISO 8601)'),
      dateTo: z.string().describe('End date (ISO 8601)'),
      top: z.number().int().min(1).max(1000).default(500),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .ge('CURDATE', params.dateFrom)
          .le('CURDATE', params.dateTo)
          .select('IVNUM', 'CURDATE', 'TOTPRICE', 'CUSTNAME')
          .orderBy('CURDATE', 'asc')
          .top(params.top);
        const result = await client.list<Record<string, unknown>>('AINVOICES', qb.build());
        const totalRevenue = result.value.reduce((sum, inv) => sum + (Number(inv['TOTPRICE']) || 0), 0);
        return textResult({ invoices: result.value, totalRevenue, count: result.value.length, dateRange: { from: params.dateFrom, to: params.dateTo } });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_top_customers',
    `Get top customers by revenue for a given period.

Returns customers ranked by total invoice value within the date range.`,
    {
      dateFrom: z.string().describe('Start date (ISO 8601)'),
      dateTo: z.string().describe('End date (ISO 8601)'),
      top: z.number().int().min(1).max(100).default(10),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .ge('CURDATE', params.dateFrom)
          .le('CURDATE', params.dateTo)
          .select('CUSTNAME', 'TOTPRICE', 'CURDATE')
          .top(1000);
        const result = await client.list<Record<string, unknown>>('AINVOICES', qb.build());

        // Aggregate by customer
        const byCustomer = new Map<string, number>();
        for (const inv of result.value) {
          const cust = String(inv['CUSTNAME'] ?? '');
          byCustomer.set(cust, (byCustomer.get(cust) ?? 0) + (Number(inv['TOTPRICE']) || 0));
        }
        const ranked = [...byCustomer.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, params.top)
          .map(([custName, totalRevenue]) => ({ custName, totalRevenue }));

        return textResult({ topCustomers: ranked, period: { from: params.dateFrom, to: params.dateTo } });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_top_products',
    `Get top-selling products by revenue for a given period.`,
    {
      dateFrom: z.string().describe('Start date (ISO 8601)'),
      dateTo: z.string().describe('End date (ISO 8601)'),
      top: z.number().int().min(1).max(100).default(10),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .ge('CURDATE', params.dateFrom)
          .le('CURDATE', params.dateTo)
          .select('PARTNAME', 'TQUANT', 'TOTPRICE', 'CURDATE')
          .top(1000);
        const result = await client.list<Record<string, unknown>>('ORDERITEMS', qb.build());

        const byProduct = new Map<string, { qty: number; revenue: number }>();
        for (const item of result.value) {
          const part = String(item['PARTNAME'] ?? '');
          const existing = byProduct.get(part) ?? { qty: 0, revenue: 0 };
          existing.qty += Number(item['TQUANT']) || 0;
          existing.revenue += Number(item['TOTPRICE']) || 0;
          byProduct.set(part, existing);
        }
        const ranked = [...byProduct.entries()]
          .sort((a, b) => b[1].revenue - a[1].revenue)
          .slice(0, params.top)
          .map(([partName, data]) => ({ partName, ...data }));

        return textResult({ topProducts: ranked, period: { from: params.dateFrom, to: params.dateTo } });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_ar_aging_summary',
    `Get accounts receivable aging summary across all customers.

Returns totals for aging buckets (current, 30, 60, 90, 90+ days).`,
    {},
    async () => {
      try {
        const result = await client.list('AGED_BALANCES', new ODataBuilder().top(500).build());
        return textResult({ arAging: result.value });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_ap_aging_summary',
    `Get accounts payable aging summary across all suppliers.`,
    {},
    async () => {
      try {
        const result = await client.list('SUP_AGED_BALANCES', new ODataBuilder().top(500).build());
        return textResult({ apAging: result.value });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_cashflow_projection',
    `Get cashflow projection based on upcoming AR (receivables) vs AP (payables).

Shows expected cash inflows and outflows to help with liquidity planning.`,
    {
      daysAhead: z.number().int().min(1).max(365).default(30).describe('How many days ahead to project'),
    },
    async (params) => {
      try {
        const futureDate = new Date(Date.now() + params.daysAhead * 86400000).toISOString().split('T')[0];
        const today = new Date().toISOString().split('T')[0];

        const [ar, ap] = await Promise.all([
          client.list<Record<string, unknown>>('OPENDEBT',
            new ODataBuilder().ge('PAYDATE', today).le('PAYDATE', futureDate).select('DEBIT', 'PAYDATE', 'CUSTNAME').top(500).build()),
          client.list<Record<string, unknown>>('SUP_OPENDEBT',
            new ODataBuilder().ge('PAYDATE', today).le('PAYDATE', futureDate).select('CREDIT', 'PAYDATE', 'SUPNAME').top(500).build()),
        ]);

        const totalAR = ar.value.reduce((s, r) => s + (Number(r['DEBIT']) || 0), 0);
        const totalAP = ap.value.reduce((s, r) => s + (Number(r['CREDIT']) || 0), 0);

        return textResult({
          period: { from: today, to: futureDate, daysAhead: params.daysAhead },
          expectedInflows: { total: totalAR, count: ar.value.length },
          expectedOutflows: { total: totalAP, count: ap.value.length },
          netCashflow: totalAR - totalAP,
        });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
