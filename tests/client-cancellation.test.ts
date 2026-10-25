import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
const config = {
  priorityBaseUrl: 'https://p.test/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityPat: 'x',
  priorityReadOnly: true,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 1000,
  requestTimeoutMs: 500,
  logLevel: 'error',
};
const logger = { debug: vi.fn(), warn: vi.fn() };
afterEach(() => vi.unstubAllGlobals());
describe('read cancellation', () => {
  it('never starts a fetch for an already-aborted report request', async () => {
    const client = new PriorityClient(config as unknown as Config, logger as unknown as Logger);
    const controller = new AbortController();
    controller.abort();
    const fetch = vi.fn(async () => new Response('{"value":[]}'));
    vi.stubGlobal('fetch', fetch);
    await expect(
      client.list('CUSTOMERS', undefined, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels an in-flight continuation GET without retry', async () => {
    const client = new PriorityClient(config as unknown as Config, logger as unknown as Logger);
    const controller = new AbortController();
    const fetch = vi.fn(
      async (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener(
            'abort',
            () => reject(new DOMException('aborted', 'AbortError')),
            { once: true },
          ),
        ),
    );
    vi.stubGlobal('fetch', fetch);
    const started = Date.now();
    const request = client.listNext('CUSTOMERS?$skiptoken=next', { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(request).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(300);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('cancels a retry backoff before another GET can start', async () => {
    const client = new PriorityClient(config as unknown as Config, logger as unknown as Logger);
    const controller = new AbortController();
    const fetch = vi.fn(async () => {
      throw new TypeError('network');
    });
    vi.stubGlobal('fetch', fetch);
    const request = client.list('CUSTOMERS', undefined, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(request).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
