import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const capabilityCheck =
  'Use fresh capability evidence for the specific tools needed. When evidence is missing or expired, call priority_get_capabilities with names and view=summary for those tools; refresh only when runtime support is needed. If policy blocks that tool, use tools/list descriptions and report capability evidence as unknown. Use only enabled, implemented tools; a guide does not execute its procedure. If a required source is unavailable, name the missing evidence instead of inventing totals. Do not send messages or write ERP records as part of this report.';
const message = (text: string) => ({
  messages: [
    {
      role: 'user' as const,
      content: { type: 'text' as const, text: `${capabilityCheck}\n\n${text}` },
    },
  ],
});

export function registerAllPrompts(server: McpServer) {
  server.prompt(
    'debt_collection_workflow',
    'Evidence-based collection review and draft next action.',
    { customerId: z.string().describe('CUSTNAME') },
    (p) =>
      message(`Review customer ${JSON.stringify(p.customerId)}:
1. Read priority_get_customer_balance and priority_get_unpaid_invoices_for_customer. Report scan completeness. Unreconciled invoice face values are not verified remaining balances.
2. Read priority_get_customer_contacts for a draft contact approach. Do not contact anyone.
3. Use aging, payment history and activity tools only if their capability entries show an implemented, enabled route; otherwise state that due dates, actual payments or CRM history are unavailable.
4. Draft one next action using the verified evidence. A receipt or ledger entry does not prove bank clearing; payment-plan decisions need the user.`),
  );
  server.prompt(
    'daily_briefing',
    'Orders, ledger cash, debt and available inventory evidence.',
    {},
    () =>
      message(`Produce a daily briefing:
1. Read priority_list_orders for the explicit date range and page before claiming totals.
2. Read priority_get_cash_position and priority_get_top_debtors. Label cash figures as Priority GL balances with their currencies and sign convention.
3. Use overdue, low-stock and task tools only when implemented and enabled; otherwise list those gaps. Never substitute uninvoiced delivery documents for debt.
4. Give the top five findings and one concrete next action, identifying every incomplete scan.`),
  );
  server.prompt(
    'cash_position_summary',
    'Ledger cash snapshot with conditional due-date projection.',
    { periodDays: z.string().default('30').describe('Days ahead') },
    (p) =>
      message(`Review the next ${JSON.stringify(p.periodDays)} days:
1. Read priority_get_cash_position and preserve each currency. These are GL balances, not bank-confirmed available funds.
2. Use cash-flow and AR/AP aging tools only if implemented and enabled with verified due-date/open-item sources.
3. If those sources are missing, report projection unavailable and name the required evidence. Do not invent inflows, outflows or a net projection.`),
  );
  server.prompt(
    'order_fulfillment_check',
    'Check order readiness using stock and incoming-order evidence.',
    { orderId: z.string().describe('ORDNAME') },
    (p) =>
      message(`Review order ${JSON.stringify(p.orderId)}:
1. Read priority_get_order and priority_get_stock_levels for each line and relevant warehouse.
2. Read priority_get_incoming_shipments for shortages; expected dates are estimates.
3. Report stock gaps and source coverage. A closed order, shipment assignment or carrier pickup does not prove delivery to the customer.`),
  );
  server.prompt(
    'inventory_reorder_check',
    'Inventory review using verified stock and sales coverage.',
    {},
    () =>
      message(`Review inventory:
1. Use low-stock tools only when implemented. Otherwise page priority_list_products and inspect priority_get_stock_levels for a clearly stated scope.
2. Use priority_product_sales_by_period for selected products and an explicit date range, retaining incomplete-window warnings.
3. Read priority_get_incoming_shipments. Report missing reorder points or lead times as unknown.
4. Suggest quantities only when stock, demand and lead-time evidence supports them; do not create purchase orders.`),
  );
}
