import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityError } from '../src/client/errors.js';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';

const config = {
  priorityBaseUrl: 'https://p.example/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityPat: 'tok',
  priorityReadOnly: false,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 1200,
  requestTimeoutMs: 5000,
  logLevel: 'error',
} as unknown as Config;

const client = new PriorityClient(config, createLogger(config));
const BASE = 'https://p.example/odata/Priority/tabula.ini/demo';

afterEach(() => vi.unstubAllGlobals());

/** Stub fetch with a fixed response and capture the requests that were made. */
function stubFetch(res: { status?: number; body?: string; contentType?: string }) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      return {
        ok: (res.status ?? 200) < 400,
        status: res.status ?? 200,
        headers: new Headers({ 'content-type': res.contentType ?? 'application/json' }),
        text: async () => res.body ?? '{}',
      } as unknown as Response;
    }),
  );
  return calls;
}

describe('resolveSubformRowUrl', () => {
  it('addresses one sub-form row under a composite-keyed parent', () => {
    // Shape verified live 2026-07-29 against company a051014.
    expect(
      client.resolveSubformRowUrl(
        'IMPFILEIV',
        { IVNUM: 'GI25000029', DEBIT: 'D', TYPE: 'P' },
        'IMPFILEIVS_SUBFORM',
        { KLINE: 1 },
      ),
    ).toBe(`${BASE}/IMPFILEIV(IVNUM='GI25000029',DEBIT='D',TYPE='P')/IMPFILEIVS_SUBFORM(KLINE=1)`);
  });

  it('quotes and encodes string sub-keys, emits numeric ones bare', () => {
    const url = client.resolveSubformRowUrl('F', { K: "O'B" }, 'S_SUBFORM', { A: 'x y', N: 2 });
    expect(url).toContain("K='O''B'");
    expect(url).toContain("A='x%20y'");
    expect(url).toContain('N=2');
  });

  it('rejects path traversal in the sub-form name', () => {
    expect(() =>
      client.resolveSubformRowUrl('F', { K: 'v' }, '../other/S_SUBFORM', { A: 1 }),
    ).toThrow(/Illegal entity/);
  });

  it('appends a query string when provided', () => {
    const url = client.resolveSubformRowUrl('F', { K: 'v' }, 'S', { A: 1 }, '?$select=IMPFNUM');
    expect(url.endsWith('(A=1)?$select=IMPFNUM')).toBe(true);
  });
});

describe('updateSubformRow', () => {
  it('PATCHes the row url with the given body', async () => {
    const calls = stubFetch({ body: '{"IMPFNUM":"IM25000012"}' });
    await client.updateSubformRow(
      'IMPFILEIV',
      { IVNUM: 'GI25000029', DEBIT: 'D', TYPE: 'P' },
      'IMPFILEIVS_SUBFORM',
      { KLINE: 3 },
      { IMPFNUM: 'IM25000012' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].url).toContain('IMPFILEIVS_SUBFORM(KLINE=3)');
    expect(calls[0].body).toBe('{"IMPFNUM":"IM25000012"}');
  });

  it('is not served from the GET cache', async () => {
    const calls = stubFetch({ body: '{}' });
    const args = ['F', { K: 'v' }, 'S_SUBFORM', { KLINE: 1 }, { IMPFNUM: 'A' }] as const;
    await client.updateSubformRow(...args);
    await client.updateSubformRow(...args);
    expect(calls).toHaveLength(2);
  });
});

describe('errors carry the form the request targeted', () => {
  const resourceOf = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      return err instanceof PriorityError ? err.resource : undefined;
    }
    throw new Error('expected a PriorityError');
  };

  it('names the form for a plain list request', async () => {
    stubFetch({ status: 404, body: '' });
    expect(await resourceOf(() => client.list('GLPERIODS', '?$top=1'))).toEqual({
      form: 'GLPERIODS',
      keyed: false,
    });
  });

  it('flags that a key predicate was used', async () => {
    stubFetch({ status: 404, body: '' });
    expect(await resourceOf(() => client.get('PINVOICES', 'GI25000029'))).toEqual({
      form: 'PINVOICES',
      keyed: true,
    });
  });

  it('names the parent form for a sub-form request', async () => {
    stubFetch({ status: 400, body: '{"error":{"message":"nope"}}' });
    expect(
      await resourceOf(() => client.listSubform('IMPFILES', 'IM1', 'EXTFILES_SUBFORM')),
    ).toEqual({ form: 'IMPFILES', keyed: true });
  });

  it('leaves the resource undefined for $metadata and the service root', async () => {
    // 400 rather than 5xx: a retryable status would make this test wait out the backoff.
    stubFetch({ status: 400, body: 'boom' });
    expect(await resourceOf(() => client.request('$metadata'))).toBeUndefined();
    expect(await resourceOf(() => client.serviceRoot())).toBeUndefined();
  });
});
