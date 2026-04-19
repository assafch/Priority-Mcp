import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import { toMcpError } from '../client/errors.js';
import type { Config } from '../config.js';

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerMetaTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_entities',
    `List all available entities (tables/forms) in this Priority instance.

Use for discoverability — see what data is available. Returns entity names from the OData $metadata.
Useful when exploring the API or when the AI needs to find the right entity for a query.`,
    {},
    async () => {
      try {
        const result = await client.request<string>('$metadata', undefined, undefined, { cache: true });
        // $metadata returns XML — extract entity names
        const entityNames = [...String(result).matchAll(/EntityType Name="([^"]+)"/g)].map((m) => m[1]);
        return textResult({ entities: entityNames, count: entityNames.length });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_entity_schema',
    `Get the field list and types for a specific entity.

Returns all fields with their data types. Essential for building dynamic queries.
Example: priority_get_entity_schema({ entity: "CUSTOMERS" }) → shows all customer fields.`,
    {
      entity: z.string().min(1).describe('Entity name (e.g. "CUSTOMERS", "ORDERS")'),
    },
    async (params) => {
      try {
        const result = await client.request<string>('$metadata', undefined, undefined, { cache: true });
        const xml = String(result);
        // Extract the specific entity type definition
        const regex = new RegExp(`<EntityType Name="${params.entity}"[^>]*>([\\s\\S]*?)</EntityType>`);
        const match = xml.match(regex);
        if (!match) {
          return textResult({ error: `Entity "${params.entity}" not found. Use priority_list_entities to see available entities.` });
        }
        // Extract properties
        const props = [...match[1].matchAll(/Property Name="([^"]+)"[^>]*Type="([^"]+)"/g)]
          .map((m) => ({ name: m[1], type: m[2] }));
        return textResult({ entity: params.entity, fields: props, fieldCount: props.length });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_list_companies',
    `List all companies available in this Priority environment.

Useful for multi-company setups to see which company databases are accessible.`,
    {},
    async () => {
      try {
        const result = await client.list('COMPANIES', '?$top=100');
        return textResult({ companies: result.value });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_get_current_user',
    `Get information about the currently authenticated API user.`,
    {},
    async () => {
      try {
        return textResult({
          environment: config.priorityEnvironment,
          company: config.priorityCompany,
          language: config.priorityLanguage,
          readOnly: config.priorityReadOnly,
        });
      } catch (err) { throw toMcpError(err); }
    },
  );

  server.tool(
    'priority_execute_odata_query',
    `Execute a raw OData query against any Priority entity.

⚠️ POWER USER TOOL — use with caution. Allows running arbitrary OData queries.
Only use this when the pre-built tools don't cover your use case.
The entity and query string are passed directly to the Priority OData API.

Example: entity="CUSTOMERS", query="?$filter=CUSTBALANCE gt 5000&$select=CUSTNAME,CUSTDES&$top=10"`,
    {
      entity: z.string().min(1).describe('Entity name (e.g. "CUSTOMERS")'),
      query: z.string().optional().describe('OData query string (e.g. "?$filter=...&$select=...")'),
      key: z.string().optional().describe('Entity key for single-record fetch'),
    },
    async (params) => {
      try {
        if (params.key) {
          const result = await client.get(params.entity, params.key, params.query);
          return textResult(result);
        }
        const result = await client.list(params.entity, params.query);
        return textResult({ value: result.value, count: result.value.length });
      } catch (err) { throw toMcpError(err); }
    },
  );
}
