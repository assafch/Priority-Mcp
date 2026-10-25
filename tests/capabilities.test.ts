import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createServer } from '../src/server.js';
const config = {
  priorityServiceRoot: 'https://example.invalid/odata/Priority/offline/demo',
  priorityPat: 'synthetic',
  priorityReadOnly: true,
  priorityCompany: 'demo',
  priorityEnvironment: 'offline',
  priorityLanguage: 'EN',
  priorityCustomEntities: [],
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 120,
  requestTimeoutMs: 1000,
  logLevel: 'error',
  mcpTransport: 'stdio',
  mcpHttpPort: 3000,
  mcpHttpHost: '127.0.0.1',
} as Config;
async function session(overrides: Partial<Config> = {}) {
  const cfg = { ...config, ...overrides };
  const server = createServer(cfg, createLogger(cfg));
  const client = new Client({ name: 'capability-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
describe('capability-aware protocol', () => {
  it('lists every legacy tool with risk metadata and output schema without backend calls', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network'));
    const s = await session();
    try {
      const { tools } = await s.client.listTools();
      expect(tools.length).toBeGreaterThanOrEqual(104);
      expect(tools.every((t) => t.annotations && t.outputSchema)).toBe(true);
      expect(
        tools.find((t) => t.name === 'impfile_run_calc_guide')?.annotations?.readOnlyHint,
      ).toBe(true);
      expect(
        tools.find((t) => t.name === 'priority_create_record')?.annotations?.readOnlyHint,
      ).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await s.close();
      fetch.mockRestore();
    }
  });
  it('returns dated truthful unavailable and policy states as structured JSON', async () => {
    const s = await session({ priorityBlockedTools: ['priority_void_invoice'] });
    try {
      const r = await s.client.callTool({
        name: 'priority_get_capabilities',
        arguments: { domain: 'invoices', top: 100 },
      });
      const data = r.structuredContent as {
        capabilities: Array<Record<string, unknown>>;
        meta: { complete: boolean };
      };
      expect(data).toBeDefined();
      expect(data.capabilities.find((x) => x.name === 'priority_void_invoice')).toMatchObject({
        implementation: 'unavailable',
        access: 'blocked',
        evidence: 'static',
      });
      expect(data.meta.complete).toBe(true);
      expect(JSON.parse((r.content as Array<{ text: string }>)[0].text)).toEqual(data);
    } finally {
      await s.close();
    }
  });
  it('keeps preview results valid under the declared output schema', async () => {
    const s = await session();
    try {
      const r = await s.client.callTool({
        name: 'priority_create_record',
        arguments: { form: 'CUSTOMERS', data: { CUSTNAME: 'synthetic' } },
      });
      expect(r.isError).not.toBe(true);
      expect(r.structuredContent).toMatchObject({ dryRun: true });
    } finally {
      await s.close();
    }
  });
  it('prompts begin with capability checks and avoid mandatory unsupported aging calls', async () => {
    const s = await session();
    try {
      const r = await s.client.getPrompt({
        name: 'debt_collection_workflow',
        arguments: { customerId: 'synthetic' },
      });
      const text = JSON.stringify(r);
      expect(text).toContain('priority_get_capabilities');
      expect(text).toContain('priority_get_unpaid_invoices_for_customer');
      expect(text).not.toContain('Call priority_get_customer_aging');
    } finally {
      await s.close();
    }
  });
});

it('pages the complete catalog without skipping names even when a page is size-limited', async () => {
  const s = await session();
  try {
    const names: string[] = [];
    let skip: number | null = 0;
    for (let i = 0; i < 20 && skip !== null; i++) {
      const r = await s.client.callTool({
        name: 'priority_get_capabilities',
        arguments: { top: 100, skip },
      });
      const d = r.structuredContent as {
        capabilities: Array<{ name: string }>;
        returned: number;
        nextSkip: number | null;
      };
      expect(d.returned).toBe(d.capabilities.length);
      names.push(...d.capabilities.map((x) => x.name));
      skip = d.nextSkip;
    }
    expect(skip).toBeNull();
    const { tools } = await s.client.listTools();
    expect(new Set(names).size).toBe(names.length);
    expect(names.sort()).toEqual(tools.map((x) => x.name).sort());
  } finally {
    await s.close();
  }
});

it('bounds named summary discovery without skipping catalog entries', async () => {
  const s = await session();
  try {
    const names: string[] = [];
    let skip: number | null = 0;
    while (skip !== null) {
      const result = await s.client.callTool({
        name: 'priority_get_capabilities',
        arguments: { view: 'summary', top: 100, skip },
      });
      const content = result.content as Array<{ text: string }>;
      expect(content[0].text.length).toBeLessThanOrEqual(8000);
      const payload = result.structuredContent as {
        capabilities: Array<{ name: string }>;
        returned: number;
        nextSkip: number | null;
      };
      expect(payload.returned).toBe(payload.capabilities.length);
      names.push(...payload.capabilities.map((x) => x.name));
      skip = payload.nextSkip;
      expect(names.length).toBeLessThan(500);
    }
    expect(names.sort()).toEqual((await s.client.listTools()).tools.map((x) => x.name).sort());
  } finally {
    await s.close();
  }
});
