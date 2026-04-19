import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import { ODataBuilder } from '../client/odata-builder.js';
import { toMcpError } from '../client/errors.js';

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerWarehouseTools(server: McpServer, client: PriorityClient) {
  server.tool(
    'priority_list_warehouses',
    `List all warehouses in the system.

Returns warehouse code, name, and location info. Useful for stock queries and transfer planning.`,
    {
      top: z.number().int().min(1).max(200).default(50),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().top(params.top);
        const result = await client.list('WAREHOUSES', qb.build());
        return textResult({ warehouses: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
