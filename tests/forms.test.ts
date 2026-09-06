import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PriorityError } from '../src/client/errors.js';
import type { PriorityClient } from '../src/client/priority-client.js';
import {
  _resetFormCaches,
  attachmentSubformOf,
  cachedExposedForms,
  filterForms,
  isApiFlagOffError,
  listExposedForms,
  probeCandidates,
  probeForm,
} from '../src/lib/forms.js';

const apiFlagOff = () =>
  new PriorityError('לא ניתן להפעיל API למסך זה.', 400, undefined, undefined, {
    error: { message: 'לא ניתן להפעיל API למסך זה.' },
  });
const absent = () => new PriorityError('', 404);

function fakeClient(over: Partial<PriorityClient> = {}): PriorityClient {
  return {
    serviceRoot: vi.fn().mockResolvedValue({
      value: [
        { name: 'IMPFILES', kind: 'EntitySet', url: 'IMPFILES' },
        { name: 'IMPFILEIV', kind: 'EntitySet', url: 'IMPFILEIV' },
        { name: 'BANKS', kind: 'EntitySet', url: 'BANKS' },
        { name: 'ACCOUNTS', kind: 'EntitySet', url: 'ACCOUNTS' },
      ],
    }),
    list: vi.fn().mockResolvedValue({ value: [{ A: 1 }] }),
    getMetadataFor: vi.fn(),
    ...over,
  } as unknown as PriorityClient;
}

beforeEach(() => _resetFormCaches());

describe('listExposedForms', () => {
  it('reads the service document once and memoizes it', async () => {
    const client = fakeClient();
    expect(cachedExposedForms()).toBeUndefined();
    const first = await listExposedForms(client);
    const second = await listExposedForms(client);
    expect(first).toBe(second);
    expect(client.serviceRoot).toHaveBeenCalledTimes(1);
    expect(cachedExposedForms()).toHaveLength(4);
  });

  it('shares one in-flight request between concurrent callers', async () => {
    // The service document takes ~65s on this tenant — a stampede must not multiply that.
    const client = fakeClient();
    const [a, b, c] = await Promise.all([
      listExposedForms(client),
      listExposedForms(client),
      listExposedForms(client),
    ]);
    expect(client.serviceRoot).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('re-fetches after the cache is reset', async () => {
    const client = fakeClient();
    await listExposedForms(client);
    _resetFormCaches();
    await listExposedForms(client);
    expect(client.serviceRoot).toHaveBeenCalledTimes(2);
  });
});

describe('filterForms', () => {
  const forms = ['IMPFILES', 'IMPFILEIV', 'BANKS', 'BANKPAGES', 'ACCOUNTS'].map((name) => ({
    name,
  }));

  it('filters by prefix, case-insensitively', () => {
    const r = filterForms(forms, { prefix: 'impf' });
    expect(r.matches.map((m) => m.name)).toEqual(['IMPFILES', 'IMPFILEIV']);
    expect(r.total).toBe(5);
    expect(r.matched).toBe(2);
  });

  it('filters by contains', () => {
    expect(filterForms(forms, { contains: 'bank' }).matched).toBe(2);
  });

  it('combines prefix and contains', () => {
    expect(filterForms(forms, { prefix: 'BANK', contains: 'PAGE' }).matches).toHaveLength(1);
  });

  it('reports truncation instead of silently dropping matches', () => {
    const r = filterForms(forms, { limit: 2 });
    expect(r.matches).toHaveLength(2);
    expect(r.matched).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it('does not flag truncation when everything fits', () => {
    expect(filterForms(forms, { limit: 10 }).truncated).toBe(false);
  });
});

describe('probeForm', () => {
  it('classifies a readable form as ok and reports its fields', async () => {
    const probe = await probeForm(fakeClient(), 'ACCOUNTS');
    expect(probe.status).toBe('ok');
    expect(probe.fields).toEqual(['A']);
  });

  it('classifies the Hebrew API-flag 400 as api-flag-off, not as missing', async () => {
    const client = fakeClient({ list: vi.fn().mockRejectedValue(apiFlagOff()) });
    const probe = await probeForm(client, 'BANKS');
    expect(probe.status).toBe('api-flag-off');
    expect(probe.detail).toContain('Available for API');
  });

  it('classifies a 404 as absent', async () => {
    const client = fakeClient({ list: vi.fn().mockRejectedValue(absent()) });
    const probe = await probeForm(client, 'BANKACCOUNTS');
    expect(probe.status).toBe('absent');
    expect(probe.detail).toContain('service document');
  });

  it('memoizes verdicts so a multi-candidate check stays cheap', async () => {
    const client = fakeClient();
    await probeForm(client, 'ACCOUNTS');
    await probeForm(client, 'ACCOUNTS');
    expect(client.list).toHaveBeenCalledTimes(1);
  });
});

describe('probeCandidates', () => {
  it('returns the first candidate that answers, with every verdict recorded', async () => {
    const list = vi.fn(async (form: string) => {
      if (form === 'BANKACCOUNTS') throw absent();
      if (form === 'BANKS') throw apiFlagOff();
      return { value: [{ ACCNAME: '318' }] };
    });
    const client = fakeClient({ list: list as unknown as PriorityClient['list'] });
    const { working, probes } = await probeCandidates(client, [
      'BANKACCOUNTS',
      'BANKS',
      'ACCOUNTS',
    ]);
    expect(working?.form).toBe('ACCOUNTS');
    expect(probes.map((p) => p.status)).toEqual(['absent', 'api-flag-off', 'ok']);
  });

  it('returns no winner but keeps the diagnosis when nothing works', async () => {
    const client = fakeClient({ list: vi.fn().mockRejectedValue(apiFlagOff()) });
    const { working, probes } = await probeCandidates(client, ['BANKS', 'CASH']);
    expect(working).toBeUndefined();
    expect(probes).toHaveLength(2);
    expect(probes.every((p) => p.status === 'api-flag-off')).toBe(true);
  });
});

describe('isApiFlagOffError', () => {
  it('matches the Hebrew message and the English wording', () => {
    expect(isApiFlagOffError(apiFlagOff())).toBe(true);
    expect(isApiFlagOffError(new PriorityError('Cannot enable API for this form', 400))).toBe(true);
  });

  it('does not match other 400s or a 404', () => {
    expect(isApiFlagOffError(new PriorityError("Could not find a property named 'X'", 400))).toBe(
      false,
    );
    expect(isApiFlagOffError(absent())).toBe(false);
  });
});

describe('attachmentSubformOf', () => {
  const csdl = (navs: string[]) =>
    `<EntityType Name="F"><Property Name="X" Type="Edm.String"/>${navs
      .map((n) => `<NavigationProperty Name="${n}" Type="Collection(Priority.OData.Y)" />`)
      .join('')}</EntityType>`;

  it('finds EXTFILES_SUBFORM', async () => {
    const client = fakeClient({
      getMetadataFor: vi.fn().mockResolvedValue(csdl(['IMPFILEITEMS_SUBFORM', 'EXTFILES_SUBFORM'])),
    });
    expect((await attachmentSubformOf(client, 'F')).subform).toBe('EXTFILES_SUBFORM');
  });

  it('accepts the alternate spelling (LOGPART uses PARTEXTFILE_SUBFORM)', async () => {
    const client = fakeClient({
      getMetadataFor: vi.fn().mockResolvedValue(csdl(['PARTEXTFILE_SUBFORM'])),
    });
    expect((await attachmentSubformOf(client, 'F')).subform).toBe('PARTEXTFILE_SUBFORM');
  });

  it('reports none (with the sub-forms it does have) rather than guessing', async () => {
    const client = fakeClient({
      getMetadataFor: vi.fn().mockResolvedValue(csdl(['CUSTNOTES_SUBFORM'])),
    });
    const r = await attachmentSubformOf(client, 'F');
    expect(r.subform).toBeNull();
    expect(r.subforms).toEqual(['CUSTNOTES_SUBFORM']);
  });

  it('degrades to null when metadata is unavailable', async () => {
    const client = fakeClient({ getMetadataFor: vi.fn().mockRejectedValue(new Error('boom')) });
    expect(await attachmentSubformOf(client, 'F')).toEqual({ subform: null, subforms: null });
  });
});
