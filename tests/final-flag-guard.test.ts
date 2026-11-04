import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PriorityError } from '../src/client/errors.js';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import {
  PROCEDURE_ONLY_FIELDS,
  assertNoProcedureOnlyField,
  canonicalFieldName,
  findProcedureOnlyField,
  findProcedureOnlyPath,
  wireBody,
} from '../src/lib/procedure-only-fields.js';
import { createLogger } from '../src/logger.js';
import { registerGenericTools } from '../src/tools/generic.js';
import { registerImpfileTools } from '../src/tools/impfiles.js';

/**
 * A document's FINAL flag is set by Priority's own close procedure ("סגירת חשבונית",
 * CLOSEANINVOICE), never by a field write. A direct OData PATCH FINAL='Y' marked EINVOICES
 * T164 (25.10.2026) and T173 (2.11.2026) final with no journal entry, no final number and no
 * stock movement, and locked them ("לא ניתן לעדכן מסמך סופי"; Priority ticket SCI26096671).
 * These tests pin the guard that keeps every write path of this server from doing it again —
 * in the body (any spelling, any depth, as serialized) and as the URL target (…/FINAL).
 */
const config = {
  priorityBaseUrl: 'https://p.test/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityPat: 'x',
  priorityReadOnly: false,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 10000,
  requestTimeoutMs: 500,
  logLevel: 'error',
} as unknown as Config;
const logger = createLogger(config);
const root = 'https://p.test/odata/Priority/tabula.ini/demo';

afterEach(() => vi.unstubAllGlobals());

describe('findProcedureOnlyField', () => {
  it('lists FINAL as procedure-only', () => {
    expect([...PROCEDURE_ONLY_FIELDS]).toContain('FINAL');
  });

  it('finds FINAL at the top level, in any case, with any value', () => {
    expect(findProcedureOnlyField({ FINAL: 'Y' })).toBe('FINAL');
    expect(findProcedureOnlyField({ final: 'Y' })).toBe('final');
    expect(findProcedureOnlyField({ Final: null })).toBe('Final');
    expect(findProcedureOnlyField({ FINAL: '' })).toBe('FINAL');
    expect(findProcedureOnlyField({ FINAL: 'N' })).toBe('FINAL');
  });

  it('finds FINAL nested inside a deep-insert sub-form array', () => {
    expect(
      findProcedureOnlyField({
        CUSTNAME: 'www',
        EINVOICEITEMS_SUBFORM: [{ PARTNAME: 'P1' }, { PARTNAME: 'P2', FINAL: 'Y' }],
      }),
    ).toBe('EINVOICEITEMS_SUBFORM[1].FINAL');
    expect(findProcedureOnlyField([{ A: 1 }, { nested: { FINAL: 'Y' } }])).toBe('[1].nested.FINAL');
    expect(findProcedureOnlyField([[{ FINAL: 'Y' }]])).toBe('[0][0].FINAL');
  });

  it('canonicalizes padded, zero-width-spaced, ligature and dotted-I spellings to FINAL', () => {
    for (const key of ['FINAL ', ' final', 'F​INAL', 'FİNAL', 'ﬁnal', 'F.I.N.A.L']) {
      expect(canonicalFieldName(key)).toBe('FINAL');
      expect(findProcedureOnlyField({ [key]: 'Y' })).toBe(key);
    }
    expect(canonicalFieldName('FINALFLAG')).toBe('FINALFLAG');
  });

  it('inspects the wire form of the body: toJSON(), getters and proxies cannot hide the key', () => {
    expect(findProcedureOnlyField(wireBody({ toJSON: () => ({ FINAL: 'Y' }) }))).toBe('FINAL');
    // A proxy that hides FINAL on its first enumeration and reveals it afterwards: the wire form
    // is taken once, so what is inspected is exactly what would be serialized — they cannot differ.
    let enumerations = 0;
    const flipping = new Proxy(
      { PHONE: 'x', FINAL: 'Y' },
      { ownKeys: (t) => (enumerations++ === 0 ? ['PHONE'] : Reflect.ownKeys(t)) },
    );
    const wire = wireBody(flipping);
    expect(findProcedureOnlyField(wire) !== null).toBe(JSON.stringify(wire).includes('FINAL'));
    expect(findProcedureOnlyField(wireBody(flipping))).toBe('FINAL');
    expect(wireBody(undefined)).toBeUndefined();
    expect(wireBody({ A: undefined, B: 1 })).toEqual({ B: 1 });
  });

  it('matches the exact key only — look-alike fields and plain values pass', () => {
    expect(findProcedureOnlyField({ FINALFLAG: 'Y', FINALDATE: '2026-01-01' })).toBeNull();
    expect(findProcedureOnlyField({ PHONE: '03-1234567', STATDES: 'FINAL' })).toBeNull();
    expect(findProcedureOnlyField({ TOTPRICE: 98.7 })).toBeNull();
    expect(findProcedureOnlyField(null)).toBeNull();
    expect(findProcedureOnlyField('FINAL')).toBeNull();
    expect(findProcedureOnlyField(undefined)).toBeNull();
  });
});

describe('findProcedureOnlyPath', () => {
  it('spots a single-property target with or without $value, encoded or not', () => {
    expect(findProcedureOnlyPath(`${root}/EINVOICES('T173')/FINAL`)).toBe('FINAL');
    expect(
      findProcedureOnlyPath(`${root}/EINVOICES(IVNUM='T173',DEBIT='D',IVTYPE='E')/FINAL/$value`),
    ).toBe('FINAL');
    expect(findProcedureOnlyPath(`${root}/EINVOICES('T173')/final?$select=IVNUM`)).toBe('final');
    expect(findProcedureOnlyPath(`${root}/EINVOICES('T173')/%46INAL`)).toBe('FINAL');
    expect(findProcedureOnlyPath("EINVOICES('T173')/FINAL")).toBe('FINAL');
  });

  it('ignores ordinary entity, key-predicate and sub-form paths', () => {
    expect(
      findProcedureOnlyPath(`${root}/EINVOICES(IVNUM='T173',DEBIT='D',IVTYPE='E')`),
    ).toBeNull();
    expect(findProcedureOnlyPath(`${root}/EINVOICES('FINAL')`)).toBeNull();
    expect(findProcedureOnlyPath(`${root}/EINVOICES('T173')/EINVOICEITEMS_SUBFORM`)).toBeNull();
    expect(findProcedureOnlyPath(`${root}/EINVOICES?$filter=FINAL eq 'Y'`)).toBeNull();
    expect(findProcedureOnlyPath(undefined)).toBeNull();
  });
});

describe('assertNoProcedureOnlyField', () => {
  it('throws a 400 PriorityError that names the field and the procedure', () => {
    let caught: unknown;
    try {
      assertNoProcedureOnlyField('PATCH', { FINAL: 'Y' }, "EINVOICES(IVNUM='T173')");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PriorityError);
    const err = caught as PriorityError;
    expect(err.statusCode).toBe(400);
    expect(err.priorityCode).toBe('PROCEDURE_ONLY_FIELD');
    expect(err.message).toContain('FINAL');
    expect(err.message).toContain('CLOSEANINVOICE');
    expect(err.message).toContain("EINVOICES(IVNUM='T173')");
  });

  it('throws for a URL that targets the property even with a clean body', () => {
    expect(() =>
      assertNoProcedureOnlyField('PATCH', { value: 'Y' }, "EINVOICES('T173')/FINAL"),
    ).toThrow(/targets "FINAL"/);
    expect(() => assertNoProcedureOnlyField('PUT', 'Y', "EINVOICES('T173')/FINAL/$value")).toThrow(
      PriorityError,
    );
    expect(() =>
      assertNoProcedureOnlyField('GET', undefined, "EINVOICES('T173')/FINAL"),
    ).not.toThrow();
  });

  it('ignores reads and deletes, and bodies without the field', () => {
    expect(() => assertNoProcedureOnlyField('GET', { FINAL: 'Y' })).not.toThrow();
    expect(() => assertNoProcedureOnlyField('DELETE', undefined)).not.toThrow();
    expect(() => assertNoProcedureOnlyField('PATCH', { PHONE: 'x' })).not.toThrow();
    expect(() => assertNoProcedureOnlyField('POST', undefined)).not.toThrow();
  });
});

describe('PriorityClient refuses every write path that carries FINAL', () => {
  function stubbedClient() {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return { client: new PriorityClient(config, logger), fetchMock };
  }

  it('update()', async () => {
    const { client, fetchMock } = stubbedClient();
    await expect(client.update('EINVOICES', 'T173', { FINAL: 'Y' })).rejects.toMatchObject({
      statusCode: 400,
      priorityCode: 'PROCEDURE_ONLY_FIELD',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('updateComposite()', async () => {
    const { client, fetchMock } = stubbedClient();
    await expect(
      client.updateComposite(
        'EINVOICES',
        { IVNUM: 'T173', DEBIT: 'D', IVTYPE: 'E' },
        { FINAL: 'Y' },
      ),
    ).rejects.toMatchObject({ priorityCode: 'PROCEDURE_ONLY_FIELD' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('create() with a nested deep-insert line', async () => {
    const { client, fetchMock } = stubbedClient();
    await expect(
      client.create('EINVOICES', { CUSTNAME: 'www', EINVOICEITEMS_SUBFORM: [{ final: 'Y' }] }),
    ).rejects.toMatchObject({ priorityCode: 'PROCEDURE_ONLY_FIELD' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('addLine() and updateSubformRow()', async () => {
    const { client, fetchMock } = stubbedClient();
    await expect(
      client.addLine('EINVOICES', 'T173', 'EINVOICEITEMS_SUBFORM', { FINAL: 'Y' }),
    ).rejects.toMatchObject({ priorityCode: 'PROCEDURE_ONLY_FIELD' });
    await expect(
      client.updateSubformRow(
        'EINVOICES',
        'T173',
        'EINVOICEITEMS_SUBFORM',
        { KLINE: 1 },
        { FINAL: 'Y' },
      ),
    ).rejects.toMatchObject({ priorityCode: 'PROCEDURE_ONLY_FIELD' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('request() with an explicit PATCH', async () => {
    const { client, fetchMock } = stubbedClient();
    await expect(
      client.request('EINVOICES', 'T173', undefined, { method: 'PATCH', body: { FINAL: null } }),
    ).rejects.toMatchObject({ priorityCode: 'PROCEDURE_ONLY_FIELD' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('request() that addresses the property in the URL (OData single-property update)', async () => {
    const { client, fetchMock } = stubbedClient();
    await expect(
      client.request("EINVOICES('T173')/FINAL", undefined, undefined, {
        method: 'PATCH',
        body: { value: 'Y' },
      }),
    ).rejects.toMatchObject({ priorityCode: 'PROCEDURE_ONLY_FIELD' });
    await expect(
      client.addLine('EINVOICES', 'T173', 'FINAL', { value: 'Y' }),
    ).rejects.toMatchObject({ priorityCode: 'PROCEDURE_ONLY_FIELD' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bodies whose serialized form differs from the live object', async () => {
    const { client, fetchMock } = stubbedClient();
    await expect(
      client.update('EINVOICES', 'T173', { toJSON: () => ({ FINAL: 'Y' }) }),
    ).rejects.toMatchObject({ priorityCode: 'PROCEDURE_ONLY_FIELD' });
    let reads = 0;
    const flipping = {
      CUSTNAME: 'www',
      get EINVOICEITEMS_SUBFORM() {
        return reads++ === 0 ? [] : [{ FINAL: 'Y' }];
      },
    };
    // The wire form is taken exactly once, so whatever the getter yields is what is inspected.
    await client.create('EINVOICES', flipping).catch(() => undefined);
    const sentBodies = fetchMock.mock.calls.map((c) => String(c[1]?.body));
    expect(sentBodies.some((b) => b.includes('FINAL'))).toBe(false);
  });

  it('padded or zero-width-spaced spellings of the key', async () => {
    const { client, fetchMock } = stubbedClient();
    for (const key of ['FINAL ', 'F​INAL', 'FİNAL']) {
      await expect(client.update('EINVOICES', 'T173', { [key]: 'Y' })).rejects.toMatchObject({
        priorityCode: 'PROCEDURE_ONLY_FIELD',
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still sends an ordinary PATCH', async () => {
    const { client, fetchMock } = stubbedClient();
    await client.update('CUSTOMERS', 'C1', { PHONE: '03-1234567' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'PATCH' });
  });
});

type Handler = (p: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function harness(register: (server: McpServer, client: PriorityClient, config: Config) => void) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const client = new PriorityClient(config, logger);
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _desc: string, schema: z.ZodRawShape, fn: Handler) =>
      handlers.set(name, (p) => fn(z.object(schema).parse(p))),
  } as unknown as McpServer;
  register(server, client, config);
  return {
    fetchMock,
    call: async (name: string, p: unknown) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`tool ${name} not registered`);
      return handler(p);
    },
  };
}

function expectBlocked(res: Awaited<ReturnType<Handler>>) {
  expect(res.isError).toBe(true);
  const body = JSON.parse(res.content[0].text);
  expect(body.status).toBe('blocked');
  expect(body.error).toContain('FINAL');
  expect(body.error).toContain('CLOSEANINVOICE');
  expect(body.dryRun).not.toBe(true);
}

describe('generic write tools refuse FINAL before the dry-run preview', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['priority_update_record', { form: 'EINVOICES', key: 'T173', data: { FINAL: 'Y' } }],
    ['priority_create_record', { form: 'EINVOICES', data: { CUSTNAME: 'www', FINAL: 'Y' } }],
    [
      'priority_add_line',
      { form: 'EINVOICES', key: 'T173', subform: 'EINVOICEITEMS_SUBFORM', data: { FINAL: 'Y' } },
    ],
    [
      'priority_update_line',
      {
        form: 'EINVOICES',
        key: 'T173',
        subform: 'EINVOICEITEMS_SUBFORM',
        lineKeys: { KLINE: 1 },
        data: { FINAL: 'Y' },
      },
    ],
    // The property named in the path instead of the body (OData single-property update).
    ['priority_create_record', { form: "EINVOICES('T173')/FINAL", data: { value: 'Y' } }],
    [
      'priority_add_line',
      { form: 'EINVOICES', key: 'T173', subform: 'FINAL', data: { value: 'Y' } },
    ],
  ];

  for (const [tool, params] of cases) {
    it(`${tool}: dry-run and confirm=true are both blocked, nothing is sent`, async () => {
      const h = harness(registerGenericTools);
      for (const confirm of [false, true]) {
        expectBlocked(await h.call(tool, { ...params, confirm }));
      }
      expect(h.fetchMock).not.toHaveBeenCalled();
    });
  }
});

describe('curated raw-field import-file tools refuse FINAL before the preview', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['impfile_manual_alloc', { impfnum: 'IM26000001', target: 'cost', fields: { FINAL: 'Y' } }],
    ['impfile_expected_costs', { impfnum: 'IM26000001', fields: { Final: 'Y' } }],
  ];

  for (const [tool, params] of cases) {
    it(`${tool}: dryRun true and false are both blocked, nothing is sent`, async () => {
      const h = harness(registerImpfileTools);
      for (const dryRun of [true, false]) {
        expectBlocked(await h.call(tool, { ...params, dryRun }));
      }
      expect(h.fetchMock).not.toHaveBeenCalled();
    });
  }
});
