import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { createOperation, withOperation } from '../src/runtime/operation-context.js';
const config = {
  priorityBaseUrl: 'https://p.test/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityPat: 'scheduling-test',
  priorityReadOnly: false,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 1000,
  requestTimeoutMs: 1000,
} as Config;
const logger = { debug: vi.fn(), warn: vi.fn() } as unknown as Logger;
const clients: PriorityClient[] = [];
const client = (overrides = {}) => {
  const c = new PriorityClient({ ...config, ...overrides }, logger);
  clients.push(c);
  return c;
};
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
afterEach(() => {
  for (const c of clients.splice(0)) c.close?.();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('client scheduler and sharing boundaries', () => {
  it('deduplicates twenty identical GETs, with scope isolation and uncached bypass', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      await Promise.resolve();
      return json({ value: calls });
    });
    const a = client();
    const values = await Promise.all(Array.from({ length: 20 }, () => a.get('CUSTOMERS', 'a')));
    expect(calls).toBe(1);
    expect(values.every((value) => JSON.stringify(value) === JSON.stringify(values[0]))).toBe(true);
    const b = client({ priorityCompany: 'other' });
    await b.get('CUSTOMERS', 'a');
    expect(calls).toBe(2);
    await Promise.all([
      a.get('CUSTOMERS', 'a', undefined, { cache: false }),
      a.get('CUSTOMERS', 'a', undefined, { cache: false }),
    ]);
    expect(calls).toBe(4);
  });
  it('can roll back coalescing while retaining the response cache', async () => {
    const fetch = vi.fn(async () => json({ value: 1 }));
    vi.stubGlobal('fetch', fetch);
    const a = client({ priorityCoalesceReads: false });
    await Promise.all(Array.from({ length: 20 }, () => a.get('CUSTOMERS', 'same')));
    expect(fetch).toHaveBeenCalledTimes(20);
    await a.get('CUSTOMERS', 'same');
    expect(fetch).toHaveBeenCalledTimes(20);
  });
  it('keeps data separate for credentials sharing an explicit rate scope in the same company', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls++;
      return json({ visibility: (init.headers as Record<string, string>).Authorization });
    });
    const a = client({ priorityRateScope: 'same-account' });
    const b = client({ priorityRateScope: 'same-account', priorityPat: 'second-credential' });
    const first = await a.get('CUSTOMERS', 'same');
    const second = await b.get('CUSTOMERS', 'same');
    expect(first).not.toEqual(second);
    expect(calls).toBe(2);
    expect(a.scopeId).not.toBe(b.scopeId);
  });
  it('applies the explicit full-metadata body budget separately from ordinary reads', async () => {
    vi.stubGlobal('fetch', async () => json({ value: '12345678901234567890' }));
    const a = client({ priorityMaxReadBodyBytes: 16, priorityMaxMetadataBodyBytes: 128 });
    await expect(a.request('$metadata')).resolves.toEqual({ value: '12345678901234567890' });
    await expect(a.getMetadataFor('CUSTOMERS')).rejects.toMatchObject({ statusCode: 413 });
  });
  it('isolates subscriber cancellation at the real fetch boundary', async () => {
    let finish!: () => void;
    let fetchedSignal!: AbortSignal;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      fetchedSignal = init.signal as AbortSignal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return json({ value: 1 });
    });
    const a = client();
    const controller = new AbortController();
    const first = a.get('CUSTOMERS', 'a', undefined, { signal: controller.signal });
    const second = a.get('CUSTOMERS', 'a');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    controller.abort();
    await expect(first).rejects.toThrow();
    expect(fetchedSignal.aborted).toBe(false);
    finish();
    expect(await second).toEqual({ value: 1 });
  });
  it('lets a later long-budget subscriber outlive the first subscriber without a shared deadline', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        finish = resolve;
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
      return json({ value: 1 });
    });
    const a = client({ requestTimeoutMs: 300000 });
    const first = withOperation(
      createOperation('priority_query', { deadlineAt: Date.now() + 10 }),
      () => a.get('CUSTOMERS', 'a'),
    );
    const second = withOperation(
      createOperation('priority_query', { deadlineAt: Date.now() + 180000 }),
      () => a.get('CUSTOMERS', 'a'),
    );
    const outcomes = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(121000);
    finish();
    expect(await outcomes).toMatchObject([
      { status: 'rejected' },
      { status: 'fulfilled', value: { value: 1 } },
    ]);
  });
  it('never starts a queued request after the inherited operation deadline', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return json({});
    });
    const a = client({ rateLimitPerMinute: 1 });
    await a.get('CUSTOMERS', 'first');
    const pending = withOperation(
      createOperation('priority_query', { deadlineAt: Date.now() + 25 }),
      () => a.get('CUSTOMERS', 'queued'),
    );
    const rejected = expect(pending).rejects.toThrow(/deadline/i);
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    await vi.advanceTimersByTimeAsync(60000);
    expect(calls).toBe(1);
  });
  it('shares same-account/company-independent quotas but never cached data', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return json({ value: calls });
    });
    const a = client({ priorityRateScope: 'shared-user', rateLimitPerMinute: 1 });
    const b = client({
      priorityRateScope: 'shared-user',
      priorityPat: 'other-token',
      priorityCompany: 'other',
      rateLimitPerMinute: 2,
    });
    await a.get('CUSTOMERS', 'a');
    const pending = b.get('CUSTOMERS', 'a');
    const rejected = expect(pending).rejects.toThrow(/deadline/i);
    await vi.advanceTimersByTimeAsync(20000);
    await rejected;
    expect(calls).toBe(1);
  });
  it.each(['identity', 'gzip'])(
    'bounds consumed decoded bytes for %s response bodies',
    async (encoding) => {
      let cancelled = false;
      vi.stubGlobal(
        'fetch',
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"value":"'));
                controller.enqueue(new TextEncoder().encode('12345678901234567890'));
              },
              cancel() {
                cancelled = true;
              },
            }),
            {
              headers: {
                'content-type': 'application/json',
                'content-encoding': encoding,
                'content-length': '1',
              },
            },
          ),
      );
      const a = client({ priorityMaxReadBodyBytes: 16 });
      await expect(a.get('CUSTOMERS', 'large')).rejects.toMatchObject({ statusCode: 413 });
      expect(cancelled).toBe(true);
    },
  );
  it('enforces a deadline while reading a response body after headers', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const a = client();
    const pending = withOperation(
      createOperation('priority_query', { deadlineAt: Date.now() + 25 }),
      () => a.get('CUSTOMERS', 'a'),
    );
    const rejected = expect(pending).rejects.toThrow(/deadline/i);
    await vi.advanceTimersByTimeAsync(25);
    await rejected;
    expect(cancelled).toBe(true);
  });
  it('all subscribers cancelling queued work prevents any later fetch', async () => {
    let calls = 0;
    let finish!: () => void;
    vi.stubGlobal('fetch', async () => {
      calls++;
      if (calls === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return json({});
    });
    const a = client({ priorityMaxConcurrency: 1 });
    const blocker = a.get('CUSTOMERS', 'block');
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const controllers = [new AbortController(), new AbortController()];
    const queued = controllers.map((c) =>
      a.get('CUSTOMERS', 'queued', undefined, { signal: c.signal }).catch((e) => e),
    );
    const started = Date.now();
    for (const controller of controllers) controller.abort();
    await Promise.all(queued);
    expect(Date.now() - started).toBeLessThan(100);
    finish();
    await blocker;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
  });
  it('counts retry attempts against quota and pauses other reads on a clean429', async () => {
    vi.useFakeTimers();
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return calls === 1
        ? new Response('{}', {
            status: 429,
            headers: { 'retry-after': '1', 'content-type': 'application/json' },
          })
        : json({ value: calls });
    });
    const a = client({ rateLimitPerMinute: 2 });
    const first = a.get('CUSTOMERS', 'one', undefined, { budgetMs: 2000 });
    await vi.advanceTimersByTimeAsync(0);
    const second = a.get('CUSTOMERS', 'two', undefined, { budgetMs: 2000 });
    const settled = Promise.allSettled([first, second]);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    const results = await settled;
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(calls).toBe(2);
  });
});
