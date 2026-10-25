import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PriorityError, toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { toolAllowed } from '../lib/capabilities.js';
import { connectionInfo } from '../lib/connection-info.js';
import { knowledgeFor } from '../lib/schema-service.js';
import { toolHelp } from '../lib/tool-help.js';
import { createOperation } from '../runtime/operation-context.js';
import { registerResultResources } from './results.js';

export function registerAllResources(server: McpServer, client: PriorityClient, config: Config) {
  registerResultResources(server, client, config);
  // Schema resource TEMPLATE — get schema for any entity. Must be registered via ResourceTemplate:
  // passing the "priority://schema/{entity}" string directly registers a STATIC resource at that
  // literal URI, so {entity} never binds and every real read returns "resource not found".
  server.resource(
    'entity-schema',
    new ResourceTemplate('priority://schema/{entity}', { list: undefined }),
    {
      description: 'JSON schema of a Priority entity — lists all fields and their types.',
      mimeType: 'application/json',
    },
    async (uri, variables, extra) => {
      try {
        if (!toolAllowed(config, 'priority_get_entity_metadata'))
          throw new PriorityError('Metadata dependency is blocked by tool policy.', 403);
        const raw = variables.entity;
        const entity = String(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''));
        const { schema, evidence } = await knowledgeFor(client).schemas.get(
          entity,
          { purpose: 'read' },
          createOperation('schema-resource', {
            workClass: 'discovery',
            signal: extra.signal,
            metrics: client.metrics,
          }),
        );
        const payload = { ...schema, meta: evidence };
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(payload, null, 2),
            },
          ],
        };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.resource(
    'tool-help',
    new ResourceTemplate('priority://tools/{name}', { list: undefined }),
    {
      description:
        'Detailed tool help. Text fallback: priority_get_capabilities with names and view=detail.',
      mimeType: 'text/plain',
    },
    async (uri, variables) => {
      const name = String(variables.name ?? '');
      const help = toolHelp(server, name);
      if (!toolAllowed(config, name) || help === undefined)
        throw new PriorityError('Tool help unavailable under current policy.', 403);
      return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: help }] };
    },
  );

  // Company info resource
  server.resource(
    'company-info',
    'priority://company/info',
    {
      description: 'Current Priority company metadata — environment, company code, language.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(connectionInfo(config), null, 2),
        },
      ],
    }),
  );

  // User profile resource
  server.resource(
    'user-profile',
    'priority://user/profile',
    {
      description: 'Current API user info and connection details.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(connectionInfo(config), null, 2),
        },
      ],
    }),
  );
}
