import { Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityClient } from '../src/client/priority-client.js';
import { createLogger } from '../src/logger.js';
import { MetricsCollector, metricsSnapshot, recordMetric } from '../src/runtime/metrics.js';
import {
  createOperation,
  currentOperation,
  withOperation,
} from '../src/runtime/operation-context.js';
import { createServer } from '../src/server.js';
import { config, logger } from './runtime-fixture.js';

afterEach(() => vi.restoreAllMocks());

describe('local operation measurements', () => {
  it('isolates nested and concurrent operation contexts without retaining request history', async () => {
    const a = createOperation('priority_healthcheck');
    const b = createOperation('priority_list_customers');
    expect(a.traceId).not.toBe(b.traceId);
    await Promise.all(
      [a, b].map((ctx) =>
        withOperation(ctx, async () => {
          await Promise.resolve();
          expect(currentOperation()).toBe(ctx);
          await withOperation(createOperation('priority_get_capabilities'), async () => {
            expect(currentOperation()?.traceId).not.toBe(ctx.traceId);
          });
          expect(currentOperation()).toBe(ctx);
        }),
      ),
    );
    expect(currentOperation()).toBeUndefined();
  });

  it('bounds form buckets and drops arbitrary strings and request parameters', async () => {
    const metrics = new MetricsCollector();
    await withOperation(createOperation('priority_healthcheck', { metrics }), async () => {
      for (let i = 0; i < 1000; i++)
        recordMetric({
          form: `CUSTOM_${i}`,
          phase: 'network',
          durationMs: 3,
          bytes: 7,
          outcome: 'ok',
        });
      recordMetric({
        form: "CUSTOMERS('Secret Customer')?$filter=PAT",
        tool: 'synthetic-PAT-secret',
        phase: 'network',
        durationMs: 2,
      });
      const snapshot = metricsSnapshot();
      expect(new Set(snapshot.buckets.map((b) => b.form)).size).toBeLessThanOrEqual(257);
      expect(snapshot.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1001);
      const serialized = JSON.stringify(snapshot);
      for (const secret of ['Secret Customer', '$filter', 'synthetic-PAT-secret', 'CUSTOM_999'])
        expect(serialized).not.toContain(secret);
    });
  });

  it('sums numeric row/page values without retaining rows or allowing invalid measurements', () => {
    const collector = new MetricsCollector();
    collector.record({ phase: 'rows', value: 3 });
    collector.record({ phase: 'rows', value: 2 });
    collector.record({
      phase: 'rows',
      value: Number.NaN,
      bytes: Number.POSITIVE_INFINITY,
      durationMs: -1,
    });
    expect(collector.snapshot().buckets[0]).toMatchObject({
      count: 3,
      value: 5,
      bytes: 0,
      durationMs: 0,
    });
  });

  it('bounds total series and returns detached snapshots without a global collector', () => {
    const collector = new MetricsCollector();
    const names = ['priority_get_customer', 'priority_list_customers', 'priority_healthcheck'];
    const phases = [
      'tool',
      'queue',
      'network',
      'retry',
      'cache',
      'parse',
      'serialization',
      'rows',
      'pages',
    ] as const;
    for (let i = 0; i < 100; i++)
      for (const tool of names)
        for (const phase of phases) collector.record({ form: `FORM_${i}`, tool, phase });
    const snapshot = collector.snapshot();
    expect(snapshot.buckets.length).toBeLessThanOrEqual(2049);
    expect(snapshot.overflowed).toBe(true);
    expect(snapshot.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(2700);
    snapshot.buckets[0].count = -1;
    snapshot.buckets[0].durationHistogram[0] = -1;
    expect(collector.snapshot().buckets[0].count).toBeGreaterThan(0);
    expect(collector.snapshot().buckets[0].durationHistogram[0]).toBeGreaterThanOrEqual(0);
    recordMetric({ phase: 'network' });
    expect(metricsSnapshot().buckets).toEqual([]);
  });

  it('attributes cache and network boundaries without logging URLs, payloads or errors', async () => {
    let logs = '';
    const stream = new Writable({
      write(chunk, _encoding, done) {
        logs += chunk.toString();
        done();
      },
    });
    const measured = new PriorityClient(
      { ...config, logLevel: 'debug' },
      createLogger({ ...config, logLevel: 'debug' }, stream),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ value: [{ CUSTNAME: 'Secret Customer' }] }), {
        headers: { 'content-type': 'application/json' },
      }),
    );
    await measured.list('CUSTOMERS', "?$filter=CUSTDES eq 'Secret Customer'");
    await measured.list('CUSTOMERS', "?$filter=CUSTDES eq 'Secret Customer'");
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message: 'synthetic-PAT-secret Secret Customer https://private.test/?$filter=secret',
          },
        }),
        { status: 400 },
      ),
    );
    await expect(measured.list('PART')).rejects.toThrow();
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { message: 'synthetic-PAT-secret Secret Customer' } }),
          { status: 429, headers: { 'retry-after': '0' } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ value: [] }));
    await measured.list('SUPPLIERS');
    const snapshot = measured.metrics.snapshot();
    expect(snapshot.buckets.some((b) => b.phase === 'network' && b.outcome === 'error')).toBe(true);
    expect(snapshot.buckets.some((b) => b.phase === 'cache' && b.cache === 'hit')).toBe(true);
    expect(snapshot.buckets.some((b) => b.phase === 'parse' && b.bytes > 0)).toBe(true);
    for (const secret of [
      'synthetic-PAT-secret',
      'Secret Customer',
      'https://',
      '$filter',
      'authorization',
    ])
      expect(logs + JSON.stringify(snapshot)).not.toContain(secret);
  });

  it('keeps diagnostics local to the Priority client and disabled by default without ERP I/O', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network forbidden'));
    const cfg = { ...config };
    const backendA = new PriorityClient(cfg, logger);
    const backendB = new PriorityClient(cfg, logger);
    backendA.metrics.record({ phase: 'network', form: 'CUSTOMERS' });
    backendB.metrics.record({ phase: 'network', form: 'SUPPLIERS' });
    const server = createServer(cfg, logger, backendA);
    const client = new Client({ name: 'metrics-test', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const plain = await client.callTool({ name: 'priority_healthcheck', arguments: {} });
      expect(plain.structuredContent).not.toHaveProperty('diagnostics');
      const result = await client.callTool({
        name: 'priority_healthcheck',
        arguments: { diagnostics: true },
      });
      const data = result.structuredContent as {
        diagnostics: { buckets: Array<{ form: string }> };
      };
      expect(data.diagnostics.buckets.some((b) => b.form === 'CUSTOMERS')).toBe(true);
      expect(data.diagnostics.buckets.some((b) => b.form === 'SUPPLIERS')).toBe(false);
      expect(backendA.metrics.snapshot().buckets.some((b) => b.phase === 'tool')).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});

it('records partial and cancelled business results through the real tool registry', async () => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { z } = await import('zod');
  const { toolRegistry } = await import('../src/lib/tool-registry.js');
  const { textResult } = await import('../src/lib/tool-result.js');
  const metrics = new MetricsCollector();
  const server = new McpServer({ name: 'metric-results', version: '1' });
  toolRegistry(server, config, metrics).tool(
    'priority_search_customers',
    'fixture',
    { stopReason: z.string() },
    async ({ stopReason }) => textResult({ results: [], search: { complete: false, stopReason } }),
  );
  const client = new Client({ name: 'metric-test', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    await client.callTool({
      name: 'priority_search_customers',
      arguments: { stopReason: 'maxRows' },
    });
    await client.callTool({
      name: 'priority_search_customers',
      arguments: { stopReason: 'cancelled' },
    });
    expect(
      metrics
        .snapshot()
        .buckets.filter((b) => b.phase === 'tool')
        .map((b) => b.outcome)
        .sort(),
    ).toEqual(['cancelled', 'incomplete']);
  } finally {
    await client.close();
    await server.close();
  }
});
