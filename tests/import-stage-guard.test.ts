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
