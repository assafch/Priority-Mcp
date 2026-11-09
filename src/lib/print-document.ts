import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PriorityError, notFoundMessage } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import { type WebSdkProcStep, type WebSdkSession, withTimeout } from '../client/web-sdk.js';
import { convertHtmlToPdf } from './html-to-pdf.js';
import { sanitizeODataValue } from './sanitize.js';

/**
 * Official Priority printouts via the Web SDK — the same document programs the UI runs
 * (WWWSHOWORDER, WWWSHOWAIV, …), not a layout rebuilt from OData fields.
 *
 * The procedure is always continued in display mode (documentOptions mode:'display', pdf:1).
 * That is the on-screen original layout. It is not automail, not Click2Sign, and not the
 * "print" send-option that sets the Printed flag and stamps מקור on invoices and delivery notes.
 * CLOSEANINVOICE is never called and FINAL is never written, so a draft (T…) stays a draft.
 *
 * Procedure names are Priority's standard document programs (developer portal: WWWSHOWORDER,
 * WWWSHOWAIV, WWWSHOWEIV, WWWSHOWCIV, WWWSHOWTIV, WWWSHOWDOC). They were not re-probed against
 * the ORGAT tenant from this environment.
 */

export const PRINT_FORMS = {
  ORDERS: {
    procedure: 'WWWSHOWORDER',
    keyField: 'ORDNAME',
    title: 'Sales order (הזמנה)',
  },
  AINVOICES: {
    procedure: 'WWWSHOWAIV',
    keyField: 'IVNUM',
    title: 'Tax invoice and credit invoice (חשבונית מס / זיכוי), including drafts T…',
  },
  EINVOICES: {
    procedure: 'WWWSHOWEIV',
    keyField: 'IVNUM',
    title: 'Tax invoice-receipt (חשבונית מס קבלה); final numbers look like OV…',
  },
  CINVOICES: {
    procedure: 'WWWSHOWCIV',
    keyField: 'IVNUM',
    title: 'Credit invoice when it lives on the legacy CINVOICES form',
  },
  TINVOICES: {
    procedure: 'WWWSHOWTIV',
    keyField: 'IVNUM',
    title: 'Receipt (קבלה)',
  },
  DOCUMENTS_D: {
    procedure: 'WWWSHOWDOC',
    keyField: 'DOCNO',
    title: 'Delivery note (תעודת משלוח)',
  },
  OPENINVOICES: {
    procedure: 'WWWSHOWDOC',
    keyField: 'DOCNO',
    title:
      'Open delivery note or return on this tenant (OPENINVOICES is that list; the print program is still WWWSHOWDOC)',
  },
} as const;

export type PrintFormName = keyof typeof PRINT_FORMS;
export const PRINT_FORM_NAMES = Object.keys(PRINT_FORMS) as PrintFormName[];

const WATCHED_FIELDS = [
  'FINAL',
  'FNCNUM',
  'STATDES',
  'IVNUM',
  'ORDNAME',
  'DOCNO',
  'ORDSTATUSDES',
  'CLOSED',
  'DEBIT',
  'IVTYPE',
] as const;

/** Choices that would email, sign, finalize, delete, or print every document. */
const UNSAFE_OPTION =
  /automail|e-?mail|מייל|דוא.?ל|שליח(?:ה|ת)|לחתום|חתימה|signature|click2sign|סגיר(?:ה|ת)|finalize|close\b|מחיק|delete|כל המסמכים|כל ההזמנות|all documents|every document|mark as printed|סמן.*הודפס/i;

/** Messages that mean the procedure is about to change the document or has not found it. */
const UNSAFE_MESSAGE =
  /סגירת חשבונית|CLOSEANINVOICE|CLOSEPRINT|יופק מסמך סופי|finali[sz]|פקודת יומן|journal entry|נשלח ל|will be e-?mailed|הודפס|as printed|סומן כהודפס|לא נמצא|no records|not found|אין נתונים/i;

const DEFAULT_MAX_BYTES = 6_000_000;
const DOWNLOAD_CAP = 20 * 1024 * 1024;

export interface ProcedureEditField {
  field: number;
  title?: string;
  helpstring?: string;
  code?: string;
  operator?: number;
  value?: string;
  readonly?: boolean | number;
  zoom?: string;
}

export interface ProcedureOption {
  field: number;
  title?: string;
  name?: string;
  selected?: boolean | number;
}

export interface ListedFormat {
  id: number;
  title: string;
  selected: boolean;
}

export interface FormatChoice {
  id: number;
  title: string;
  kind: 'format' | 'word';
  how: 'default-selected' | 'first' | 'id' | 'title';
}

interface ProcHandle {
  inputFields(ok: 0 | 1, data: unknown): Promise<WebSdkProcStep>;
  inputOptions(ok: 0 | 1, selection: number): Promise<WebSdkProcStep>;
  inputHelp(ok: 0 | 1): Promise<WebSdkProcStep>;
  message(ok: 0 | 1): Promise<WebSdkProcStep>;
  documentOptions(
    ok: 0 | 1,
    selectedFormat: number,
    options: { pdf: 0 | 1; word: 0 | 1; mode: 'display' },
  ): Promise<WebSdkProcStep>;
  continueProc(): Promise<WebSdkProcStep>;
  clientContinue(data?: string): Promise<WebSdkProcStep>;
  cancel(): Promise<unknown>;
}

interface ProcStep extends WebSdkProcStep {
  type?: string;
  message?: string;
  messagetype?: string;
  formats?: Array<{ format?: number; title?: string; selected?: boolean | number }>;
  wordTemplates?: Array<{ template?: number; title?: string; selected?: boolean | number }>;
  Urls?: Array<{ url?: string; action?: string } | string>;
  urls?: Array<{ url?: string; action?: string } | string>;
  input?: {
    title?: string;
    text?: string;
    EditFields?: ProcedureEditField[];
    EditField?: ProcedureEditField[];
    Options?: ProcedureOption[];
  };
  proc?: ProcHandle;
}

export interface PrintRequest {
  form: PrintFormName;
  key: string;
  format?: string;
  listFormats?: boolean;
  /** Exact warning texts that may be answered OK. Errors and send/close/finalize messages are never accepted. */
  acceptMessages?: string[];
}

export interface PrintDeps {
  session?: () => WebSdkSession;
  fetchFile?: (url: string) => Promise<{ bytes: Buffer; contentType: string }>;
  htmlToPdf?: (html: Buffer, pageUrl: string) => Promise<Buffer>;
  stepTimeoutMs?: number;
  downloadTimeoutMs?: number;
  maxBytes?: number;
  outputDir?: string;
}

export type PrintOutcome =
  | {
      status: 'ok' | 'status-changed';
      form: PrintFormName;
      key: string;
      procedure: string;
      draft: boolean;
      format: FormatChoice | null;
      pdfSource: 'priority' | 'html-converted';
      filename: string;
      mimeType: 'application/pdf';
      byteLength: number;
      contentBase64?: string;
      contentOmitted?: string;
      filePath?: string;
      sourceUrl?: string;
      documentBefore: Record<string, unknown>;
      documentAfter: Record<string, unknown> | null;
      statusCheck: 'unchanged' | 'changed' | 'unread';
      statusNote?: string;
      messages: string[];
      note: string;
    }
  | {
      status: 'formats';
      form: PrintFormName;
      key: string;
      procedure: string;
      draft: boolean;
      formats: ListedFormat[];
      wordTemplates: ListedFormat[];
      documentBefore: Record<string, unknown>;
      note: string;
    }
  | {
      status: 'failed';
      reason: string;
      form?: PrintFormName;
      key?: string;
      procedure?: string;
      detail: string;
      steps?: string[];
      formats?: ListedFormat[];
      wordTemplates?: ListedFormat[];
    };

class PrintFailure extends Error {
  constructor(
    readonly reason: string,
    message: string,
    readonly extra?: { formats?: ListedFormat[]; wordTemplates?: ListedFormat[] },
  ) {
    super(message);
    this.name = 'PrintFailure';
  }
}

export function isDraftDocument(
  form: PrintFormName,
  row: Record<string, unknown>,
  keyField: string,
): boolean {
  const number = String(row[keyField] ?? '');
  if (/^T\d+$/i.test(number)) return true;
  if (row.FINAL === 'Y' || row.FINAL === 'y') return false;
  if (String(row.STATDES ?? '').includes('טיוט')) return true;
  if (form === 'ORDERS' || form === 'DOCUMENTS_D' || form === 'OPENINVOICES') return false;
  return 'FINAL' in row && row.FINAL !== 'Y';
}

export function statusSnapshot(row: Record<string, unknown>): Record<string, unknown> {
  const snap: Record<string, unknown> = {};
  for (const field of WATCHED_FIELDS) {
    if (field in row) snap[field] = row[field] ?? null;
  }
  return snap;
}

export function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...fields].filter((field) => String(before[field] ?? '') !== String(after[field] ?? ''));
}

function isSortField(field: ProcedureEditField): boolean {
  const title = `${field.title ?? ''} ${field.helpstring ?? ''}`;
  return /מיון|sort|סדר מיון|order by/i.test(title);
}

function isDocField(field: ProcedureEditField): boolean {
  const title = `${field.title ?? ''} ${field.helpstring ?? ''}`;
  return /הזמנ|חשבונ|מסמך|מספר|order|invoice|document|קבלה|תעוד|shipment|delivery|receipt/i.test(
    title,
  );
}

/** Fill the document-number parameter(s) and keep every other field's default, including sort. */
export function buildInputFields(
  fields: ProcedureEditField[],
  key: string,
): { EditFields: Array<{ field: number; op: number; value: string; value2?: string }> } {
  const editable = fields.filter((field) => !field.readonly);
  const pool = editable.length ? editable : fields;
  const docFields = pool.filter((field) => isDocField(field) && !isSortField(field));
  let targets: ProcedureEditField[];
  if (docFields.length) targets = docFields;
  else {
    const strings = pool.filter(
      (field) => !isSortField(field) && (!field.code || /str/i.test(field.code)),
    );
    targets = strings.slice(0, 2);
    if (!targets.length && pool[0]) targets = [pool[0]];
  }
  const targetIds = new Set(targets.map((field) => field.field));
  const sent = fields.filter((field) => targetIds.has(field.field) || !field.readonly);
  return {
    EditFields: sent.map((field) => {
      if (!targetIds.has(field.field)) {
        return { field: field.field, op: field.operator ?? 0, value: String(field.value ?? '') };
      }
      if ((field.operator ?? 0) === 6)
        return { field: field.field, op: 6, value: key, value2: key };
      return { field: field.field, op: 0, value: key };
    }),
  };
}

export function chooseOption(
  options: ProcedureOption[],
): { ok: true; field: number; title: string } | { ok: false; detail: string } {
  if (!options.length) {
    return { ok: false, detail: 'The procedure asked for a choice but listed none.' };
  }
  const label = (option: ProcedureOption) => `${option.title ?? ''} ${option.name ?? ''}`.trim();
  const safe = options.filter((option) => !UNSAFE_OPTION.test(label(option)));
  if (!safe.length) {
    return {
      ok: false,
      detail: `Every choice would send, close, or batch-print: ${options
        .map((option) => label(option) || String(option.field))
        .join('; ')}. Nothing was confirmed.`,
    };
  }
  const selected = safe.find((option) => option.selected === true || option.selected === 1);
  const picked =
    selected ??
    safe.find((option) => option.field === 1) ??
    (safe.length === 1 ? safe[0] : undefined);
  if (!picked) {
    return {
      ok: false,
      detail: `Refusing to guess a procedure choice. Options: ${safe
        .map((option) => `${option.field}=${label(option) || option.field}`)
        .join('; ')}.`,
    };
  }
  return { ok: true, field: picked.field, title: label(picked) || String(picked.field) };
}

export function chooseFormat(
  formats: Array<{ format?: number; title?: string; selected?: boolean | number }>,
  words: Array<{ template?: number; title?: string; selected?: boolean | number }>,
  requested?: string,
): { ok: true; choice: FormatChoice } | { ok: false; detail: string } {
  const system = formats
    .filter((format) => typeof format.format === 'number')
    .map((format) => ({
      id: format.format as number,
      title: format.title ?? '',
      selected: format.selected === true || format.selected === 1,
      kind: 'format' as const,
    }));
  const templates = words
    .filter((template) => typeof template.template === 'number')
    .map((template) => ({
      id: template.template as number,
      title: template.title ?? '',
      selected: template.selected === true || template.selected === 1,
      kind: 'word' as const,
    }));
  const describe = () =>
    [
      ...system.map((format) => `${format.id} ${format.title}`.trim()),
      ...templates.map((template) => `word ${template.id} ${template.title}`.trim()),
    ].join('; ') || '(none)';
  if (!requested) {
    const selected = system.find((format) => format.selected) ?? system[0];
    if (!selected) {
      return {
        ok: false,
        detail: `Priority offered no system print format. Word templates, if any: ${describe()}. Pass format as a template id or title to use one.`,
      };
    }
    return {
      ok: true,
      choice: {
        id: selected.id,
        title: selected.title,
        kind: 'format',
        how: selected.selected ? 'default-selected' : 'first',
      },
    };
  }
  const wanted = requested.trim();
  if (/^-?\d+$/.test(wanted)) {
    const id = Number(wanted);
    const hit =
      system.find((format) => format.id === id) ?? templates.find((template) => template.id === id);
    if (!hit)
      return { ok: false, detail: `Format ${wanted} is not offered. Available: ${describe()}` };
    return { ok: true, choice: { id: hit.id, title: hit.title, kind: hit.kind, how: 'id' } };
  }
  const norm = (value: string) => value.trim().toLowerCase();
  const query = norm(wanted);
  const matches = [...system, ...templates].filter(
    (format) =>
      norm(format.title) === query || (query.length >= 3 && norm(format.title).includes(query)),
  );
  if (matches.length === 1) {
    const hit = matches[0];
    return { ok: true, choice: { id: hit.id, title: hit.title, kind: hit.kind, how: 'title' } };
  }
  if (!matches.length)
    return { ok: false, detail: `No format named "${wanted}". Available: ${describe()}` };
  return {
    ok: false,
    detail: `Format name "${wanted}" matches more than one: ${matches
      .map((format) => `${format.id} ${format.title}`.trim())
      .join('; ')}.`,
  };
}

export function sniffPrintFile(
  bytes: Buffer,
  contentType: string,
): 'pdf' | 'html' | 'docx' | 'unknown' {
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  if (
    bytes
      .subarray(start, start + 5)
      .toString('latin1')
      .startsWith('%PDF')
  )
    return 'pdf';
  if (bytes[start] === 0x50 && bytes[start + 1] === 0x4b) return 'docx';
  const sample = bytes
    .subarray(start, start + 400)
    .toString('utf8')
    .trimStart()
    .toLowerCase();
  if (
    sample.startsWith('<!doctype html') ||
    sample.startsWith('<html') ||
    sample.startsWith('<head') ||
    sample.startsWith('<body')
  ) {
    return 'html';
  }
  const type = contentType.toLowerCase();
  if (type.includes('application/pdf') || type.includes('application/x-pdf')) return 'pdf';
  if (type.includes('text/html') || type.includes('application/xhtml')) return 'html';
  return 'unknown';
}

export function printFilename(form: string, key: string): string {
  const clean = key
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return `${form}-${clean || 'document'}.pdf`;
}

function editFieldsOf(step: ProcStep): ProcedureEditField[] {
  const input = step.input;
  const raw = input?.EditFields ?? input?.EditField ?? [];
  return Array.isArray(raw) ? raw : [];
}

function optionsOf(step: ProcStep): ProcedureOption[] {
  const raw = step.input?.Options ?? [];
  return Array.isArray(raw) ? raw : [];
}

function listedFormats(
  raw: Array<{ format?: number; template?: number; title?: string; selected?: boolean | number }>,
  idKey: 'format' | 'template',
): ListedFormat[] {
  return raw
    .filter((item) => typeof item[idKey] === 'number')
    .map((item) => ({
      id: item[idKey] as number,
      title: item.title ?? '',
      selected: item.selected === true || item.selected === 1,
    }));
}

function urlsOf(step: ProcStep): string[] {
  const raw = step.Urls ?? step.urls ?? [];
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === 'string' ? item : item?.url))
    .filter((url): url is string => typeof url === 'string' && url.length > 0);
}

function stepSummary(step: ProcStep): string {
  const type = step.type ?? 'unknown';
  const title = step.input?.title ?? '';
  const message = (step.message ?? step.input?.text ?? '').replace(/\s+/g, ' ').slice(0, 300);
  return [type, title, message].filter(Boolean).join(' | ').slice(0, 400);
}

async function safeCancel(proc: ProcHandle | undefined, timeoutMs: number): Promise<void> {
  const cancel = proc?.cancel;
  if (!cancel) return;
  await withTimeout(
    Promise.resolve().then(() => cancel()),
    timeoutMs,
    'proc.cancel',
  ).catch(() => undefined);
}

function requireProc(step: ProcStep, method: keyof ProcHandle): ProcHandle {
  const proc = step.proc;
  if (!proc?.[method]) {
    throw new PrintFailure(
      'procedure-failed',
      `Procedure step '${step.type ?? 'unknown'}' has no ${method}() to answer it.`,
    );
  }
  return proc;
}

async function lookupDocument(
  client: PriorityClient,
  form: PrintFormName,
  key: string,
): Promise<
  | { ok: true; row: Record<string, unknown> }
  | { ok: false; reason: 'not-found' | 'ambiguous' | 'odata'; detail: string }
> {
  const spec = PRINT_FORMS[form];
  const value = sanitizeODataValue(key).trim();
  if (!value) return { ok: false, reason: 'not-found', detail: 'Document number is empty.' };
  try {
    const query = new ODataBuilder().eq(spec.keyField, value).top(5).build();
    const result = await client.list<Record<string, unknown>>(form, query);
    const rows = result.value ?? [];
    if (rows.length === 0) {
      return {
        ok: false,
        reason: 'not-found',
        detail: `No ${form} document with ${spec.keyField} '${value}'. Printing was not started.`,
      };
    }
    if (rows.length > 1) {
      const ids = rows
        .map((row) =>
          ['IVNUM', 'DEBIT', 'IVTYPE', 'DOCNO', 'ORDNAME', 'STATDES']
            .filter((field) => field in row)
            .map((field) => `${field}=${String(row[field] ?? '')}`)
            .join(' '),
        )
        .join('; ');
      return {
        ok: false,
        reason: 'ambiguous',
        detail: `${rows.length} ${form} rows share ${spec.keyField} '${value}'. Refusing to print. ${ids}`,
      };
    }
    return { ok: true, row: rows[0] };
  } catch (err) {
    if (err instanceof PriorityError) {
      const detail =
        err.statusCode === 404
          ? notFoundMessage(err)
          : `Could not read ${form} '${value}' (${err.statusCode}): ${err.message}`;
      return { ok: false, reason: 'odata', detail };
    }
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: 'odata', detail };
  }
}

function sdkFailure(err: unknown): PrintFailure {
  if (err instanceof PrintFailure) return err;
  const detail = err instanceof Error ? err.message : String(err);
  if (/not installed|procStart are missing|Cannot derive|Web SDK login needs/i.test(detail)) {
    return new PrintFailure('sdk-not-configured', detail);
  }
  if (/web sdk login|login failed|unauthorized|401/i.test(detail)) {
    return new PrintFailure('sdk-login-failed', `Web SDK login failed: ${detail}`);
  }
  if (/timed out/i.test(detail)) return new PrintFailure('timeout', detail);
  return new PrintFailure('procedure-failed', detail);
}

async function defaultFetch(
  url: string,
  timeoutMs: number,
): Promise<{ bytes: Buffer; contentType: string }> {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new PrintFailure(
      'download-failed',
      `Downloading the print file failed: HTTP ${response.status} from ${safeHost(url)}.`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > DOWNLOAD_CAP) {
    throw new PrintFailure(
      'too-large',
      `Print file is ${bytes.length} bytes, over the ${DOWNLOAD_CAP} byte download cap.`,
    );
  }
  return { bytes, contentType: response.headers.get('content-type') ?? '' };
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'the print host';
  }
}

function resolveMaxBytes(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_BYTES;
  return Math.floor(value);
}

async function writePdf(dir: string, filename: string, bytes: Buffer): Promise<string> {
  const root = resolve(dir);
  const target = resolve(root, filename);
  if (target !== join(root, filename)) {
    throw new PrintFailure('write-failed', 'Refusing to write the PDF outside PRIORITY_PRINT_DIR.');
  }
  await mkdir(root, { recursive: true });
  await writeFile(target, bytes);
  return target;
}

const DISPLAY_NOTE =
  'Official Priority document procedure, display mode only (pdf:1, mode:display). ' +
  'CLOSEANINVOICE was not called and FINAL was not written. ' +
  'Display mode does not request the Printed flag: invoices and delivery notes therefore show as copy (העתק), not original (מקור). ' +
  'Nothing was emailed.';

/**
 * Confirm the document over OData, run its standard print procedure, and return PDF bytes.
 * `listFormats` stops at the format dialog and cancels without downloading.
 */
export async function printDocument(
  client: PriorityClient,
  request: PrintRequest,
  deps: PrintDeps = {},
): Promise<PrintOutcome> {
  const spec = PRINT_FORMS[request.form];
  const key = request.key.trim();
  const found = await lookupDocument(client, request.form, key);
  if (!found.ok) {
    return {
      status: 'failed',
      reason: found.reason,
      form: request.form,
      key,
      procedure: spec.procedure,
      detail: found.detail,
    };
  }
  const before = statusSnapshot(found.row);
  const draft = isDraftDocument(request.form, found.row, spec.keyField);
  let session: WebSdkSession;
  try {
    if (!deps.session) {
      throw new PrintFailure(
        'sdk-not-configured',
        'Web SDK session is not configured. Set PRIORITY_PAT or PRIORITY_USERNAME and PRIORITY_PASSWORD (same values as OData). Optional overrides: PRIORITY_WEB_URL, PRIORITY_WEB_TABULAINI, PRIORITY_WEB_LANGUAGE, PRIORITY_WEB_APPNAME.',
      );
    }
    session = deps.session();
  } catch (err) {
    const failure = sdkFailure(err);
    return {
      status: 'failed',
      reason: failure.reason,
      form: request.form,
      key,
      procedure: spec.procedure,
      detail: failure.message,
    };
  }

  const timeoutMs = deps.stepTimeoutMs ?? 60_000;
  const messages: string[] = [];
  const steps: string[] = [];
  let current: ProcStep | undefined;
  let procHandle: ProcHandle | undefined;
  let fileUrl: string | undefined;
  let choice: FormatChoice | null = null;
  let ended = false;

  const fail = async (failure: PrintFailure): Promise<PrintOutcome> => {
    await safeCancel(procHandle, timeoutMs);
    ended = true;
    return {
      status: 'failed',
      reason: failure.reason,
      form: request.form,
      key,
      procedure: spec.procedure,
      detail: failure.message,
      steps,
      ...failure.extra,
    };
  };

  try {
    await session.ensureLogin().catch((err) => {
      session.reset();
      throw err;
    });
    const start = session.sdk.procStart;
    if (!start) {
      throw new PrintFailure(
        'sdk-not-configured',
        'priority-web-sdk has no procStart. Reinstall priority-web-sdk@3.0.39.',
      );
    }
    if (!/^WWWSHOW[A-Z0-9_]+$/.test(spec.procedure)) {
      throw new PrintFailure('procedure-failed', `Refusing procedure name ${spec.procedure}.`);
    }
    current = (await withTimeout(
      start(spec.procedure, 'P', () => {}, session.company),
      timeoutMs,
      `procStart(${spec.procedure})`,
    )) as ProcStep;
    let previous = '';
    let repeats = 0;
    for (let i = 0; i < 16; i++) {
      if (!current) throw new PrintFailure('procedure-failed', 'Procedure returned an empty step.');
      procHandle = current.proc;
      const type = String(current.type ?? '').toLowerCase();
      const summary = stepSummary(current);
      steps.push(summary);
      if (summary === previous) repeats += 1;
      else repeats = 0;
      previous = summary;
      if (repeats >= 2) {
        throw new PrintFailure('procedure-failed', `Procedure repeated '${summary}'. Cancelled.`);
      }
      const urls = urlsOf(current);
      if (urls.length) fileUrl = urls.find((url) => /\.pdf($|\?)/i.test(url)) ?? urls[0];

      if (type === 'end') {
        ended = true;
        break;
      }
      if (type === 'inputoptions') {
        const picked = chooseOption(optionsOf(current));
        if (!picked.ok) throw new PrintFailure('cancelled', picked.detail);
        messages.push(`choice: ${picked.title}`);
        const proc = requireProc(current, 'inputOptions');
        current = (await withTimeout(
          proc.inputOptions(1, picked.field),
          timeoutMs,
          'inputOptions',
        )) as ProcStep;
        continue;
      }
      if (type === 'inputfields') {
        const fields = editFieldsOf(current);
        if (!fields.length) {
          throw new PrintFailure(
            'procedure-failed',
            'Procedure asked for input fields but listed none.',
          );
        }
        const proc = requireProc(current, 'inputFields');
        current = (await withTimeout(
          proc.inputFields(1, buildInputFields(fields, key)),
          timeoutMs,
          'inputFields',
        )) as ProcStep;
        continue;
      }
      if (type === 'inputhelp') {
        const proc = requireProc(current, 'inputHelp');
        current = (await withTimeout(proc.inputHelp(1), timeoutMs, 'inputHelp')) as ProcStep;
        continue;
      }
      if (type === 'message') {
        const text = String(current.message ?? '').trim();
        const kind = String(current.messagetype ?? 'information').toLowerCase();
        messages.push(`${kind}: ${text}`.slice(0, 500));
        const listed = (request.acceptMessages ?? []).some((item) => item.trim() === text);
        const unsafe = kind === 'error' || UNSAFE_MESSAGE.test(text);
        if (unsafe || (kind === 'warning' && !listed)) {
          const hint =
            kind === 'warning' && !unsafe
              ? 'Pass that exact text in acceptMessages to continue, after reading it.'
              : 'Errors and messages about sending, closing, or finalizing are never accepted.';
          throw new PrintFailure(
            'cancelled',
            `Procedure ${kind} was not accepted, so nothing was confirmed: ${text || '(empty)'}. ${hint}`,
          );
        }
        const proc = requireProc(current, 'message');
        current = (await withTimeout(proc.message(1), timeoutMs, 'message')) as ProcStep;
        continue;
      }
      if (type === 'client') {
        const proc = requireProc(current, 'clientContinue');
        current = (await withTimeout(
          proc.clientContinue(''),
          timeoutMs,
          'clientContinue',
        )) as ProcStep;
        continue;
      }
      if (type === 'documentoptions') {
        const formats = listedFormats(current.formats ?? [], 'format');
        const wordTemplates = listedFormats(current.wordTemplates ?? [], 'template');
        if (request.listFormats) {
          await safeCancel(procHandle, timeoutMs);
          ended = true;
          return {
            status: 'formats',
            form: request.form,
            key,
            procedure: spec.procedure,
            draft,
            formats,
            wordTemplates,
            documentBefore: before,
            note: 'Format dialog only. The procedure was cancelled before a file was requested. Call again with format set to an id or title and listFormats false.',
          };
        }
        const picked = chooseFormat(
          current.formats ?? [],
          current.wordTemplates ?? [],
          request.format,
        );
        if (!picked.ok)
          throw new PrintFailure('unknown-format', picked.detail, { formats, wordTemplates });
        choice = picked.choice;
        const proc = requireProc(current, 'documentOptions');
        const options = {
          pdf: 1 as const,
          word: choice.kind === 'word' ? (1 as const) : (0 as const),
          mode: 'display' as const,
        };
        current = (await withTimeout(
          proc.documentOptions(1, choice.id, options),
          timeoutMs,
          'documentOptions',
        )) as ProcStep;
        continue;
      }
      if (type === 'displayurl') {
        if (request.listFormats) {
          await safeCancel(procHandle, timeoutMs);
          ended = true;
          return {
            status: 'formats',
            form: request.form,
            key,
            procedure: spec.procedure,
            draft,
            formats: [],
            wordTemplates: [],
            documentBefore: before,
            note: 'This procedure did not offer a format dialog (single default format) and had already produced a temporary display file. That file was not downloaded. The procedure was cancelled. Call again with listFormats false to retrieve the PDF.',
          };
        }
        const proc = requireProc(current, 'continueProc');
        current = (await withTimeout(proc.continueProc(), timeoutMs, 'continueProc')) as ProcStep;
        continue;
      }
      throw new PrintFailure(
        'cancelled',
        `Unexpected procedure step '${type || 'unknown'}' (${summary}). Cancelled without confirming it.`,
      );
    }
    if (!ended) {
      throw new PrintFailure('procedure-failed', 'Procedure did not finish within 16 steps.');
    }
    if (!fileUrl) {
      throw new PrintFailure(
        'no-file',
        `Procedure ${spec.procedure} ended without a file URL. Steps: ${steps.join(' > ') || '(none)'}`,
      );
    }
    const fetched = await (
      deps.fetchFile ?? ((url: string) => defaultFetch(url, deps.downloadTimeoutMs ?? 60_000))
    )(fileUrl);
    let pdf = fetched.bytes;
    let pdfSource: 'priority' | 'html-converted' = 'priority';
    const kind = sniffPrintFile(fetched.bytes, fetched.contentType);
    if (kind === 'html') {
      const convert =
        deps.htmlToPdf ?? ((html: Buffer, pageUrl: string) => convertHtmlToPdf({ html, pageUrl }));
      try {
        pdf = await convert(fetched.bytes, fileUrl);
      } catch (err) {
        if (err instanceof PrintFailure) throw err;
        const detail = err instanceof Error ? err.message : String(err);
        throw new PrintFailure('not-pdf', detail);
      }
      if (sniffPrintFile(pdf, 'application/pdf') !== 'pdf') {
        throw new PrintFailure(
          'not-pdf',
          'HTML-to-PDF conversion did not produce a PDF. Priority had returned HTML even though pdf:1 was requested.',
        );
      }
      pdfSource = 'html-converted';
    } else if (kind === 'docx') {
      throw new PrintFailure(
        'not-pdf',
        'Priority returned a Word document. Pick a system print format (the numeric format id), not a Word template.',
      );
    } else if (kind !== 'pdf') {
      throw new PrintFailure(
        'not-pdf',
        `Priority's file is neither PDF nor HTML (content-type '${fetched.contentType || 'unknown'}', ${fetched.bytes.length} bytes).`,
      );
    }

    const filename = printFilename(request.form, key);
    const maxBytes = resolveMaxBytes(deps.maxBytes);
    let filePath: string | undefined;
    if (deps.outputDir) {
      try {
        filePath = await writePdf(deps.outputDir, filename, pdf);
      } catch (err) {
        if (err instanceof PrintFailure) throw err;
        const detail = err instanceof Error ? err.message : String(err);
        throw new PrintFailure('write-failed', `Could not write ${filename}: ${detail}`);
      }
    }
    let contentBase64: string | undefined;
    let contentOmitted: string | undefined;
    if (pdf.length > maxBytes) {
      contentOmitted = filePath
        ? `PDF is ${pdf.length} bytes, over the ${maxBytes} byte inline limit. The file was written to filePath and base64 was omitted.`
        : `PDF is ${pdf.length} bytes, over the ${maxBytes} byte inline limit. Set PRIORITY_PRINT_DIR to write it to disk, or raise PRIORITY_PRINT_MAX_BYTES.`;
      if (!filePath) throw new PrintFailure('too-large', contentOmitted);
    } else {
      contentBase64 = pdf.toString('base64');
    }

    let documentAfter: Record<string, unknown> | null = null;
    let statusCheck: 'unchanged' | 'changed' | 'unread' = 'unread';
    let statusNote: string | undefined;
    const again = await lookupDocument(client, request.form, key);
    if (again.ok) {
      documentAfter = statusSnapshot(again.row);
      const diffs = changedFields(before, documentAfter);
      if (diffs.length) {
        statusCheck = 'changed';
        statusNote = `After the display procedure, these fields differ: ${diffs.join(', ')}. The PDF is still returned. Re-read the document in Priority before trusting that nothing else changed.`;
      } else statusCheck = 'unchanged';
    } else if (again.reason === 'not-found' || again.reason === 'ambiguous') {
      statusCheck = 'changed';
      statusNote = `The document key '${key}' did not read back the same way after the procedure: ${again.detail}`;
    } else {
      statusCheck = 'unread';
      statusNote = `Could not re-read the document after printing: ${again.detail}`;
    }

    const note = draft
      ? `Draft ${key} was printed as a draft and was not finalized. ${DISPLAY_NOTE}`
      : DISPLAY_NOTE;
    return {
      status: statusCheck === 'changed' ? 'status-changed' : 'ok',
      form: request.form,
      key,
      procedure: spec.procedure,
      draft,
      format: choice,
      pdfSource,
      filename,
      mimeType: 'application/pdf',
      byteLength: pdf.length,
      ...(contentBase64 ? { contentBase64 } : {}),
      ...(contentOmitted ? { contentOmitted } : {}),
      ...(filePath ? { filePath } : {}),
      sourceUrl: fileUrl,
      documentBefore: before,
      documentAfter,
      statusCheck,
      ...(statusNote ? { statusNote } : {}),
      messages,
      note,
    };
  } catch (err) {
    return fail(sdkFailure(err));
  } finally {
    if (!ended) await safeCancel(procHandle, timeoutMs);
  }
}
