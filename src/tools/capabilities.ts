import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { CapabilityCatalog } from '../lib/capabilities.js';
import { toolHelp } from '../lib/tool-help.js';
import { textResult } from '../lib/tool-result.js';

export function registerCapabilityTools(server: McpServer, client: PriorityClient, config: Config) {
  const catalog = new CapabilityCatalog(client, config);
  server.tool(
    'priority_get_capabilities',
    'List implemented, unavailable and guide-only tools, policy state and dated form-readability evidence. No backend call unless refresh=true. Refresh checks only this page and never enables tools.',
    {
      domain: z.string().optional(),
      names: z.array(z.string()).max(25).optional(),
      view: z.enum(['summary', 'detail']).default('detail'),
      forceRefresh: z.boolean().default(false),
      includeUnavailable: z.boolean().default(true),
      refresh: z.boolean().default(false),
      top: z.number().int().min(1).max(100).default(25),
      skip: z.number().int().min(0).default(0),
    },
    async (p) => {
      const list = () =>
        catalog
          .list(p.domain, p.includeUnavailable)
          .filter((d) => !p.names || p.names.includes(d.name));
      let all = list();
      if (p.refresh) {
        await catalog.refresh(all.slice(p.skip, p.skip + p.top), p.forceRefresh);
        all = list();
      }
      const capabilities = all.slice(p.skip, p.skip + p.top).map((d) =>
        p.view === 'summary'
          ? {
              name: d.name,
              mode: d.mode,
              implementation: d.implementation,
              access: d.access,
              availability: d.availability,
              checkedAt: d.checkedAt,
              evidence: d.evidence,
            }
          : p.names
            ? { ...d, help: toolHelp(server, d.name) }
            : d,
      );
      return textResult(
        {
          capabilities,
          skip: p.skip,
          total: all.length,
          returned: capabilities.length,
          nextSkip: p.skip + capabilities.length < all.length ? p.skip + capabilities.length : null,
          serverReadOnly: config.priorityReadOnly,
          meta: {
            schemaVersion: 1,
            source: 'capability-catalog',
            observedAt: new Date().toISOString(),
            complete: p.skip === 0 && capabilities.length === all.length,
            warnings: ['Live read evidence does not prove writes or business completion.'],
          },
        },
        p.view === 'summary' ? 8000 : 24000,
      );
    },
  );
  server.tool(
    'priority_healthcheck',
    'Check local MCP configuration and optionally perform one bounded read-only Priority connectivity probe. Returns no credentials or business data. checkBackend=false by default.',
    { checkBackend: z.boolean().default(false), diagnostics: z.boolean().default(false) },
    async (p) => {
      let backend: 'not-checked' | 'reachable' | 'failed' = 'not-checked';
      if (p.checkBackend) {
        try {
          await client.request('GetLoginName()', undefined, undefined, { cache: false });
          backend = 'reachable';
        } catch {
          backend = 'failed';
        }
      }
      return textResult({
        ok: backend !== 'failed',
        backend,
        serverReadOnly: config.priorityReadOnly,
        registeredDefinitions: catalog.list().length,
        ...(p.diagnostics ? { diagnostics: client.metrics.snapshot() } : {}),
        meta: {
          schemaVersion: 1,
          source: 'healthcheck',
          observedAt: new Date().toISOString(),
          complete: p.checkBackend,
          warnings:
            backend === 'failed'
              ? [
                  'Backend read failed; inspect configured authentication and connectivity. No mutation attempted.',
                ]
              : [],
        },
      });
    },
  );
}
