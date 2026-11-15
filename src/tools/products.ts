import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { getSchema } from '../lib/priority-schema.js';
import { escapeODataString, sanitizeODataValue } from '../lib/sanitize.js';
import { searchForm } from '../lib/search.js';
import { textResult, unavailableHere } from '../lib/write-guard.js';
import { currentOperation } from '../runtime/operation-context.js';

const LOGPART = getSchema('LOGPART');
const PART_SEARCH_FIELDS = LOGPART?.searchFields ?? ['PARTDES', 'PARTNAME'];
const PART_SELECT = LOGPART?.defaultSelect ?? ['PARTNAME', 'PARTDES'];
// LOGPART has no INACTIVE flag; active/inactive is the STATDES status text ('פעיל' = active).
const ACTIVE_STATUS = 'פעיל';

export function registerProductTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_products',
    `List products/parts from Priority ERP with optional filters.

Returns paginated product list. Use priority_get_product for full details.
Filter by category, stock availability, or active status.`,
    {
      cursor: z
        .string()
        .optional()
        .describe('Server-owned search continuation; repeat the same search arguments.'),
      category: z.string().optional().describe('Filter by product family/category (FAMILYDES)'),
      active: z.boolean().optional().describe('Filter active products only'),
      search: z.string().optional().describe('Search in product description (PARTDES)'),
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).default(0),
      orderBy: z.enum(['PARTNAME', 'PARTDES']).default('PARTNAME'),
      orderDir: z.enum(['asc', 'desc']).default('asc'),
    },
    async (params, extra) => {
      try {
        // Build the server-side filters that must apply in BOTH the plain-list and search paths.
        // These were previously dropped whenever `search` was set, silently returning inactive
        // products / ignoring the category filter.
        const baseFilters: string[] = [];
        if (params.category)
          baseFilters.push(`FAMILYDES eq '${escapeODataString(params.category)}'`);
        if (params.active !== undefined) {
          baseFilters.push(
            params.active
              ? `STATDES eq '${escapeODataString(ACTIVE_STATUS)}'`
              : `STATDES ne '${escapeODataString(ACTIVE_STATUS)}'`,
          );
        }

        // Name/SKU search routes through the capability-aware helper (contains() → fallback).
        if (params.search) {
          const { value, meta } = await searchForm(client, {
            signal: extra?.signal ?? currentOperation()?.signal,
            deadlineAt: currentOperation()?.deadlineAt,
            cursor: params.cursor,
            form: 'LOGPART',
            query: params.search,
            fields: PART_SEARCH_FIELDS,
            select: PART_SELECT,
            top: params.top,
            baseFilter: baseFilters.length ? baseFilters.join(' and ') : undefined,
            orderby: `${params.orderBy} ${params.orderDir}`,
          });
          return textResult({
            products: value,
            pagination: { returned: value.length, top: params.top, skip: 0 },
            // searchForm has no $skip; be explicit rather than silently returning page 1 again.
            ...(params.skip > 0
              ? {
                  note: 'Search mode does not support skip-based paging — narrow the query instead.',
                }
              : {}),
            search: meta,
          });
        }

        const qb = new ODataBuilder()
          .top(params.top)
          .skip(params.skip)
          .orderBy(params.orderBy, params.orderDir)
          .select(...PART_SELECT);
        if (params.category) qb.eq('FAMILYDES', sanitizeODataValue(params.category));
        if (params.active !== undefined) {
          qb.filter(
            params.active
              ? `STATDES eq '${escapeODataString(ACTIVE_STATUS)}'`
              : `STATDES ne '${escapeODataString(ACTIVE_STATUS)}'`,
          );
        }
        const result = await client.list('LOGPART', qb.build());
        return textResult({
          products: result.value,
          pagination: { returned: result.value.length, top: params.top, skip: params.skip },
        });
      } catch (err) {
        throw toMcpError(err);
      }
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
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_search_products',
    `Search products by name, SKU, or barcode.

Fuzzy search across product description and part number. Returns up to 20 matches by default.`,
    {
      cursor: z
        .string()
        .optional()
        .describe('Server-owned search continuation; repeat the same search arguments.'),
      query: z.string().min(1).describe('Search term'),
      top: z.number().int().min(1).max(100).default(20),
    },
    async (params, extra) => {
      try {
        const { value, meta } = await searchForm(client, {
          signal: extra?.signal ?? currentOperation()?.signal,
          deadlineAt: currentOperation()?.deadlineAt,
          cursor: params.cursor,
          form: 'LOGPART',
          query: params.query,
          fields: PART_SEARCH_FIELDS,
          select: ['PARTNAME', 'PARTDES', 'FAMILYDES'],
          top: params.top,
        });
        return textResult({ results: value, count: value.length, search: meta });
      } catch (err) {
        throw toMcpError(err);
      }
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
        // The flat PARTBAL form is API-blocked on this install; per-part on-hand balances live on
        // the part master's PARTBALANCE_SUBFORM (one row per warehouse/location).
        const result = await client.listSubform<Record<string, unknown>>(
          'LOGPART',
          params.productId,
          'PARTBALANCE_SUBFORM',
        );
        const rows = result.value ?? [];
        const totalOnHand = rows.reduce((sum, r) => sum + (Number(r.BALANCE) || 0), 0);
        return textResult({
          productId: params.productId,
          totalOnHand,
          byWarehouse: rows.map((r) => ({
            warehouse: r.WARHSNAME,
            location: r.LOCNAME,
            balance: Number(r.BALANCE) || 0,
            baseBalance: Number(r.TBALANCE) || 0,
            unit: r.UNITNAME,
          })),
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_low_stock_alerts',
    `Get products below their reorder point.

Use for inventory planning — returns products where current stock is below the minimum defined in Priority.`,
    {
      top: z.number().int().min(1).max(500).default(100),
    },
    async () =>
      // Reorder-point detection needs a minimum-stock column, and the flat stock forms
      // (LOGCOUNTERS, PARTBAL) are not API-enabled on this install.
      unavailableHere(
        'Below-reorder-point detection needs a minimum-stock column on an API-enabled stock form; ' +
          'the flat stock forms (LOGCOUNTERS, PARTBAL) are not API-enabled here.',
        'Check a specific product with priority_get_stock_levels, or expose a form carrying the ' +
          'reorder point (e.g. LOGCOUNTERS) to the API for true low-stock alerts.',
      ),
  );

  server.tool(
    'priority_get_out_of_stock',
    'Get products with zero stock across all warehouses.',
    {
      top: z.number().int().min(1).max(500).default(100),
    },
    async () =>
      // The only flat, company-wide stock form (PARTBAL) is API-blocked here (400 "לא ניתן להפעיל
      // API למסך זה"), and per-part balances live on LOGPART/PARTBALANCE_SUBFORM — which can't be
      // scanned across every product efficiently. So a company-wide out-of-stock sweep isn't
      // feasible via the API on this install.
      unavailableHere(
        'A company-wide out-of-stock list needs the flat PARTBAL stock form, which is API-blocked ' +
          'on this installation; per-part balances are only reachable one product at a time.',
        'Check a specific product with priority_get_stock_levels(productId) (reads LOGPART/' +
          'PARTBALANCE_SUBFORM), or expose PARTBAL to the API for a company-wide sweep.',
      ),
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
        // The base sale price lives on the LOGPART part master: BASEPLPRICE (base price-list
        // price), VATPRICE (incl VAT), WSPLPRICE (wholesale). The PRICELIST form has no
        // PARTNAME/CUSTNAME columns and is API-blocked on this install, so it cannot be queried
        // for a product's price — LOGPART.BASEPLPRICE is verified to equal the invoiced unit price.
        const qb = new ODataBuilder()
          .eq('PARTNAME', sanitizeODataValue(params.productId))
          .select(
            'PARTNAME',
            'PARTDES',
            'BASEPLPRICE',
            'BASEPLCODE',
            'VATPRICE',
            'WSPLPRICE',
            'LASTPRICE',
          )
          .top(1);
        const result = await client.list<Record<string, unknown>>('LOGPART', qb.build());
        const part = result.value[0];
        if (!part) {
          return textResult({
            productId: params.productId,
            note: `No product found with PARTNAME "${params.productId}".`,
          });
        }
        return textResult({
          productId: params.productId,
          description: part.PARTDES,
          basePrice: Number(part.BASEPLPRICE) || 0,
          currency: part.BASEPLCODE,
          priceWithVat: Number(part.VATPRICE) || 0,
          wholesalePrice: Number(part.WSPLPRICE) || 0,
          ...(params.customerId
            ? {
                customerPricingNote: `Showing the base list price. Customer-specific pricing for "${params.customerId}" lives in the PRICELIST form (API-blocked here) — use priority_get_customer_price_list for a customer's price list.`,
              }
            : {}),
        });
      } catch (err) {
        throw toMcpError(err);
      }
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
    // The flat sales-line form SALESINVOICEITEMS is API-blocked on this installation (400
    // "לא ניתן להפעיל API למסך זה"), so a direct per-line query always failed. Redirect to the
    // tool that computes per-product sales here (via AINVOICEITEMS_SUBFORM expansion).
    async () =>
      unavailableHere(
        'Per-product sales history needs the sales-line form SALESINVOICEITEMS, which is API-blocked ' +
          'on this installation, so it cannot be queried directly.',
        'Use priority_product_sales_by_period (products=[PARTNAME], a date range, bucket=month) — it ' +
          'aggregates sales per product over time and works here.',
      ),
  );

  // --- Write Tools ---

  server.tool(
    'priority_update_product_price',
    `Update the base list price for a product.

⚠️ WRITE OPERATION. NOTE: disabled on this installation — see the response for why.`,
    {
      productId: z.string().min(1).describe('PARTNAME'),
      newPrice: z.number().positive().describe('New list price'),
      priceList: z
        .string()
        .optional()
        .describe('Price list name (PLNAME) — defaults to base price list'),
      dryRun: z.boolean().default(true),
    },
    // Disabled: the price source (PRICELIST / its PARTPRICE2_SUBFORM) is API-blocked here
    // (400 "לא ניתן להפעיל API למסך זה"), and PRICELIST is a header keyed by PLNAME with no
    // PARTNAME column — the old code PATCHed PRICELIST(PLNAME){PRICE}, which targets the whole
    // price-list header (wrong record) or 404s. LOGPART.BASEPLPRICE mirrors the base list but is
    // not a verified-safe write target. Rather than corrupt pricing on a live ERP, disable it.
    async () =>
      unavailableHere(
        'Updating a product price needs the PRICELIST form (or its PARTPRICE2_SUBFORM part-price ' +
          'sub-form), which is API-blocked on this installation. The base price on the part master ' +
          '(LOGPART.BASEPLPRICE) mirrors that price list and is not a safe write target via the API, ' +
          'so this tool is disabled to avoid corrupting pricing.',
        'Change prices in the Priority price-list screen (מחירונים), or expose PRICELIST to the OData ' +
          'API. Read the current base price with priority_get_product_price.',
      ),
  );

  server.tool(
    'priority_adjust_stock',
    `Adjust stock level for a product with a reason code.

⚠️ WRITE OPERATION. NOTE: disabled on this installation — see the response for why.`,
    {
      productId: z.string().min(1).describe('PARTNAME'),
      warehouse: z.string().min(1).describe('Warehouse name (WARHSNAME)'),
      quantity: z.number().describe('Adjustment quantity (positive to add, negative to subtract)'),
      reason: z.string().min(1).describe('Reason for adjustment'),
      dryRun: z.boolean().default(true),
    },
    // Disabled: the old body wrote { WARESSION, QUANT, ADJDES } to INVENTCOUNT — 'WARESSION' is
    // not a Priority field (the warehouse field is WARHSNAME), and INVENTCOUNT records an
    // ABSOLUTE counted quantity, not a signed delta as the tool documents. Best case every call
    // 400s; worst case it writes a stock-count line that corrupts the count. Needs the real
    // inventory-adjustment document flow, which can't be verified while read-only.
    async () =>
      unavailableHere(
        'Stock adjustment wrote to INVENTCOUNT with a non-existent field (WARESSION; the warehouse ' +
          'field is WARHSNAME) and treated an absolute stock-count quantity as a signed delta, so it ' +
          'could corrupt the count. Disabled until the correct inventory-adjustment document form is verified.',
        'Discover the adjustment form with priority_list_forms (e.g. a stock-count/DOCUMENTS_* form), ' +
          'confirm its fields with priority_get_entity_metadata, and post it via priority_create_record.',
      ),
  );

  server.tool(
    'priority_transfer_stock',
    `Transfer stock between warehouses.

⚠️ WRITE OPERATION. NOTE: disabled on this installation — see the response for why.`,
    {
      productId: z.string().min(1).describe('PARTNAME'),
      fromWarehouse: z.string().min(1).describe('Source warehouse name (WARHSNAME)'),
      toWarehouse: z.string().min(1).describe('Destination warehouse name (WARHSNAME)'),
      quantity: z.number().positive().describe('Quantity to transfer'),
      dryRun: z.boolean().default(true),
    },
    // Disabled: the old body POSTed { FROMWARESSION, TOWARESSION, TQUANT } to 'WAREHOUSE_TRANSFER',
    // which is not a real Priority entity (transfers are document forms with line sub-forms, e.g.
    // TRANSORDER/DOCUMENTS_N), and 'WARESSION' is not a field. Every call 404s. Needs the real
    // transfer-document flow, unverifiable while read-only.
    async () =>
      unavailableHere(
        "Stock transfer posted to a non-existent entity 'WAREHOUSE_TRANSFER' with non-existent fields, " +
          'so it always failed. A warehouse transfer in Priority is a document with a line sub-form, not ' +
          'a flat record. Disabled until the correct transfer form is verified.',
        'Discover the transfer form with priority_list_forms (e.g. TRANSORDER / DOCUMENTS_N), confirm its ' +
          'header + line fields with priority_get_entity_metadata, and create it via priority_create_record.',
      ),
  );
}
