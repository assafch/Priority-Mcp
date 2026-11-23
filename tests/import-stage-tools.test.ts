import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { registerImpfileTools } from '../src/tools/impfiles.js';

/**
 * impfile_close / impfile_reopen report the file's stage and never write; the status can no
 * longer travel through impfile_update / impfile_open; impfile_preflight includes the stage.
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

afterEach(() => vi.unstubAllGlobals());

function harness() {
  const client = new PriorityClient(config, logger);
  type Handler = (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _desc: string, schema: z.ZodRawShape, fn: Handler) =>
      handlers.set(name, (p) => fn(z.object(schema).parse(p))),
  } as unknown as McpServer;
  registerImpfileTools(server, client, config);
  return {
    call: async (name: string, p: unknown) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool missing: ${name}`);
      return JSON.parse((await handler(p)).content[0].text);
    },
  };
}

function respond(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

type Docs = object[] | Error;
function stubFile(file: object, receipts: Docs, releases: Docs) {
  const fetchMock = vi.fn(async (url: unknown, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') throw new Error(`unexpected ${method}`);
    const u = decodeURIComponent(String(url));
    if (u.includes('/DOCUMENTS_P')) {
      if (receipts instanceof Error) throw receipts;
      return respond({ value: receipts });
    }
    if (u.includes('/DOCUMENTS_J')) {
      if (releases instanceof Error) throw releases;
      return respond({ value: releases });
    }
    return respond(file);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const onlyReads = (fetchMock: ReturnType<typeof stubFile>) =>
  fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET');

const readyFile = {
  IMPFNUM: 'IM1',
  STATDES: 'טיוטא',
  CLOSED: null,
  SUPNAME: 'S1',
  IMPFILEINV_SUBFORM: [{ IVNUM: 'GI1', SUPNAME: 'S1', DEBIT: 'D' }],
  IMPFILEITEMS_SUBFORM: [{ PARTNAME: 'P1', TQUANT: 1, WEIGHT: 1 }],
  IMPFILECUSTOMS_SUBFORM: [{ PARTNAME: 'P1', COUNTRYNAME: 'X' }],
};
const finalReceipt = [{ DOCNO: 'GR1', STATDES: 'סופית', TOWARHSNAME: 'BONDED', IVNUM: 'GI1' }];

describe('impfile_close', () => {
  it('never writes, even when the file is ready and the caller asks for a real run', async () => {
    const fetchMock = stubFile(readyFile, finalReceipt, []);
    const r = await harness().call('impfile_close', {
      impfnum: 'IM1',
      dryRun: false,
      override: true,
    });
    expect(r).toMatchObject({ mutates: false, readyToClose: true, closed: false });
    expect(r.nextStep).toContain('סגירת התיק');
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    expect(onlyReads(fetchMock)).toBe(true);
  });

  it('looks the receipt up by the final invoice and the release by the file', async () => {
    const fetchMock = stubFile(readyFile, finalReceipt, []);
    await harness().call('impfile_close', { impfnum: 'IM1' });
    const urls = fetchMock.mock.calls.map(([u]) => decodeURIComponent(String(u)));
    expect(urls.some((u) => u.includes('/DOCUMENTS_P') && u.includes("IVNUM eq 'GI1'"))).toBe(true);
    expect(urls.some((u) => u.includes('/DOCUMENTS_J') && u.includes("IMPFNUM eq 'IM1'"))).toBe(
      true,
    );
  });

  it('names the first missing step', async () => {
    stubFile(
      { ...readyFile, IMPFILEINV_SUBFORM: [{ IVNUM: 'T7', SUPNAME: 'S1', DEBIT: 'D' }] },
      [],
      [],
    );
    const r = await harness().call('impfile_close', { impfnum: 'IM1' });
    expect(r.readyToClose).toBe(false);
    expect(r.nextStep).toContain('T7');
  });

  it('a failed receipt read blocks instead of passing', async () => {
    stubFile(readyFile, new DOMException('timeout', 'TimeoutError'), []);
    const r = await harness().call('impfile_close', { impfnum: 'IM1' });
    expect(r.readyToClose).toBe(false);
    expect(r.stage.steps.bondedReceipt).toBe('unknown');
  });

  it('a release that exists before the close blocks', async () => {
    stubFile(readyFile, finalReceipt, [{ DOCNO: 'BD1', STATDES: 'סופית' }]);
    const r = await harness().call('impfile_close', { impfnum: 'IM1' });
    expect(r.readyToClose).toBe(false);
    expect(r.blocking.join(' ')).toContain('BD1');
  });

  it('says so when the file is already closed', async () => {
    stubFile({ ...readyFile, CLOSED: 'Y', STATDES: 'סופי' }, finalReceipt, []);
    const r = await harness().call('impfile_close', { impfnum: 'IM1' });
    expect(r).toMatchObject({ closed: true, readyToClose: false, nextStep: 'התיק כבר סגור.' });
  });
});

describe('impfile_reopen', () => {
  it('never writes', async () => {
    const fetchMock = stubFile({ ...readyFile, CLOSED: 'Y', STATDES: 'סופי' }, finalReceipt, []);
    const r = await harness().call('impfile_reopen', { impfnum: 'IM1', dryRun: false });
    expect(r).toMatchObject({ mutates: false, closed: true });
    expect(r.nextStep).toContain('ביטול סגירה של התיק');
    expect(onlyReads(fetchMock)).toBe(true);
  });

  it('says there is nothing to reopen on an open file', async () => {
    stubFile(readyFile, finalReceipt, []);
    const r = await harness().call('impfile_reopen', { impfnum: 'IM1' });
    expect(r).toMatchObject({ closed: false, nextStep: 'התיק פתוח — אין מה לבטל.' });
  });
});

describe('status can no longer travel through the header tools', () => {
  it('impfile_update drops a status argument', async () => {
    stubFile(readyFile, [], []);
    const r = await harness().call('impfile_update', {
      impfnum: 'IM1',
      status: 'סופי',
      details: 'x',
      dryRun: true,
    });
    expect(JSON.stringify(r)).not.toContain('STATDES');
    expect(JSON.stringify(r)).toContain('DETAILS');
  });

  it('impfile_open always opens a draft', async () => {
    stubFile(readyFile, [], []);
    const r = await harness().call('impfile_open', {
      date: '2026-01-01',
      currency: 'EUR',
      status: 'סופי',
      dryRun: true,
    });
    expect(JSON.stringify(r)).toContain('טיוטא');
    expect(JSON.stringify(r)).not.toContain('סופי');
  });
});

describe('opening a file still works through the lock', () => {
  it('a real impfile_open sends exactly one POST to IMPFILES with the draft status', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: { method?: string; body?: string }) =>
      respond({ IMPFNUM: 'IM1', CURDATE: '2026-01-01T00:00:00Z', CODE: 'EUR', STATDES: 'טיוטא' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const r = await harness().call('impfile_open', {
      date: '2026-01-01',
      currency: 'EUR',
      dryRun: false,
    });
    expect(r.status).not.toBe('blocked');
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(String(posts[0][0])).toMatch(/\/IMPFILES$/);
    expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({
      STATDES: 'טיוטא',
    });
  });
});

describe('impfile_preflight', () => {
  it('is not ok while a stage step is missing', async () => {
    stubFile({ ...readyFile, IMPFILECUSTOMS_SUBFORM: [] }, finalReceipt, []);
    const r = await harness().call('impfile_preflight', { impfnum: 'IM1' });
    expect(r.ok).toBe(false);
    expect(r.blocking.join(' ')).toContain('חישוב העמסה');
    expect(r.stage.steps.calcEvidence).toBe('missing');
  });

  it('is ok when every step is proven', async () => {
    stubFile(readyFile, finalReceipt, []);
    const r = await harness().call('impfile_preflight', { impfnum: 'IM1' });
    expect(r.ok).toBe(true);
    expect(r.blocking).toEqual([]);
  });
});
