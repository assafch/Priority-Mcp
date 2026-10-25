import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityError } from '../src/client/errors.js';
import type { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { CapabilityCatalog } from '../src/lib/capabilities.js';
import { CapabilityStore } from '../src/lib/capability-store.js';
import { searchForm } from '../src/lib/search.js';
import {
  createOperation,
  currentOperation,
  withOperation,
} from '../src/runtime/operation-context.js';
afterEach(() => vi.useRealTimers());
describe('per form capability evidence', () => {
  it('shares fresh read evidence across catalog sessions for the same authenticated client', async () => {
    const request = vi.fn().mockResolvedValue({ value: [] });
    const client = { request } as unknown as PriorityClient;
    const a = new CapabilityCatalog(client, {} as Config);
    const b = new CapabilityCatalog(client, {} as Config);
    await a.refresh(a.list('invoices'));
    await b.refresh(b.list('invoices'));
    expect(request).toHaveBeenCalledTimes(1);
    expect(b.list('invoices').find((x) => x.name === 'priority_list_invoices')?.evidence).toBe(
      'live-read',
    );
  });
  it('does not apply one forms unsupported function verdict to another form', async () => {
    const queries: Array<[string, string]> = [];
    const client = {
      list: async (form: string, query: string) => {
        queries.push([form, query]);
        if (form === 'CUSTOMERS' && decodeURIComponent(query).includes('contains('))
          throw new PriorityError('contains unsupported', 501);
        return { value: [] };
      },
    } as unknown as PriorityClient;
    await searchForm(client, { form: 'CUSTOMERS', query: 'a', fields: ['CUSTDES'] });
    await searchForm(client, { form: 'LOGPART', query: 'b', fields: ['PARTDES'] });
    expect(
      queries.some(([f, q]) => f === 'LOGPART' && decodeURIComponent(q).includes('contains(')),
    ).toBe(true);
  });
  it('isolates cancellation across sessions sharing one capability probe', async () => {
    const store = new CapabilityStore();
    const ac = new AbortController();
    let finish!: (value: 'supported') => void;
    const probe = () =>
      new Promise<'supported'>((resolve, reject) => {
        finish = resolve;
        currentOperation()?.signal.addEventListener('abort', () =>
          reject(new Error('cancelled backend')),
        );
      });
    const a = withOperation(createOperation('cap', { signal: ac.signal }), () =>
      store.probe('F', 'read', probe),
    );
    const rejected = expect(a).rejects.toThrow();
    const b = withOperation(createOperation('cap'), () => store.probe('F', 'read', probe));
    await Promise.resolve();
    ac.abort(new Error('cancelled'));
    finish('supported');
    await rejected;
    expect((await b).status).toBe('supported');
  });
  it('keeps function verdicts separate and expires denial before normal support', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000000);
    const store = new CapabilityStore();
    store.put('CUSTOMERS', 'contains', 'unsupported');
    store.put('LOGPART', 'contains', 'supported');
    store.put('CUSTOMERS', 'read', 'denied');
    expect(store.get('CUSTOMERS', 'contains')?.status).toBe('unsupported');
    expect(store.get('LOGPART', 'contains')?.status).toBe('supported');
    vi.advanceTimersByTime(30001);
    expect(store.get('CUSTOMERS', 'read')).toBeUndefined();
    expect(store.get('LOGPART', 'contains')?.status).toBe('supported');
    vi.advanceTimersByTime(300000);
    expect(store.get('LOGPART', 'contains')).toBeUndefined();
  });
  it('shares concurrent probes but does not retain a rejected operation', async () => {
    const store = new CapabilityStore();
    let calls = 0;
    await expect(
      store.probe('CUSTOMERS', 'read', async () => {
        calls++;
        throw Error('offline');
      }),
    ).rejects.toThrow('offline');
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.probe('CUSTOMERS', 'read', async () => {
          calls++;
          return 'supported' as const;
        }),
      ),
    );
    expect(calls).toBe(2);
    expect(store.get('CUSTOMERS', 'read')?.status).toBe('supported');
  });
});
