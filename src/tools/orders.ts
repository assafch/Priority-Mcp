import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { dateRange } from '../lib/dates.js';
import { getSchema } from '../lib/priority-schema.js';
import { sanitizeODataValue } from '../lib/sanitize.js';
import { previewOrBlock, textResult, unavailableHere } from '../lib/write-guard.js';
import { verifyRecordCreate, verifyRecordUpdate } from '../lib/write-verification.js';

const ORDERS = getSchema('ORDERS');

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
        const qb = new ODataBuilder()
          .top(params.top)
          .skip(params.skip)
          .orderBy(params.orderBy, params.orderDir);
        if (params.customerId) qb.eq('CUSTNAME', sanitizeODataValue(params.customerId));
        // Order status field on this install is ORDSTATUSDES (not STATDES).
        if (params.status) qb.eq('ORDSTATUSDES', sanitizeODataValue(params.status));
        const range = dateRange(params.dateFrom, params.dateTo);
        if (range.from) qb.ge('CURDATE', range.from);
        if (range.to) {
          if (range.upperOperator === 'lt') qb.lt('CURDATE', range.to);
          else qb.le('CURDATE', range.to);
        }
        if (ORDERS?.defaultSelect) qb.select(...ORDERS.defaultSelect);
        const result = await client.list('ORDERS', qb.build());
        return textResult({
          orders: result.value,
          pagination: { returned: result.value.length, top: params.top, skip: params.skip },
        });
      } catch (err) {
        throw toMcpError(err);
      }
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
      } catch (err) {
        throw toMcpError(err);
      }
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
        // Closed flag on ORDERS is BOOLCLOSED (Y/blank); pending = not closed.
        const qb = new ODataBuilder()
          .filter("BOOLCLOSED ne 'Y'")
          .top(params.top)
          .skip(params.skip)
          .orderBy('CURDATE', 'asc');
        if (ORDERS?.defaultSelect) qb.select(...ORDERS.defaultSelect);
        const result = await client.list('ORDERS', qb.build());
        return textResult({
          pendingOrders: result.value,
          pagination: { returned: result.value.length, top: params.top, skip: params.skip },
        });
      } catch (err) {
        throw toMcpError(err);
      }
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
        const order = await client.get<Record<string, unknown>>(
          'ORDERS',
          params.orderNumber,
          qb.build(),
        );
        return textResult({
          orderNumber: params.orderNumber,
          shipments: order.SHIPMENTS_SUBFORM ?? [],
        });
      } catch (err) {
        throw toMcpError(err);
      }
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
        return textResult({
          backorders: result.value,
          pagination: { returned: result.value.length, top: params.top, skip: params.skip },
        });
      } catch (err) {
        throw toMcpError(err);
      }
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
      items: z
        .array(
          z.object({
            productId: z.string().min(1).describe('PARTNAME'),
            quantity: z.number().positive(),
            price: z.number().optional().describe('Unit price override'),
          }),
        )
        .min(1),
      remarks: z.string().optional(),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
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

        const gate = previewOrBlock(config, params.dryRun, 'CREATE ORDER', body);
        if (gate) return gate;

        const outcome = await verifyRecordCreate(client, 'ORDERS', body);
        return textResult({ created: outcome.verified, order: outcome.result, ...outcome });
      } catch (err) {
        throw toMcpError(err);
      }
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
      try {
        const body: Record<string, unknown> = {};
        if (params.remarks) body.DETAILS = params.remarks;

        if (Object.keys(body).length === 0) return textResult({ error: 'No fields to update.' });

        const gate = previewOrBlock(
          config,
          params.dryRun,
          `UPDATE ORDER ${params.orderNumber}`,
          body,
        );
        if (gate) return gate;

        const outcome = await verifyRecordUpdate(client, 'ORDERS', params.orderNumber, body);
        return textResult({
          updated: outcome.verified,
          orderNumber: params.orderNumber,
          ...outcome,
        });
      } catch (err) {
        throw toMcpError(err);
      }
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
      try {
        const body = { BOOLCLOSED: 'Y', DETAILS: params.reason };

        const gate = previewOrBlock(
          config,
          params.dryRun,
          `CANCEL ORDER ${params.orderNumber}`,
          body,
        );
        if (gate) return gate;

        const outcome = await verifyRecordUpdate(client, 'ORDERS', params.orderNumber, body);
        return textResult({
          cancelled: outcome.verified,
          orderNumber: params.orderNumber,
          ...outcome,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_confirm_order',
    `Confirm/approve a sales order, moving it to confirmed status.

⚠️ WRITE OPERATION. NOTE: disabled on this installation — see the response for why.`,
    {
      orderNumber: z.string().min(1).describe('ORDNAME'),
      dryRun: z.boolean().default(true),
    },
    // Disabled: the old code PATCHed ORDSTATUSDES='confirmed'. ORDSTATUSDES is the status
    // DESCRIPTION — a computed mirror, Hebrew on this install (values seen: טיוטא/בוצעה/שולמה/
    // מבוטלת; there is no 'confirmed' state) — so the English literal can never match, and the
    // field isn't the lever that drives an order-status transition.
    async () =>
      unavailableHere(
        "Confirming an order by writing ORDSTATUSDES isn't supported: it's a computed status " +
          "description (values here are טיוטא/בוצעה/שולמה/מבוטלת — no 'confirmed' state) and the English " +
          'literal never matches. Order status is driven by the order lifecycle, not a direct field write.',
        'Advance the order in the Priority orders screen, or identify the field/flag that drives the ' +
          'transition with priority_get_entity_metadata and set it via priority_update_record.',
      ),
  );
}
