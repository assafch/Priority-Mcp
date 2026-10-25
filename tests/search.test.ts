import { beforeEach, describe, expect, it } from 'vitest';
import { PriorityError } from '../src/client/errors.js';
import type { PriorityClient } from '../src/client/priority-client.js';
import {
  _resetStringFnSupport,
  _stringFnSupport,
  isUnsupportedFunctionError,
  searchForm,
} from '../src/lib/search.js';

type Handler = (entity: string, query: string) => Promise<{ value: unknown[] }>;

function makeClient(handler: Handler): { client: PriorityClient; queries: string[] } {
  const queries: string[] = [];
  const client = {
    list: (entity: string, query = '') => {
      queries.push(decodeURIComponent(query));
      if (Number(new URLSearchParams(query.replace(/^\?/, '')).get('$skip') ?? 0) > 0)
        return Promise.resolve({ value: [] });
      return handler(entity, query);
    },
  } as unknown as PriorityClient;
  return { client, queries };
}

const unsupported = () => new PriorityError('Function "contains" is not supported', 501);

describe('isUnsupportedFunctionError', () => {
  it('detects 501 and message-based "not supported"', () => {
    expect(isUnsupportedFunctionError(new PriorityError('x', 501))).toBe(true);
    expect(
      isUnsupportedFunctionError(new PriorityError('Function "contains" is not supported', 500)),
    ).toBe(true);
    expect(isUnsupportedFunctionError(new PriorityError('not found', 404))).toBe(false);
    expect(isUnsupportedFunctionError(new Error('boom'))).toBe(false);
  });
});

describe('searchForm', () => {
  beforeEach(() => _resetStringFnSupport());

  it('uses native contains() when the install supports it', async () => {
    const { client, queries } = makeClient(async () => ({
      value: [{ CUSTNAME: '1', CUSTDES: 'Acme' }],
    }));
    const res = await searchForm(client, {
      form: 'CUSTOMERS',
      query: 'Acme',
      fields: ['CUSTDES'],
    });
    expect(res.meta.strategy).toBe('contains');
    expect(res.value).toHaveLength(1);
    expect(queries[0]).toContain("contains(CUSTDES,'Acme')");
    expect(_stringFnSupport(client)).toBe(true);
  });

  it('falls back to client-side filtering on a 501, returning only matches', async () => {
    const { client, queries } = makeClient(async (_e, query) => {
      if (decodeURIComponent(query).includes('contains(')) throw unsupported();
      return {
        value: [
          { CUSTNAME: '11005', CUSTDES: 'יעד כימיה בע"מ' },
          { CUSTNAME: '1', CUSTDES: 'גרגו סנדרובסקי' },
        ],
      };
    });
    const res = await searchForm<{ CUSTNAME: string; CUSTDES: string }>(client, {
      form: 'CUSTOMERS',
      query: 'יעד',
      fields: ['CUSTDES', 'CUSTNAME'],
      top: 10,
    });
    expect(res.meta.strategy).toBe('client-filter');
    expect(res.meta.scanned).toBe(2);
    expect(res.value).toHaveLength(1);
    expect(res.value[0].CUSTNAME).toBe('11005');
    // The contains attempt happened once, then the fallback fetch.
    expect(queries.some((q) => q.includes('contains('))).toBe(true);
    expect(_stringFnSupport(client)).toBe(false);
  });

  it('memoizes the unsupported verdict and skips contains on later calls', async () => {
    // Prime: learn that contains is unsupported.
    const first = makeClient(async (_e, query) => {
      if (decodeURIComponent(query).includes('contains(')) throw unsupported();
      return { value: [] };
    });
    await searchForm(first.client, { form: 'CUSTOMERS', query: 'x', fields: ['CUSTDES'] });
    expect(_stringFnSupport(first.client)).toBe(false);

    // Replace the same authenticated client backend stub; cached verdict remains local.
    const second = makeClient(async (_e, query) => {
      if (decodeURIComponent(query).includes('contains(')) throw new Error('must not attempt');
      return { value: [{ CUSTNAME: '2', CUSTDES: 'Beta' }] };
    });
    first.client.list = second.client.list;
    const res = await searchForm(first.client, {
      form: 'CUSTOMERS',
      query: 'Beta',
      fields: ['CUSTDES'],
    });
    expect(res.meta.strategy).toBe('client-filter');
    expect(second.queries.some((q) => q.includes('contains('))).toBe(false);
  });

  it('surfaces an unknown projected field without an all-column retry', async () => {
    const { client, queries } = makeClient(async (_e, query) => {
      if (decodeURIComponent(query).includes('contains(')) throw unsupported();
      throw new PriorityError("Could not find a property named 'BARCODE'", 400);
    });
    await expect(
      searchForm(client, {
        form: 'LOGPART',
        query: 'widget',
        fields: ['PARTDES', 'BARCODE'],
        select: ['PARTNAME', 'PARTDES', 'BARCODE'],
        top: 5,
      }),
    ).rejects.toThrow('BARCODE');
    expect(queries.every((q) => q.includes('$select='))).toBe(true);
  });

  it('surfaces native unknown-property errors instead of silently changing search semantics', async () => {
    const { client, queries } = makeClient(async () => {
      throw new PriorityError("Could not find a property named 'BARCODE'", 400);
    });
    await expect(
      searchForm(client, { form: 'LOGPART', query: 'x', fields: ['BARCODE'] }),
    ).rejects.toThrow('BARCODE');
    expect(queries).toHaveLength(1);
  });

  it('reports scanCapped when the scan hits the cap', async () => {
    const { client } = makeClient(async (_e, query) => {
      if (decodeURIComponent(query).includes('contains(')) throw unsupported();
      return {
        value: [
          { CUSTNAME: '11005', CUSTDES: 'יעד כימיה' },
          { CUSTNAME: '9', CUSTDES: 'אחר' },
        ],
      };
    });
    const res = await searchForm(client, {
      form: 'CUSTOMERS',
      query: 'יעד',
      fields: ['CUSTDES'],
      scanCap: 2,
    });
    expect(res.meta.scanCapped).toBe(true);
    expect(res.meta.scanned).toBe(2);
    expect(res.value).toHaveLength(1);
  });

  it('flags truncated on the contains path when more than top matches exist', async () => {
    // Server honors top+1; returning 3 for top=2 means a 3rd match exists.
    const { client } = makeClient(async () => ({
      value: [
        { CUSTNAME: '1', CUSTDES: 'Acme A' },
        { CUSTNAME: '2', CUSTDES: 'Acme B' },
        { CUSTNAME: '3', CUSTDES: 'Acme C' },
      ],
    }));
    const res = await searchForm(client, {
      form: 'CUSTOMERS',
      query: 'Acme',
      fields: ['CUSTDES'],
      top: 2,
    });
    expect(res.meta.strategy).toBe('contains');
    expect(res.value).toHaveLength(2);
    expect(res.meta.truncated).toBe(true);
  });

  it('flags truncated in the fallback when matches exceed top', async () => {
    const { client } = makeClient(async (_e, query) => {
      if (decodeURIComponent(query).includes('contains(')) throw unsupported();
      return {
        value: [
          { CUSTNAME: '1', CUSTDES: 'יעד א' },
          { CUSTNAME: '2', CUSTDES: 'יעד ב' },
          { CUSTNAME: '3', CUSTDES: 'יעד ג' },
        ],
      };
    });
    const res = await searchForm(client, {
      form: 'CUSTOMERS',
      query: 'יעד',
      fields: ['CUSTDES'],
      top: 2,
    });
    expect(res.meta.strategy).toBe('client-filter');
    expect(res.value).toHaveLength(2);
    expect(res.meta.truncated).toBe(true);
  });

  it('applies a baseFilter alongside the search term', async () => {
    const { client, queries } = makeClient(async () => ({
      value: [{ CUSTNAME: '1', CUSTDES: 'Acme', STATDES: 'פעיל' }],
    }));
    await searchForm(client, {
      form: 'CUSTOMERS',
      query: 'Acme',
      fields: ['CUSTDES'],
      baseFilter: "STATDES eq 'פעיל'",
    });
    expect(queries[0]).toContain("STATDES eq 'פעיל'");
    expect(queries[0]).toContain('contains(CUSTDES');
  });
});

describe('search capability tenancy', () => {
  it('tries native search for a different backend after one backend rejects it', async () => {
    const first = makeClient(async (_entity, query) => {
      if (decodeURIComponent(query).includes('contains('))
        throw new PriorityError('Function contains is not supported', 501);
      return { value: [] };
    });
    await searchForm(first.client, { form: 'CUSTOMERS', query: 'x', fields: ['CUSTDES'] });
    const second = makeClient(async () => ({ value: [{ CUSTDES: 'x' }] }));
    const result = await searchForm(second.client, {
      form: 'CUSTOMERS',
      query: 'x',
      fields: ['CUSTDES'],
    });
    expect(result.meta.strategy).toBe('contains');
  });
});
