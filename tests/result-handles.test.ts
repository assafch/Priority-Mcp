import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityError } from '../src/client/errors.js';
import type { PriorityClient } from '../src/client/priority-client.js';
import { ResultHandles, handleBindingFor } from '../src/lib/result-handles.js';
import { searchForm } from '../src/lib/search.js';
import { createOperation, withOperation } from '../src/runtime/operation-context.js';
const binding = {
  scopeId: 'tenant-auth',
  policyScope: 'policy',
  queryHash: 'query',
  generation: 0,
};
afterEach(() => vi.useRealTimers());
describe('bounded scoped result handles', () => {
  it('rejects a recreated client incarnation even with identical credentials and numeric generation', () => {
    const a = { scopeId: 'same-data-scope', cacheGeneration: () => 0 } as unknown as PriorityClient;
    const b = { scopeId: 'same-data-scope', cacheGeneration: () => 0 } as unknown as PriorityClient;
    const handles = new ResultHandles();
    const first = handleBindingFor(a, 'same-policy', 'same-query');
    const token = handles.create(first, { rows: [] }) as string;
    expect(handleBindingFor(a, 'same-policy', 'same-query')).toEqual(first);
    expect(() => handles.get(token, handleBindingFor(b, 'same-policy', 'same-query'))).toThrow(
      /scope|restart/i,
    );
  });
  it('resumes a real search scan boundary and rejects changed caller policy', async () => {
    const data = [
      { CUSTNAME: 'a', CUSTDES: 'other' },
      { CUSTNAME: 'b', CUSTDES: 'other' },
      { CUSTNAME: 'c', CUSTDES: 'needle' },
    ];
    const client = {
      scopeId: 'search-cursor',
      cacheGeneration: () => 0,
      list: async (_form: string, query: string) => {
        const q = new URLSearchParams(query.slice(1));
        if (q.get('$filter')?.includes('contains')) throw new PriorityError('unsupported', 501);
        const skip = Number(q.get('$skip') ?? 0);
        const take = Number(q.get('$top'));
        return { value: data.slice(skip, skip + take) };
      },
    } as unknown as PriorityClient;
    const options = { form: 'CUSTOMERS', query: 'needle', fields: ['CUSTDES'], top: 1, scanCap: 2 };
    const run = <T>(policyScope: string, fn: () => Promise<T>) =>
      withOperation(createOperation('search', { policyScope }), fn);
    const first = await run('policy-a', () => searchForm(client, options));
    expect(first.value).toEqual([]);
    expect(first.meta.nextCursor).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(
      run('policy-b', () =>
        searchForm(client, { ...options, cursor: first.meta.nextCursor as string }),
      ),
    ).rejects.toThrow(/scope|policy|restart/i);
    const next = await run('policy-a', () =>
      searchForm(client, { ...options, cursor: first.meta.nextCursor as string }),
    );
    expect(next.value).toEqual([data[2]]);
    expect(next.meta.complete).toBe(true);
  });
  it('rejects wrong scope, policy, query and generation while retaining detached data', () => {
    const handles = new ResultHandles();
    const token = handles.create(binding, { rows: [{ id: 'a' }] });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const data = handles.get<{ rows: { id: string }[] }>(token as string, binding);
    data.rows[0].id = 'changed';
    expect(handles.get(token as string, binding)).toEqual({ rows: [{ id: 'a' }] });
    for (const changed of [
      { scopeId: 'other' },
      { policyScope: 'other' },
      { queryHash: 'other' },
      { generation: 1 },
    ])
      expect(() => handles.get(token as string, { ...binding, ...changed })).toThrow(
        /restart|scope|expired/i,
      );
    expect(() => new ResultHandles().get(token as string, binding)).toThrow(/restart|expired/i);
  });
  it('expires after fifteen minutes and evicts the oldest handle after100 per scope', () => {
    vi.useFakeTimers();
    const handles = new ResultHandles();
    const first = handles.create(binding, { rows: [] }) as string;
    for (let i = 0; i < 100; i++) handles.create(binding, { i });
    expect(() => handles.get(first, binding)).toThrow(/restart|expired/i);
    const last = handles.create(binding, { last: true }) as string;
    vi.advanceTimersByTime(900001);
    expect(() => handles.get(last, binding)).toThrow(/restart|expired/i);
  });
  it('returns non-resumable for state over its byte budget and bounds result page size', () => {
    const handles = new ResultHandles({ maxBytes: 100 });
    expect(handles.create(binding, { large: 'x'.repeat(200) })).toBeNull();
    const normal = new ResultHandles();
    const token = normal.create(binding, {
      rows: Array.from({ length: 230 }, (_, id) => ({ id })),
    }) as string;
    expect(normal.page(token, binding, 1, 100)).toMatchObject({
      rows: Array.from({ length: 100 }, (_, id) => ({ id: 100 + id })),
      nextPage: 2,
      totalRows: 230,
    });
    expect(() => normal.page(token, binding, 0, 101)).toThrow();
    normal.remove(token);
    expect(() => normal.get(token, binding)).toThrow(/restart|expired/i);
  });
});
