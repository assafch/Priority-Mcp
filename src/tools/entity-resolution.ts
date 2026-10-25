import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { toolAllowed } from '../lib/capabilities.js';
import type { EntityKind } from '../lib/entity-aliases.js';
import { EntityResolver, type ResolverOptions } from '../lib/entity-resolver.js';
import { evidenceSchema } from '../lib/result-contracts.js';
import { textResult } from '../lib/tool-result.js';
import { createOperation, currentOperation } from '../runtime/operation-context.js';

export const resolveEntityResultSchema = z.object({
  query: z.string(),
  status: z.enum(['resolved', 'ambiguous', 'not-found-in-scan']),
  candidates: z.array(
    z.object({
      identity: z.object({
        form: z.string(),
        keys: z.record(z.string(), z.union([z.string(), z.number()])),
      }),
      displayName: z.string(),
      rank: z.number().int().positive(),
      matchReasons: z.array(z.string()),
    }),
  ),
  meta: evidenceSchema.extend({
    stopReason: z.string(),
    verification: z.enum(['verified', 'unavailable', 'denied']),
    scanned: z.number().int().nonnegative().optional(),
  }),
});
/** Component policy is evaluated independently of profile visibility, on every call. */
export function entityResolutionAllowed(config: Config, kind: EntityKind): boolean {
  const plural = kind === 'customer' ? 'customers' : kind === 'supplier' ? 'suppliers' : 'products';
  return (
    toolAllowed(config, 'priority_resolve_entity') &&
    toolAllowed(config, `priority_list_${plural}`) &&
    toolAllowed(config, `priority_get_${kind}`)
  );
}
export function registerEntityResolutionTools(
  server: McpServer,
  client: PriorityClient,
  config: Config,
  options: ResolverOptions = {},
) {
  const resolver = new EntityResolver(client, {
    ...options,
    authorize: (kind) =>
      entityResolutionAllowed(config, kind) && (options.authorize?.(kind) ?? true),
  });
  server.tool(
    'priority_resolve_entity',
    'Resolve an exact customer, supplier or product identifier, verified barcode or reviewed alias. Names return ranked candidates for explicit selection. Incomplete absence is not proof of nonexistence; resolution does not authorize writes.',
    {
      kind: z.enum(['customer', 'supplier', 'product']),
      query: z.string().min(1).max(500),
      limit: z.number().int().min(1).max(5).default(3),
    },
    async (params, extra) => {
      try {
        const active = currentOperation();
        const context =
          active ??
          createOperation('priority_resolve_entity', {
            ...(extra?.signal ? { signal: extra.signal } : {}),
          });
        const result = resolveEntityResultSchema.parse(
          await resolver.resolveEntity(params, context),
        );
        return textResult(result);
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}
