import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityError } from '../src/client/errors.js';
import type { PriorityClient } from '../src/client/priority-client.js';
import { SchemaService, knowledgeFor } from '../src/lib/schema-service.js';
import { createOperation } from '../src/runtime/operation-context.js';
import { createServer } from '../src/server.js';
import { config, logger } from './runtime-fixture.js';
const xml =
  '<Schema><EntityType Name="CUSTOMERS"><Key><PropertyRef Name="CUSTNAME" /></Key><Property Name="CUSTNAME" Type="Edm.String" /><Property Name="CUSTDES" Type="Edm.String" /></EntityType></Schema>';
const fake = (request: ReturnType<typeof vi.fn>) =>
  ({
    request,
    getMetadataFor: (entity: string) => request(`GetMetadataFor(entity='${entity}')`),
  }) as unknown as PriorityClient;
afterEach(() => vi.useRealTimers());
describe('scoped targeted schema knowledge', () => {
  it('unifies the two schema tools and schema resource on the targeted cache', async () => {
    const request = vi.fn().mockResolvedValue(xml);
    const server = createServer(config, logger, fake(request));
    const client = new Client({ name: 'schema-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const a = await client.callTool({
        name: 'priority_get_entity_schema',
        arguments: { entity: 'CUSTOMERS' },
      });
      const b = await client.callTool({
        name: 'priority_get_entity_metadata',
        arguments: { entity: 'CUSTOMERS' },
      });
      const c = await client.readResource({ uri: 'priority://schema/CUSTOMERS' });
      expect(a.isError).not.toBe(true);
      expect(b.isError).not.toBe(true);
      expect(JSON.parse(c.contents[0].text as string).key).toEqual(['CUSTNAME']);
      expect(request.mock.calls.map((c) => c[0])).toEqual(["GetMetadataFor(entity='CUSTOMERS')"]);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('uses one targeted fetch for concurrent and warm reads without full metadata', async () => {
    const request = vi.fn(async () => xml);
    const service = new SchemaService(fake(request));
    const results = await Promise.all(
      Array.from({ length: 20 }, () => service.get('CUSTOMERS', { purpose: 'read' })),
    );
    expect(results.every((r) => r.schema?.key[0] === 'CUSTNAME')).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe("GetMetadataFor(entity='CUSTOMERS')");
    const warm = await service.get('CUSTOMERS', { purpose: 'read' });
    expect(warm.evidence.freshness).toBe('cached');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('cancels a subscriber without aborting another schema subscriber', async () => {
    let finish!: (value: string) => void;
    const request = vi.fn(
      (_path: unknown, _q: unknown, _body: unknown, options: { signal: AbortSignal }) =>
        new Promise<string>((resolve, reject) => {
          finish = resolve;
          options.signal.addEventListener('abort', () => reject(new Error('backend aborted')));
        }),
    );
    const service = new SchemaService(fake(request));
    const ac = new AbortController();
    const first = service.get(
      'CUSTOMERS',
      { purpose: 'read' },
      createOperation('first', { signal: ac.signal }),
    );
    const rejected = expect(first).rejects.toThrow();
    const second = service.get('CUSTOMERS', { purpose: 'read' }, createOperation('second'));
    ac.abort(new Error('cancelled'));
    finish(xml);
    await rejected;
    expect((await second).schema.key).toEqual(['CUSTNAME']);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('keeps evidence trace IDs local to each caller and rejects cancelled warm reads', async () => {
    const service = new SchemaService(fake(vi.fn().mockResolvedValue(xml)));
    const [a, b] = await Promise.all(
      ['first', 'second'].map((traceId) =>
        service.get('CUSTOMERS', { purpose: 'read' }, createOperation('schema', { traceId })),
      ),
    );
    expect(a.evidence.traceId).toBe('first');
    expect(b.evidence.traceId).toBe('second');
    await expect(
      service.get(
        'CUSTOMERS',
        { purpose: 'read' },
        createOperation('schema', { signal: AbortSignal.abort(new Error('cancelled')) }),
      ),
    ).rejects.toThrow('cancelled');
  });
  it('does not convert authorization failure to unsupported or attempt a full scan', async () => {
    const request = vi.fn().mockRejectedValue(new PriorityError('denied', 403));
    await expect(
      new SchemaService(fake(request)).get('CUSTOMERS', { purpose: 'read', allowFullScan: true }),
    ).rejects.toThrow('denied');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('permits full metadata only after unsupported targeted metadata and explicit opt in', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new PriorityError('not implemented', 501))
      .mockResolvedValue(xml);
    const result = await new SchemaService(fake(request)).get('CUSTOMERS', {
      purpose: 'read',
      allowFullScan: true,
    });
    expect(result.schema?.fields).toHaveLength(2);
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      "GetMetadataFor(entity='CUSTOMERS')",
      '$metadata',
    ]);
  });
  it('labels stale read hints and requires a refreshed schema before writing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    const request = vi.fn().mockResolvedValue(xml);
    const service = new SchemaService(fake(request));
    await service.get('CUSTOMERS', { purpose: 'read' });
    vi.advanceTimersByTime(3600001);
    request.mockRejectedValue(new PriorityError('timeout', 408));
    const stale = await service.get('CUSTOMERS', { purpose: 'read' });
    expect(stale.evidence.freshness).toBe('stale');
    await expect(service.get('CUSTOMERS', { purpose: 'write' })).rejects.toThrow('timeout');
    vi.advanceTimersByTime(86400000);
    await expect(service.get('CUSTOMERS', { purpose: 'read' })).rejects.toThrow('timeout');
  });
  it('is shared by one client and isolated across another authenticated client', async () => {
    const a = fake(vi.fn().mockResolvedValue(xml));
    const b = fake(vi.fn().mockRejectedValue(new PriorityError('denied', 403)));
    expect(knowledgeFor(a)).toBe(knowledgeFor(a));
    expect(knowledgeFor(a)).not.toBe(knowledgeFor(b));
    await knowledgeFor(a).schemas.get('CUSTOMERS', { purpose: 'read' });
    await expect(knowledgeFor(b).schemas.get('CUSTOMERS', { purpose: 'read' })).rejects.toThrow();
  });
  it('does not claim an empty or malformed document is a complete schema', async () => {
    await expect(
      new SchemaService(fake(vi.fn().mockResolvedValue('<oops/>'))).get('CUSTOMERS', {
        purpose: 'read',
      }),
    ).rejects.toThrow(/schema/i);
  });
});

it('blocks schema resource access through explicit metadata policy even with a warm schema', async () => {
  const request = vi.fn().mockResolvedValue(xml);
  const backend = fake(request);
  await knowledgeFor(backend).schemas.get('CUSTOMERS', { purpose: 'read' });
  const server = createServer(
    {
      ...config,
      priorityBlockedTools: ['priority_get_entity_metadata', 'priority_get_entity_schema'],
    },
    logger,
    backend,
  );
  const client = new Client({ name: 'policy-schema', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    await expect(client.readResource({ uri: 'priority://schema/CUSTOMERS' })).rejects.toThrow(
      /policy/i,
    );
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    await client.close();
    await server.close();
  }
});
