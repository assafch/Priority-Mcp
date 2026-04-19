import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import { ODataBuilder } from '../client/odata-builder.js';
import { toMcpError } from '../client/errors.js';
import { sanitizeODataValue } from '../lib/sanitize.js';

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerSupplierTools(server: McpServer, client: PriorityClient) {
  server.tool(
    'priority_list_suppliers',
    `List suppliers from Priority ERP with optional filters.`,
    {
      search: z.string().optional().describe('Search in supplier name'),
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).default(0),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().top(params.top).skip(params.skip).orderBy('SUPNAME', 'asc');
        if (params.search) qb.contains('SUPDES', sanitizeODataValue(params.search));
        const result = await client.list('SUPPLIERS', qb.build());
        return textResult({ suppliers: result.value, pagination: { returned: result.value.length, top: params.top, skip: params.skip } });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_supplier',
    `Get full supplier record by SUPNAME.`,
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
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_supplier_balance',
    `Get open accounts payable (AP) balance for a supplier.`,
    {
      supplierId: z.string().min(1).describe('The SUPNAME'),
    },
    async (params) => {
      try {
        const s = await client.get<Record<string, unknown>>('SUPPLIERS', params.supplierId,
          new ODataBuilder().select('SUPNAME', 'SUPDES', 'SUPBALANCE').build());
        return textResult({ supplierId: s['SUPNAME'], name: s['SUPDES'], balance: s['SUPBALANCE'] ?? 0 });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
