import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { csdlEntityNames } from '../lib/csdl.js';
import { filterForms, probeForm } from '../lib/forms.js';
import { knowledgeFor } from '../lib/schema-service.js';
import { textResult } from '../lib/write-guard.js';

/**
 * Fetch the $metadata CSDL document, in whichever representation Priority feels like sending.
 *
 * The same request alternates between CSDL **XML** (~10MB) and CSDL **JSON**
 * (`application/json; odata.metadata=minimal`, ~7MB) — verified live on 2026-07-29 across
 * consecutive calls. Because the client parses a json content-type, the JSON case arrived as an
 * OBJECT; the old `String(result)` regex then found nothing and reported "0 entity types" — a
 * confident wrong answer. Return the payload as-is and let the format-agnostic CSDL parsers
 * handle both, failing loudly only when it is neither.
 */
async function fetchMetadata(client: PriorityClient): Promise<unknown> {
  // One retry: on top of the format flip, a heavy metadata request occasionally comes back empty.
  // An empty 200 is never cached, so the second attempt really re-fetches.
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await client.request<unknown>('$metadata', undefined, undefined, { cache: true });
    if (csdlEntityNames(raw)?.length) return raw;
    if (attempt === 0) await new Promise((r) => setTimeout(r, 2000));
  }
  throw new McpError(
    ErrorCode.InternalError,
    'Priority returned a $metadata document containing no entity types, twice. This document is 7-10MB on this installation and the endpoint intermittently answers with an empty body while a previous metadata request is still being served. Retry shortly, or use priority_list_forms (the service document — much smaller) if you only need the forms this installation exposes.',
  );
}

export function registerMetaTools(server: McpServer, client: PriorityClient, config: Config) {
  server.tool(
    'priority_list_entities',
    `List the entity TYPES declared in this Priority instance's $metadata, filtered at the source.

Prefer priority_list_forms for "what can I query?" — it reads the service document, which is what
the API actually exposes. This tool reads $metadata, which also contains every SUB-FORM type
(~3000 types here vs. ~1370 forms), so it is the right tool for "what is this sub-form called?".

ALWAYS pass 'prefix' or 'contains': the unfiltered list is thousands of names long and gets
truncated to fit the result budget. Matching is case-insensitive.`,
    {
      prefix: z
        .string()
        .optional()
        .describe('Only types whose name starts with this (case-insensitive), e.g. "IMPFILE"'),
      contains: z
        .string()
        .optional()
        .describe('Only types whose name contains this (case-insensitive), e.g. "EXTFILE"'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Max entity names to return (default 100)'),
    },
    async (params) => {
      try {
        // Works against either representation ($metadata flips between CSDL XML and CSDL JSON).
        const entityNames = csdlEntityNames(await fetchMetadata(client)) ?? [];
        const { matches, total, matched, truncated } = filterForms(
          entityNames.map((name) => ({ name })),
          params,
        );
        return textResult({
          entities: matches.map((m) => m.name),
          returned: matches.length,
          matched,
          totalEntityTypes: total,
          filter: { prefix: params.prefix ?? null, contains: params.contains ?? null },
          ...(truncated
            ? {
                truncated: `${matched} types matched; showing ${matches.length}. Raise 'limit' or narrow 'prefix'/'contains'.`,
              }
            : {}),
          note: 'These are $metadata entity TYPES (including sub-form types), not necessarily queryable forms. Use priority_list_forms to see the entity sets this installation exposes.',
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_entity_schema',
    `Get the field list and types for a specific entity.

Returns all fields with their data types. Essential for building dynamic queries.
Example: priority_get_entity_schema({ entity: "CUSTOMERS" }) → shows all customer fields.`,
    {
      entity: z.string().min(1).describe('Entity name (e.g. "CUSTOMERS", "ORDERS")'),
      refresh: z.boolean().default(false),
      allowFullScan: z
        .boolean()
        .default(false)
        .describe('Allow expensive full metadata only if targeted metadata is unsupported.'),
    },
    async (params) => {
      try {
        const { schema: parsed, evidence } = await knowledgeFor(client).schemas.get(params.entity, {
          purpose: 'read',
          force: params.refresh,
          allowFullScan: params.allowFullScan,
        });
        return textResult({
          entity: parsed.entity,
          title: parsed.title ?? null,
          key: parsed.key,
          fieldCount: parsed.fieldCount,
          fields: parsed.fields,
          subforms: parsed.subforms,
          meta: evidence,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_list_companies',
    `List the companies (company databases) available in this Priority environment.

Reads the COMPANIES form. If that form's "Available for API" flag is off, this reports exactly
that — naming the form an admin has to enable — instead of failing opaquely.`,
    {},
    async () => {
      try {
        const probe = await probeForm(
          client,
          'COMPANIES',
          '?$select=COMPANYNAME,COMPANYDES,WTAXNUM,VATNUM&$top=100',
        );
        if (probe.status !== 'ok') {
          return textResult({
            available: false,
            form: 'COMPANIES',
            status: probe.status,
            reason: probe.detail,
            configuredCompany: config.priorityCompany,
            suggestion:
              probe.status === 'api-flag-off'
                ? 'Ask a Priority admin to tick "Available for API" for the COMPANIES form (חברות) in the API/Limited-Access Forms screen. The company this server is bound to is PRIORITY_COMPANY and is reported by priority_get_current_user.'
                : 'This installation does not expose a companies form; the company this server is bound to is PRIORITY_COMPANY (see priority_get_current_user).',
          });
        }
        const result = await client.list(
          'COMPANIES',
          '?$select=COMPANYNAME,COMPANYDES,WTAXNUM,VATNUM&$top=100',
        );
        return textResult({ available: true, companies: result.value });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_current_user',
    `Report who this server is connected to Priority as, and how it is configured.

Includes the Priority-side identity (from the OData GetTenantDetails / GetLoginName functions) and
this server's own settings — notably serverReadOnly, which is a setting of THIS MCP SERVER, not a
Priority permission.`,
    {},
    async () => {
      // Priority-side identity. These functions exist from Priority 25.x; if they are missing we
      // still report the server-side configuration rather than failing the whole call.
      let tenant: Record<string, unknown> | undefined;
      let loginName: string | undefined;
      try {
        tenant = await client.request<Record<string, unknown>>('GetTenantDetails()');
      } catch {
        /* older Priority: function not available */
      }
      try {
        const raw = await client.request<unknown>('GetLoginName()');
        loginName =
          typeof raw === 'string'
            ? raw
            : ((raw as Record<string, unknown> | undefined)?.value as string | undefined);
      } catch {
        /* older Priority: function not available */
      }

      return textResult({
        priorityUser: {
          userName: tenant?.userName ?? loginName ?? null,
          company: tenant?.company ?? config.priorityCompany ?? null,
          environment: tenant?.tabini ?? config.priorityEnvironment,
          tenantId: tenant?.tenantID ?? null,
          hosted: tenant?.hosting ?? null,
          source: tenant ? 'GetTenantDetails()' : loginName ? 'GetLoginName()' : 'configuration',
        },
        serverConfig: {
          environment: config.priorityEnvironment,
          company: config.priorityCompany,
          language: config.priorityLanguage,
          // Renamed from `readOnly`: this is THIS SERVER's write switch, not a Priority-side
          // permission. Callers used to read it as "my Priority user lacks write access" and go
          // hunting for a Priority admin.
          serverReadOnly: config.priorityReadOnly,
          serverReadOnlyMeans: config.priorityReadOnly
            ? 'This MCP server refuses all writes (PRIORITY_READ_ONLY). It says NOTHING about what your Priority user is allowed to do. To enable writes: set PRIORITY_READ_ONLY=false in .env AND RESTART THE MCP HOST — the server is launched with --env-file-if-exists, so an edited .env is not picked up until the process restarts. Dry-run previews (dryRun=true / confirm=false) keep working while read-only.'
            : 'This MCP server permits writes; each write tool still requires an explicit dryRun=false / confirm=true. Priority-side permissions apply on top of this.',
        },
      });
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
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
