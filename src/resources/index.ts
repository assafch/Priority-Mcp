import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { parseCsdl } from '../lib/csdl.js';

export function registerAllResources(server: McpServer, client: PriorityClient, config: Config) {
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
    async (uri, variables) => {
      try {
        const raw = variables.entity;
        const entity = String(Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? ''));
        // GetMetadataFor(entity) returns just this form's CSDL (fast) — far cheaper than the full
        // $metadata document, which can take 60–90s and exceed the client timeout.
        const metadata = await client.getMetadataFor<unknown>(entity);
        // Parses CSDL in either representation (Priority answers XML or JSON here).
        const parsed = parseCsdl(metadata, entity);
        const payload =
          parsed ??
          (typeof metadata === 'object' && metadata !== null
            ? metadata
            : { entity, fields: [], note: 'Metadata unavailable or could not be parsed.' });
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
          text: JSON.stringify(
            {
              environment: config.priorityEnvironment,
              company: config.priorityCompany,
              language: config.priorityLanguage,
              apiUrl: config.priorityApiUrl,
              readOnly: config.priorityReadOnly,
            },
            null,
            2,
          ),
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
          text: JSON.stringify(
            {
              username: config.priorityUsername,
              environment: config.priorityEnvironment,
              company: config.priorityCompany,
              language: config.priorityLanguage,
              readOnly: config.priorityReadOnly,
            },
            null,
            2,
          ),
        },
      ],
    }),
  );
}
