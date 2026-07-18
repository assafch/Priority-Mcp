import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import { getSchema } from '../lib/priority-schema.js';
import { searchForm } from '../lib/search.js';
import { textResult, unavailableHere } from '../lib/write-guard.js';

const SUPPLIERS = getSchema('SUPPLIERS');

export function registerSupplierTools(server: McpServer, client: PriorityClient) {
  server.tool(
    'priority_list_suppliers',
    'List suppliers from Priority ERP with optional filters.',
    {
      search: z.string().optional().describe('Search in supplier name'),
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).default(0),
    },
    async (params) => {
      try {
        // Text search routes through the capability-aware helper (falls back to server-side
        // matching when the install rejects contains()).
        if (params.search) {
          const { value, meta } = await searchForm(client, {
            form: 'SUPPLIERS',
            query: params.search,
            fields: SUPPLIERS?.searchFields ?? ['SUPDES', 'SUPNAME'],
            select: SUPPLIERS?.defaultSelect,
            top: params.top,
            orderby: 'SUPNAME asc',
          });
          return textResult({
            suppliers: value,
            pagination: { returned: value.length, top: params.top, skip: 0 },
            search: meta,
          });
        }
        const qb = new ODataBuilder().top(params.top).skip(params.skip).orderBy('SUPNAME', 'asc');
        if (SUPPLIERS?.defaultSelect) qb.select(...SUPPLIERS.defaultSelect);
        const result = await client.list('SUPPLIERS', qb.build());
        return textResult({
          suppliers: result.value,
          pagination: { returned: result.value.length, top: params.top, skip: params.skip },
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_supplier',
    'Get full supplier record by SUPNAME.',
    {
      supplierId: z.string().min(1).describe('The SUPNAME (supplier ID)'),
      expand: z.array(z.string()).optional(),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder();
        if (params.expand?.length) qb.expand(...params.expand);
        const supplier = await client.get('SUPPLIERS', params.supplierId, qb.build() || undefined);
        return textResult(supplier);
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_supplier_balance',
    'Get open accounts payable (AP) balance for a supplier.',
    {
      supplierId: z.string().min(1).describe('The SUPNAME'),
    },
    async (_params) => {
      // SUPPLIERS has no SUPBALANCE field on this install, and there is no exposed per-supplier
      // open-balance form (no SUP_OBLIGO / SUP_OPENDEBT).
      return unavailableHere(
        'SUPPLIERS has no balance field on this installation and no per-supplier open-balance form ' +
          '(SUP_OBLIGO / SUP_OPENDEBT) is exposed to the API.',
        'The GL form ACCOUNTS_PAYABLE is exposed — query it via priority_query for A/P balances, or ' +
          'expose a supplier-balance form to the API.',
      );
    },
  );
}
