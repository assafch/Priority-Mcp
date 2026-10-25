import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PriorityError, toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { toolAllowed } from '../lib/capabilities.js';
import { handleBindingFor, policyScopeFor, resultHandles } from '../lib/result-handles.js';
import { type SalesState, salesStateEvidence } from '../services/reports/sales-aggregate.js';
/** An opaque page URI carries no caller-supplied backend continuation URL. */
export function registerResultResources(
  server: McpServer,
  client: PriorityClient,
  config: Config,
): void {
  server.resource(
    'result-pages',
    new ResourceTemplate('priority://results/{handle}/{queryHash}/{page}', { list: undefined }),
    {
      description:
        'Authenticated retained result detail pages, up to100rows per page; handles expire after15minutes.',
      mimeType: 'application/json',
    },
    async (uri, variables) => {
      try {
        if (!toolAllowed(config, 'priority_product_sales_by_period'))
          throw new PriorityError('Result dependency is blocked by tool policy.', 403);
        const scalar = (key: string) => {
          const value = variables[key];
          return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
        };
        const page = Number(scalar('page'));
        const binding = handleBindingFor(client, policyScopeFor(config), scalar('queryHash'));
        const state = resultHandles.get<SalesState>(scalar('handle'), binding);
        if (state.kind !== 'sales-report')
          throw new PriorityError('Result handle is not a report detail page.', 400);
        const result = resultHandles.page(scalar('handle'), binding, page, 100);
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({
                ...result,
                meta: salesStateEvidence(state),
                outputComplete: result.nextPage === null,
                consistency: 'multi-observation',
                snapshotConsistent: false,
              }),
            },
          ],
        };
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}
