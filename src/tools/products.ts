import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { ODataBuilder } from '../client/odata-builder.js';
import { toMcpError } from '../client/errors.js';
import { sanitizeODataValue } from '../lib/sanitize.js';
import { checkWriteAllowed, dryRunResult, textResult } from '../lib/write-guard.js';

export function registerProductTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_products',
    `List products/parts from Priority ERP with optional filters.

Returns paginated product list. Use priority_get_product for full details.
Filter by category, stock availability, or active status.`,
    {
      category: z.string().optional().describe('Filter by product family/category (FAMILYDES)'),
      active: z.boolean().optional().describe('Filter active products only'),
      search: z.string().optional().describe('Search in product description (PARTDES)'),
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).default(0),
      orderBy: z.enum(['PARTNAME', 'PARTDES']).default('PARTNAME'),
      orderDir: z.enum(['asc', 'desc']).default('asc'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().top(params.top).skip(params.skip).orderBy(params.orderBy, params.orderDir);
        if (params.category) qb.eq('FAMILYDES', sanitizeODataValue(params.category));
        if (params.active !== undefined) qb.eq('INACTIVE', params.active ? 'N' : 'Y');
        if (params.search) qb.contains('PARTDES', sanitizeODataValue(params.search));
        const result = await client.list('LOGPART', qb.build());
        return textResult({ products: result.value, pagination: { returned: result.value.length, top: params.top, skip: params.skip } });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_product',
    `Get full product details including cost, prices, stock levels, and suppliers.

Use PARTNAME (part/product number) as the key.`,
    {
      productId: z.string().min(1).describe('The PARTNAME (product/part number)'),
      expand: z.array(z.string()).optional().describe('Sub-forms to expand'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder();
        if (params.expand?.length) qb.expand(...params.expand);
        const product = await client.get('LOGPART', params.productId, qb.build() || undefined);
        return textResult(product);
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_search_products',
    `Search products by name, SKU, or barcode.

Fuzzy search across product description and part number. Returns up to 20 matches by default.`,
    {
      query: z.string().min(1).describe('Search term'),
      top: z.number().int().min(1).max(100).default(20),
    },
    async (params) => {
      try {
        const q = sanitizeODataValue(params.query);
        const qb = new ODataBuilder()
          .filter(`contains(PARTDES,'${q}') or contains(PARTNAME,'${q}') or contains(BARCODE,'${q}')`)
          .select('PARTNAME', 'PARTDES', 'FAMILYDES', 'BARCODE')
          .top(params.top);
        const result = await client.list('LOGPART', qb.build());
        return textResult({ results: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_stock_levels',
    `Get stock levels for a product across all warehouses.

Shows available, reserved, and total quantities per warehouse.`,
    {
      productId: z.string().min(1).describe('The PARTNAME'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().eq('PARTNAME', params.productId);
        const result = await client.list('LOGCOUNTERS', qb.build());
        return textResult({ productId: params.productId, stockLevels: result.value });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_low_stock_alerts',
    `Get products below their reorder point.

Use for inventory planning — returns products where current stock is below the minimum defined in Priority.`,
    {
      top: z.number().int().min(1).max(500).default(100),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .filter('BALANCE lt MINBAL')
          .top(params.top);
        const result = await client.list('LOGCOUNTERS', qb.build());
        return textResult({ lowStockItems: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_out_of_stock',
    `Get products with zero stock across all warehouses.`,
    {
      top: z.number().int().min(1).max(500).default(100),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().le('BALANCE', 0).top(params.top);
        const result = await client.list('LOGCOUNTERS', qb.build());
        return textResult({ outOfStockItems: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_product_price',
    `Get the price for a product, optionally for a specific customer (using their price list).

Without a customerId, returns the base/list price. With a customerId, returns the customer-specific price.`,
    {
      productId: z.string().min(1).describe('The PARTNAME'),
      customerId: z.string().optional().describe('CUSTNAME for customer-specific pricing'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().eq('PARTNAME', params.productId);
        if (params.customerId) qb.eq('CUSTNAME', params.customerId);
        const result = await client.list('PRICELIST', qb.build());
        return textResult({ productId: params.productId, pricing: result.value });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_product_sales_history',
    `Get sales velocity data for a product — quantity sold over recent periods.

Useful for reorder planning and demand forecasting.`,
    {
      productId: z.string().min(1).describe('The PARTNAME'),
      top: z.number().int().min(1).max(500).default(100),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder()
          .eq('PARTNAME', params.productId)
          .orderBy('CURDATE', 'desc')
          .top(params.top);
        const result = await client.list('ORDERITEMS', qb.build());
        return textResult({ productId: params.productId, salesHistory: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
    },
  );

  // --- Write Tools ---

  server.tool(
    'priority_update_product_price',
    `Update the list price for a product.

⚠️ WRITE OPERATION — changes pricing. Use dryRun=true (default) to preview.`,
    {
      productId: z.string().min(1).describe('PARTNAME'),
      newPrice: z.number().positive().describe('New list price'),
      priceList: z.string().optional().describe('Price list name (PLNAME) — defaults to base price list'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body: Record<string, unknown> = { PRICE: params.newPrice };
        if (params.dryRun) return dryRunResult('UPDATE PRICE ' + params.productId, { ...body, PARTNAME: params.productId, PLNAME: params.priceList });

        // Price updates go through the PRICELIST entity
        const qb = new ODataBuilder().eq('PARTNAME', params.productId);
        if (params.priceList) qb.eq('PLNAME', params.priceList);
        const existing = await client.list<Record<string, unknown>>('PRICELIST', qb.build());
        if (existing.value.length === 0) return textResult({ error: 'Price list entry not found for this product.' });

        const result = await client.update('PRICELIST', String(existing.value[0]!['PLNAME']), body);
        return textResult({ updated: true, productId: params.productId, result });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_adjust_stock',
    `Adjust stock level for a product with a reason code.

⚠️ WRITE OPERATION — changes inventory quantities. Use dryRun=true (default) to preview.`,
    {
      productId: z.string().min(1).describe('PARTNAME'),
      warehouse: z.string().min(1).describe('Warehouse code (WARESSION)'),
      quantity: z.number().describe('Adjustment quantity (positive to add, negative to subtract)'),
      reason: z.string().min(1).describe('Reason for adjustment'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body = {
          PARTNAME: params.productId,
          WARESSION: params.warehouse,
          QUANT: params.quantity,
          ADJDES: params.reason,
        };
        if (params.dryRun) return dryRunResult('ADJUST STOCK', body);

        const result = await client.create('INVENTCOUNT', body);
        return textResult({ adjusted: true, result });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_transfer_stock',
    `Transfer stock between warehouses.

⚠️ WRITE OPERATION — moves inventory. Use dryRun=true (default) to preview.`,
    {
      productId: z.string().min(1).describe('PARTNAME'),
      fromWarehouse: z.string().min(1).describe('Source warehouse code'),
      toWarehouse: z.string().min(1).describe('Destination warehouse code'),
      quantity: z.number().positive().describe('Quantity to transfer'),
      dryRun: z.boolean().default(true),
    },
    async (params) => {
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const body = {
          PARTNAME: params.productId,
          FROMWARESSION: params.fromWarehouse,
          TOWARESSION: params.toWarehouse,
          TQUANT: params.quantity,
        };
        if (params.dryRun) return dryRunResult('TRANSFER STOCK', body);

        const result = await client.create('WAREHOUSE_TRANSFER', body);
        return textResult({ transferred: true, result });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
