import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { ODataBuilder } from '../client/odata-builder.js';
import { toMcpError } from '../client/errors.js';
import { sanitizeODataValue } from '../lib/sanitize.js';
import { checkWriteAllowed, dryRunResult, textResult } from '../lib/write-guard.js';

export function registerOrderTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_orders',
    `List sales orders with optional filters.

Returns paginated order list. Default sort: newest first by order date.
Use priority_get_order for full details with line items.`,
    {
      customerId: z.string().optional().describe('Filter by CUSTNAME'),
      status: z.string().optional().describe('Filter by order status (STATDES)'),
      dateFrom: z.string().optional().describe('Start date (ISO 8601)'),
      dateTo: z.string().optional().describe('End date (ISO 8601)'),
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).default(0),
      orderBy: z.enum(['ORDNAME', 'CURDATE', 'TOTPRICE']).default('CURDATE'),
      orderDir: z.enum(['asc', 'desc']).default('desc'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().top(params.top).skip(params.skip).orderBy(params.orderBy, params.orderDir);
        if (params.customerId) qb.eq('CUSTNAME', sanitizeODataValue(params.customerId));
        if (params.status) qb.eq('STATDES', sanitizeODataValue(params.status));
        if (params.dateFrom) qb.ge('CURDATE', params.dateFrom);
        if (params.dateTo) qb.le('CURDATE', params.dateTo);
        const result = await client.list('ORDERS', qb.build());
        return textResult({ orders: result.value, pagination: { returned: result.value.length, top: params.top, skip: params.skip } });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_order',
    `Get a single sales order with full details including line items, customer, and status.

Use ORDNAME (order number) as the key. Expands line items by default.`,
    {
      orderNumber: z.string().min(1).describe('The ORDNAME (order number)'),
      expand: z.array(z.string()).optional().describe('Additional sub-forms to expand'),
    },
    async (params) => {
      try {
        const expands = ['ORDERITEMS_SUBFORM', ...(params.expand ?? [])];
        const qb = new ODataBuilder().expand(...expands);
        const order = await client.get('ORDERS', params.orderNumber, qb.build());
        return textResult(order);
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_pending_orders',
    `Get orders awaiting fulfillment — orders that are confirmed but not yet shipped.

Useful for warehouse/fulfillment teams to see what needs to go out.`,
    {
      top: z.number().int().min(1).max(500).default(100),
      skip: z.number().int().min(0).default(0),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .eq('CLOSED', 'N')
          .top(params.top).skip(params.skip)
          .orderBy('CURDATE', 'asc');
        const result = await client.list('ORDERS', qb.build());
        return textResult({ pendingOrders: result.value, pagination: { returned: result.value.length, top: params.top, skip: params.skip } });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_order_shipment_status',
    `Get shipment/tracking info for a specific order.

Returns shipping details including carrier, tracking number, and expected delivery date if available.`,
    {
      orderNumber: z.string().min(1).describe('The ORDNAME'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().expand('SHIPMENTS_SUBFORM');
        const order = await client.get<Record<string, unknown>>('ORDERS', params.orderNumber, qb.build());
        return textResult({ orderNumber: params.orderNumber, shipments: order['SHIPMENTS_SUBFORM'] ?? [] });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_backorder_report',
    `Get orders with items that are out of stock or on backorder.

Shows which orders can't be fully fulfilled due to insufficient inventory.`,
    {
      top: z.number().int().min(1).max(500).default(100),
      skip: z.number().int().min(0).default(0),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().top(params.top).skip(params.skip);
        const result = await client.list('ORDERSBKMN', qb.build());
        return textResult({ backorders: result.value, pagination: { returned: result.value.length, top: params.top, skip: params.skip } });
      } catch (err) { throw toMcpError(err); }
    },
  );

  // --- Write Tools ---

  server.tool(
    'priority_create_order',
    `Create a new sales order in Priority ERP.

⚠️ WRITE OPERATION — creates a sales order.
Use dryRun=true (default) to preview. Disabled when PRIORITY_READ_ONLY=true.`,
    {
      customerId: z.string().min(1).describe('CUSTNAME'),
      items: z.array(z.object({
        productId: z.string().min(1).describe('PARTNAME'),
        quantity: z.number().positive(),
        price: z.number().optional().describe('Unit price override'),
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
          ORDERITEMS_SUBFORM: params.items.map((item) => ({
            PARTNAME: item.productId,
            TQUANT: item.quantity,
            ...(item.price !== undefined ? { PRICE: item.price } : {}),
          })),
        };
        if (params.remarks) body.DETAILS = params.remarks;

        if (params.dryRun) return dryRunResult('CREATE ORDER', body);

        const result = await client.create('ORDERS', body);
        return textResult({ created: true, order: result });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_update_order',
    `Update an existing sales order — modify header fields or line items.

⚠️ WRITE OPERATION. Use dryRun=true (default) to preview.`,
    {
      orderNumber: z.string().min(1).describe('ORDNAME'),
      remarks: z.string().optional(),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body: Record<string, unknown> = {};
        if (params.remarks) body.DETAILS = params.remarks;

        if (Object.keys(body).length === 0) return textResult({ error: 'No fields to update.' });
        if (params.dryRun) return dryRunResult('UPDATE ORDER ' + params.orderNumber, body);

        const result = await client.update('ORDERS', params.orderNumber, body);
        return textResult({ updated: true, orderNumber: params.orderNumber, result });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_cancel_order',
    `Cancel a sales order with a reason.

⚠️ WRITE OPERATION — marks the order as closed/cancelled. Use dryRun=true (default) to preview.`,
    {
      orderNumber: z.string().min(1).describe('ORDNAME'),
      reason: z.string().min(1).describe('Cancellation reason'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body = { CLOSED: 'Y', DETAILS: params.reason };
        if (params.dryRun) return dryRunResult('CANCEL ORDER ' + params.orderNumber, body);

        const result = await client.update('ORDERS', params.orderNumber, body);
        return textResult({ cancelled: true, orderNumber: params.orderNumber, result });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_confirm_order',
    `Confirm/approve a sales order, moving it to confirmed status.

⚠️ WRITE OPERATION. Use dryRun=true (default) to preview.`,
    {
      orderNumber: z.string().min(1).describe('ORDNAME'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body = { STATDES: 'confirmed' };
        if (params.dryRun) return dryRunResult('CONFIRM ORDER ' + params.orderNumber, body);

        const result = await client.update('ORDERS', params.orderNumber, body);
        return textResult({ confirmed: true, orderNumber: params.orderNumber, result });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
