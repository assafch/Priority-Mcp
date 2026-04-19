import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerAllPrompts(server: McpServer) {
  server.prompt(
    'debt_collection_workflow',
    `Step-by-step debt collection workflow for a specific customer.
Guides the AI through: checking aging → reviewing payment history → drafting collection approach → suggesting next action.`,
    { customerId: z.string().describe('CUSTNAME of the customer to collect from') },
    (params) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Run a debt collection workflow for customer "${params.customerId}". Follow these steps:

1. **Check aging**: Call priority_get_customer_aging for this customer. Summarize how much is in each bucket (0-30, 31-60, 61-90, 90+).
2. **Review payment history**: Call priority_get_payment_history to understand their typical payment behavior (avg days to pay).
3. **Check recent activities**: Call priority_get_customer_activities to see if there have been recent collection attempts.
4. **Get contact info**: Call priority_get_customer_contacts to find the right person to reach out to.
5. **Draft approach**: Based on the above, recommend:
   - Urgency level (low/medium/high/critical)
   - Suggested communication channel (email/phone/letter)
   - Talking points for the conversation
   - Whether to offer a payment plan
6. **Suggest next action**: Recommend scheduling a follow-up using priority_schedule_followup.`,
        },
      }],
    }),
  );

  server.prompt(
    'daily_briefing',
    `Morning briefing: overnight orders, overdue invoices, low stock alerts, and cash position.
Produces a concise executive summary to start the day.`,
    {},
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Generate a daily business briefing. Gather the following data and present a concise summary:

1. **New Orders**: Call priority_list_orders with dateFrom=yesterday, dateTo=today. Summarize count and total value.
2. **Overdue Invoices**: Call priority_get_overdue_invoices. Highlight the top 5 most overdue by amount.
3. **Cash Position**: Call priority_get_cash_position. Show total cash across all accounts.
4. **Low Stock Alerts**: Call priority_get_low_stock_alerts. List any critical items below reorder point.
5. **Top Debtors**: Call priority_get_top_debtors with top=5. Show who owes the most.
6. **Open Tasks**: Call priority_get_open_tasks with top=10. List upcoming tasks due today/this week.

Format as a clean briefing with sections, totals, and action items.`,
        },
      }],
    }),
  );

  server.prompt(
    'cash_position_summary',
    `Cash position snapshot with AR/AP projection.`,
    { periodDays: z.string().default('30').describe('Days ahead to project (default 30)') },
    (params) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Generate a cash position summary with ${params.periodDays}-day projection:

1. Call priority_get_cash_position for current balances.
2. Call priority_get_cashflow_projection with daysAhead=${params.periodDays}.
3. Call priority_get_ar_aging_summary and priority_get_ap_aging_summary.

Present: current cash, expected inflows, expected outflows, net projection, and any concerns.`,
        },
      }],
    }),
  );

  server.prompt(
    'order_fulfillment_check',
    `Check if an order can be fulfilled: stock availability, delivery estimate, potential issues.`,
    { orderId: z.string().describe('ORDNAME to check') },
    (params) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Check fulfillment readiness for order "${params.orderId}":

1. Call priority_get_order to get order details and line items.
2. For each line item, call priority_get_stock_levels to check availability.
3. Flag any items with insufficient stock.
4. Check priority_get_incoming_shipments for any POs that might cover shortages.
5. Summarize: can this order ship completely? If not, what's missing and when might it arrive?`,
        },
      }],
    }),
  );

  server.prompt(
    'inventory_reorder_check',
    `Identify products needing reorder and suggest quantities based on sales velocity.`,
    {},
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `Run an inventory reorder analysis:

1. Call priority_get_low_stock_alerts to find products below reorder point.
2. For the top 10 most critical items, call priority_get_product_sales_history to determine sales velocity.
3. Check priority_get_incoming_shipments for any pending POs that cover these items.
4. For each item, suggest a reorder quantity based on: current stock, reorder point, sales velocity, and lead time.
5. Present a table: Product | Current Stock | Reorder Point | Monthly Velocity | Suggested Order Qty | Pending POs`,
        },
      }],
    }),
  );
}
