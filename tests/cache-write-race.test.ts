import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { verifyRecordUpdate } from '../src/lib/write-verification.js';
import type { Logger } from '../src/logger.js';
const cfg = {
  priorityBaseUrl: 'https://p.test/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityPat: 'x',
  priorityReadOnly: false,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 10000,
  requestTimeoutMs: 500,
} as Config;
const logger = { debug: vi.fn(), warn: vi.fn() } as unknown as Logger;
const response = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
afterEach(() => vi.unstubAllGlobals());
describe('cache mutation generations', () => {
  it('cannot retain a GET cached during an in-flight verified PATCH', async () => {
    const client = new PriorityClient(cfg, logger);
    const entered = deferred<void>();
    const release = deferred<void>();
    let state = 'old';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init.method === 'PATCH') {
          entered.resolve();
          await release.promise;
          state = 'new';
          return response(null, 204);
        }
        return response({ PHONE: state });
      }),
    );
    const write = verifyRecordUpdate(client, 'CUSTOMERS', 'C1', { PHONE: 'new' });
    await entered.promise;
    expect(await client.get('CUSTOMERS', 'C1')).toEqual({ PHONE: 'old' });
    release.resolve();
    expect(await write).toMatchObject({ verified: true });
    expect(await client.get('CUSTOMERS', 'C1')).toEqual({ PHONE: 'new' });
  });
  it('does not cache an old GET completing after mutation and verification', async () => {
    const client = new PriorityClient(cfg, logger);
    const entered = deferred<void>();
    const release = deferred<void>();
    let first = true;
    let state = 'old';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init.method === 'PATCH') {
          state = 'new';
          return response(null, 204);
        }
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
          return response({ PHONE: 'old' });
        }
        return response({ PHONE: state });
      }),
    );
    const oldRead = client.get('CUSTOMERS', 'C1');
    await entered.promise;
    expect(await verifyRecordUpdate(client, 'CUSTOMERS', 'C1', { PHONE: 'new' })).toMatchObject({
      verified: true,
    });
    release.resolve();
    await oldRead;
    expect(await client.get('CUSTOMERS', 'C1')).toEqual({ PHONE: 'new' });
  });
  it('invalidates related-form caches even when the write response is lost', async () => {
    const client = new PriorityClient(cfg, logger);
    let state = 'old';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init.method === 'PATCH') {
          state = 'new';
          throw new TypeError('lost response');
        }
        return response({ CREDIT: state });
      }),
    );
    await client.get('OBLIGO', 'C1');
    expect(await verifyRecordUpdate(client, 'CUSTOMERS', 'C1', { PHONE: 'new' })).toMatchObject({
      status: 'unknown',
    });
    expect(await client.get('OBLIGO', 'C1')).toEqual({ CREDIT: 'new' });
  });
});
