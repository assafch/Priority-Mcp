import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PriorityClient } from '../src/client/priority-client.js';
import {
  type WebSdkForm,
  type WebSdkLoginConfig,
  type WebSdkModule,
  type WebSdkProcStep,
  type WebSdkRow,
  type WebSdkServerMessage,
  WebSdkSession,
  deriveWebSdkLoginConfig,
} from '../src/client/web-sdk.js';
import type { Config } from '../src/config.js';
import {
  CLOSE_ACTIVATION,
  COOLDOWN_MS,
  type CloseIdentity,
  type InvoiceRow,
  checkSdkRow,
  checkSdkSiblings,
  claimPaths,
  classifyPreflight,
  closeInvoice,
  describeError,
  normalizeFormMessage,
  validateIdentity,
} from '../src/lib/invoice-close.js';
import { createLogger } from '../src/logger.js';
import { registerCloseInvoiceTool } from '../src/tools/close-invoice.js';

/**
 * priority_close_invoice runs Priority's own CLOSEANINVOICE through the Web SDK. These tests drive
 * the orchestration against a scripted fake SDK and a fake OData backend: nothing here touches a
 * Priority server. They pin the safety contract — full identity, clean-draft preflight, no sibling
 * drafts, order-level locking across processes, dry-run by default, cancel on anything unexpected,
 * no retry, status decided by the OData readback, cooldown after an unconfirmed dispatch, and an
 * append-only ledger whose failure never hides a result.
 */

const config = {
  priorityBaseUrl: 'https://p.test/odata/Priority/tabp008h.ini',
  priorityCompany: 'demo',
  priorityPat: 'tok',
  priorityReadOnly: false,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 10000,
  requestTimeoutMs: 500,
  logLevel: 'error',
  priorityEnvironment: 'tabula.ini',
} as unknown as Config;
const logger = createLogger(config);

const ID: CloseIdentity = {
  form: 'EINVOICES',
  ivnum: 'T173',
  booknum: 'WC-38435',
  party: 'www',
  totprice: 98.7,
};
const draft: InvoiceRow = {
  IVNUM: 'T173',
  IV: 99142,
  DEBIT: 'D',
  IVTYPE: 'E',
  BOOKNUM: 'WC-38435',
  TOTPRICE: 98.7,
  STATDES: 'טיוטא',
  FINAL: null,
  FNCNUM: null,
  IVDATE: '2026-10-29T00:00:00Z',
  CUSTNAME: 'www',
};
const final: InvoiceRow = {
  ...draft,
  IVNUM: 'OV265000999',
  STATDES: 'סופית',
  FINAL: 'Y',
  FNCNUM: '26003999',
};
const sibling: InvoiceRow = { ...draft, IVNUM: 'T180', IV: 99180 };
const journal = {
  FNCNUM: '26003999',
  FNCREF: 'OV265000999',
  FINAL: 'Y',
  BALDATE: '2026-10-29T00:00:00Z',
  SUMDEBIT: 98.7,
  SUMCREDIT: 98.7,
};

const loginConfig: WebSdkLoginConfig = {
  url: 'https://p.test/wcf/service.svc',
  tabulaini: 'tabp008h.ini',
  language: 1,
  profile: { company: 'demo' },
  appname: 'test',
  devicename: 'test',
  appid: 'test',
  appkey: '',
  username: 'tok',
  password: 'PAT',
};

interface ODataState {
  /** Rows for the BOOKNUM+party read. */
  rows: () => InvoiceRow[];
  /** Rows for the BOOKNUM-only (any party) read; defaults to rows(). */
  anyParty?: () => InvoiceRow[];
  journal?: Record<string, unknown> | null;
  subformLines?: number;
}

/** OData backend: rows by BOOKNUM (+party), FNCTRANS, the final doc's journal sub-form. GET only. */
function fakeOData(state: ODataState) {
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = decodeURIComponent(String(input instanceof Request ? input.url : input));
    if (init?.method && init.method !== 'GET') throw new Error(`unexpected ${init.method} ${url}`);
    if (/\/FNCTRANS\?/.test(url))
      return respond({ value: state.journal === null ? [] : [state.journal ?? journal] });
    if (/\/(EINVOICES|AINVOICES|PINVOICES)\(/.test(url)) {
      return respond({
        IVNUM: 'OV265000999',
        IVFNCTRANS_SUBFORM: Array.from({ length: state.subformLines ?? 2 }, (_, i) => ({
          KLINE: i + 1,
        })),
      });
    }
    if (/\/(EINVOICES|AINVOICES|PINVOICES)\?/.test(url)) {
      const anyParty = !/ and (CUSTNAME|SUPNAME) eq /.test(url);
      return respond({ value: anyParty ? (state.anyParty ?? state.rows)() : state.rows() });
    }
    throw new Error(`unexpected GET ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const sdkDraftRow = (ivnum = 'T173', extra: Record<string, unknown> = {}): WebSdkRow => ({
  IVNUM: ivnum,
  BOOKNUM: 'WC-38435',
  CUSTNAME: 'www',
  TOTPRICE: '98.70',
  STATDES: 'טיוטא',
  IVDATE: '2026-10-29',
  metadata: { color: '#000000' },
  ...extra,
});

interface FakeSdkOptions {
  rows?: Record<string, WebSdkRow>;
  steps?: WebSdkProcStep[];
  activations?: Record<string, { background: number; confirm: number }> | undefined;
  /** Delivered through the formStart callback as the real SDK does: ONE argument, form inside. */
  openMessages?: WebSdkServerMessage[];
  onActivate?: () => void;
  slowActivateMs?: number;
  /** Make proc.message hang (never settle). */
  hangMessage?: boolean;
  rejectSetActiveRowWith?: unknown;
  loginRejects?: number;
  /** Make proc.cancel hang (the real SDK polls until the server answers). */
  hangCancel?: boolean;
}

/** A scripted Web SDK: records every call, replays the given procedure steps. */
function fakeSdk(opts: FakeSdkOptions = {}) {
  const calls: string[] = [];
  const steps = opts.steps ?? [{ type: 'end' }];
  const rows: Record<string, WebSdkRow> = opts.rows ?? { '1': sdkDraftRow() };
  let cursor = 0;
  let loginsLeftToReject = opts.loginRejects ?? 0;
  const proc = {
    message: vi.fn(async (ok: 0 | 1) => {
      calls.push(`message(${ok})`);
      if (opts.hangMessage) return new Promise<WebSdkProcStep>(() => {});
      cursor++;
      return { ...steps[cursor], proc };
    }),
    cancel: vi.fn(async () => {
      calls.push('cancel');
      if (opts.hangCancel) await new Promise(() => {});
    }),
  };
  const sdk: WebSdkModule = {
    login: vi.fn(async () => {
      calls.push('login');
      if (loginsLeftToReject-- > 0)
        throw { type: 'apiError', code: 'loginFailed', message: 'bad login' };
      return {};
    }),
    formStart: vi.fn(async (name, onMessage) => {
      calls.push(`formStart(${name})`);
      const form: WebSdkForm = {
        activations:
          'activations' in opts
            ? opts.activations
            : { [`${CLOSE_ACTIVATION}.P`]: { background: 0, confirm: 1 } },
        warningConfirm: vi.fn((ok: 0 | 1) => calls.push(`warningConfirm(${ok})`)),
        infoMsgConfirm: vi.fn(() => calls.push('infoMsgConfirm')),
        setSearchFilter: vi.fn(async (f: unknown) => {
          calls.push(
            `setSearchFilter(${JSON.stringify((f as { QueryValues: unknown[] }).QueryValues)})`,
          );
        }),
        getRows: vi.fn(async () => {
          calls.push('getRows');
          return { [name]: rows };
        }),
        setActiveRow: vi.fn(async (i: number) => {
          calls.push(`setActiveRow(${i})`);
          if (opts.rejectSetActiveRowWith) throw opts.rejectSetActiveRowWith;
        }),
        activateStart: vi.fn(async (ename: string, type: string) => {
          calls.push(`activateStart(${ename},${type})`);
          if (opts.slowActivateMs) await new Promise((r) => setTimeout(r, opts.slowActivateMs));
          opts.onActivate?.();
          cursor = 0;
          return { ...steps[0], proc };
        }),
        activateEnd: vi.fn(async () => {
          calls.push('activateEnd');
        }),
        endCurrentForm: vi.fn(async () => {
          calls.push('endCurrentForm');
        }),
      };
      // Real SDK shape: a single message argument carrying the form.
      for (const m of opts.openMessages ?? [])
        (onMessage as (msg: unknown) => void)({ ...m, form });
      return form;
    }),
  };
  return { sdk, calls, proc };
}

function deps(sdk: WebSdkModule, ledgerDir = mkdtempSync(join(tmpdir(), 'close-'))) {
  const session = new WebSdkSession(sdk, loginConfig);
  const ledgerPath = join(ledgerDir, 'ledger.jsonl');
  let clock = Date.parse('2026-11-04T10:00:00.000Z');
  return {
    session: () => session,
    ledgerPath,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    stepTimeoutMs: 1000,
    endTimeoutMs: 200,
  };
}

function ledgerLines(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const client = () => new PriorityClient(config, logger);
const T0 = Date.parse('2026-11-04T10:00:00.000Z');

afterEach(() => vi.unstubAllGlobals());

describe('validateIdentity', () => {
  it('accepts a full draft identity and rounds the amount', () => {
    expect(validateIdentity({ ...ID, totprice: 98.699999 })).toEqual(ID);
  });
  it('rejects anything that cannot be a draft identity', () => {
    expect(() => validateIdentity({ ...ID, ivnum: 'OV265000050' })).toThrow(/T<digits>/);
    expect(() => validateIdentity({ ...ID, form: 'TINVOICES' })).toThrow(/form must be/);
    expect(() => validateIdentity({ ...ID, booknum: '' })).toThrow(/booknum/);
    expect(() => validateIdentity({ ...ID, party: 'www\n' })).toThrow(/party/);
    expect(() => validateIdentity({ ...ID, totprice: Number.NaN })).toThrow(/totprice/);
  });
});

describe('classifyPreflight', () => {
  it('approves a clean draft', () => {
    expect(classifyPreflight(ID, [draft])).toMatchObject({ ok: true, row: { IVNUM: 'T173' } });
  });
  it('refuses when the draft is missing, closed already, duplicated or ambiguous', () => {
    expect(classifyPreflight(ID, [])).toMatchObject({ ok: false, reason: 'not-found' });
    expect(classifyPreflight(ID, [final])).toMatchObject({ ok: false, reason: 'already-closed' });
    expect(classifyPreflight(ID, [draft, final])).toMatchObject({
      ok: false,
      reason: 'duplicate-final',
    });
    expect(classifyPreflight(ID, [draft, { ...draft }])).toMatchObject({
      ok: false,
      reason: 'ambiguous',
    });
  });
  it('refuses a final under another customer for customer forms only', () => {
    const foreign = { ...final, CUSTNAME: 'ABC' };
    expect(classifyPreflight(ID, [draft], [foreign])).toMatchObject({
      ok: false,
      reason: 'duplicate-final',
    });
    const pid: CloseIdentity = { ...ID, form: 'PINVOICES', party: '200003' };
    const prow = { ...draft, SUPNAME: '200003', IVTYPE: 'P' };
    expect(classifyPreflight(pid, [prow], [])).toMatchObject({ ok: true });
  });
  it('refuses sibling open drafts unless allowed', () => {
    expect(classifyPreflight(ID, [draft, sibling])).toMatchObject({
      ok: false,
      reason: 'sibling-drafts',
    });
    expect(classifyPreflight(ID, [draft, sibling], [], true)).toMatchObject({
      ok: true,
      others: [{ IVNUM: 'T180' }],
    });
  });
  it('names the FINAL-without-journal half-state and points to support', () => {
    const r = classifyPreflight(ID, [{ ...draft, FINAL: 'Y' }]);
    expect(r).toMatchObject({ ok: false, reason: 'half-state' });
    expect((r as { detail: string }).detail).toContain('SCI26096671');
  });
  it('refuses non-drafts, amount differences and missing amounts', () => {
    expect(classifyPreflight(ID, [{ ...draft, STATDES: 'סופית' }])).toMatchObject({
      reason: 'not-a-draft',
    });
    expect(classifyPreflight(ID, [{ ...draft, FNCNUM: '1' }])).toMatchObject({
      reason: 'not-a-draft',
    });
    expect(classifyPreflight(ID, [{ ...draft, TOTPRICE: 98.71 }])).toMatchObject({
      reason: 'amount-mismatch',
    });
    expect(
      classifyPreflight({ ...ID, totprice: 0 }, [{ ...draft, TOTPRICE: undefined }]),
    ).toMatchObject({ reason: 'amount-mismatch' });
    expect(classifyPreflight(ID, [{ ...draft, TOTPRICE: '98.70' }])).toMatchObject({ ok: true });
  });
});

describe('SDK row checks', () => {
  it('requires the identity columns and cross-checks the OData row', () => {
    expect(checkSdkRow(ID, sdkDraftRow(), draft)).toBeNull();
    expect(checkSdkRow(ID, sdkDraftRow('T173', { TOTPRICE: '1,346.03' }), draft)).toContain(
      'TOTPRICE',
    );
    const { TOTPRICE: _omit, ...noAmount } = sdkDraftRow();
    expect(checkSdkRow({ ...ID, totprice: 0 }, noAmount, draft)).toContain('TOTPRICE');
    expect(checkSdkRow(ID, sdkDraftRow('T173', { IVDATE: '2020-01-01' }), draft)).toContain(
      'IVDATE',
    );
    expect(checkSdkRow(ID, sdkDraftRow('T173', { IV: '12345' }), draft)).toContain('IV');
    expect(checkSdkRow(ID, sdkDraftRow('T173', { DEBIT: 'C' }), draft)).toContain('DEBIT');
    expect(checkSdkRow(ID, sdkDraftRow('T173', { FINAL: 'Y' }), draft)).toContain('FINAL');
  });
  it('blocks when another row of the BOOKNUM is final, or an open draft when siblings are not allowed', () => {
    const closedSibling = sdkDraftRow('OV265000998', { STATDES: 'סופית' });
    expect(checkSdkSiblings(ID, [sdkDraftRow(), closedSibling], true)).toContain('OV265000998');
    expect(checkSdkSiblings(ID, [sdkDraftRow(), sdkDraftRow('T180')], false)).toContain('T180');
    expect(checkSdkSiblings(ID, [sdkDraftRow(), sdkDraftRow('T180')], true)).toBeNull();
  });
  it('normalizes both callback shapes and describes object rejections', () => {
    const form = {} as WebSdkForm;
    expect(normalizeFormMessage([{ type: 'warning', message: 'x', form }])).toMatchObject({
      form,
      message: { type: 'warning' },
    });
    expect(normalizeFormMessage([form, { type: 'information' }])).toMatchObject({
      form,
      message: { type: 'information' },
    });
    expect(describeError({ type: 'apiError', code: 'exception', message: 'לא ניתן' })).toBe(
      'type=apiError code=exception message=לא ניתן',
    );
    expect(describeError(new Error('boom'))).toBe('boom');
  });
});

describe('closeInvoice', () => {
  it('dryRun: preflight + plan, the SDK is never loaded or logged into', async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk();
    const d = deps(f.sdk);
    const out = await closeInvoice(client(), { ...ID, dryRun: true }, false, d);
    expect(out.status).toBe('preview');
    expect(out).toMatchObject({
      plan: { procedure: 'CLOSEANINVOICE', activation: 'CLOSEANINVOICE.P' },
    });
    expect(f.calls).toEqual([]);
    expect(ledgerLines(d.ledgerPath)).toEqual([]);
  });

  it('dryRun + probeSdk: logs in and locates the row read-only — no setActiveRow, no activation', async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk();
    const out = await closeInvoice(
      client(),
      { ...ID, dryRun: true, probeSdk: true },
      false,
      deps(f.sdk),
    );
    expect(out.status).toBe('preview');
    expect((out as { sdkProbe: { sdkRow: WebSdkRow } }).sdkProbe.sdkRow).toMatchObject({
      IVNUM: 'T173',
    });
    expect(f.calls).toEqual([
      'login',
      'formStart(EINVOICES)',
      'setSearchFilter([{"field":"BOOKNUM","fromval":"WC-38435","op":"="}])',
      'getRows',
      'endCurrentForm',
    ]);
  });

  it('refuses before the SDK when the preflight fails (half-state T173, sibling drafts)', async () => {
    fakeOData({ rows: () => [{ ...draft, FINAL: 'Y' }] });
    const f = fakeSdk();
    let out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(f.sdk));
    expect(out).toMatchObject({ status: 'refused', reason: 'half-state' });
    fakeOData({ rows: () => [draft, sibling] });
    out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(f.sdk));
    expect(out).toMatchObject({ status: 'refused', reason: 'sibling-drafts' });
    expect(f.calls).toEqual([]);
  });

  it('read-only mode never activates', async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk();
    const out = await closeInvoice(client(), { ...ID, dryRun: false }, true, deps(f.sdk));
    expect(out).toMatchObject({ status: 'refused', reason: 'read-only' });
    expect(f.calls).toEqual([]);
  });

  it('closes a clean draft: information step accepted, OData shows the final document and journal, claims released', async () => {
    let closed = false;
    fakeOData({ rows: () => (closed ? [final] : [draft]) });
    const f = fakeSdk({
      steps: [
        { type: 'message', messagetype: 'information', message: 'החשבונית נסגרה בהצלחה' },
        { type: 'end' },
      ],
      onActivate: () => {
        closed = true;
      },
    });
    const d = deps(f.sdk);
    const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, d);
    expect(out.status).toBe('closed');
    expect(out).toMatchObject({
      after: { IVNUM: 'OV265000999', FNCNUM: '26003999' },
      journal: { found: true, FINAL: 'Y', journalSubformLines: 2 },
    });
    expect(f.calls).toEqual([
      'login',
      'formStart(EINVOICES)',
      'setSearchFilter([{"field":"BOOKNUM","fromval":"WC-38435","op":"="}])',
      'getRows',
      'setActiveRow(1)',
      'activateStart(CLOSEANINVOICE,P)',
      'message(1)',
      'activateEnd',
      'endCurrentForm',
    ]);
    const lines = ledgerLines(d.ledgerPath);
    expect(lines.map((l) => l.phase)).toEqual(['in_flight', 'closed']);
    expect(lines[1]).toMatchObject({ ivnum: 'T173', after: { IVNUM: 'OV265000999' } });
    for (const p of claimPaths(d.ledgerPath, ID)) expect(existsSync(p)).toBe(false);
  });

  it('accepts only prompts the caller listed exactly; anything else cancels before the end', async () => {
    let closed = false;
    fakeOData({ rows: () => (closed ? [final] : [draft]) });
    const prompt = 'האם לסגור את החשבונית?';
    const ok = fakeSdk({
      steps: [{ type: 'message', messagetype: 'warning', message: prompt }, { type: 'end' }],
      onActivate: () => {
        closed = true;
      },
    });
    const accepted = await closeInvoice(
      client(),
      { ...ID, dryRun: false, acceptPrompts: [prompt] },
      false,
      deps(ok.sdk),
    );
    expect(accepted.status).toBe('closed');
    expect(ok.proc.message).toHaveBeenCalledWith(1);

    fakeOData({ rows: () => [draft] }); // fresh backend: the draft is still open for this case
    const unlisted = fakeSdk({
      steps: [{ type: 'message', messagetype: 'warning', message: prompt }, { type: 'end' }],
    });
    const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(unlisted.sdk));
    expect(out).toMatchObject({ status: 'unknown', procedure: { outcome: 'cancelled' } });
    expect(unlisted.proc.cancel).toHaveBeenCalledTimes(1);
    expect(unlisted.proc.message).not.toHaveBeenCalled();
    expect(unlisted.calls).not.toContain('activateEnd');
    expect(
      (out as { procedure: { steps: Array<{ message?: string }> } }).procedure.steps[0].message,
    ).toBe(prompt);
  });

  it('cancels on an error step or an input dialog (dispatched → unknown, cooldown set)', async () => {
    for (const steps of [
      [{ type: 'message', messagetype: 'error', message: 'שגיאה' }],
      [{ type: 'inputFields', input: { title: 'פרמטרים' } }],
    ]) {
      fakeOData({ rows: () => [draft] });
      const f = fakeSdk({ steps });
      const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(f.sdk));
      expect(out).toMatchObject({
        status: 'unknown',
        dispatched: true,
        procedure: { outcome: 'cancelled' },
      });
      expect(f.proc.cancel).toHaveBeenCalledTimes(1);
      expect((out as { cooldownUntil: string }).cooldownUntil).toBe(
        new Date(T0 + COOLDOWN_MS).toISOString(),
      );
    }
  });

  it('form messages arrive as ONE argument: information is acknowledged, a warning is declined and stops the close before activation', async () => {
    fakeOData({ rows: () => [draft] });
    const warned = fakeSdk({ openMessages: [{ type: 'warning', message: 'אזהרה כלשהי' }] });
    let out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(warned.sdk));
    expect(out).toMatchObject({ status: 'failed', dispatched: false });
    expect((out as { error: string }).error).toContain('אזהרה כלשהי');
    expect(warned.calls).toContain('warningConfirm(0)');
    expect(warned.calls).not.toContain('activateStart(CLOSEANINVOICE,P)');

    let closed = false;
    fakeOData({ rows: () => (closed ? [final] : [draft]) });
    const informed = fakeSdk({
      openMessages: [{ type: 'information', message: 'שים לב' }],
      onActivate: () => {
        closed = true;
      },
    });
    out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(informed.sdk));
    expect(out.status).toBe('closed');
    expect(informed.calls).toContain('infoMsgConfirm');
    expect((out as { procedure: { formMessages: unknown[] } }).procedure.formMessages).toEqual([
      { type: 'information', code: undefined, message: 'שים לב', fatal: undefined },
    ]);
  });

  it('refuses when the SDK row differs, a sibling row is final, or the activation metadata is wrong — nothing dispatched', async () => {
    fakeOData({ rows: () => [draft] });
    const other = fakeSdk({ rows: { '1': sdkDraftRow('T173', { TOTPRICE: '99.70' }) } });
    let out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(other.sdk));
    expect(out).toMatchObject({ status: 'failed', dispatched: false });
    expect((out as { error: string }).error).toContain('TOTPRICE');
    expect(other.calls).not.toContain('setActiveRow(1)');

    // A sibling that became final between the OData preflight and the SDK read.
    const raced = fakeSdk({
      rows: { '1': sdkDraftRow('OV265000998', { STATDES: 'סופית' }), '2': sdkDraftRow() },
    });
    out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(raced.sdk));
    expect(out).toMatchObject({ status: 'failed', dispatched: false });
    expect((out as { error: string }).error).toContain('OV265000998');
    expect(raced.calls).not.toContain('activateStart(CLOSEANINVOICE,P)');

    const noAct = fakeSdk({ activations: {} });
    out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(noAct.sdk));
    expect((out as { error: string }).error).toContain('CLOSEANINVOICE.P');
    const background = fakeSdk({
      activations: { 'CLOSEANINVOICE.P': { background: 1, confirm: 1 } },
    });
    out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(background.sdk));
    expect((out as { error: string }).error).toContain('activation metadata');
    expect(background.calls).not.toContain('activateStart(CLOSEANINVOICE,P)');
  });

  it('SDK object rejections are described, not "[object Object]"', async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk({
      rejectSetActiveRowWith: {
        type: 'apiError',
        code: 'exception',
        message: 'לא ניתן לעדכן מסמך סופי',
      },
    });
    const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(f.sdk));
    expect(out).toMatchObject({ status: 'failed', dispatched: false });
    expect((out as { error: string }).error).toContain('לא ניתן לעדכן מסמך סופי');
  });

  it("the OData readback decides: a transport failure after dispatch still reports 'closed' when the document is final", async () => {
    let closed = false;
    fakeOData({ rows: () => (closed ? [final] : [draft]) });
    const f = fakeSdk({
      steps: [{ type: 'message', messagetype: 'information', message: 'נסגר' }, { type: 'end' }],
      hangMessage: true,
      onActivate: () => {
        closed = true;
      },
    });
    const d = { ...deps(f.sdk), stepTimeoutMs: 30 };
    const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, d);
    expect(out.status).toBe('closed');
    expect((out as { procedure: { error?: string } }).procedure.error).toContain('timed out');
    expect(f.proc.cancel).toHaveBeenCalledTimes(1); // best-effort cancel of the hung step
    expect(ledgerLines(d.ledgerPath).map((l) => l.phase)).toEqual(['in_flight', 'closed']);
  });

  it("reports 'unverified' (never retries) when the procedure ends but OData still shows the draft, and the cooldown refuses a second dispatch", async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk();
    const d = deps(f.sdk);
    const first = await closeInvoice(client(), { ...ID, dryRun: false }, false, d);
    expect(first).toMatchObject({
      status: 'unverified',
      dispatched: true,
      verification: { verified: false },
    });
    const second = await closeInvoice(client(), { ...ID, dryRun: false }, false, d);
    expect(second).toMatchObject({ status: 'refused', reason: 'cooldown' });
    d.advance(COOLDOWN_MS + 1);
    const third = await closeInvoice(client(), { ...ID, dryRun: false }, false, d);
    expect(third.status).toBe('unverified'); // preflight re-read first: still a draft, so a new attempt is allowed
    expect(f.calls.filter((c) => c.startsWith('activateStart'))).toHaveLength(2);
    expect(ledgerLines(d.ledgerPath).map((l) => l.phase)).toEqual([
      'in_flight',
      'unverified',
      'in_flight',
      'unverified',
    ]);
  });

  it("reports 'unverified' when the journal entry is missing or the final has another internal IV", async () => {
    let closed = false;
    fakeOData({ rows: () => (closed ? [final] : [draft]), journal: null });
    let f = fakeSdk({
      onActivate: () => {
        closed = true;
      },
    });
    let out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(f.sdk));
    expect(out).toMatchObject({ status: 'unverified' });
    expect((out as { verification: { reason: string } }).verification.reason).toContain('journal');

    closed = false;
    fakeOData({ rows: () => (closed ? [{ ...final, IV: 1 }] : [draft]) });
    f = fakeSdk({
      onActivate: () => {
        closed = true;
      },
    });
    out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(f.sdk));
    expect((out as { verification: { reason: string } }).verification.reason).toContain(
      'internal IV',
    );
  });

  it('serializes per document and per order (two drafts of one order never both activate)', async () => {
    fakeOData({ rows: () => [draft, sibling] });
    const f = fakeSdk({
      slowActivateMs: 50,
      rows: { '1': sdkDraftRow(), '2': sdkDraftRow('T180') },
    });
    const d = deps(f.sdk);
    const c = client();
    const siblingId = { ...ID, ivnum: 'T180' };
    const [a, b] = await Promise.all([
      closeInvoice(c, { ...ID, dryRun: false, allowSiblingDrafts: true }, false, d),
      new Promise((r) => setTimeout(r, 10)).then(() =>
        closeInvoice(c, { ...siblingId, dryRun: false, allowSiblingDrafts: true }, false, d),
      ),
    ]);
    expect([a.status, b.status].sort()).toEqual(['refused', 'unverified']);
    expect(f.calls.filter((x) => x.startsWith('activateStart'))).toHaveLength(1);
  });

  it('a claim file from another process refuses; a stale one is replaced', async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk();
    const d = deps(f.sdk);
    const [docClaim] = claimPaths(d.ledgerPath, ID);
    mkdirSync(join(d.ledgerPath, '..', 'locks'), { recursive: true });
    writeFileSync(
      docClaim,
      JSON.stringify({ t: d.now() - 1000, pid: 4242, phase: 'in_flight', ...ID }),
    );
    let out = await closeInvoice(client(), { ...ID, dryRun: false }, false, d);
    expect(out).toMatchObject({ status: 'refused', reason: 'in-flight' });
    expect((out as { detail: string }).detail).toContain('4242');
    expect(f.calls).toEqual([]);
    writeFileSync(
      docClaim,
      JSON.stringify({ t: d.now() - 61 * 60_000, pid: 4242, phase: 'in_flight', ...ID }),
    );
    out = await closeInvoice(client(), { ...ID, dryRun: false }, false, d);
    expect(out.status).toBe('unverified');
    expect(f.calls.filter((x) => x.startsWith('activateStart'))).toHaveLength(1);
  });

  it('an unwritable ledger refuses before anything is dispatched', async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk();
    const d = deps(f.sdk);
    writeFileSync(d.ledgerPath, '');
    chmodSync(d.ledgerPath, 0o400);
    try {
      const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, d);
      expect(out).toMatchObject({ status: 'refused', reason: 'ledger-unwritable' });
      expect(f.calls).toEqual([]);
      for (const p of claimPaths(d.ledgerPath, ID)) expect(existsSync(p)).toBe(false);
    } finally {
      chmodSync(d.ledgerPath, 0o600);
    }
  });

  it('a failed login is retried on the next call (session reset)', async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk({ loginRejects: 1 });
    const d = deps(f.sdk);
    const first = await closeInvoice(
      client(),
      { ...ID, dryRun: true, probeSdk: true },
      false,
      d,
    ).catch((e) => e);
    expect(first).toBeInstanceOf(Error);
    expect(String(first.message)).toContain('loginFailed');
    const second = await closeInvoice(client(), { ...ID, dryRun: true, probeSdk: true }, false, d);
    expect(second.status).toBe('preview');
    expect(f.calls.filter((c) => c === 'login')).toHaveLength(2);
  });
});

describe('deriveWebSdkLoginConfig', () => {
  it('derives host, .ini, company and PAT identity from the OData configuration', () => {
    const c = deriveWebSdkLoginConfig(config, {});
    expect(c).toMatchObject({
      url: 'https://p.test/wcf/service.svc',
      tabulaini: 'tabp008h.ini',
      profile: { company: 'demo' },
      username: 'tok',
      password: 'PAT',
      language: 1,
    });
  });
  it('honours the PRIORITY_WEB_* overrides', () => {
    const c = deriveWebSdkLoginConfig(config, {
      PRIORITY_WEB_URL: 'https://other.test/wcf/service.svc',
      PRIORITY_WEB_TABULAINI: 'tabula.ini',
      PRIORITY_WEB_LANGUAGE: '3',
      PRIORITY_WEB_APPNAME: 'cfo-books',
    });
    expect(c).toMatchObject({
      url: 'https://other.test/wcf/service.svc',
      tabulaini: 'tabula.ini',
      language: 3,
      appname: 'cfo-books',
    });
  });
});

describe('priority_close_invoice tool', () => {
  type Handler = (p: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
  function harness(sdk: WebSdkModule) {
    const handlers = new Map<string, Handler>();
    const server = {
      tool: (name: string, _desc: string, schema: z.ZodRawShape, fn: Handler) =>
        handlers.set(name, (p) => fn(z.object(schema).parse(p))),
    } as unknown as McpServer;
    registerCloseInvoiceTool(server, client(), config, deps(sdk));
    return async (p: unknown) => {
      const h = handlers.get('priority_close_invoice');
      if (!h) throw new Error('tool not registered');
      const res = await h(p);
      return { ...JSON.parse(res.content[0].text), isError: res.isError };
    };
  }
  const T173 = {
    form: 'EINVOICES',
    ivnum: 'T173',
    booknum: 'WC-38435',
    party: 'www',
    totprice: 98.7,
  };

  it('previews by default and never writes', async () => {
    const fetchMock = fakeOData({ rows: () => [draft] });
    const f = fakeSdk();
    const call = harness(f.sdk);
    const out = await call(T173);
    expect(out).toMatchObject({
      status: 'preview',
      dryRun: true,
      acknowledged: false,
      verified: false,
    });
    expect(out.isError).toBeFalsy();
    expect(f.calls).toEqual([]);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });

  it('marks refusals and unknown outcomes as errors, and rejects a non-draft number at the schema', async () => {
    fakeOData({ rows: () => [{ ...draft, FINAL: 'Y' }] });
    let call = harness(fakeSdk().sdk);
    const refused = await call({ ...T173, dryRun: false });
    expect(refused).toMatchObject({ status: 'refused', reason: 'half-state', isError: true });
    await expect(call({ ...T173, ivnum: 'OV265000050' })).rejects.toThrow();

    fakeOData({ rows: () => [draft] });
    call = harness(
      fakeSdk({ steps: [{ type: 'message', messagetype: 'error', message: 'x' }] }).sdk,
    );
    const unknown = await call({ ...T173, dryRun: false });
    expect(unknown).toMatchObject({
      status: 'unknown',
      acknowledged: false,
      verified: false,
      isError: true,
    });
    expect(unknown.verification.reason).toContain('Do not dispatch again');
  });
});

describe('second-review hardening', () => {
  it('locks the order on BOOKNUM alone for customer forms: two drafts under two customers never both activate', async () => {
    const other: InvoiceRow = { ...draft, IVNUM: 'T200', IV: 99200, CUSTNAME: 'ABC' };
    expect(claimPaths('/x/l.jsonl', ID)[1]).toBe(
      claimPaths('/x/l.jsonl', { ...ID, ivnum: 'T200', party: 'ABC' })[1],
    );
    expect(claimPaths('/x/l.jsonl', { ...ID, form: 'PINVOICES' })[1]).not.toBe(
      claimPaths('/x/l.jsonl', { ...ID, form: 'PINVOICES', party: 'ABC' })[1],
    );
    // default: the foreign open draft is a sibling at preflight, before any login
    fakeOData({ rows: () => [draft], anyParty: () => [draft, other] });
    const f0 = fakeSdk();
    const refused = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(f0.sdk));
    expect(refused).toMatchObject({ status: 'refused', reason: 'sibling-drafts' });
    expect((refused as { detail: string }).detail).toContain('ABC');
    expect(f0.calls).toEqual([]);
    // with the override, concurrent closes of the two drafts are still serialized
    const f = fakeSdk({
      slowActivateMs: 50,
      rows: { '1': sdkDraftRow(), '2': sdkDraftRow('T200', { CUSTNAME: 'ABC' }) },
    });
    const d = deps(f.sdk);
    const c = client();
    const [a, b] = await Promise.all([
      closeInvoice(c, { ...ID, dryRun: false, allowSiblingDrafts: true }, false, d),
      new Promise((r) => setTimeout(r, 10)).then(() =>
        closeInvoice(
          c,
          { ...ID, ivnum: 'T200', party: 'ABC', dryRun: false, allowSiblingDrafts: true },
          false,
          d,
        ),
      ),
    ]);
    expect([a.status, b.status].sort()).toEqual(['refused', 'unverified']);
    expect(f.calls.filter((x) => x.startsWith('activateStart'))).toHaveLength(1);
  });

  it('a cancel that never answers cannot hang the close: bounded, readback still decides', async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk({
      steps: [{ type: 'message', messagetype: 'error', message: 'x' }],
      hangCancel: true,
    });
    const d = { ...deps(f.sdk), endTimeoutMs: 30 };
    const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, d);
    expect(out).toMatchObject({ status: 'unknown', dispatched: true });
    expect(f.proc.cancel).toHaveBeenCalledTimes(1);
    expect(ledgerLines(d.ledgerPath).map((l) => l.phase)).toEqual(['in_flight', 'unknown']);
  });

  it('an empty or unparsable claim file blocks only until it is stale, by its file age', async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk();
    const d = deps(f.sdk);
    const [docClaim] = claimPaths(d.ledgerPath, ID);
    mkdirSync(join(d.ledgerPath, '..', 'locks'), { recursive: true });
    writeFileSync(docClaim, '');
    const fresh = await closeInvoice(client(), { ...ID, dryRun: false }, false, {
      ...d,
      now: () => Date.now(),
    });
    expect(fresh).toMatchObject({ status: 'refused', reason: 'in-flight' });
    const later = await closeInvoice(client(), { ...ID, dryRun: false }, false, {
      ...d,
      now: () => Date.now() + 61 * 60_000,
    });
    expect(later.status).toBe('unverified');
    expect(f.calls.filter((x) => x.startsWith('activateStart'))).toHaveLength(1);
  });

  it('a claim whose t is not a number is timed by its file and not taken over while fresh', async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk();
    const d = deps(f.sdk);
    const [docClaim] = claimPaths(d.ledgerPath, ID);
    mkdirSync(join(d.ledgerPath, '..', 'locks'), { recursive: true });
    writeFileSync(
      docClaim,
      JSON.stringify({ t: '2026-11-04T10:00:00Z', pid: 4242, phase: 'in_flight' }),
    );
    const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, {
      ...d,
      now: () => Date.now(),
    });
    expect(out).toMatchObject({ status: 'refused', reason: 'in-flight' });
    expect(f.calls).toEqual([]);
  });

  it('a stale claim being replaced by another process (takeover lock held) refuses instead of racing', async () => {
    fakeOData({ rows: () => [draft] });
    const f = fakeSdk();
    const d = deps(f.sdk);
    const [docClaim] = claimPaths(d.ledgerPath, ID);
    mkdirSync(join(d.ledgerPath, '..', 'locks'), { recursive: true });
    writeFileSync(
      docClaim,
      JSON.stringify({
        t: d.now() - 61 * 60_000,
        pid: 4242,
        token: 'old',
        phase: 'in_flight',
        ...ID,
      }),
    );
    writeFileSync(`${docClaim}.takeover`, String(Date.now()));
    const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, d);
    expect(out).toMatchObject({ status: 'refused', reason: 'in-flight' });
    expect(f.calls).toEqual([]);
    expect(JSON.parse(readFileSync(docClaim, 'utf8')).token).toBe('old');
  });

  it('release never removes or rewrites a claim another attempt now owns', async () => {
    fakeOData({ rows: () => [draft] });
    const d = deps(fakeSdk().sdk);
    const [docClaim] = claimPaths(d.ledgerPath, ID);
    const f = fakeSdk({
      onActivate: () =>
        writeFileSync(
          docClaim,
          JSON.stringify({ t: d.now(), pid: 7, token: 'theirs', phase: 'in_flight', ...ID }),
        ),
    });
    const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, {
      ...d,
      session: () => new WebSdkSession(f.sdk, loginConfig),
    });
    expect(out.status).toBe('unverified');
    expect(JSON.parse(readFileSync(docClaim, 'utf8')).token).toBe('theirs');
  });

  it('a draft closed by someone else between preflight and the SDK is reported as refused already-closed, not closed', async () => {
    let reads = 0;
    fakeOData({ rows: () => (reads++ < 1 ? [draft] : [final]), anyParty: () => [draft] });
    const f = fakeSdk({ rows: { '1': sdkDraftRow('OV265000999', { STATDES: 'סופית' }) } });
    const d = deps(f.sdk);
    const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, d);
    expect(out).toMatchObject({ status: 'refused', reason: 'already-closed' });
    expect(f.calls).not.toContain('activateStart(CLOSEANINVOICE,P)');
    expect(ledgerLines(d.ledgerPath).map((l) => l.phase)).toEqual([
      'in_flight',
      'closed-elsewhere',
    ]);
  });

  it('a listed prompt text is accepted only on a warning step, never on an error step', async () => {
    fakeOData({ rows: () => [draft] });
    const text = 'האם לסגור את החשבונית?';
    const f = fakeSdk({
      steps: [{ type: 'message', messagetype: 'error', message: text }, { type: 'end' }],
    });
    const out = await closeInvoice(
      client(),
      { ...ID, dryRun: false, acceptPrompts: [text] },
      false,
      deps(f.sdk),
    );
    expect(out.status).toBe('unknown');
    expect(f.proc.message).not.toHaveBeenCalled();
    expect(f.proc.cancel).toHaveBeenCalledTimes(1);
  });

  it('readback finds two finals across customers → unverified duplicate, never closed', async () => {
    let closed = false;
    const foreignFinal: InvoiceRow = { ...final, IVNUM: 'OV265000500', IV: 5, CUSTNAME: 'ABC' };
    fakeOData({
      rows: () => (closed ? [final] : [draft]),
      anyParty: () => (closed ? [final, foreignFinal] : [draft]),
    });
    const f = fakeSdk({
      onActivate: () => {
        closed = true;
      },
    });
    const out = await closeInvoice(client(), { ...ID, dryRun: false }, false, deps(f.sdk));
    expect(out.status).toBe('unverified');
    expect((out as { verification: { reason: string } }).verification.reason).toContain(
      'duplicate',
    );
  });
});
