import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { ODataBuilder } from '../client/odata-builder.js';
import { toMcpError } from '../client/errors.js';
import { sanitizeODataValue } from '../lib/sanitize.js';
import { checkWriteAllowed, dryRunResult, textResult } from '../lib/write-guard.js';

export function registerPurchaseOrderTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_purchase_orders',
    `List purchase orders with optional filters by supplier, status, and date.`,
    {
      supplierId: z.string().optional().describe('Filter by SUPNAME'),
      status: z.string().optional().describe('Filter by status'),
      dateFrom: z.string().optional(),
      dateTo: z.string().optional(),
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).default(0),
      orderDir: z.enum(['asc', 'desc']).default('desc'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().top(params.top).skip(params.skip).orderBy('CURDATE', params.orderDir);
        if (params.supplierId) qb.eq('SUPNAME', sanitizeODataValue(params.supplierId));
        if (params.status) qb.eq('STATDES', sanitizeODataValue(params.status));
        if (params.dateFrom) qb.ge('CURDATE', params.dateFrom);
        if (params.dateTo) qb.le('CURDATE', params.dateTo);
        const result = await client.list('PORDERS', qb.build());
        return textResult({ purchaseOrders: result.value, pagination: { returned: result.value.length, top: params.top, skip: params.skip } });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_purchase_order',
    `Get a single purchase order with line items.`,
    {
      poNumber: z.string().min(1).describe('The PORDNAME (PO number)'),
      expand: z.array(z.string()).optional(),
    },
    async (params) => {
      try {
        const expands = ['PORDERITEMS_SUBFORM', ...(params.expand ?? [])];
        const qb = new ODataBuilder().expand(...expands);
        const po = await client.get('PORDERS', params.poNumber, qb.build());
        return textResult(po);
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_incoming_shipments',
    `Get purchase orders that are in transit / expected to arrive.

Useful for inventory planning — shows what's coming in and when.`,
    {
      top: z.number().int().min(1).max(500).default(100),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .eq('CLOSED', 'N')
          .orderBy('EXPIRYDATE', 'asc')
          .top(params.top);
        const result = await client.list('PORDERS', qb.build());
        return textResult({ incomingShipments: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
    },
  );

  // --- Write Tools ---

  server.tool(
    'priority_create_purchase_order',
    `Create a new purchase order in Priority ERP.

⚠️ WRITE OPERATION. Use dryRun=true (default) to preview.`,
    {
      supplierId: z.string().min(1).describe('SUPNAME'),
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
          SUPNAME: params.supplierId,
          PORDERITEMS_SUBFORM: params.items.map((item) => ({
            PARTNAME: item.productId,
            TQUANT: item.quantity,
            ...(item.price !== undefined ? { PRICE: item.price } : {}),
          })),
        };
        if (params.remarks) body.DETAILS = params.remarks;

        if (params.dryRun) return dryRunResult('CREATE PURCHASE ORDER', body);

        const result = await client.create('PORDERS', body);
        return textResult({ created: true, purchaseOrder: result });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
