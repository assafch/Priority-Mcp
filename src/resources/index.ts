import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { toMcpError } from '../client/errors.js';

export function registerAllResources(server: McpServer, client: PriorityClient, config: Config) {
  // Schema resource template — get schema for any entity
  server.resource(
    'entity-schema',
    'priority://schema/{entity}',
    {
      description: 'JSON schema of a Priority entity — lists all fields and their types.',
      mimeType: 'application/json',
    },
    async (uri, _params) => {
      try {
        const entity = uri.pathname.split('/').pop() ?? '';
        const metadata = await client.request<string>('$metadata', undefined, undefined, { cache: true });
        const xml = String(metadata);
        const regex = new RegExp(`<EntityType Name="${entity}"[^>]*>([\\s\\S]*?)</EntityType>`);
        const match = xml.match(regex);
        const fields = match
          ? [...match[1].matchAll(/Property Name="([^"]+)"[^>]*Type="([^"]+)"/g)].map((m) => ({ name: m[1], type: m[2] }))
          : [];
        return {
          contents: [{
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ entity, fields, fieldCount: fields.length }, null, 2),
          }],
        };
      } catch (err) { throw toMcpError(err); }
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
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          environment: config.priorityEnvironment,
          company: config.priorityCompany,
          language: config.priorityLanguage,
          apiUrl: config.priorityApiUrl,
          readOnly: config.priorityReadOnly,
        }, null, 2),
      }],
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
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          username: config.priorityUsername,
          environment: config.priorityEnvironment,
          company: config.priorityCompany,
          language: config.priorityLanguage,
          readOnly: config.priorityReadOnly,
        }, null, 2),
      }],
    }),
  );
}
