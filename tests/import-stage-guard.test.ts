import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import {
  IMPORT_STAGE_GUARD_CODE,
  assertNoStageViolation,
  blockStageViolation,
  findStageViolation,
  runWithReleaseDraftScope,
  runWithReleaseFinalScope,
} from '../src/lib/import-stage-guard.js';
import { createLogger } from '../src/logger.js';
import { registerGenericTools } from '../src/tools/generic.js';

/**
 * Closing or reopening an import file and writing a bonded release are Priority screen
 * procedures with a mandatory order (receipt into arov → detail → loading calc → close →
 * release → per-line costs → costing). These tests pin the lock that keeps every write path of
 * this server from doing either as a plain field write.
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
const R = 'https://p.test/odata/Priority/tabula.ini/demo';

afterEach(() => vi.unstubAllGlobals());

function harness() {
  const client = new PriorityClient(config, logger);
  type Handler = (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _desc: string, schema: z.ZodRawShape, fn: Handler) =>
      handlers.set(name, (p) => fn(z.object(schema).parse(p))),
  } as unknown as McpServer;
  registerGenericTools(server, client, config);
  return {
    client,
    call: async (name: string, p: unknown) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool missing: ${name}`);
      return JSON.parse((await handler(p)).content[0].text);
    },
  };
}

describe('findStageViolation', () => {
  it('blocks closing an import file by PATCH', () => {
    expect(
      findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { CLOSED: 'Y', STATDES: 'סופי' }),
    ).toMatchObject({ rule: 'impfile-status', field: 'CLOSED' });
  });

  it('blocks reopening and a bare status change', () => {
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { CLOSED: '' })?.rule).toBe(
      'impfile-status',
    );
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { STATDES: 'טיוטא' })?.rule).toBe(
      'impfile-status',
    );
  });

  it('matches field names in any case or padding', () => {
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { closed: 'Y' })?.rule).toBe(
      'impfile-status',
    );
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { 'Statdes ': 'סופי' })?.rule).toBe(
      'impfile-status',
    );
  });

  it('blocks the property addressed in the URL', () => {
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')/CLOSED`, { value: 'Y' })?.rule).toBe(
      'impfile-status',
    );
    expect(findStageViolation('PUT', `${R}/IMPFILES('IM1')/STATDES/$value`, 'סופי')?.rule).toBe(
      'impfile-status',
    );
  });

  it('reads a percent-encoded key and ignores the query string', () => {
    expect(
      findStageViolation('PATCH', `${R}/IMPFILES(%27IM1%27)?$select=IMPFNUM`, { CLOSED: 'Y' })
        ?.rule,
    ).toBe('impfile-status');
  });

  it('allows opening a draft file and ordinary header edits', () => {
    expect(
      findStageViolation('POST', `${R}/IMPFILES`, { CURDATE: '2026-01-01', STATDES: 'טיוטא' }),
    ).toBeNull();
    expect(
      findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { DETAILS: 'x', CUSTOMSNUM: '1' }),
    ).toBeNull();
  });

  it('refuses to open a file already final', () => {
    expect(findStageViolation('POST', `${R}/IMPFILES`, { STATDES: 'סופי' })?.rule).toBe(
      'impfile-status',
    );
  });

  it('does not guard import-file sub-forms', () => {
    expect(
      findStageViolation('POST', `${R}/IMPFILES('IM1')/IMPFILEITEMS_SUBFORM`, {
        PARTNAME: 'P1',
        STATDES: 'x',
      }),
    ).toBeNull();
  });

  it('blocks every write to a bonded release, header or line', () => {
    expect(findStageViolation('POST', `${R}/DOCUMENTS_J`, { IMPFNUM: 'IM1' })?.rule).toBe(
      'bonded-release',
    );
    expect(
      findStageViolation('PATCH', `${R}/DOCUMENTS_J(DOCNO='BD1',TYPE='J')`, { STATDES: 'סופית' })
        ?.rule,
    ).toBe('bonded-release');
    expect(
      findStageViolation(
        'PATCH',
        `${R}/DOCUMENTS_J(DOCNO='BD1',TYPE='J')/TRANSORDER_J_SUBFORM(KLINE=1,TYPE='J')`,
        { TQUANT: 5 },
      )?.rule,
    ).toBe('bonded-release');
    expect(
      findStageViolation('DELETE', `${R}/DOCUMENTS_J(DOCNO='BD1',TYPE='J')`, undefined)?.rule,
    ).toBe('bonded-release');
  });

  it('never matches a read, or other receipt forms', () => {
    expect(findStageViolation('GET', `${R}/DOCUMENTS_J`, undefined)).toBeNull();
    expect(findStageViolation('GET', `${R}/IMPFILES('IM1')`, undefined)).toBeNull();
    expect(findStageViolation('POST', `${R}/DOCUMENTS_P`, { TOWARHSNAME: 'arov' })).toBeNull();
    expect(findStageViolation('PATCH', `${R}/PORDERS('P1')`, { STATDES: 'x' })).toBeNull();
  });

  it('throws and returns a blocked tool result with the same message', () => {
    expect(() => assertNoStageViolation('PATCH', { CLOSED: 'Y' }, `${R}/IMPFILES('IM1')`)).toThrow(
      /סגירת התיק/,
    );
    const blocked = blockStageViolation('POST', `${R}/DOCUMENTS_J`, { IMPFNUM: 'IM1' });
    expect(blocked?.isError).toBe(true);
    expect(JSON.parse(blocked?.content[0].text ?? '{}')).toMatchObject({
      status: 'blocked',
      rule: 'bonded-release',
    });
    expect(blockStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { DETAILS: 'x' })).toBeNull();
  });
});

describe('PriorityClient stage lock', () => {
  it('sends nothing when a write breaks the lock', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new PriorityClient(config, logger);
    await expect(client.update('IMPFILES', 'IM1', { CLOSED: 'Y' })).rejects.toMatchObject({
      priorityCode: IMPORT_STAGE_GUARD_CODE,
    });
    await expect(client.create('DOCUMENTS_J', { IMPFNUM: 'IM1' })).rejects.toMatchObject({
      priorityCode: IMPORT_STAGE_GUARD_CODE,
    });
    await expect(
      client.updateComposite('DOCUMENTS_J', { DOCNO: 'BD1', TYPE: 'J' }, { STATDES: 'סופית' }),
    ).rejects.toMatchObject({ priorityCode: IMPORT_STAGE_GUARD_CODE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is enforced even when the server is read-only', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new PriorityClient({ ...config, priorityReadOnly: true } as Config, logger);
    await expect(client.update('IMPFILES', 'IM1', { STATDES: 'סופי' })).rejects.toMatchObject({
      priorityCode: IMPORT_STAGE_GUARD_CODE,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('release-draft scope', () => {
  const DOC = `${R}/DOCUMENTS_J(DOCNO='BD1',TYPE='J')`;
  const LINE = `${DOC}/TRANSORDER_J_SUBFORM(KLINE=1,TYPE='J')`;
  const HEADER = {
    CURDATE: '2026-01-10T00:00:00Z',
    IMPFNUM: 'IM1',
    WARHSNAME: 'arov',
    LOCNAME: '0',
    TOWARHSNAME: 'Main',
    TOLOCNAME: '0',
    DOCREF: 'D1',
  };
  const inScope = (method: string, target: string, body: unknown) =>
    runWithReleaseDraftScope(async () => findStageViolation(method, target, body));

  it('lets through exactly the draft header POST and a line quantity PATCH', async () => {
    expect(await inScope('POST', `${R}/DOCUMENTS_J`, HEADER)).toBeNull();
    expect(await inScope('PATCH', LINE, { TQUANT: 5 })).toBeNull();
  });

  it.each([
    ['a status on the new document', 'POST', `${R}/DOCUMENTS_J`, { ...HEADER, STATDES: 'סופית' }],
    ['a draft status spelled out', 'POST', `${R}/DOCUMENTS_J`, { ...HEADER, STATDES: 'טיוטא' }],
    ['a field outside the header list', 'POST', `${R}/DOCUMENTS_J`, { ...HEADER, DETAILS: 'x' }],
    [
      'lines inserted with the header',
      'POST',
      `${R}/DOCUMENTS_J`,
      { ...HEADER, TRANSORDER_J_SUBFORM: [{ PARTNAME: 'P1', TQUANT: 1 }] },
    ],
    ['a header value that is not a scalar', 'POST', `${R}/DOCUMENTS_J`, { ...HEADER, DOCREF: {} }],
    ['an empty header', 'POST', `${R}/DOCUMENTS_J`, {}],
    ['a status change of the document', 'PATCH', DOC, { STATDES: 'סופית' }],
    ['any other header edit', 'PATCH', DOC, { DOCREF: 'D2' }],
    ['a line flag next to the quantity', 'PATCH', LINE, { TQUANT: 1, SETFLAG: 'Y' }],
    ['a quantity that is not a number', 'PATCH', LINE, { TQUANT: '5' }],
    ['a line PATCH without a quantity', 'PATCH', LINE, {}],
    ['a new line', 'POST', `${DOC}/TRANSORDER_J_SUBFORM`, { PARTNAME: 'P1', TQUANT: 1 }],
    ['the cost row of a line', 'PATCH', `${LINE}/TRANSIMPFILE_SUBFORM(KLINE=1)`, { TQUANT: 1 }],
    ['deleting a line', 'DELETE', LINE, undefined],
    ['deleting the document', 'DELETE', DOC, undefined],
  ])('still blocks %s', async (_name, method, target, body) => {
    expect((await inScope(method, target, body))?.rule).toBe('bonded-release');
  });

  it('keeps the import-file status lock inside the scope', async () => {
    expect((await inScope('PATCH', `${R}/IMPFILES('IM1')`, { CLOSED: 'Y' }))?.rule).toBe(
      'impfile-status',
    );
  });

  it('does not leak to a call made after the scope returned', async () => {
    await inScope('POST', `${R}/DOCUMENTS_J`, HEADER);
    expect(findStageViolation('POST', `${R}/DOCUMENTS_J`, HEADER)?.rule).toBe('bonded-release');
    expect(findStageViolation('PATCH', LINE, { TQUANT: 5 })?.rule).toBe('bonded-release');
  });

  it('through the client: of two concurrent writes only the scoped one is sent', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ DOCNO: 'BD1' }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new PriorityClient(config, logger);
    const [outsideFirst, scoped, outsideLast] = await Promise.allSettled([
      client.create('DOCUMENTS_J', HEADER),
      runWithReleaseDraftScope(() => client.create('DOCUMENTS_J', HEADER)),
      client.create('DOCUMENTS_J', HEADER),
    ]);
    expect(scoped.status).toBe('fulfilled');
    for (const outside of [outsideFirst, outsideLast]) {
      expect(outside.status).toBe('rejected');
      expect((outside as PromiseRejectedResult).reason).toMatchObject({
        priorityCode: IMPORT_STAGE_GUARD_CODE,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('generic tools stage lock', () => {
  it('report blocked even in a preview', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const h = harness();
    expect(
      await h.call('priority_update_record', {
        form: 'IMPFILES',
        key: 'IM1',
        data: { CLOSED: 'Y' },
        confirm: false,
      }),
    ).toMatchObject({ status: 'blocked', rule: 'impfile-status' });
    expect(
      await h.call('priority_create_record', {
        form: 'DOCUMENTS_J',
        data: { IMPFNUM: 'IM1' },
        confirm: false,
      }),
    ).toMatchObject({ status: 'blocked', rule: 'bonded-release' });
    expect(
      await h.call('priority_create_record', {
        form: 'DOCUMENTS_J',
        data: { IMPFNUM: 'IM1' },
        confirm: true,
      }),
    ).toMatchObject({ status: 'blocked' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still previews an ordinary import-file edit', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const r = await harness().call('priority_update_record', {
      form: 'IMPFILES',
      key: 'IM1',
      data: { DETAILS: 'x' },
      confirm: false,
    });
    expect(r.status).not.toBe('blocked');
  });
});

describe('the release-final opening (bonded_release_finalize)', () => {
  const HEADER = "DOCUMENTS_J(DOCNO='BD1',TYPE='J')";
  const LINE = `${HEADER}/TRANSORDER_J_SUBFORM(KLINE=1,TYPE='J')`;
  const inFinal = (method: string, target: string, body: unknown) =>
    runWithReleaseFinalScope(async () => findStageViolation(method, target, body));

  it('lets exactly one header PATCH to final through, inside the scope only', async () => {
    expect(await inFinal('PATCH', HEADER, { STATDES: 'סופית' })).toBeNull();
    expect(findStageViolation('PATCH', HEADER, { STATDES: 'סופית' })?.rule).toBe('bonded-release');
  });

  it('keeps everything else blocked inside the scope', async () => {
    const blocked: Array<[string, string, unknown]> = [
      ['PATCH', HEADER, { STATDES: 'סופית', TOWARHSNAME: 'X' }],
      ['PATCH', HEADER, { STATDES: 'טיוטא' }],
      ['PATCH', HEADER, { STATDES: 'מבוטלת' }],
      ['PATCH', HEADER, { TQUANT: 1 }],
      ['PATCH', LINE, { STATDES: 'סופית' }],
      ['PATCH', 'DOCUMENTS_J', { STATDES: 'סופית' }],
      ['POST', 'DOCUMENTS_J', { IMPFNUM: 'IM1' }],
      ['DELETE', HEADER, undefined],
    ];
    for (const [method, target, body] of blocked) {
      expect((await inFinal(method, target, body))?.rule, `${method} ${target}`).toBe(
        'bonded-release',
      );
    }
    expect((await inFinal('PATCH', "IMPFILES('IM1')", { CLOSED: 'Y' }))?.rule).toBe(
      'impfile-status',
    );
  });

  it('the two openings do not open each other', async () => {
    expect(
      (
        await runWithReleaseDraftScope(async () =>
          findStageViolation('PATCH', HEADER, { STATDES: 'סופית' }),
        )
      )?.rule,
    ).toBe('bonded-release');
    expect((await inFinal('POST', 'DOCUMENTS_J', { IMPFNUM: 'IM1' }))?.rule).toBe('bonded-release');
  });
});
