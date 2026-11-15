import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { attachmentFromBase64, sha256Hex } from '../src/lib/attachment-file.js';
import {
  checkGoodsInvoice,
  planGoodsInvoice,
  reconcileGoodsLines,
} from '../src/lib/impfiles-logic.js';
import { checkDraft } from '../src/lib/subform-rows.js';
import { createLogger } from '../src/logger.js';
import { registerDocumentTools } from '../src/tools/documents.js';
import { registerGenericTools } from '../src/tools/generic.js';
import { registerImpfileTools } from '../src/tools/impfiles.js';

const base = {
  priorityBaseUrl: 'https://p.test/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityPat: 'x',
  priorityReadOnly: false,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 10000,
  requestTimeoutMs: 500,
  logLevel: 'error',
} as Config;
const root = 'https://p.test/odata/Priority/tabula.ini/demo';

type Register = (server: McpServer, client: PriorityClient, config: Config) => void;
function harness(register: Register, config: Config = base) {
  const client = new PriorityClient(config, createLogger(config));
  type Handler = (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (name: string, desc: string, schema: z.ZodRawShape, fn: Handler) => {
      descriptions.set(name, desc);
      handlers.set(name, (p) => fn(z.object(schema).parse(p)));
    },
  } as unknown as McpServer;
  register(server, client, config);
  return {
    descriptions,
    call: async (name: string, p: unknown) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool missing: ${name}`);
      return JSON.parse((await handler(p)).content[0].text);
    },
  };
}

interface Call {
  method: string;
  url: string;
  body?: Record<string, unknown>;
}
/** Route fetch through a tiny scripted Priority; records every request. */
function priority(route: (c: Call) => { status?: number; body?: unknown; xml?: string }) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: decodeURIComponent(String(url).slice(root.length)),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const r = route(call);
      const status = r.status ?? 200;
      if (r.xml !== undefined)
        return new Response(r.xml, { status, headers: { 'content-type': 'application/xml' } });
      return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

/** CSDL as Priority's GetMetadataFor answers it. */
const csdl = (type: string, key: string[], nav: Record<string, string> = {}) =>
  `<Schema><EntityType Name="${type}"><Key>${key
    .map((k) => `<PropertyRef Name="${k}"/>`)
    .join('')}</Key>${key
    .map((k) => `<Property Name="${k}" Type="Edm.String"/>`)
    .join('')}${Object.entries(nav)
    .map(([n, t]) => `<NavigationProperty Name="${n}" Type="Collection(Priority.OData.${t})"/>`)
    .join('')}</EntityType></Schema>`;
function metadata(c: Call) {
  const entity = /GetMetadataFor\(entity='([^']+)'\)/.exec(c.url)?.[1];
  if (!entity) return null;
  if (entity.endsWith('_SUBFORM'))
    return {
      status: 500,
      body: {
        error: {
          code: '500',
          message: `entity ${entity} not found: parse metadata for ${entity}: XML decode: EOF`,
        },
      },
    };
  if (entity === 'PINVOICES')
    return {
      xml: csdl('PINVOICES', ['IVNUM', 'DEBIT', 'IVTYPE'], {
        PINVOICEITEMS_SUBFORM: 'PINVOICEITEMS',
        EXTFILES_SUBFORM: 'EXTFILES',
      }),
    };
  if (entity === 'PORDERS')
    return { xml: csdl('PORDERS', ['ORDNAME'], { PORDERITEMS_SUBFORM: 'PORDERITEMS' }) };
  if (entity === 'EXTFILES') return { xml: csdl('EXTFILES', ['EXTFILENUM']) };
  return { xml: csdl(entity, ['KLINE']) };
}

afterEach(() => vi.unstubAllGlobals());

// ───────────────────────────────────────────────────────────── 1. duplicate goods line

const PO = {
  ORDNAME: 'PO-1',
  SUPNAME: 'S100',
  CODE: 'GBP',
  PORDERITEMS_SUBFORM: [{ KLINE: 2, PARTNAME: 'GLUE50', TQUANT: 100, TBALANCE: 100, PRICE: 2 }],
};
const pulled = (over: Record<string, unknown> = {}) => ({
  KLINE: 1,
  PARTNAME: 'GLUE50',
  TQUANT: 100,
  PRICE: 2,
  QPRICE: 200,
  ORDNAME: 'PO-1',
  PRSOURCENAME: 'הזמנה',
  ...over,
});
const goods = {
  mode: 'goods',
  supplier: 'S100',
  invoiceNumber: 'INV-1001',
  invoiceDate: '2026-09-25',
  currency: 'GBP',
  impfnum: 'IM-1',
  po: 'PO-1',
  goodsLines: [{ part: 'GLUE50', qty: 100, price: 2 }],
};
const T = "/PINVOICES(IVNUM='T500',DEBIT='D',IVTYPE='P')";

/** A scripted Priority that pulls the order's lines when ORDNAME is on the header. */
function invoiceServer(opts: { order?: unknown; pulledLines?: Record<string, unknown>[] } = {}) {
  let lines = opts.pulledLines ?? [pulled()];
  let exists = false;
  return priority((c) => {
    if (c.url.startsWith('/PORDERS?')) return { body: { value: [opts.order ?? PO] } };
    if (c.url.startsWith('/PINVOICES?')) return { body: { value: [] } };
    if (c.method === 'POST' && c.url === '/PINVOICES') {
      exists = true;
      return { status: 201, body: { ...c.body, IVNUM: 'T500', IVTYPE: 'P' } };
    }
    const row = /PINVOICEITEMS_SUBFORM\(KLINE=(\d+)\)/.exec(c.url);
    if (row && c.method === 'PATCH') {
      lines = lines.map((l) => {
        if (l.KLINE !== Number(row[1])) return l;
        const next = { ...l, ...c.body };
        return { ...next, QPRICE: Number(next.TQUANT) * Number(next.PRICE) };
      });
      return { body: {} };
    }
    if (row && c.method === 'DELETE') {
      lines = lines.filter((l) => l.KLINE !== Number(row[1]));
      return { status: 204 };
    }
    if (c.method === 'POST' && c.url === `${T}/PINVOICEITEMS_SUBFORM`) {
      const line = {
        KLINE: lines.length + 1,
        ORDNAME: null,
        PRSOURCENAME: 'ידני',
        ...c.body,
        QPRICE: Number(c.body?.TQUANT) * Number(c.body?.PRICE),
      };
      lines = [...lines, line];
      return { status: 201, body: line };
    }
    if (c.url.startsWith(`${T}/PINVOICEITEMS_SUBFORM?`)) return { body: { value: lines } };
    if (c.url.startsWith(`${T}?$expand`) && exists)
      return {
        body: {
          IVNUM: 'T500',
          BOOKNUM: 'INV-1001',
          ORDNAME: 'PO-1',
          STATDES: 'טיוטא',
          QPRICE: lines.reduce((s, l) => s + Number(l.QPRICE), 0),
          PINVOICEITEMS_SUBFORM: lines,
        },
      };
    return { status: 404, body: { error: { message: 'not found' } } };
  });
}

describe('pinvoice_create — goods invoice against a purchase order', () => {
  it("sends the header WITHOUT lines, so Priority's own order pull is not doubled", async () => {
    const calls = invoiceServer();
    const r = await harness(registerImpfileTools).call('pinvoice_create', {
      ...goods,
      dryRun: false,
    });
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      SUPNAME: 'S100',
      IVDATE: '2026-09-25',
      BOOKNUM: 'INV-1001',
      CODE: 'GBP',
      DEBIT: 'D',
      OTYPE: 'P',
      IMPFNUM: 'IM-1',
      ORDNAME: 'PO-1',
    });
    expect(post?.body).not.toHaveProperty('PINVOICEITEMS_SUBFORM');
    expect(writes(calls)).toHaveLength(1); // nothing to correct: the pulled line is the invoice
    expect(r).toMatchObject({ status: 'verified', created: true, verified: true });
    expect(r.lines).toHaveLength(1);
    expect(r.verification.observed).toEqual({ lineCount: 1, total: 200, headerTotal: 200 });
  });

  it('corrects a partial quantity and removes order lines that are not on the invoice', async () => {
    const order = {
      ...PO,
      PORDERITEMS_SUBFORM: [
        ...PO.PORDERITEMS_SUBFORM,
        { KLINE: 3, PARTNAME: 'OTHER', TQUANT: 10, TBALANCE: 10, PRICE: 5 },
      ],
    };
    const calls = invoiceServer({
      order,
      pulledLines: [
        pulled(),
        pulled({ KLINE: 2, PARTNAME: 'OTHER', TQUANT: 10, PRICE: 5, QPRICE: 50 }),
      ],
    });
    const r = await harness(registerImpfileTools).call('pinvoice_create', {
      ...goods,
      goodsLines: [{ part: 'GLUE50', qty: 25, price: 2.4 }],
      dryRun: false,
    });
    expect(writes(calls).map((c) => `${c.method} ${c.url.replace(T, '')}`)).toEqual([
      'POST /PINVOICES',
      'PATCH /PINVOICEITEMS_SUBFORM(KLINE=1)',
      'DELETE /PINVOICEITEMS_SUBFORM(KLINE=2)',
    ]);
    expect(writes(calls)[1].body).toEqual({ TQUANT: 25, PRICE: 2.4 });
    expect(r).toMatchObject({ status: 'verified', verified: true });
    expect(r.verification.observed).toEqual({ lineCount: 1, total: 60, headerTotal: 60 });
  });

  it('adds a charge that is on the invoice but not on the order as a manual line', async () => {
    const calls = invoiceServer();
    const r = await harness(registerImpfileTools).call('pinvoice_create', {
      ...goods,
      extraLines: [{ part: '000', price: 12.5, description: 'Carriage' }],
      dryRun: false,
    });
    expect(writes(calls).map((c) => `${c.method} ${c.url.replace(T, '')}`)).toEqual([
      'POST /PINVOICES',
      'POST /PINVOICEITEMS_SUBFORM',
    ]);
    expect(writes(calls)[1].body).toEqual({
      PARTNAME: '000',
      TQUANT: 1,
      PRICE: 12.5,
      PDES: 'Carriage',
    });
    expect(r).toMatchObject({ status: 'verified', verified: true });
    expect(r.verification.observed).toEqual({ lineCount: 2, total: 212.5, headerTotal: 212.5 });
  });

  it('refuses an extra line that is in fact on the order', async () => {
    const calls = invoiceServer();
    const r = await harness(registerImpfileTools).call('pinvoice_create', {
      ...goods,
      goodsLines: [{ part: 'GLUE50', qty: 100, price: 2 }],
      extraLines: [{ part: 'GLUE50', price: 5 }],
      dryRun: false,
    });
    expect(r.status).toBe('refused');
    expect(writes(calls)).toHaveLength(0);
  });

  it('refuses before any write when a part is not on the order', async () => {
    const calls = invoiceServer();
    const r = await harness(registerImpfileTools).call('pinvoice_create', {
      ...goods,
      goodsLines: [{ part: 'NOPE', qty: 1, price: 1 }],
      dryRun: false,
    });
    expect(r.status).toBe('refused');
    expect(r.problems[0]).toMatch(/NOPE has no open line/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('refuses when the supplier already has an invoice with that number', async () => {
    const calls = priority((c) =>
      c.url.startsWith('/PORDERS?')
        ? { body: { value: [PO] } }
        : { body: { value: [{ IVNUM: 'T900', STATDES: 'טיוטא' }] } },
    );
    const r = await harness(registerImpfileTools).call('pinvoice_create', {
      ...goods,
      dryRun: false,
    });
    expect(r.status).toBe('refused');
    expect(r.problems[0]).toMatch(/already has invoice T900/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('reports the draft and forbids re-creating it when the pull does not cover the invoice', async () => {
    const calls = invoiceServer({ pulledLines: [] });
    const r = await harness(registerImpfileTools).call('pinvoice_create', {
      ...goods,
      dryRun: false,
    });
    expect(r).toMatchObject({ status: 'incomplete', created: false, verified: false });
    expect(r.invoice.IVNUM).toBe('T500');
    expect(r.doNotCreateAgain).toMatch(/Do NOT call pinvoice_create again/);
    expect(writes(calls)).toHaveLength(1);
  });

  it('dry-run reads the order and shows single lines and the matching total, sending nothing', async () => {
    const calls = invoiceServer();
    const r = await harness(registerImpfileTools, { ...base, priorityReadOnly: true }).call(
      'pinvoice_create',
      goods,
    );
    expect(r.dryRun).toBe(true);
    expect(r.wouldSend.expectedLineCount).toBe(1);
    expect(r.wouldSend.expectedTotal).toBe(200);
    expect(r.wouldSend.expectedLines[0]).toMatchObject({ part: 'GLUE50', qty: 100, poLine: 2 });
    expect(r.wouldSend.steps[0].body).not.toHaveProperty('PINVOICEITEMS_SUBFORM');
    expect(writes(calls)).toHaveLength(0);
  });

  it('says the invoice number is the supplier invoice number, not the sales order', () => {
    const d = harness(registerImpfileTools).descriptions.get('pinvoice_create') ?? '';
    expect(d).toMatch(/NOT\s+the supplier's sales-order/);
    expect(d).toMatch(/number PRINTED ON THE SUPPLIER'S INVOICE/);
  });

  it('the read-back check catches the doubled-draft shape: a twin line and a doubled total', () => {
    const check = checkGoodsInvoice({
      po: 'PO-1',
      requested: goods.goodsLines,
      invoice: {
        QPRICE: 400,
        PINVOICEITEMS_SUBFORM: [pulled(), pulled({ KLINE: 2, ORDNAME: null })],
      },
    });
    expect(check.verified).toBe(false);
    expect(check.observed).toEqual({ lineCount: 2, total: 400, headerTotal: 400 });
  });

  it('treats a sub-cent unit-price difference as a difference, and totals per line', () => {
    // 2.004 vs 2 must be corrected, not waved through by a money-sized tolerance.
    expect(
      reconcileGoodsLines({
        po: 'PO-1',
        requested: [{ part: 'GLUE50', qty: 100, price: 2.004 }],
        actual: [pulled()],
      }).steps,
    ).toEqual([{ op: 'PATCH', kline: 1, part: 'GLUE50', body: { PRICE: 2.004 } }]);
    // Three lines of 0.335 each: Priority stores 0.34 per line (1.02), not round(1.005).
    const parts = ['A', 'B', 'C'];
    const check = checkGoodsInvoice({
      po: 'PO-1',
      requested: parts.map((part) => ({ part, qty: 1, price: 0.335 })),
      invoice: {
        QPRICE: 1.02,
        PINVOICEITEMS_SUBFORM: parts.map((part, i) =>
          pulled({ KLINE: i + 1, PARTNAME: part, TQUANT: 1, PRICE: 0.335, QPRICE: 0.34 }),
        ),
      },
    });
    expect(check.verified).toBe(true);
    expect(check.expected.total).toBe(1.02);
  });

  it('plans and reconciles as pure functions', () => {
    const plan = planGoodsInvoice({
      supplier: 'S100',
      currency: 'GBP',
      po: 'PO-1',
      order: PO,
      lines: [{ part: 'GLUE50', qty: 100 }],
    });
    expect(plan).toMatchObject({ ok: true, expectedTotal: 200 });
    expect(plan.lines[0].priceSource).toBe('order');
    expect(
      planGoodsInvoice({ ...{ supplier: 'X', currency: 'GBP', po: 'P', lines: [] }, order: PO }).ok,
    ).toBe(false);
    // The doubled draft: keep the order line, delete the manual twin.
    expect(
      reconcileGoodsLines({
        po: 'PO-1',
        requested: goods.goodsLines,
        actual: [pulled({ KLINE: 2, ORDNAME: null, PRSOURCENAME: 'ידני' }), pulled()],
      }).steps,
    ).toEqual([
      { op: 'DELETE', kline: 2, part: 'GLUE50', reason: 'line not linked to the purchase order' },
    ]);
  });
});

// ───────────────────────────────────────────────────────────── 2. delete a sub-form row

describe('priority_delete_line', () => {
  const keys = { IVNUM: 'T900', DEBIT: 'D', IVTYPE: 'P' };
  const P = "/PINVOICES(IVNUM='T900',DEBIT='D',IVTYPE='P')";
  const args = {
    form: 'PINVOICES',
    keys,
    subform: 'PINVOICEITEMS_SUBFORM',
    lineKeys: { KLINE: 2 },
  };
  function server(header: Record<string, unknown>, opts: { ignoreDelete?: boolean } = {}) {
    let rows = [{ KLINE: 1 }, { KLINE: 2 }];
    return priority((c) => {
      const meta = metadata(c);
      if (meta) return meta;
      if (c.method === 'DELETE') {
        if (!opts.ignoreDelete) rows = rows.filter((r) => r.KLINE !== 2);
        return { status: 204 };
      }
      if (c.url === P) return { body: header };
      if (c.url === `${P}/PINVOICEITEMS_SUBFORM(KLINE=2)`)
        return { body: { KLINE: 2, PARTNAME: 'GLUE50', TQUANT: 100 } };
      if (c.url.startsWith(`${P}/PINVOICEITEMS_SUBFORM?`)) return { body: { value: rows } };
      return { status: 404, body: { error: { message: 'not found' } } };
    });
  }
  const draft = { IVNUM: 'T900', STATDES: 'טיוטא', FINAL: null, FNCNUM: null };

  it('previews by default: shows the row, sends no DELETE', async () => {
    const calls = server(draft);
    const r = await harness(registerGenericTools).call('priority_delete_line', args);
    expect(r).toMatchObject({ dryRun: true, status: 'preview' });
    expect(r.wouldSend).toEqual({
      method: 'DELETE',
      endpoint: `${root}${P}/PINVOICEITEMS_SUBFORM(KLINE=2)`,
    });
    expect(r.rowToDelete.PARTNAME).toBe('GLUE50');
    expect(writes(calls)).toHaveLength(0);
  });

  it('deletes with confirm and verifies the row is gone and the count dropped by one', async () => {
    const calls = server(draft);
    const r = await harness(registerGenericTools).call('priority_delete_line', {
      ...args,
      confirm: true,
    });
    expect(writes(calls).map((c) => `${c.method} ${c.url}`)).toEqual([
      `DELETE ${P}/PINVOICEITEMS_SUBFORM(KLINE=2)`,
    ]);
    expect(r).toMatchObject({ deleted: true, status: 'verified', verified: true });
    expect(r.verification).toMatchObject({ rowsBefore: 2, rowsAfter: 1, rowStillPresent: false });
  });

  it('refuses a final document, even with confirm', async () => {
    const calls = server({ IVNUM: 'GI-9', STATDES: 'סופית', FINAL: 'Y', FNCNUM: 'J-77' });
    const r = await harness(registerGenericTools).call('priority_delete_line', {
      ...args,
      confirm: true,
    });
    expect(r.status).toBe('refused');
    expect(r.error).toMatch(/final/);
    expect(writes(calls)).toHaveLength(0);
  });

  it('does not report success when Priority acknowledges but the row is still there', async () => {
    server(draft, { ignoreDelete: true });
    const r = await harness(registerGenericTools).call('priority_delete_line', {
      ...args,
      confirm: true,
    });
    expect(r).toMatchObject({ deleted: false, status: 'unverified', acknowledged: true });
  });

  it('is blocked by read-only mode', async () => {
    const calls = server(draft);
    const r = await harness(registerGenericTools, { ...base, priorityReadOnly: true }).call(
      'priority_delete_line',
      { ...args, confirm: true },
    );
    expect(r.status).toBe('blocked');
    expect(writes(calls)).toHaveLength(0);
  });

  it("rejects row keys that are not the sub-form's key", async () => {
    server(draft);
    await expect(
      harness(registerGenericTools).call('priority_delete_line', {
        ...args,
        lineKeys: { PARTNAME: 'GLUE50' },
      }),
    ).rejects.toThrow(/Expected exactly these key fields: KLINE/);
  });

  it('checkDraft fails closed', () => {
    expect(checkDraft({ FINAL: null, STATDES: 'טיוטא' }).draft).toBe(true);
    expect(checkDraft({ FINAL: 'Y' }).draft).toBe(false);
    expect(checkDraft({ FINAL: null, FNCNUM: 'J-77' }).draft).toBe(false);
    expect(checkDraft({ STATDES: 'אושרה' }).draft).toBe(false); // an approved PO is not a draft
    expect(checkDraft({ STATDES: 'טיוטא' }).draft).toBe(true);
    expect(checkDraft({ STATDES: 'טיוטא', CLOSED: 'Y' }).draft).toBe(false);
    expect(checkDraft({}).draft).toBe(false);
  });
});

describe('priority_update_line — sub-form key validation (HTTP 500 of 15.11.2026)', () => {
  it('reads the row type from the parent instead of asking for the sub-form as an entity', async () => {
    const calls = priority((c) => {
      const meta = metadata(c);
      if (meta) return meta;
      if (c.method === 'PATCH') return { body: {} };
      return { body: { ORDNAME: 'PO-1', KLINE: 2, TQUANT: 50 } };
    });
    const r = await harness(registerGenericTools).call('priority_update_line', {
      form: 'PORDERS',
      key: 'PO-1',
      subform: 'PORDERITEMS_SUBFORM',
      lineKeys: { KLINE: 2 },
      data: { TQUANT: 50 },
      confirm: true,
    });
    expect(r).toMatchObject({ updated: true, status: 'verified' });
    expect(calls.some((c) => c.url.includes("entity='PORDERITEMS_SUBFORM'"))).toBe(false);
    expect(writes(calls)[0].url).toBe("/PORDERS('PO-1')/PORDERITEMS_SUBFORM(KLINE=2)");
  });
});

// ───────────────────────────────────────────────────────────── 3. attachments

describe('priority_upload_attachment — a local file', () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2000, 7)]);
  const hash = sha256Hex(pdf);
  const args = {
    entityType: 'PINVOICES',
    keys: { IVNUM: 'T900', DEBIT: 'D', IVTYPE: 'P' },
    subform: 'EXTFILES_SUBFORM',
  };
  const A = "/PINVOICES(IVNUM='T900',DEBIT='D',IVTYPE='P')/EXTFILES_SUBFORM";
  async function localPdf(bytes = pdf, name = 'INV-1001.pdf') {
    const path = join(await mkdtemp(join(tmpdir(), 'att-')), name);
    await writeFile(path, bytes);
    return path;
  }
  /** Priority stores what it is sent (or a corrupted copy) and returns it on read. */
  function server(opts: { corrupt?: boolean } = {}) {
    let stored: Record<string, unknown> | undefined;
    return priority((c) => {
      if (c.method === 'POST') {
        stored = { ...c.body, EXTFILENUM: 3, FILESIZE: pdf.length };
        if (opts.corrupt)
          stored.EXTFILENAME = `data:application/pdf;base64,${pdf.subarray(0, 100).toString('base64')}`;
        return { status: 201, body: stored };
      }
      if (c.url === `${A}(EXTFILENUM=3)`) return { body: stored };
      return { status: 404, body: { error: { message: 'not found' } } };
    });
  }

  it('previews size and hash without the bytes and sends nothing', async () => {
    const calls = server();
    const r = await harness(registerDocumentTools).call('priority_upload_attachment', {
      ...args,
      localPath: await localPdf(),
    });
    expect(r.dryRun).toBe(true);
    expect(r.wouldSend.file).toEqual({
      name: 'INV-1001.pdf',
      mime: 'application/pdf',
      bytes: pdf.length,
      sha256: hash,
    });
    expect(JSON.stringify(r)).not.toContain(pdf.toString('base64').slice(0, 40));
    expect(calls).toHaveLength(0);
  });

  it('sends the file as a data URI and verifies the stored bytes by hash', async () => {
    const calls = server();
    const r = await harness(registerDocumentTools).call('priority_upload_attachment', {
      ...args,
      localPath: await localPdf(),
      dryRun: false,
    });
    const post = writes(calls)[0];
    expect(post.url).toBe(A);
    expect(post.body).toEqual({
      EXTFILENAME: `data:application/pdf;base64,${pdf.toString('base64')}`,
      EXTFILEDES: 'INV-1001.pdf',
      SUFFIX: 'pdf',
    });
    expect(r).toMatchObject({ attached: true, fileContentVerified: true, status: 'verified' });
    expect(r.storedRow).toMatchObject({ EXTFILENUM: 3, sha256: hash, bytes: pdf.length });
    expect(JSON.stringify(r)).not.toContain('base64,');
  });

  it('accepts base64 content with a file name', async () => {
    const calls = server();
    const r = await harness(registerDocumentTools).call('priority_upload_attachment', {
      ...args,
      fileContent: pdf.toString('base64'),
      fileName: 'invoice.pdf',
      dryRun: false,
    });
    expect(r.attached).toBe(true);
    expect(writes(calls)).toHaveLength(1);
  });

  it('does not claim success when Priority stored different bytes', async () => {
    server({ corrupt: true });
    const r = await harness(registerDocumentTools).call('priority_upload_attachment', {
      ...args,
      localPath: await localPdf(),
      dryRun: false,
    });
    expect(r).toMatchObject({ attached: false, status: 'unverified', acknowledged: true });
  });

  it('rejects a file that is not what its extension says, cut-off base64, and two sources', async () => {
    const calls = server();
    const h = harness(registerDocumentTools);
    const notPdf = await localPdf(Buffer.from('<html>login page</html>'), 'x.pdf');
    expect(
      (await h.call('priority_upload_attachment', { ...args, localPath: notPdf, dryRun: false }))
        .error,
    ).toMatch(/not a valid \.pdf/);
    expect(() => attachmentFromBase64(pdf.toString('base64').slice(0, -3), 'a.pdf')).toThrow(
      /not complete base64/,
    );
    expect(
      (
        await h.call('priority_upload_attachment', {
          ...args,
          localPath: notPdf,
          filePath: '\\\\server\\share\\x.pdf',
          dryRun: false,
        })
      ).error,
    ).toMatch(/exactly one way/);
    expect(calls).toHaveLength(0);
  });

  it('lists attachments without echoing the stored file', async () => {
    priority(() => ({
      body: {
        value: [
          {
            EXTFILENUM: 3,
            EXTFILEDES: 'INV-1001.pdf',
            EXTFILENAME: `data:application/pdf;base64,${pdf.toString('base64')}`,
          },
        ],
      },
    }));
    const r = await harness(registerDocumentTools).call('priority_list_attachments', args);
    expect(r.attachments[0].EXTFILENAME).toBe(
      `[file stored in Priority: application/pdf, ${pdf.length} bytes]`,
    );
    expect(r.attachments[0].storedFile.sha256).toBe(hash);
  });
});
