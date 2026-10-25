import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../src/config.js';
import { createOperation, withOperation } from '../src/runtime/operation-context.js';
import { registerCustomerTools } from '../src/tools/customers.js';
import { registerProductTools } from '../src/tools/products.js';
import { registerSupplierTools } from '../src/tools/suppliers.js';

import { beforeEach, describe, expect, it } from 'vitest';
import { PriorityError } from '../src/client/errors.js';
import type { PriorityClient } from '../src/client/priority-client.js';
import { _resetStringFnSupport, searchForm } from '../src/lib/search.js';

type Row = { CUSTNAME: string; CUSTDES: string };
function backend(
  opts: { native?: boolean; links?: boolean; total?: number; serverPage?: number } = {},
) {
  const rows = Array.from({ length: opts.total ?? 300 }, (_, i) => ({
    CUSTNAME: String(i),
    CUSTDES: opts.native ? `needle ${i}` : i === 250 ? 'needle' : `row ${i}`,
  }));
  const calls: string[] = [];
  const page = async (query: string, native: boolean) => {
    const q = new URLSearchParams(query.replace(/^\?/, ''));
    const skip = Number(q.get('$skip') ?? 0);
    const top = Math.min(Number(q.get('$top') ?? 500), opts.serverPage ?? 100);
    const source = native ? rows.filter((r) => r.CUSTDES.includes('needle')) : rows;
    return {
      value: source.slice(skip, skip + top),
      ...(opts.links && skip + top < source.length
        ? { '@odata.nextLink': `CUSTOMERS?$skip=${skip + top}&$top=${top}` }
        : {}),
    };
  };
  const client = {
    list: async (_form: string, query = '') => {
      calls.push(decodeURIComponent(query));
      const native = decodeURIComponent(query).includes('contains(');
      if (native && !opts.native) throw new PriorityError('contains is not supported', 501);
      return page(query, native);
    },
    listNext: async (link: string) => {
      calls.push(link);
      return page(link.slice(link.indexOf('?')), Boolean(opts.native));
    },
  } as unknown as PriorityClient;
  return { client, calls };
}
const options = { form: 'CUSTOMERS', query: 'needle', fields: ['CUSTDES'], top: 500 };

describe('search continuation and completeness', () => {
  beforeEach(_resetStringFnSupport);
  for (const links of [true, false]) {
    it(`finds row 250 through short fallback pages ${links ? 'with links' : 'using actual offsets'}`, async () => {
      const { client, calls } = backend({ links });
      const result = await searchForm<Row>(client, options);
      expect(result.value).toEqual([{ CUSTNAME: '250', CUSTDES: 'needle' }]);
      expect(result.meta).toMatchObject({
        scanned: 300,
        complete: true,
        stopReason: 'exhausted',
        nextCursor: null,
      });
      expect(calls).toHaveLength(5);
    });
    it(`preserves native short-page continuation ${links ? 'with links' : 'without links'}`, async () => {
      const { client } = backend({ native: true, links });
      const result = await searchForm<Row>(client, options);
      expect(result.value).toHaveLength(300);
      expect(result.value[250].CUSTNAME).toBe('250');
      expect(result.meta).toMatchObject({ complete: true, truncated: false, nextCursor: null });
    });
  }
  it('never scans or returns more than an exact 600-row cap when the backend ignores top', async () => {
    const { client } = backend({ total: 1000, serverPage: 1000 });
    client.list = async (_form, query = '') => {
      if (decodeURIComponent(query).includes('contains('))
        throw new PriorityError('unsupported', 501);
      return {
        value: Array.from({ length: 1000 }, (_, i) => ({ CUSTNAME: String(i), CUSTDES: 'needle' })),
      };
    };
    const result = await searchForm(client, { ...options, top: 1000, scanCap: 600 });
    expect(result.value).toHaveLength(600);
    expect(result.meta).toMatchObject({
      scanned: 600,
      scanCapped: true,
      complete: false,
      stopReason: 'maxRows',
      nextCursor: null,
    });
  });
  it('does not claim completion on a continuation loop', async () => {
    const { client } = backend({ native: true });
    client.list = async () => ({
      value: [{ CUSTNAME: '1', CUSTDES: 'needle' }],
      '@odata.nextLink': 'CUSTOMERS?$skiptoken=loop',
    });
    client.listNext = client.list as unknown as PriorityClient['listNext'];
    const result = await searchForm(client, options);
    expect(result.meta).toMatchObject({
      complete: false,
      stopReason: 'continuationLoop',
      nextCursor: null,
    });
  });
  it('does not claim completion when the client cannot follow a link', async () => {
    const client = {
      list: async () => ({
        value: [{ CUSTNAME: '1', CUSTDES: 'needle' }],
        '@odata.nextLink': 'CUSTOMERS?$skiptoken=next',
      }),
    } as unknown as PriorityClient;
    const result = await searchForm(client, options);
    expect(result.meta).toMatchObject({ complete: false, stopReason: 'continuationUnavailable' });
  });
  it('appends every key to sorting and includes match/key fields in projection', async () => {
    const { client, calls } = backend();
    await searchForm(client, {
      ...options,
      form: 'CUSTOMERS',
      select: ['CUSTDES'],
      orderby: 'CUSTDES desc, REGION asc',
      keyFields: ['CUSTNAME', 'BRANCH'],
      baseFilter: "ACTIVE eq 'Y'",
    });
    for (const query of calls) {
      expect(query).toContain('$orderby=CUSTDES desc,REGION asc,CUSTNAME asc,BRANCH asc');
      expect(query).toContain('$select=CUSTDES,CUSTNAME,BRANCH');
      expect(query).toContain("ACTIVE eq 'Y'");
    }
  });
  it('returns a cancelled boundary without starting a backend request', async () => {
    const { client, calls } = backend();
    const controller = new AbortController();
    controller.abort();
    const result = await searchForm(client, { ...options, signal: controller.signal });
    expect(result.meta).toMatchObject({
      complete: false,
      stopReason: 'cancelled',
      nextCursor: null,
    });
    expect(calls).toHaveLength(0);
  });
  it('returns an expired deadline boundary without starting a backend request', async () => {
    const { client, calls } = backend();
    const result = await searchForm(client, { ...options, deadlineAt: Date.now() - 1 });
    expect(result.meta).toMatchObject({
      complete: false,
      stopReason: 'deadline',
      nextCursor: null,
    });
    expect(calls).toHaveLength(0);
  });
  it('cancels an in-flight read and returns the scanned boundary', async () => {
    const controller = new AbortController();
    const client = {
      list: async (_form: string, _query: string, opts: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(opts.signal?.reason), { once: true });
          controller.abort();
        }),
    } as unknown as PriorityClient;
    const result = await searchForm(client, { ...options, signal: controller.signal });
    expect(result.meta).toMatchObject({ complete: false, stopReason: 'cancelled' });
  });
  it('does not call a response exhausted when cancellation races with body completion', async () => {
    const controller = new AbortController();
    const client = {
      list: async () => {
        controller.abort();
        return { value: [] };
      },
    } as unknown as PriorityClient;
    const result = await searchForm(client, { ...options, signal: controller.signal });
    expect(result.value).toEqual([]);
    expect(result.meta).toMatchObject({ complete: false, stopReason: 'cancelled' });
  });
  it('rejects cursor input until scoped server-owned handles exist', async () => {
    const { client, calls } = backend();
    await expect(
      searchForm(client, { ...options, cursor: 'https://evil.test/rows' }),
    ).rejects.toThrow(/cursor|resum/i);
    expect(calls).toHaveLength(0);
  });
});

it('every master search tool propagates request cancellation and operation deadlines', async () => {
  const { client, calls } = backend();
  type Handler = (
    params: Record<string, unknown>,
    extra?: { signal: AbortSignal },
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: Handler) =>
      handlers.set(name, handler),
  } as unknown as McpServer;
  registerCustomerTools(server, client, {} as Config);
  registerProductTools(server, client, {} as Config);
  registerSupplierTools(server, client);
  for (const kind of ['customers', 'products', 'suppliers']) {
    for (const action of ['list', 'search']) {
      const name = `priority_${action}_${kind}`;
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Missing ${name}`);
      const params = {
        query: 'needle',
        search: 'needle',
        top: 20,
        skip: 0,
        orderBy: kind === 'products' ? 'PARTDES' : 'CUSTDES',
        orderDir: 'desc',
      };
      const controller = new AbortController();
      controller.abort();
      const cancelled = await handler(params, { signal: controller.signal });
      expect(JSON.parse(cancelled.content[0].text ?? '').search).toMatchObject({
        complete: false,
        stopReason: 'cancelled',
      });
      const expired = await withOperation(
        createOperation(name, { deadlineAt: Date.now() - 1 }),
        () => handler(params),
      );
      expect(JSON.parse(expired.content[0].text ?? '').search).toMatchObject({
        complete: false,
        stopReason: 'deadline',
        nextCursor: null,
      });
    }
  }
  expect(calls).toHaveLength(0);
});
