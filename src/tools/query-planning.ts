import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PriorityClient } from '../client/priority-client.js';
import { prepareReadQuery } from '../lib/query-plan.js';
import { textResult } from '../lib/tool-result.js';
import { createOperation, currentOperation } from '../runtime/operation-context.js';

export function registerQueryPlanningTools(server: McpServer, client: PriorityClient): void {
  server.tool(
    'priority_prepare_query',
    'Prepare a schema-validated read query preview. Reads targeted metadata only; never executes the data query or a mutation. Explain cost, projection, bounds and date mapping; use an existing read tool for execution.',
    {
      form: z.string().min(1).max(128),
      fields: z.array(z.string().min(1).max(128)).min(1).max(100),
      filters: z
        .array(
          z.object({
            field: z.string().min(1).max(128),
            op: z.enum(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains']),
            value: z.union([z.string().max(10000), z.number().finite(), z.boolean()]),
          }),
        )
        .max(50)
        .default([]),
      dates: z
        .object({ from: z.string().max(100).optional(), to: z.string().max(100).optional() })
        .optional(),
      expand: z.array(z.string().min(1).max(128)).max(2).optional(),
      top: z.number().int().min(1).max(500).default(50),
    },
    async (input) => {
      const operation =
        currentOperation() ??
        createOperation('priority_prepare_query', { metrics: client.metrics });
      const result = await prepareReadQuery(input, { ...operation, client });
      return textResult({ ...result, preview: true });
    },
  );
}
