import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PriorityClient } from '../src/client/priority-client.js';
import { ResultHandles, handleBindingFor } from '../src/lib/result-handles.js';
import { toolRegistry } from '../src/lib/tool-registry.js';
import { textResult } from '../src/lib/tool-result.js';
import {
  createOperation,
  currentOperation,
  withOperation,
} from '../src/runtime/operation-context.js';
import { createServer } from '../src/server.js';
import { scanObservation } from '../src/services/reports/observations.js';
import { config, logger } from './runtime-fixture.js';
const clients: PriorityClient[] = [];
const backend = (overrides = {}) => {
  const client = new PriorityClient({ ...config, rateLimitPerMinute: 10000, ...overrides }, logger);
  clients.push(client);
  return client;
};
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.restoreAllMocks();
});
async function session(server: McpServer) {
  const client = new Client({ name: 'foundation-fix', version: '1' });
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe('foundation review safeguards', () => {
  it('caps all ordinary cache entries at60s and financial/stock entries at15s including expansions', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ value: [{ CREDIT: 1 }] }));
    const client = backend({ cacheTtlSeconds: 600 });
    for (const [form, query] of [
      ['OBLIGO', undefined],
      ['LOGPART', undefined],
      ['ORDERS', '?$expand=PARTBALANCE_SUBFORM'],
    ]) {
      await client.list(form, query);
      const before = fetch.mock.calls.length;
      now += 15000;
      await client.list(form, query);
      expect(fetch.mock.calls.length).toBe(before + 1);
    }
    await client.list('CUSTOMERS');
    const before = fetch.mock.calls.length;
    now += 60000;
    await client.list('CUSTOMERS');
    expect(fetch.mock.calls.length).toBe(before + 1);
  });

  it('reports original financial observation age on warm payloads and cached report pages', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ value: [{ CREDIT: 1 }] }));
    const client = backend();
    const observedAt = new Date(now).toISOString();
    await withOperation(createOperation('priority_get_customer_balance'), async () =>
      client.list('OBLIGO'),
    );
    now += 5000;
    const result = await withOperation(createOperation('priority_get_customer_balance'), async () =>
      textResult(await client.list('OBLIGO')),
    );
    expect(result.structuredContent).toMatchObject({
      meta: { observedAt, freshness: 'cached', ageMs: 5000, cachedReads: 1, liveReads: 0 },
    });
    const meta = await withOperation(createOperation('priority_get_open_debts'), async () => {
      await client.list('OBLIGO');
      return scanObservation(
        { complete: true, pages: 1, stopReason: 'exhausted' },
        new Date(now).toISOString(),
      );
    });
    expect(meta).toMatchObject({
      observedAt,
      freshness: 'cached',
      firstObservedAt: observedAt,
      ageMs: 5000,
    });
  });

  it('exposes additive true-age metadata through the real legacy balance and stock tools', async () => {
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('PARTBALANCE_SUBFORM')
        ? Response.json({ value: [{ WARHSNAME: 'W1', BALANCE: 5, TBALANCE: 5 }] })
        : Response.json({
            value: [{ CUSTNAME: 'C1', CREDIT: 9, MAX_CREDIT: 100, CREDIT_REST: 91, CODE: 'ILS' }],
          }),
    );
    const priority = backend();
    const s = await session(createServer(config, logger, priority));
    try {
      const first = await s.client.callTool({
        name: 'priority_get_customer_balance',
        arguments: { customerId: 'C1' },
      });
      expect(first.structuredContent).toMatchObject({
        balance: 9,
        creditLimit: 100,
        availableCredit: 91,
        meta: { freshness: 'live', ageMs: 0 },
      });
      now += 3000;
      const warm = await s.client.callTool({
        name: 'priority_get_customer_balance',
        arguments: { customerId: 'C1' },
      });
      expect(warm.structuredContent).toMatchObject({
        balance: 9,
        meta: {
          observedAt: (first.structuredContent as { meta: { observedAt: string } }).meta.observedAt,
          freshness: 'cached',
          ageMs: 3000,
        },
      });
      const stock = await s.client.callTool({
        name: 'priority_get_stock_levels',
        arguments: { productId: 'P1' },
      });
      expect(stock.structuredContent).toMatchObject({
        totalOnHand: 5,
        meta: { freshness: 'live', ageMs: 0 },
      });
      now += 1000;
      const warmStock = await s.client.callTool({
        name: 'priority_get_stock_levels',
        arguments: { productId: 'P1' },
      });
      expect(warmStock.structuredContent).toMatchObject({
        totalOnHand: 5,
        meta: { freshness: 'cached', ageMs: 1000 },
      });
    } finally {
      await s.close();
    }
  });

  it('gives explicit full discovery a120s context and only two heavy attempt slots', async () => {
    const server = new McpServer({ name: 'discovery-context', version: '1' });
    toolRegistry(server, config).tool(
      'priority_list_entities',
      'Read full metadata.',
      {},
      async () =>
        textResult({
          workClass: currentOperation()?.workClass,
          remaining: (currentOperation()?.deadlineAt ?? 0) - Date.now(),
        }),
    );
    const s = await session(server);
    try {
      const result = await s.client.callTool({ name: 'priority_list_entities', arguments: {} });
      expect(result.structuredContent).toMatchObject({ workClass: 'discovery' });
      expect((result.structuredContent as { remaining: number }).remaining).toBeGreaterThan(119000);
    } finally {
      await s.close();
    }
    const fetches: Array<() => void> = [];
    let active = 0;
    let peak = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => fetches.push(resolve));
      active--;
      return new Response('<metadata/>');
    });
    const priority = backend();
    const heavy = new McpServer({ name: 'heavy-discovery', version: '1' });
    toolRegistry(heavy, config).tool(
      'priority_list_entities',
      'Read full metadata.',
      { i: z.number() },
      async (p) =>
        textResult(
          await priority.request('$metadata', undefined, `?$top=${p.i}`, { cache: false }),
        ),
    );
    const h = await session(heavy);
    try {
      const pending = Promise.all(
        [1, 2, 3].map((i) =>
          h.client.callTool({ name: 'priority_list_entities', arguments: { i } }),
        ),
      );
      for (let i = 0; i < 50 && fetches.length < 2; i++) await tick();
      expect(fetches).toHaveLength(2);
      fetches[0]();
      for (let i = 0; i < 50 && fetches.length < 3; i++) await tick();
      fetches[1]();
      fetches[2]?.();
      await pending;
      expect(peak).toBe(2);
    } finally {
      for (const finish of fetches) finish();
      await h.close();
    }
  });

  it('keeps complete risk statements in compact discovery while meeting manifest limits', async () => {
    const s = await session(createServer({ ...config, priorityToolProfile: 'operations' }, logger));
    try {
      const manifest = await s.client.listTools();
      const descriptions = Object.fromEntries(
        manifest.tools.map((tool) => [tool.name, tool.description]),
      );
      expect(descriptions.priority_customer_snapshot).toMatch(/ledger.*not.*bank.*receipt/i);
      expect(descriptions.priority_resolve_entity).toMatch(/absence.*not.*nonexistence/i);
      expect(descriptions.priority_resolve_entity).toMatch(/not.*authoriz.*writ/i);
      expect(descriptions.priority_import_diagnosis).toMatch(
        /missing.*prevent.*financial.*calculation/i,
      );
      expect(manifest.tools.length).toBeLessThanOrEqual(25);
      expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThanOrEqual(40000);
    } finally {
      await s.close();
    }
  });

  it('shares invalidation and write fences across same-data-scope clients without sharing payload caches', async () => {
    let state = 1;
    let releaseWrite!: () => void;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'PATCH') {
        await new Promise<void>((resolve) => {
          releaseWrite = resolve;
        });
        state = 2;
        return Response.json({ CUSTNAME: 'C1' });
      }
      return Response.json({ CUSTNAME: 'C1', state });
    });
    const a = backend({ priorityReadOnly: false });
    const b = backend({ priorityReadOnly: false, priorityToolProfile: 'operations' });
    await a.get('CUSTOMERS', 'C1');
    await b.get('CUSTOMERS', 'C1');
    expect(fetch).toHaveBeenCalledTimes(2);
    const before = b.cacheGeneration();
    const write = a.update('CUSTOMERS', 'C1', { CUSTDES: 'new' });
    for (let i = 0; i < 50 && !releaseWrite; i++) await tick();
    expect(b.cacheGeneration()).toBeGreaterThan(before);
    const during = fetch.mock.calls.length;
    await b.get('CUSTOMERS', 'C1');
    await b.get('CUSTOMERS', 'C1');
    expect(fetch.mock.calls.length).toBe(during + 2);
    releaseWrite();
    await write;
    expect(await b.get('CUSTOMERS', 'C1')).toMatchObject({ state: 2 });
    const after = fetch.mock.calls.length;
    await b.get('CUSTOMERS', 'C1');
    expect(fetch.mock.calls.length).toBe(after);
  });

  it('rejects late cross-client cache writeback after a shared mutation and cleans unused fence leases', async () => {
    let finishOld!: () => void;
    let state = 1;
    let first = true;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      if (init?.method === 'PATCH') {
        state = 2;
        return Response.json({ CUSTNAME: 'C1', state });
      }
      if (first) {
        first = false;
        await new Promise<void>((resolve) => {
          finishOld = resolve;
        });
        return Response.json({ CUSTNAME: 'C1', state: 1 });
      }
      return Response.json({ CUSTNAME: 'C1', state });
    });
    const writer = backend({ priorityReadOnly: false });
    const reader = backend();
    const old = reader.get('CUSTOMERS', 'C1');
    for (let i = 0; i < 50 && !finishOld; i++) await tick();
    await writer.update('CUSTOMERS', 'C1', { CUSTDES: 'new' });
    finishOld();
    expect(await old).toMatchObject({ state: 1 });
    const before = fetch.mock.calls.length;
    expect(await reader.get('CUSTOMERS', 'C1')).toMatchObject({ state: 2 });
    expect(fetch.mock.calls.length).toBe(before + 1);
    const generation = reader.cacheGeneration();
    writer.close();
    const joining = backend();
    expect(joining.cacheGeneration()).toBe(generation);
    reader.close();
    joining.close();
    const fresh = backend();
    expect(fresh.cacheGeneration()).toBe(0);
  });

  it('propagates explicit same-scope invalidation but isolates other credentials and companies', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ value: [] }));
    const a = backend();
    const b = backend({ cacheTtlSeconds: 30 });
    const otherCompany = backend({ priorityCompany: 'other' });
    const otherIdentity = backend({ priorityUsername: 'other-secret' });
    const before = [b, otherCompany, otherIdentity].map((client) => client.cacheGeneration());
    const handles = new ResultHandles();
    const token = handles.create(handleBindingFor(b, 'policy', 'query'), { rows: [1] });
    a.invalidateCache('CUSTOMERS');
    expect(() => handles.get(token as string, handleBindingFor(b, 'policy', 'query'))).toThrow(
      /generation/,
    );
    expect(b.cacheGeneration()).toBeGreaterThan(before[0]);
    expect(otherCompany.cacheGeneration()).toBe(before[1]);
    expect(otherIdentity.cacheGeneration()).toBe(before[2]);
  });
});
