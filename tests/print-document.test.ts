import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PriorityClient } from '../src/client/priority-client.js';
import type { WebSdkProcStep, WebSdkSession } from '../src/client/web-sdk.js';
import { convertHtmlToPdf, htmlWithBase } from '../src/lib/html-to-pdf.js';
import {
  PRINT_FORMS,
  type PrintOutcome,
  buildInputFields,
  chooseFormat,
  chooseOption,
  isDraftDocument,
  printDocument,
  sniffPrintFile,
} from '../src/lib/print-document.js';
import { registerPrintDocumentTool } from '../src/tools/print-document.js';

/**
 * priority_print_document runs Priority's own document procedure through a scripted Web SDK.
 * Nothing here contacts a Priority tenant. The tests pin the safety contract: OData must find
 * exactly one row before procStart, the procedure stays in display mode, drafts are not
 * finalized, and the PDF comes back as base64 a remote MCP client can use.
 */

const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF');

interface Step extends Record<string, unknown> {
  type: string;
}

function scripted(steps: Step[]) {
  const calls: string[] = [];
  let index = 0;
  const proc = {
    inputOptions: vi.fn(async (ok: number, selection: number) => {
      calls.push(`inputOptions:${ok}:${selection}`);
      return next();
    }),
    inputFields: vi.fn(async (ok: number, data: unknown) => {
      calls.push(`inputFields:${ok}:${JSON.stringify(data)}`);
      return next();
    }),
    documentOptions: vi.fn(async (ok: number, format: number, options: unknown) => {
      calls.push(`documentOptions:${ok}:${format}:${JSON.stringify(options)}`);
      return next();
    }),
    continueProc: vi.fn(async () => {
      calls.push('continueProc');
      return next();
    }),
    clientContinue: vi.fn(async (data?: string) => {
      calls.push(`clientContinue:${data ?? ''}`);
      return next();
    }),
    inputHelp: vi.fn(async (ok: number) => {
      calls.push(`inputHelp:${ok}`);
      return next();
    }),
    message: vi.fn(async (ok: number) => {
      calls.push(`message:${ok}`);
      return next();
    }),
    cancel: vi.fn(async () => {
      calls.push('cancel');
    }),
  };
  function next(): WebSdkProcStep {
    const spec = steps[index++] ?? { type: 'end' };
    return { ...spec, proc } as WebSdkProcStep;
  }
  const procStart = vi.fn(
    async (name: string, type: string, _progress: unknown, company?: string) => {
      calls.push(`procStart:${name}:${type}:${company ?? ''}`);
      return next();
    },
  );
  return { calls, proc, procStart };
}

function sessionFrom(fake: ReturnType<typeof scripted>): WebSdkSession {
  return {
    company: 'a051014',
    ensureLogin: vi.fn(async () => undefined),
    reset: vi.fn(),
    describe: () => ({ company: 'a051014' }),
    sdk: { procStart: fake.procStart, login: vi.fn(), formStart: vi.fn() },
    loginConfig: { password: 'PAT' },
  } as unknown as WebSdkSession;
}

function clientReturning(rows: Array<Array<Record<string, unknown>>>) {
  let n = 0;
  const list = vi.fn(async () => ({ value: rows[Math.min(n++, rows.length - 1)] ?? [] }));
  return { client: { list } as unknown as PriorityClient, list };
}

const orderSteps = (): Step[] => [
  {
    type: 'inputOptions',
    input: { title: 'Range', Options: [{ field: 1, title: 'One order', selected: 1 }] },
  },
  {
    type: 'inputFields',
    input: {
      title: 'Parameters',
      EditFields: [
        { field: 1, title: 'מהזמנה', code: 'Str', value: '' },
        {
          field: 2,
          title: 'מיון',
          code: 'Str',
          operator: 0,
          value: 'לפי מספר הזמנה',
          zoom: 'Choose',
        },
      ],
    },
  },
  { type: 'client' },
  {
    type: 'documentOptions',
    formats: [
      { format: -1, title: 'Standard', selected: 1 },
      { format: -7, title: 'By Base Product', selected: 0 },
    ],
    wordTemplates: [{ template: -3, title: 'Predefined Template', selected: 0 }],
  },
  {
    type: 'displayUrl',
    Urls: [{ url: 'https://files.example/netfiles/order.pdf', action: 'display' }],
  },
  { type: 'end' },
];

async function run(
  form: 'ORDERS' | 'AINVOICES' | 'EINVOICES',
  key: string,
  rows: Array<Record<string, unknown>>,
  steps: Step[],
  extra: Record<string, unknown> = {},
) {
  const fake = scripted(steps);
  const { client, list } = clientReturning([rows, rows]);
  const fetchFile = vi.fn(async () => ({ bytes: PDF, contentType: 'application/pdf' }));
  const outcome = await printDocument(
    client,
    { form, key, ...(extra.request as object) },
    {
      session: () => sessionFrom(fake),
      fetchFile,
      ...(extra.deps as object),
    },
  );
  return { outcome, calls: fake.calls, fetchFile, list };
}

describe('print format and input helpers', () => {
  it('keeps the sort field and puts the document number on the document fields', () => {
    const filled = buildInputFields(
      [
        { field: 1, title: 'מהזמנה', value: '' },
        { field: 2, title: 'עד הזמנה', value: '' },
        { field: 3, title: 'מיון', operator: 0, value: 'לפי מספר הזמנה' },
      ],
      'SO26000419',
    );
    expect(filled.EditFields).toEqual([
      { field: 1, op: 0, value: 'SO26000419' },
      { field: 2, op: 0, value: 'SO26000419' },
      { field: 3, op: 0, value: 'לפי מספר הזמנה' },
    ]);
  });

  it('refuses a choice that would email or print every document', () => {
    expect(
      chooseOption([
        { field: 1, title: 'Email the customer' },
        { field: 2, title: 'All documents' },
      ]).ok,
    ).toBe(false);
    const picked = chooseOption([
      { field: 1, title: 'All documents' },
      { field: 2, title: 'This document only' },
    ]);
    expect(picked).toMatchObject({ ok: true, field: 2 });
  });

  it('defaults to the selected system format and can match a title or a word template id', () => {
    const formats = [
      { format: -1, title: 'Standard', selected: 1 },
      { format: -7, title: 'Detailed', selected: 0 },
    ];
    const words = [{ template: -3, title: 'Predefined Template', selected: 0 }];
    expect(chooseFormat(formats, words).ok && chooseFormat(formats, words)).toMatchObject({
      ok: true,
      choice: { id: -1, kind: 'format', how: 'default-selected' },
    });
    expect(chooseFormat(formats, words, 'detailed')).toMatchObject({
      ok: true,
      choice: { id: -7, kind: 'format', how: 'title' },
    });
    expect(chooseFormat(formats, words, '-3')).toMatchObject({
      ok: true,
      choice: { id: -3, kind: 'word', how: 'id' },
    });
    expect(chooseFormat(formats, words, '-99').ok).toBe(false);
  });

  it('recognises PDF bytes ahead of a misleading content type', () => {
    expect(sniffPrintFile(PDF, 'text/html')).toBe('pdf');
    expect(sniffPrintFile(Buffer.from('<html><body>x</body></html>'), 'text/html')).toBe('html');
    expect(sniffPrintFile(Buffer.from('PK\u0003\u0004'), 'application/octet-stream')).toBe('docx');
  });

  it('treats a T-number as a draft and a final invoice as not a draft', () => {
    expect(
      isDraftDocument('AINVOICES', { IVNUM: 'T16631', FINAL: null, STATDES: 'טיוטא' }, 'IVNUM'),
    ).toBe(true);
    expect(isDraftDocument('AINVOICES', { IVNUM: 'IN264000407', FINAL: 'Y' }, 'IVNUM')).toBe(false);
    expect(isDraftDocument('ORDERS', { ORDNAME: 'SO26000419' }, 'ORDNAME')).toBe(false);
  });
});

describe('printDocument procedure', () => {
  it('names the standard document procedures', () => {
    expect(PRINT_FORMS.ORDERS.procedure).toBe('WWWSHOWORDER');
    expect(PRINT_FORMS.AINVOICES.procedure).toBe('WWWSHOWAIV');
    expect(PRINT_FORMS.EINVOICES.procedure).toBe('WWWSHOWEIV');
    expect(PRINT_FORMS.CINVOICES.procedure).toBe('WWWSHOWCIV');
    expect(PRINT_FORMS.TINVOICES.procedure).toBe('WWWSHOWTIV');
    expect(PRINT_FORMS.DOCUMENTS_D.procedure).toBe('WWWSHOWDOC');
    expect(PRINT_FORMS.OPENINVOICES.procedure).toBe('WWWSHOWDOC');
  });

  it('does not start the procedure when OData has no such document', async () => {
    const fake = scripted(orderSteps());
    const { client } = clientReturning([[]]);
    const outcome = await printDocument(
      client,
      { form: 'ORDERS', key: 'SO26000419' },
      { session: () => sessionFrom(fake) },
    );
    expect(outcome).toMatchObject({
      status: 'failed',
      reason: 'not-found',
      procedure: 'WWWSHOWORDER',
    });
    expect(fake.calls).toEqual([]);
  });

  it('does not start the procedure when several rows share the number', async () => {
    const fake = scripted(orderSteps());
    const { client } = clientReturning([
      [
        { ORDNAME: 'SO1', STATDES: 'a' },
        { ORDNAME: 'SO1', STATDES: 'b' },
      ],
    ]);
    const outcome = await printDocument(
      client,
      { form: 'ORDERS', key: 'SO1' },
      { session: () => sessionFrom(fake) },
    );
    expect(outcome).toMatchObject({ status: 'failed', reason: 'ambiguous' });
    expect(fake.calls).toEqual([]);
  });

  it('reports a missing Web SDK before procStart', async () => {
    const { client, list } = clientReturning([[{ ORDNAME: 'SO26000419' }]]);
    const outcome = await printDocument(
      client,
      { form: 'ORDERS', key: 'SO26000419' },
      {
        session: () => {
          throw new Error(
            'Web SDK login needs PRIORITY_PAT or PRIORITY_USERNAME + PRIORITY_PASSWORD',
          );
        },
      },
    );
    expect(outcome).toMatchObject({ status: 'failed', reason: 'sdk-not-configured' });
    expect(String((outcome as { detail: string }).detail)).toContain('PRIORITY_PAT');
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('returns Priority PDF bytes for a sales order and stays in display mode', async () => {
    const { outcome, calls, fetchFile } = await run(
      'ORDERS',
      'SO26000419',
      [{ ORDNAME: 'SO26000419', ORDSTATUSDES: 'מאושרת' }],
      orderSteps(),
    );
    expect(outcome.status).toBe('ok');
    const ok = outcome as Extract<PrintOutcome, { status: 'ok' }>;
    expect(ok).toMatchObject({
      procedure: 'WWWSHOWORDER',
      filename: 'ORDERS-SO26000419.pdf',
      mimeType: 'application/pdf',
      pdfSource: 'priority',
      draft: false,
      format: { id: -1, title: 'Standard', kind: 'format' },
      statusCheck: 'unchanged',
    });
    expect(Buffer.from(ok.contentBase64 ?? '', 'base64')).toEqual(PDF);
    expect(fetchFile).toHaveBeenCalledWith('https://files.example/netfiles/order.pdf');
    expect(calls.some((call) => call.startsWith('procStart:WWWSHOWORDER:P:a051014'))).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.includes('"mode":"display"') &&
          call.includes('"pdf":1') &&
          call.includes('"word":0'),
      ),
    ).toBe(true);
    expect(calls.join('\n')).not.toMatch(/automail|signature|activateStart|CLOSE/);
    const input = calls.find((call) => call.startsWith('inputFields:'));
    expect(input).toContain('SO26000419');
    expect(input).toContain('לפי מספר הזמנה');
    expect(ok.note).toContain('העתק');
    expect(ok.note).toContain('CLOSEANINVOICE was not called');
  });

  it('prints an invoice draft without finalizing it', async () => {
    const { outcome, calls } = await run(
      'AINVOICES',
      'T16631',
      [{ IVNUM: 'T16631', FINAL: null, STATDES: 'טיוטא', DEBIT: 'C' }],
      [
        { type: 'inputFields', input: { EditFields: [{ field: 1, title: 'חשבונית', value: '' }] } },
        { type: 'documentOptions', formats: [{ format: -4, title: 'Invoice', selected: 1 }] },
        { type: 'displayUrl', Urls: [{ url: 'https://files.example/t.pdf' }] },
        { type: 'end' },
      ],
    );
    expect(outcome).toMatchObject({
      status: 'ok',
      procedure: 'WWWSHOWAIV',
      draft: true,
      statusCheck: 'unchanged',
      documentBefore: { IVNUM: 'T16631', FINAL: null, STATDES: 'טיוטא', DEBIT: 'C' },
    });
    expect((outcome as { note: string }).note).toContain('was not finalized');
    expect(calls.join('\n')).not.toMatch(/CLOSE/);
  });

  it('uses WWWSHOWEIV for an EINVOICES final number', async () => {
    const { outcome } = await run(
      'EINVOICES',
      'OV265000552',
      [{ IVNUM: 'OV265000552', FINAL: 'Y', STATDES: 'סופית' }],
      [
        { type: 'inputFields', input: { EditFields: [{ field: 1, title: 'Invoice', value: '' }] } },
        { type: 'message', messagetype: 'information', message: 'Preparing document' },
        { type: 'documentOptions', formats: [{ format: -1, title: 'Standard', selected: 1 }] },
        { type: 'displayUrl', Urls: [{ url: 'https://files.example/ov.pdf' }] },
        { type: 'end' },
      ],
    );
    expect(outcome).toMatchObject({ status: 'ok', procedure: 'WWWSHOWEIV', draft: false });
  });

  it('lists formats and cancels before generating a file', async () => {
    const { outcome, calls, fetchFile } = await run(
      'ORDERS',
      'SO26000419',
      [{ ORDNAME: 'SO26000419' }],
      orderSteps(),
      { request: { listFormats: true } },
    );
    expect(outcome).toMatchObject({
      status: 'formats',
      procedure: 'WWWSHOWORDER',
      formats: [
        { id: -1, title: 'Standard', selected: true },
        { id: -7, title: 'By Base Product', selected: false },
      ],
    });
    expect(calls.some((call) => call.startsWith('documentOptions:'))).toBe(false);
    expect(calls).toContain('cancel');
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('selects a format by title', async () => {
    const { calls } = await run('ORDERS', 'SO26000419', [{ ORDNAME: 'SO26000419' }], orderSteps(), {
      request: { format: 'By Base Product' },
    });
    expect(calls.some((call) => call.startsWith('documentOptions:1:-7:'))).toBe(true);
  });

  it('cancels a warning instead of confirming it', async () => {
    const { outcome, calls, fetchFile } = await run(
      'ORDERS',
      'SO26000419',
      [{ ORDNAME: 'SO26000419' }],
      [
        {
          type: 'message',
          messagetype: 'warning',
          message: 'Please confirm the company',
        },
      ],
    );
    expect(outcome).toMatchObject({ status: 'failed', reason: 'cancelled' });
    expect((outcome as { detail: string }).detail).toContain('Please confirm the company');
    expect((outcome as { detail: string }).detail).toContain('acceptMessages');
    expect(calls).toContain('cancel');
    expect(fetchFile).not.toHaveBeenCalled();
  });

  it('accepts only an exact listed warning, and still refuses one that would finalize', async () => {
    const warning = 'Document will be shown on screen';
    const steps: Step[] = [
      { type: 'message', messagetype: 'warning', message: warning },
      { type: 'inputFields', input: { EditFields: [{ field: 1, title: 'חשבונית', value: '' }] } },
      { type: 'documentOptions', formats: [{ format: -1, title: 'Standard', selected: 1 }] },
      { type: 'displayUrl', Urls: [{ url: 'https://files.example/t.pdf' }] },
      { type: 'end' },
    ];
    const accepted = await run(
      'AINVOICES',
      'IN264000407',
      [{ IVNUM: 'IN264000407', FINAL: 'Y' }],
      steps,
      { request: { acceptMessages: [warning] } },
    );
    expect(accepted.outcome.status).toBe('ok');
    expect(accepted.calls).toContain('message:1');

    const refused = await run(
      'AINVOICES',
      'IN264000407',
      [{ IVNUM: 'IN264000407', FINAL: 'Y' }],
      [{ type: 'message', messagetype: 'warning', message: 'This will finalize the document' }],
      { request: { acceptMessages: ['This will finalize the document'] } },
    );
    expect(refused.outcome).toMatchObject({ status: 'failed', reason: 'cancelled' });
    expect(refused.calls).not.toContain('message:1');
  });

  it('cancels an email choice', async () => {
    const { outcome, calls } = await run(
      'AINVOICES',
      'IN264000407',
      [{ IVNUM: 'IN264000407', FINAL: 'Y' }],
      [
        {
          type: 'inputOptions',
          input: { Options: [{ field: 1, title: 'Send by email', selected: 1 }] },
        },
      ],
    );
    expect(outcome).toMatchObject({ status: 'failed', reason: 'cancelled' });
    expect(calls.some((call) => call.startsWith('inputOptions:'))).toBe(false);
    expect(calls).toContain('cancel');
  });

  it('converts HTML with the injected converter when Priority does not return PDF', async () => {
    const html = Buffer.from('<html><head></head><body>חשבונית</body></html>');
    const htmlToPdf = vi.fn(async () => PDF);
    const { outcome } = await run(
      'ORDERS',
      'SO26000419',
      [{ ORDNAME: 'SO26000419' }],
      orderSteps(),
      {
        deps: {
          fetchFile: async () => ({ bytes: html, contentType: 'text/html; charset=utf-8' }),
          htmlToPdf,
        },
      },
    );
    expect(htmlToPdf).toHaveBeenCalledWith(html, 'https://files.example/netfiles/order.pdf');
    expect(outcome).toMatchObject({ status: 'ok', pdfSource: 'html-converted' });
  });

  it('says how to install Chrome when HTML comes back and conversion is unavailable', async () => {
    const { outcome } = await run(
      'ORDERS',
      'SO26000419',
      [{ ORDNAME: 'SO26000419' }],
      orderSteps(),
      {
        deps: {
          fetchFile: async () => ({
            bytes: Buffer.from('<html><body>x</body></html>'),
            contentType: 'text/html',
          }),
          htmlToPdf: async () => {
            throw new Error('No Chrome/Chromium binary found. Install Google Chrome.');
          },
        },
      },
    );
    expect(outcome).toMatchObject({ status: 'failed', reason: 'not-pdf' });
    expect((outcome as { detail: string }).detail).toContain('Chrome');
  });

  it('flags a status change and still returns the PDF', async () => {
    const fake = scripted([
      { type: 'inputFields', input: { EditFields: [{ field: 1, title: 'חשבונית', value: '' }] } },
      { type: 'documentOptions', formats: [{ format: -1, title: 'Standard', selected: 1 }] },
      { type: 'displayUrl', Urls: [{ url: 'https://files.example/t.pdf' }] },
      { type: 'end' },
    ]);
    const { client } = clientReturning([
      [{ IVNUM: 'T16631', FINAL: null, STATDES: 'טיוטא' }],
      [{ IVNUM: 'IN999', FINAL: 'Y', STATDES: 'סופית' }],
    ]);
    const outcome = await printDocument(
      client,
      { form: 'AINVOICES', key: 'T16631' },
      {
        session: () => sessionFrom(fake),
        fetchFile: async () => ({ bytes: PDF, contentType: 'application/pdf' }),
      },
    );
    expect(outcome).toMatchObject({
      status: 'status-changed',
      statusCheck: 'changed',
      draft: true,
    });
    expect((outcome as { contentBase64?: string }).contentBase64).toBeTruthy();
    expect((outcome as { statusNote?: string }).statusNote).toContain('FINAL');
  });

  it('writes an oversized PDF to PRIORITY_PRINT_DIR and omits inline base64', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'print-pdf-'));
    const { outcome } = await run(
      'ORDERS',
      'SO26000419',
      [{ ORDNAME: 'SO26000419' }],
      orderSteps(),
      {
        deps: { maxBytes: 8, outputDir: dir },
      },
    );
    expect(outcome).toMatchObject({
      status: 'ok',
      contentOmitted: expect.stringContaining('inline limit'),
    });
    expect((outcome as { contentBase64?: string }).contentBase64).toBeUndefined();
    expect(readFileSync((outcome as { filePath: string }).filePath)).toEqual(PDF);
  });

  it('refuses an oversized PDF when there is nowhere to write it', async () => {
    const { outcome } = await run(
      'ORDERS',
      'SO26000419',
      [{ ORDNAME: 'SO26000419' }],
      orderSteps(),
      {
        deps: { maxBytes: 8 },
      },
    );
    expect(outcome).toMatchObject({ status: 'failed', reason: 'too-large' });
  });
});

describe('priority_print_document tool', () => {
  it('returns intact base64 and describes the display-mode safety contract', async () => {
    const big = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(20_000, 0x25),
      Buffer.from('\n%%EOF'),
    ]);
    const fake = scripted(orderSteps());
    const { client } = clientReturning([[{ ORDNAME: 'SO26000419' }], [{ ORDNAME: 'SO26000419' }]]);
    const handlers = new Map<
      string,
      (params: unknown) => Promise<{
        content: Array<{
          type: string;
          text?: string;
          resource?: { blob?: string; mimeType?: string };
        }>;
        structuredContent?: unknown;
        isError?: boolean;
      }>
    >();
    let description = '';
    const server = {
      tool: (
        name: string,
        desc: string,
        schema: z.ZodRawShape,
        fn: (params: unknown) => Promise<unknown>,
      ) => {
        description = desc;
        handlers.set(name, async (params) => fn(z.object(schema).parse(params)) as never);
      },
    } as unknown as McpServer;
    registerPrintDocumentTool(server, client, {} as never, {
      session: () => sessionFrom(fake),
      fetchFile: async () => ({ bytes: big, contentType: 'application/pdf' }),
    });
    expect(description).toContain("mode: 'display'");
    expect(description).toContain('CLOSEANINVOICE');
    expect(description).toContain('העתק');
    expect(description).toContain('WWWSHOWORDER');
    expect(description).toContain('T16631');
    const handler = handlers.get('priority_print_document');
    if (!handler) throw new Error('tool not registered');
    const result = await handler({
      form: 'ORDERS',
      key: 'SO26000419',
    });
    const body = JSON.parse(result.content[0].text ?? '') as {
      contentBase64: string;
      filename: string;
      mimeType: string;
    };
    expect(body.filename).toBe('ORDERS-SO26000419.pdf');
    expect(body.mimeType).toBe('application/pdf');
    expect(Buffer.from(body.contentBase64, 'base64')).toEqual(big);
    expect(body.contentBase64.length).toBeGreaterThan(24_000);
    expect((result.structuredContent as { contentBase64: string }).contentBase64).toBe(
      body.contentBase64,
    );
    expect(result.content[1].resource).toMatchObject({
      mimeType: 'application/pdf',
      blob: body.contentBase64,
    });
    expect(result.isError).toBeUndefined();
  });
});

describe('html to pdf fallback', () => {
  it('injects a base href and does not put the file URL on the Chrome command line', async () => {
    const pageUrl = 'https://files.example/netfiles/token/order.html';
    expect(htmlWithBase('<html><head></head><body>x</body></html>', pageUrl)).toContain(
      '<base href="https://files.example/netfiles/token/">',
    );
    const pdf = await convertHtmlToPdf(
      { html: Buffer.from('<html><head></head><body>שלום</body></html>'), pageUrl },
      {
        chromePath: process.execPath,
        execFileImpl: async (_file, args) => {
          const out = args
            .find((arg) => arg.startsWith('--print-to-pdf='))
            ?.slice('--print-to-pdf='.length);
          if (!out) throw new Error('missing --print-to-pdf path');
          expect(args.join(' ')).not.toContain('files.example');
          expect(args).toContain('--headless=new');
          const htmlPath = args[args.length - 1];
          expect(readFileSync(htmlPath, 'utf8')).toContain(
            '<base href="https://files.example/netfiles/token/">',
          );
          writeFileSync(out, Buffer.from('%PDF-1.4\n%%EOF'));
          return { stdout: '', stderr: '' };
        },
      },
    );
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('names a missing PRIORITY_CHROME_PATH', async () => {
    await expect(
      convertHtmlToPdf({ html: Buffer.from('<html></html>') }, { chromePath: '/no/such/chrome' }),
    ).rejects.toThrow(/PRIORITY_CHROME_PATH/);
  });
});
