import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PriorityClient } from '../client/priority-client.js';
import {
  type WebSdkForm,
  type WebSdkProcStep,
  type WebSdkRow,
  type WebSdkServerMessage,
  type WebSdkSession,
  withTimeout,
} from '../client/web-sdk.js';
import { escapeODataString } from './sanitize.js';

/**
 * Closing (finalizing) a Priority invoice the way Priority does it: the direct activation
 * "סגירת חשבונית" (CLOSEANINVOICE) on the invoice form, through the Web SDK.
 *
 * The procedure is the ONLY correct way to finalize. It assigns the final number (OV…/IN…/GI…),
 * posts the journal entry (FNCNUM) and moves stock. Writing FINAL='Y' through OData does none of
 * that and locks the draft (T164 25.10.2026, T173 2.11.2026 — Priority ticket SCI26096671).
 *
 * A close is irreversible and creates a tax document, so this module:
 *   1. demands the draft's full identity (form, T-number, BOOKNUM, customer/supplier, total) and
 *      refuses on any difference;
 *   2. pre-checks over OData (uncached) that the row is a clean draft, that no final document
 *      already carries the BOOKNUM (for customer forms: under ANY customer) and that no other open
 *      draft shares it (two drafts for one order = two invoices waiting to happen);
 *   3. serializes closes per document AND per order (BOOKNUM for customer forms, BOOKNUM+party
 *      for supplier invoices), in this process and across
 *      processes (claim files), and re-reads the SDK rows right before activating;
 *   4. previews by default (dryRun) and never activates in read-only mode;
 *   5. drives the activation accepting only information messages (plus prompt texts the caller
 *      explicitly listed); any other message, warning or error cancels;
 *   6. never retries an activation. The OData readback decides the status: closed / unverified /
 *      unknown (dispatched, outcome not yet visible — a cooldown blocks a second dispatch) /
 *      failed (nothing was dispatched);
 *   7. writes every attempt to an append-only ledger before and after the activation, and never
 *      lets a ledger error hide the result of an activation that already ran.
 */

export const CLOSE_ACTIVATION = 'CLOSEANINVOICE';
export const CLOSE_ACTIVATION_KEY = `${CLOSE_ACTIVATION}.P`;
export const DRAFT_STATUS = 'טיוטא';
const MAX_PROCEDURE_STEPS = 10;
const TEMP_NUMBER = /^T\d+$/;
/** A dispatched-but-unconfirmed close blocks a second dispatch of the same document for this long. */
export const COOLDOWN_MS = 180_000;
/**
 * An in_flight claim older than this belongs to a dead process. Deliberately far above the worst
 * legitimate hold (login + 5 SDK steps + 10 procedure steps + teardown + 3 OData reads ≈ 15 min):
 * a live close must never be mistaken for a dead one.
 */
export const STALE_CLAIM_MS = 60 * 60_000;
/** A takeover lock (used only while replacing a stale claim) older than this is abandoned. */
const TAKEOVER_STALE_MS = 60_000;

export const CLOSABLE_FORMS = {
  EINVOICES: {
    party: 'CUSTNAME',
    title: 'חשבונית מס קבלה',
    journalSubform: 'IVFNCTRANS_SUBFORM',
    /** Order numbers are unique across customers: a final under another customer is a duplicate. */
    booknumUniqueAcrossParties: true,
  },
  AINVOICES: {
    party: 'CUSTNAME',
    title: 'חשבונית מס',
    journalSubform: 'IVFNCTRANS_SUBFORM',
    booknumUniqueAcrossParties: true,
  },
  PINVOICES: {
    party: 'SUPNAME',
    title: 'חשבונית ספק מרכזת',
    journalSubform: null,
    /** Supplier invoice numbers legitimately collide across suppliers. */
    booknumUniqueAcrossParties: false,
  },
} as const;
export type ClosableForm = keyof typeof CLOSABLE_FORMS;
export const CLOSABLE_FORM_NAMES = Object.keys(CLOSABLE_FORMS) as ClosableForm[];

export interface CloseIdentity {
  form: ClosableForm;
  /** The draft's temporary number, T<digits>. */
  ivnum: string;
  /** BOOKNUM exactly as on the draft (the external reference, e.g. WC-38435 or the supplier's number). */
  booknum: string;
  /** CUSTNAME (EINVOICES/AINVOICES) or SUPNAME (PINVOICES) exactly as on the draft. */
  party: string;
  /** TOTPRICE exactly as on the draft (two decimals). */
  totprice: number;
}

export interface InvoiceRow {
  IVNUM: string;
  IV?: number;
  DEBIT?: string;
  IVTYPE?: string;
  BOOKNUM?: string | null;
  TOTPRICE?: number | string | null;
  STATDES?: string | null;
  FINAL?: string | null;
  FNCNUM?: string | null;
  IVDATE?: string | null;
  CUSTNAME?: string | null;
  SUPNAME?: string | null;
}

export type RefusalReason =
  | 'not-found'
  | 'ambiguous'
  | 'already-closed'
  | 'duplicate-final'
  | 'sibling-drafts'
  | 'half-state'
  | 'not-a-draft'
  | 'amount-mismatch'
  | 'read-only'
  | 'in-flight'
  | 'cooldown'
  | 'ledger-unwritable';

export type PreflightResult =
  | { ok: true; row: InvoiceRow; others: InvoiceRow[] }
  | { ok: false; reason: RefusalReason; detail: string; rows: InvoiceRow[] };

export interface ProcedureTrace {
  steps: Array<{ type?: string; messagetype?: string; message?: string; action: string }>;
  formMessages: WebSdkServerMessage[];
  activation?: unknown;
  sdkRow?: WebSdkRow;
  /** True once activateStart was called: from here on the server may have committed the close. */
  dispatched: boolean;
  outcome: 'end' | 'end-with-message' | 'cancelled' | 'failed';
  error?: string;
}

export interface JournalCheck {
  FNCNUM: string;
  found: boolean;
  FINAL?: string | null;
  FNCREF?: string | null;
  BALDATE?: string | null;
  SUMDEBIT?: number | null;
  SUMCREDIT?: number | null;
  journalSubformLines?: number | 'unavailable';
}

export type VerifyResult =
  | { verified: true; final: InvoiceRow; journal: JournalCheck }
  | {
      verified: false;
      reason: string;
      rows: InvoiceRow[];
      final?: InvoiceRow;
      journal?: JournalCheck;
    };

export interface CloseDeps {
  /** Lazily created so a preview never loads or logs into the SDK. */
  session?: () => WebSdkSession;
  ledgerPath?: string;
  now?: () => number;
  stepTimeoutMs?: number;
  endTimeoutMs?: number;
}

export interface CloseParams extends CloseIdentity {
  dryRun: boolean;
  /** With dryRun: also log into the SDK and locate the row read-only (no setActiveRow, no activation). */
  probeSdk?: boolean;
  /** Close even though other open drafts share the BOOKNUM (they stay open; the order lock — BOOKNUM alone for customer forms — still serializes closes). */
  allowSiblingDrafts?: boolean;
  /** Exact prompt texts (as Priority shows them) that may be answered OK during the close. Default: none. */
  acceptPrompts?: string[];
}

// ----------------------------------------------------------------- identity ---

const TEXT_MAX = 100;

/** Validate caller-supplied identity; throws on anything that could not be a real draft identity. */
export function validateIdentity(input: {
  form: string;
  ivnum: string;
  booknum: string;
  party: string;
  totprice: number;
}): CloseIdentity {
  if (!(input.form in CLOSABLE_FORMS)) {
    throw new Error(`form must be one of ${CLOSABLE_FORM_NAMES.join(', ')}`);
  }
  const ivnum = String(input.ivnum ?? '').trim();
  if (!TEMP_NUMBER.test(ivnum))
    throw new Error('ivnum must be the draft temporary number, T<digits>');
  const text = (name: string, value: unknown) => {
    const raw = String(value ?? '');
    const v = raw.trim();
    // Control characters are checked on the raw value: a newline inside a code is never legitimate,
    // and trimming must not turn a malformed identity into an accepted one.
    if (!v || v.length > TEXT_MAX || /\p{Cc}/u.test(raw)) {
      throw new Error(`${name} must be 1-${TEXT_MAX} printable characters`);
    }
    return v;
  };
  const totprice = Number(input.totprice);
  if (!Number.isFinite(totprice)) throw new Error('totprice must be a finite number');
  return {
    form: input.form as ClosableForm,
    ivnum,
    booknum: text('booknum', input.booknum),
    party: text('party', input.party),
    totprice: Math.round(totprice * 100) / 100,
  };
}

export function partyField(form: ClosableForm): 'CUSTNAME' | 'SUPNAME' {
  return CLOSABLE_FORMS[form].party;
}

/**
 * What counts as "the same order" for locking: the BOOKNUM alone when it is unique across parties
 * (customer forms — a web order number belongs to one sale whatever the customer code), otherwise
 * BOOKNUM + supplier (supplier invoice numbers collide across suppliers).
 */
export function orderScope(id: CloseIdentity): string {
  return CLOSABLE_FORMS[id.form].booknumUniqueAcrossParties
    ? `${id.form}:${id.booknum}`
    : `${id.form}:${id.booknum}\u0000${id.party}`;
}

/** Numeric value of a Priority amount; the SDK formats with thousands separators ("1,346.03"). */
function amount(value: unknown): number {
  if (value === null || value === undefined || value === '') return Number.NaN;
  return Math.round(Number(String(value).replace(/,/g, '')) * 100) / 100;
}

function sameAmount(a: unknown, b: number): boolean {
  const x = amount(a);
  return Number.isFinite(x) && Math.abs(x - b) < 0.005;
}

function isEmpty(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function isTemporary(row: { IVNUM?: unknown }): boolean {
  return TEMP_NUMBER.test(String(row.IVNUM ?? ''));
}

function isFinalRow(row: InvoiceRow): boolean {
  return !isTemporary(row) && row.STATDES !== DRAFT_STATUS && row.FINAL === 'Y';
}

function isOpenDraft(row: InvoiceRow): boolean {
  return isTemporary(row) && row.STATDES === DRAFT_STATUS && row.FINAL !== 'Y';
}

/** Plain-object rejections from the SDK ({type, code, message}) must not become "[object Object]". */
export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    const parts = ['type', 'code', 'message']
      .filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '')
      .map((k) => `${k}=${String(o[k])}`);
    if (parts.length) return parts.join(' ');
    try {
      return JSON.stringify(err).slice(0, 500);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

// ------------------------------------------------------------------ OData ------

const ROW_SELECT = [
  'IVNUM',
  'IV',
  'DEBIT',
  'IVTYPE',
  'BOOKNUM',
  'TOTPRICE',
  'STATDES',
  'FINAL',
  'FNCNUM',
  'IVDATE',
];

/** Every document of this form with the draft's BOOKNUM (and, unless `anyParty`, its party) — uncached. */
export async function readByBooknum(
  client: PriorityClient,
  id: CloseIdentity,
  anyParty = false,
): Promise<InvoiceRow[]> {
  const party = partyField(id.form);
  const filter = anyParty
    ? `BOOKNUM eq '${escapeODataString(id.booknum)}'`
    : `BOOKNUM eq '${escapeODataString(id.booknum)}' and ${party} eq '${escapeODataString(id.party)}'`;
  const query = `?$filter=${encodeURIComponent(filter)}&$select=${[...ROW_SELECT, party].join(',')}&$top=200`;
  const res = await client.list<InvoiceRow>(id.form, query, { cache: false });
  const value = res.value ?? [];
  if (res['@odata.nextLink'] || value.length >= 200) {
    throw new Error(
      `more than 200 ${id.form} rows carry BOOKNUM ${id.booknum}; refusing to decide on a partial read`,
    );
  }
  return value;
}

/** Classify the live state before anything is activated. `foreign` = same BOOKNUM under other parties. */
export function classifyPreflight(
  id: CloseIdentity,
  rows: InvoiceRow[],
  foreign: InvoiceRow[] = [],
  allowSiblingDrafts = false,
): PreflightResult {
  const drafts = rows.filter((r) => r.IVNUM === id.ivnum);
  const finals = rows.filter(isFinalRow);
  const foreignFinals = foreign.filter(isFinalRow);
  const party = partyField(id.form);
  if (drafts.length === 0) {
    if (finals.length) {
      return {
        ok: false,
        reason: 'already-closed',
        detail: `No draft ${id.ivnum}; a final document already exists for ${id.booknum}: ${finals.map((f) => f.IVNUM).join(', ')}.`,
        rows,
      };
    }
    return {
      ok: false,
      reason: 'not-found',
      detail: `No ${id.form} row with IVNUM ${id.ivnum}, BOOKNUM ${id.booknum} and ${party} ${id.party}.`,
      rows,
    };
  }
  if (drafts.length > 1) {
    return {
      ok: false,
      reason: 'ambiguous',
      detail: `${drafts.length} rows carry IVNUM ${id.ivnum}.`,
      rows,
    };
  }
  const row = drafts[0];
  if (row.FINAL === 'Y' && isEmpty(row.FNCNUM)) {
    return {
      ok: false,
      reason: 'half-state',
      detail: `${id.ivnum} already carries FINAL='Y' with no journal entry (FNCNUM empty, STATDES ${row.STATDES}). CLOSEANINVOICE skips such a document and the API refuses to change it ("לא ניתן לעדכן מסמך סופי"); only Priority support can clear the flag (ticket SCI26096671). Never write FINAL to fix it.`,
      rows,
    };
  }
  if (row.STATDES !== DRAFT_STATUS || row.FINAL === 'Y' || !isEmpty(row.FNCNUM)) {
    return {
      ok: false,
      reason: 'not-a-draft',
      detail: `${id.ivnum} is not an unposted draft (STATDES ${row.STATDES}, FINAL ${row.FINAL ?? 'empty'}, FNCNUM ${row.FNCNUM ?? 'empty'}).`,
      rows,
    };
  }
  if (!sameAmount(row.TOTPRICE, id.totprice)) {
    return {
      ok: false,
      reason: 'amount-mismatch',
      detail: `${id.ivnum} TOTPRICE is ${row.TOTPRICE ?? 'empty'}, not ${id.totprice}.`,
      rows,
    };
  }
  if (finals.length) {
    return {
      ok: false,
      reason: 'duplicate-final',
      detail: `A final ${id.form} document with BOOKNUM ${id.booknum} for ${id.party} already exists (${finals.map((f) => `${f.IVNUM} ${f.TOTPRICE}`).join(', ')}); closing ${id.ivnum} would invoice it twice.`,
      rows,
    };
  }
  if (foreignFinals.length) {
    return {
      ok: false,
      reason: 'duplicate-final',
      detail: `A final ${id.form} document with BOOKNUM ${id.booknum} already exists under another ${party} (${foreignFinals.map((f) => `${f.IVNUM} ${f[party] ?? ''} ${f.TOTPRICE}`).join(', ')}); closing ${id.ivnum} would invoice the same reference twice.`,
      rows: [...rows, ...foreign],
    };
  }
  const siblings = [...rows, ...foreign].filter((r) => r !== row && isOpenDraft(r));
  if (siblings.length && !allowSiblingDrafts) {
    return {
      ok: false,
      reason: 'sibling-drafts',
      detail: `${siblings.length} other open draft(s) share BOOKNUM ${id.booknum}: ${siblings.map((s) => `${s.IVNUM} ${party} ${s[party] ?? id.party} ${s.TOTPRICE}`).join(', ')}. Delete or reconcile them first, or pass allowSiblingDrafts=true knowingly (closes of one order are still serialized).`,
      rows: [...rows, ...foreign],
    };
  }
  return { ok: true, row, others: rows.filter((r) => r !== row) };
}

export async function preflight(
  client: PriorityClient,
  id: CloseIdentity,
  allowSiblingDrafts = false,
): Promise<PreflightResult> {
  const rows = await readByBooknum(client, id);
  const seen = new Set(rows.map((r) => r.IVNUM));
  const foreign = CLOSABLE_FORMS[id.form].booknumUniqueAcrossParties
    ? (await readByBooknum(client, id, true)).filter((r) => !seen.has(r.IVNUM))
    : [];
  return classifyPreflight(id, rows, foreign, allowSiblingDrafts);
}

/** After the activation: the draft must be gone and exactly one final document (same IV) must carry the BOOKNUM. */
export async function verifyClosed(
  client: PriorityClient,
  id: CloseIdentity,
  before: InvoiceRow,
): Promise<VerifyResult> {
  const rows = await readByBooknum(client, id);
  const draft = rows.find((r) => r.IVNUM === id.ivnum);
  const finals = rows.filter(isFinalRow);
  if (!draft && CLOSABLE_FORMS[id.form].booknumUniqueAcrossParties) {
    const allFinals = (await readByBooknum(client, id, true)).filter(isFinalRow);
    if (allFinals.length > 1) {
      return {
        verified: false,
        reason: `${allFinals.length} final documents carry BOOKNUM ${id.booknum} across customers (${allFinals.map((f) => `${f.IVNUM} ${f.CUSTNAME ?? ''}`).join(', ')}) — duplicate invoice, review by hand.`,
        rows: allFinals,
      };
    }
  }
  if (draft) {
    return {
      verified: false,
      reason: `${id.ivnum} still exists (STATDES ${draft.STATDES}, FINAL ${draft.FINAL ?? 'empty'}, FNCNUM ${draft.FNCNUM ?? 'empty'}).`,
      rows,
    };
  }
  if (finals.length !== 1) {
    return {
      verified: false,
      reason: `expected exactly one final document for ${id.booknum}, found ${finals.length}.`,
      rows,
    };
  }
  const final = finals[0];
  if (before.IV !== undefined && final.IV !== undefined && final.IV !== before.IV) {
    return {
      verified: false,
      reason: `final ${final.IVNUM} has internal IV ${final.IV}, the draft had ${before.IV} — not the same document.`,
      rows,
      final,
    };
  }
  if (!sameAmount(final.TOTPRICE, id.totprice)) {
    return {
      verified: false,
      reason: `final ${final.IVNUM} TOTPRICE ${final.TOTPRICE} differs from ${id.totprice}.`,
      rows,
      final,
    };
  }
  if (isEmpty(final.FNCNUM)) {
    return {
      verified: false,
      reason: `final ${final.IVNUM} has no FNCNUM (no journal entry was posted).`,
      rows,
      final,
    };
  }
  const journal = await readJournal(client, id, final);
  if (!journal.found || journal.FINAL !== 'Y') {
    return {
      verified: false,
      reason: `journal entry ${journal.FNCNUM} not found or not final.`,
      rows,
      final,
      journal,
    };
  }
  return { verified: true, final, journal };
}

async function readJournal(
  client: PriorityClient,
  id: CloseIdentity,
  final: InvoiceRow,
): Promise<JournalCheck> {
  const fncnum = String(final.FNCNUM);
  const query = `?$filter=${encodeURIComponent(`FNCNUM eq '${escapeODataString(fncnum)}'`)}&$select=FNCNUM,FNCREF,FINAL,BALDATE,SUMDEBIT,SUMCREDIT`;
  const res = await client.list<Record<string, unknown>>('FNCTRANS', query, { cache: false });
  const entry = (res.value ?? [])[0];
  const check: JournalCheck = {
    FNCNUM: fncnum,
    found: Boolean(entry),
    FINAL: (entry?.FINAL as string | null) ?? null,
    FNCREF: (entry?.FNCREF as string | null) ?? null,
    BALDATE: (entry?.BALDATE as string | null) ?? null,
    SUMDEBIT: (entry?.SUMDEBIT as number | null) ?? null,
    SUMCREDIT: (entry?.SUMCREDIT as number | null) ?? null,
  };
  const subform = CLOSABLE_FORMS[id.form].journalSubform;
  if (subform && final.DEBIT && final.IVTYPE) {
    try {
      const doc = await client.get<Record<string, unknown>>(
        id.form,
        { IVNUM: final.IVNUM, DEBIT: final.DEBIT, IVTYPE: final.IVTYPE },
        `?$select=IVNUM&$expand=${subform}`,
        { cache: false },
      );
      const lines = doc?.[subform];
      check.journalSubformLines = Array.isArray(lines) ? lines.length : 'unavailable';
    } catch {
      check.journalSubformLines = 'unavailable';
    }
  }
  return check;
}

// ------------------------------------------------------------------ SDK --------

function numericRows(bag: Record<string, WebSdkRow> | undefined): Array<[number, WebSdkRow]> {
  return Object.entries(bag ?? {})
    .filter(([k]) => /^\d+$/.test(k))
    .map(([k, v]) => [Number(k), v] as [number, WebSdkRow]);
}

/**
 * The SDK row must be the same document OData just approved. Fields the EINVOICES form does not
 * expose through the SDK (IV, DEBIT, FINAL, FNCNUM) are checked only when present.
 */
export function checkSdkRow(id: CloseIdentity, row: WebSdkRow, before?: InvoiceRow): string | null {
  const party = partyField(id.form);
  for (const key of ['IVNUM', 'BOOKNUM', party, 'TOTPRICE', 'STATDES']) {
    if (!(key in row)) return `SDK row has no ${key} column`;
  }
  if (row.IVNUM !== id.ivnum) return `IVNUM ${String(row.IVNUM)}`;
  if (String(row.BOOKNUM ?? '') !== id.booknum) return `BOOKNUM ${String(row.BOOKNUM)}`;
  if (String(row[party] ?? '') !== id.party) return `${party} ${String(row[party])}`;
  if (!sameAmount(row.TOTPRICE, id.totprice)) return `TOTPRICE ${String(row.TOTPRICE)}`;
  if (row.STATDES !== DRAFT_STATUS) return `STATDES ${String(row.STATDES)}`;
  if ('FINAL' in row && row.FINAL === 'Y') return 'FINAL already Y';
  if ('FNCNUM' in row && !isEmpty(row.FNCNUM)) return `FNCNUM ${String(row.FNCNUM)}`;
  if (before) {
    if ('IV' in row && before.IV !== undefined && String(row.IV) !== String(before.IV)) {
      return `IV ${String(row.IV)} ≠ ${before.IV}`;
    }
    if ('DEBIT' in row && before.DEBIT && row.DEBIT !== before.DEBIT)
      return `DEBIT ${String(row.DEBIT)}`;
    const sdkDate = String(row.IVDATE ?? '').slice(0, 10);
    const odataDate = String(before.IVDATE ?? '').slice(0, 10);
    if (sdkDate && odataDate && sdkDate !== odataDate) return `IVDATE ${sdkDate} ≠ ${odataDate}`;
  }
  return null;
}

/** Any other row of the same BOOKNUM that is final, or an open draft when siblings are not allowed, blocks the close. */
export function checkSdkSiblings(
  id: CloseIdentity,
  rows: WebSdkRow[],
  allowSiblingDrafts: boolean,
): string | null {
  const party = partyField(id.form);
  for (const r of rows) {
    if (r.IVNUM === id.ivnum) continue;
    if (String(r[party] ?? '') !== id.party && !CLOSABLE_FORMS[id.form].booknumUniqueAcrossParties)
      continue;
    const final = !isTemporary(r) || r.STATDES !== DRAFT_STATUS || r.FINAL === 'Y';
    if (final)
      return `${String(r.IVNUM)} (${String(r.STATDES)}) already carries BOOKNUM ${id.booknum}`;
    if (!allowSiblingDrafts) return `open draft ${String(r.IVNUM)} shares BOOKNUM ${id.booknum}`;
  }
  return null;
}

interface OpenedForm {
  form: WebSdkForm;
  messages: WebSdkServerMessage[];
  failure: () => Error | undefined;
}

/**
 * The SDK calls the formStart message callback with ONE argument — the message, carrying the form
 * as `.form` (index.js sendMessage; typings MessagesCallback). Older in-house scripts assumed
 * (form, message); both shapes are accepted so a message is never read as `undefined`.
 */
export function normalizeFormMessage(
  args: unknown[],
  fallbackForm?: WebSdkForm,
): { form: WebSdkForm | undefined; message: WebSdkServerMessage } {
  if (args.length >= 2 && args[1] && typeof args[1] === 'object') {
    return {
      form: (args[0] as WebSdkForm) ?? fallbackForm,
      message: args[1] as WebSdkServerMessage,
    };
  }
  const message = (args[0] ?? {}) as WebSdkServerMessage & { form?: WebSdkForm };
  return { form: message.form ?? fallbackForm, message };
}

async function openForm(
  session: WebSdkSession,
  id: CloseIdentity,
  stepTimeoutMs: number,
): Promise<OpenedForm> {
  const messages: WebSdkServerMessage[] = [];
  let failure: Error | undefined;
  let opened: WebSdkForm | undefined;
  const onMessage = (...args: unknown[]) => {
    const { form, message: m } = normalizeFormMessage(args, opened);
    messages.push({ type: m?.type, code: m?.code, message: m?.message, fatal: m?.fatal });
    if (m?.type === 'information') {
      // Unacknowledged messages block the form's request queue (activateEnd/endCurrentForm hang).
      form?.infoMsgConfirm?.();
      return;
    }
    failure = new Error(
      `form message: ${m?.type ?? 'unknown'} ${m?.code ?? ''} ${m?.message ?? ''}`.trim(),
    );
    if (m?.type === 'warning') form?.warningConfirm?.(0); // decline every warning — never auto-accept
  };
  try {
    await session.ensureLogin();
    opened = await withTimeout(
      session.sdk.formStart(id.form, onMessage, null, { company: session.company }, 0),
      stepTimeoutMs,
      `formStart(${id.form})`,
    );
  } catch (err) {
    // A dead or expired SDK session shows up here; make the next attempt log in again.
    session.reset();
    throw err instanceof Error ? err : new Error(describeError(err));
  }
  return { form: opened, messages, failure: () => failure };
}

async function locateRow(
  opened: OpenedForm,
  id: CloseIdentity,
  before: InvoiceRow | undefined,
  allowSiblingDrafts: boolean,
  stepTimeoutMs: number,
): Promise<{ index: number; row: WebSdkRow; rows: WebSdkRow[] }> {
  const { form, failure } = opened;
  // Filter by BOOKNUM, not IVNUM: since 01.11.2026 an IVNUM filter on a PINVOICES draft returns 0 rows.
  await withTimeout(
    form.setSearchFilter({
      or: 0,
      ignorecase: 0,
      QueryValues: [{ field: 'BOOKNUM', fromval: id.booknum, op: '=' }],
    }),
    stepTimeoutMs,
    'setSearchFilter',
  );
  if (failure()) throw failure();
  const res = await withTimeout(form.getRows(1), stepTimeoutMs, 'getRows');
  if (failure()) throw failure();
  const all = numericRows(res?.[id.form]);
  const matches = all.filter(([, r]) => r.IVNUM === id.ivnum);
  if (matches.length !== 1) {
    throw new Error(
      `SDK returned ${matches.length} rows with IVNUM ${id.ivnum} for BOOKNUM ${id.booknum}`,
    );
  }
  const [index, row] = matches[0];
  const mismatch = checkSdkRow(id, row, before);
  if (mismatch) throw new Error(`SDK row differs from the approved draft: ${mismatch}`);
  const rows = all.map(([, r]) => r);
  const sibling = checkSdkSiblings(id, rows, allowSiblingDrafts);
  if (sibling) throw new Error(`refusing to activate: ${sibling}`);
  return { index, row, rows };
}

async function closeForm(
  form: WebSdkForm | undefined,
  endTimeoutMs: number,
  session?: WebSdkSession,
): Promise<void> {
  if (!form) return;
  try {
    await withTimeout(form.endCurrentForm(), endTimeoutMs, 'endCurrentForm');
  } catch {
    // The OData readback, not the teardown, decides the outcome. A form that cannot be closed
    // leaves a stuck request queue in the SDK session, so the next close logs in afresh.
    session?.reset();
  }
}

/** Cancel a procedure step without ever waiting on it forever (a cancel polls until the server answers). */
async function safeCancel(
  proc: WebSdkProcStep['proc'] | undefined,
  timeoutMs: number,
): Promise<void> {
  if (!proc) return;
  await withTimeout(
    Promise.resolve().then(() => proc.cancel()),
    timeoutMs,
    'proc.cancel',
  ).catch(() => undefined);
}

/** Read-only SDK probe for a preview: login, open the form, find the row. No setActiveRow, no activation. */
export async function probeSdk(
  session: WebSdkSession,
  id: CloseIdentity,
  before: InvoiceRow | undefined,
  deps: CloseDeps = {},
): Promise<Record<string, unknown>> {
  const stepTimeoutMs = deps.stepTimeoutMs ?? 30_000;
  let opened: OpenedForm | undefined;
  try {
    opened = await openForm(session, id, stepTimeoutMs);
    const activation = opened.form.activations?.[CLOSE_ACTIVATION_KEY];
    const { index, row, rows } = await locateRow(opened, id, before, true, stepTimeoutMs);
    return {
      login: session.describe(),
      activation:
        activation ?? (opened.form.activations ? 'MISSING' : 'metadata not exposed by SDK'),
      rowIndex: index,
      sdkRow: row,
      siblingRows: rows
        .filter((r) => r !== row)
        .map((r) => ({ IVNUM: r.IVNUM, STATDES: r.STATDES, TOTPRICE: r.TOTPRICE })),
      formMessages: opened.messages,
    };
  } finally {
    await closeForm(opened?.form, deps.endTimeoutMs ?? 10_000, session);
  }
}

/** Only a 'warning' prompt is answerable through the SDK (OK/Cancel); its exact text must be listed. */
function acceptsPrompt(step: WebSdkProcStep, acceptPrompts: string[]): boolean {
  if (String(step.messagetype ?? '').toLowerCase() !== 'warning') return false;
  const text = String(step.message ?? '').trim();
  return text.length > 0 && acceptPrompts.some((p) => p.trim() === text);
}

/** Run CLOSEANINVOICE on the approved draft. Never retries; the caller verifies over OData. */
export async function runCloseActivation(
  session: WebSdkSession,
  id: CloseIdentity,
  before: InvoiceRow,
  options: { allowSiblingDrafts: boolean; acceptPrompts: string[] },
  deps: CloseDeps = {},
): Promise<ProcedureTrace> {
  const stepTimeoutMs = deps.stepTimeoutMs ?? 30_000;
  const endTimeoutMs = deps.endTimeoutMs ?? 15_000;
  const trace: ProcedureTrace = {
    steps: [],
    formMessages: [],
    dispatched: false,
    outcome: 'failed',
  };
  let opened: OpenedForm | undefined;
  let current: WebSdkProcStep | undefined;
  try {
    opened = await openForm(session, id, stepTimeoutMs);
    trace.formMessages = opened.messages;
    const { form, failure } = opened;
    const activation = form.activations?.[CLOSE_ACTIVATION_KEY];
    if (!activation) {
      throw new Error(
        `${CLOSE_ACTIVATION_KEY} is not an activation of ${id.form} for this user (activations ${form.activations ? 'listed' : 'not exposed'})`,
      );
    }
    if (activation.background !== 0 || ![0, 1].includes(Number(activation.confirm))) {
      throw new Error(
        `unexpected activation metadata for ${CLOSE_ACTIVATION_KEY}: ${JSON.stringify(activation)}`,
      );
    }
    trace.activation = activation;
    const { index, row } = await locateRow(
      opened,
      id,
      before,
      options.allowSiblingDrafts,
      stepTimeoutMs,
    );
    trace.sdkRow = row;
    await withTimeout(form.setActiveRow(index), stepTimeoutMs, 'setActiveRow');
    if (failure()) throw failure();

    trace.dispatched = true; // from here the server may have committed the close
    const started = form.activateStart(CLOSE_ACTIVATION, 'P', () => {});
    current = await withTimeout(started, stepTimeoutMs, 'activateStart').catch((err) => {
      // If the step arrives after we stopped waiting, cancel it instead of leaving it at a prompt.
      started.then((late) => safeCancel(late?.proc, endTimeoutMs)).catch(() => undefined);
      throw err;
    });
    for (let i = 0; i < MAX_PROCEDURE_STEPS && current && current.type !== 'end'; i++) {
      const step: WebSdkProcStep = current;
      const entry = {
        type: step.type,
        messagetype: step.messagetype,
        message: step.message,
        action: '',
      };
      trace.steps.push(entry);
      if (failure()) {
        entry.action = 'cancel (form message)';
        await safeCancel(step.proc, endTimeoutMs);
        trace.outcome = 'cancelled';
        throw failure();
      }
      if (step.type === 'message' && step.proc) {
        const kind = String(step.messagetype ?? '').toLowerCase();
        if (kind === 'information' || acceptsPrompt(step, options.acceptPrompts)) {
          entry.action =
            kind === 'information' ? 'message(1)' : 'message(1) — prompt accepted by caller list';
          current = await withTimeout(step.proc.message(1), stepTimeoutMs, 'proc.message');
          continue;
        }
        entry.action = 'cancel (unexpected message)';
        await safeCancel(step.proc, endTimeoutMs);
        trace.outcome = 'cancelled';
        throw new Error(
          `unexpected ${kind || 'message'} from Priority: ${step.message ?? ''}`.trim(),
        );
      }
      entry.action = `cancel (unexpected step ${step.type})`;
      await safeCancel(step.proc, endTimeoutMs);
      trace.outcome = 'cancelled';
      throw new Error(`unexpected procedure step: ${step.type}`);
    }
    if (!current || current.type !== 'end') {
      await safeCancel(current?.proc, endTimeoutMs);
      trace.outcome = 'cancelled';
      throw new Error(`procedure did not finish within ${MAX_PROCEDURE_STEPS} steps`);
    }
    const endKind = String(current.messagetype ?? '').toLowerCase();
    trace.steps.push({
      type: 'end',
      messagetype: current.messagetype,
      message: current.message,
      action: 'done',
    });
    // activateEnd can hang after 'end'; the OData readback is what decides.
    trace.outcome = endKind && endKind !== 'information' ? 'end-with-message' : 'end';
    if (trace.outcome === 'end-with-message') {
      trace.error = `end step carried a ${endKind}: ${current.message ?? ''}`.trim();
    }
    await withTimeout(form.activateEnd(), endTimeoutMs, 'activateEnd').catch(() => undefined);
    const late = failure();
    if (late) trace.error = `form message after the procedure ended: ${late.message}`;
    return trace;
  } catch (err) {
    trace.error = describeError(err);
    // A timed-out step leaves the procedure running server-side; cancelling is best effort only.
    if (trace.dispatched && current?.proc && /timed out/.test(trace.error)) {
      await safeCancel(current.proc, endTimeoutMs);
    }
    return trace;
  } finally {
    await closeForm(opened?.form, deps.endTimeoutMs ?? 10_000, session);
  }
}

// ----------------------------------------------------------------- ledger ------

export const DEFAULT_LEDGER_PATH = fileURLToPath(
  new URL('../../output/close-invoice-attempts.jsonl', import.meta.url),
);

/** Append-only, fsync'd record of every close attempt: intent before, result after. */
export function appendLedger(path: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ----------------------------------------------------------------- claims ------

interface ClaimRecord {
  t: number;
  pid: number;
  /** Random per attempt: a claim is only ever rewritten or removed by the attempt that owns it. */
  token: string;
  phase: 'in_flight' | 'unverified' | 'unknown';
  form: string;
  ivnum: string;
  booknum: string;
  party: string;
}

function slug(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

/**
 * Two claim files per close: the document and the order (see orderScope — BOOKNUM alone for
 * customer forms). Both are exclusive across every process that shares this output directory.
 */
export function claimPaths(ledgerPath: string, id: CloseIdentity): string[] {
  const dir = join(dirname(ledgerPath), 'locks');
  return [
    join(dir, `${id.form}-${id.ivnum}.lock`),
    join(dir, `${id.form}-order-${slug(orderScope(id))}.lock`),
  ];
}

interface ClaimState {
  raw: string;
  record?: Partial<ClaimRecord>;
  /** Claim time: the record's numeric t, else the file's mtime (fail closed on unreadable claims). */
  t: number;
  phase: string;
}

function readClaim(path: string): ClaimState | undefined {
  let raw: string;
  let mtime: number;
  try {
    raw = readFileSync(path, 'utf8');
    mtime = statSync(path).mtimeMs;
  } catch {
    return undefined; // no claim
  }
  let record: Partial<ClaimRecord> | undefined;
  try {
    record = JSON.parse(raw) as Partial<ClaimRecord>;
  } catch {
    record = undefined;
  }
  const t = typeof record?.t === 'number' && Number.isFinite(record.t) ? record.t : mtime;
  // An empty or unreadable claim (crash between create and write) is treated as a live in_flight
  // claim timed from the file itself: it blocks until it is genuinely stale, never forever.
  const phase = record && typeof record.phase === 'string' ? record.phase : 'in_flight';
  return { raw, record, t, phase };
}

type Claims =
  | { ok: true; release: (keep?: Partial<ClaimRecord>) => void }
  | { ok: false; reason: RefusalReason; detail: string };

function refuseFor(state: ClaimState, record: ClaimRecord, now: number, p: string): Claims | null {
  const age = now - state.t;
  const who = state.record?.ivnum;
  const same = who === record.ivnum;
  if (state.phase === 'in_flight' && age < STALE_CLAIM_MS) {
    return {
      ok: false,
      reason: 'in-flight',
      detail: `${same ? 'This document' : `Draft ${who ?? '?'} of the same order`} is being closed by process ${state.record?.pid ?? '?'} since ${new Date(state.t).toISOString()} (claim ${p}).`,
    };
  }
  if (state.phase !== 'in_flight' && age < COOLDOWN_MS) {
    return {
      ok: false,
      reason: 'cooldown',
      detail: `A close of ${who ?? '?'} was dispatched ${Math.round(age / 1000)} s ago and ended '${state.phase}'; re-read the document after ${Math.ceil((COOLDOWN_MS - age) / 1000)} s before trying again (claim ${p}).`,
    };
  }
  return null;
}

/**
 * Replace a stale claim atomically: only the holder of `<claim>.takeover` (exclusive create) may
 * remove the stale file, and only after re-reading it and finding exactly the content it judged
 * stale. Two processes can therefore never both delete-and-recreate the same claim.
 */
function takeOver(p: string, judged: ClaimState, now: number): boolean {
  const lock = `${p}.takeover`;
  try {
    writeFileSync(lock, String(now), { flag: 'wx', mode: 0o600 });
  } catch {
    try {
      if (now - statSync(lock).mtimeMs > TAKEOVER_STALE_MS) unlinkSync(lock); // abandoned by a crash
    } catch {
      // someone else is taking over right now
    }
    return false;
  }
  try {
    const again = readClaim(p);
    if (again && again.raw !== judged.raw) return false; // changed since we judged it: not ours to remove
    if (again) unlinkSync(p);
    return true;
  } catch {
    return false;
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // nothing to clean
    }
  }
}

/**
 * Take both claims or explain why not. A live in_flight claim refuses; a claim left by a dispatched
 * close whose result is not yet visible refuses for COOLDOWN_MS; a stale one is replaced atomically.
 */
function acquireClaims(paths: string[], record: ClaimRecord, now: number): Claims {
  mkdirSync(dirname(paths[0]), { recursive: true });
  const taken: string[] = [];
  const release = (keep?: Partial<ClaimRecord>) => {
    for (const p of taken) {
      try {
        const current = readClaim(p);
        if (current?.record?.token !== record.token) continue; // never touch another attempt's claim
        if (keep) writeFileSync(p, JSON.stringify({ ...record, ...keep }), { mode: 0o600 });
        else unlinkSync(p);
      } catch {
        // a leftover claim only makes the next attempt wait; it never allows a double dispatch
      }
    }
  };
  for (const p of paths) {
    const existing = readClaim(p);
    if (existing) {
      const refusal = refuseFor(existing, record, now, p);
      if (refusal) {
        release();
        return refusal;
      }
      if (!takeOver(p, existing, now)) {
        release();
        return {
          ok: false,
          reason: 'in-flight',
          detail: `Another process is replacing the stale claim ${p}; try again shortly.`,
        };
      }
    }
    try {
      writeFileSync(p, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      taken.push(p);
    } catch {
      release();
      return {
        ok: false,
        reason: 'in-flight',
        detail: `Could not take claim ${p}: another process holds it.`,
      };
    }
  }
  return { ok: true, release };
}

// --------------------------------------------------------------- orchestration --

const inFlight = new Set<string>();

export type CloseOutcome =
  | {
      status: 'preview';
      dryRun: true;
      identity: CloseIdentity;
      preflight: PreflightResult;
      plan: Record<string, unknown>;
      sdkProbe?: unknown;
    }
  | {
      status: 'refused';
      identity: CloseIdentity;
      reason: RefusalReason;
      detail: string;
      rows?: InvoiceRow[];
    }
  | {
      status: 'closed';
      identity: CloseIdentity;
      before: InvoiceRow;
      after: InvoiceRow;
      journal: JournalCheck;
      procedure: ProcedureTrace;
      ledger: string;
      ledgerError?: string;
    }
  | {
      status: 'unverified' | 'unknown';
      identity: CloseIdentity;
      before: InvoiceRow;
      dispatched: true;
      verification: VerifyResult;
      procedure: ProcedureTrace;
      ledger: string;
      ledgerError?: string;
      cooldownUntil: string;
    }
  | {
      status: 'failed';
      identity: CloseIdentity;
      before: InvoiceRow;
      dispatched: false;
      error: string;
      procedure: ProcedureTrace;
      readback: VerifyResult;
      ledger: string;
      ledgerError?: string;
    };

export function closePlan(
  id: CloseIdentity,
  acceptPrompts: string[] = [],
): Record<string, unknown> {
  return {
    procedure: CLOSE_ACTIVATION,
    activation: CLOSE_ACTIVATION_KEY,
    form: id.form,
    title: `סגירת חשבונית — ${CLOSABLE_FORMS[id.form].title}`,
    sdk: [
      'login (Web SDK, PAT)',
      `formStart('${id.form}') — activation ${CLOSE_ACTIVATION_KEY} must be listed with background 0`,
      `setSearchFilter(BOOKNUM = '${id.booknum}') → getRows(1) → the row whose IVNUM is ${id.ivnum}; any other final row or (unless allowed) open draft with that BOOKNUM refuses`,
      `verify the SDK row (BOOKNUM, ${partyField(id.form)}, TOTPRICE ${id.totprice}, STATDES ${DRAFT_STATUS}, IVDATE, FINAL empty)`,
      `setActiveRow → activateStart('${CLOSE_ACTIVATION}','P')`,
      `messages: information → continue; ${acceptPrompts.length ? `exactly ${JSON.stringify(acceptPrompts)} → OK` : 'no prompt is accepted'}; anything else, warnings, errors → cancel`,
      'activateEnd → endCurrentForm',
    ],
    verification: [
      `OData: ${id.ivnum} gone; exactly one final document with BOOKNUM ${id.booknum}, same internal IV, TOTPRICE ${id.totprice}; FINAL=Y; FNCNUM set`,
      'FNCTRANS(FNCNUM) exists with FINAL=Y',
      ...(CLOSABLE_FORMS[id.form].journalSubform
        ? [`${CLOSABLE_FORMS[id.form].journalSubform} line count (informational)`]
        : []),
    ],
    locks: [
      'document claim',
      CLOSABLE_FORMS[id.form].booknumUniqueAcrossParties
        ? 'order claim (BOOKNUM, any customer)'
        : 'order claim (BOOKNUM+supplier)',
      `cooldown ${COOLDOWN_MS / 1000} s after a dispatched close whose result is not yet visible`,
    ],
    neverDoes: ['PATCH FINAL', 'retry an activation', 'accept warnings or unlisted prompts'],
  };
}

export async function closeInvoice(
  client: PriorityClient,
  params: CloseParams,
  readOnly: boolean,
  deps: CloseDeps = {},
): Promise<CloseOutcome> {
  const id = validateIdentity(params);
  const allowSiblingDrafts = params.allowSiblingDrafts === true;
  const acceptPrompts = (params.acceptPrompts ?? []).map((p) => String(p)).filter((p) => p.trim());
  const pre = await preflight(client, id, allowSiblingDrafts);
  if (!pre.ok) {
    return {
      status: 'refused',
      identity: id,
      reason: pre.reason,
      detail: pre.detail,
      rows: pre.rows,
    };
  }

  if (params.dryRun) {
    const outcome: CloseOutcome = {
      status: 'preview',
      dryRun: true,
      identity: id,
      preflight: pre,
      plan: closePlan(id, acceptPrompts),
    };
    if (params.probeSdk) {
      if (!deps.session) throw new Error('Web SDK session factory is not available');
      try {
        outcome.sdkProbe = await probeSdk(deps.session(), id, pre.row, deps);
      } catch (err) {
        throw err instanceof Error ? err : new Error(describeError(err));
      }
    }
    return outcome;
  }
  if (readOnly) {
    return {
      status: 'refused',
      identity: id,
      reason: 'read-only',
      detail: 'Server is in read-only mode (PRIORITY_READ_ONLY=true); the activation was not run.',
    };
  }
  if (!deps.session) throw new Error('Web SDK session factory is not available');
  const session = deps.session(); // may throw (SDK missing, bad config) — before any record is written
  const now = deps.now ?? Date.now;
  const ledger = deps.ledgerPath ?? DEFAULT_LEDGER_PATH;
  const key = `${id.form}:${id.ivnum}`;
  const orderKey = orderScope(id);
  if (inFlight.has(key) || inFlight.has(orderKey)) {
    return {
      status: 'refused',
      identity: id,
      reason: 'in-flight',
      detail: `A close of ${inFlight.has(key) ? id.ivnum : `another draft of ${id.booknum}`} is already running in this process.`,
    };
  }
  inFlight.add(key);
  inFlight.add(orderKey);
  try {
    const started = now();
    const claims = acquireClaims(
      claimPaths(ledger, id),
      { t: started, pid: process.pid, token: randomUUID(), phase: 'in_flight', ...id },
      started,
    );
    if (!claims.ok) {
      return { status: 'refused', identity: id, reason: claims.reason, detail: claims.detail };
    }
    try {
      appendLedger(ledger, {
        t: new Date(started).toISOString(),
        phase: 'in_flight',
        ...id,
        before: pre.row,
      });
    } catch (err) {
      claims.release();
      return {
        status: 'refused',
        identity: id,
        reason: 'ledger-unwritable',
        detail: `Cannot write the attempt ledger ${ledger}: ${describeError(err)}. Nothing was activated.`,
      };
    }

    const procedure = await runCloseActivation(
      session,
      id,
      pre.row,
      { allowSiblingDrafts, acceptPrompts },
      deps,
    );
    const readback = await verifyClosed(client, id, pre.row).catch(
      (err): VerifyResult => ({
        verified: false,
        reason: `readback failed: ${describeError(err)}`,
        rows: [],
      }),
    );
    const finished = new Date(now()).toISOString();
    const record = (extra: Record<string, unknown>) => {
      try {
        appendLedger(ledger, { t: finished, ...id, ...extra });
        return undefined;
      } catch (err) {
        return describeError(err); // never hide the result of an activation behind a ledger error
      }
    };

    if (readback.verified && !procedure.dispatched) {
      const ledgerError = record({
        phase: 'closed-elsewhere',
        after: readback.final,
        error: procedure.error,
      });
      claims.release();
      return {
        status: 'refused',
        identity: id,
        reason: 'already-closed',
        detail: `${id.ivnum} was closed by someone else while this call was preparing (now ${readback.final.IVNUM}); this call dispatched nothing.${ledgerError ? ` Ledger error: ${ledgerError}` : ''}`,
      };
    }
    if (readback.verified) {
      const ledgerError = record({
        phase: 'closed',
        after: readback.final,
        journal: readback.journal,
        transport: procedure.outcome,
        error: procedure.error,
      });
      claims.release();
      return {
        status: 'closed',
        identity: id,
        before: pre.row,
        after: readback.final,
        journal: readback.journal,
        procedure,
        ledger,
        ledgerError,
      };
    }
    if (!procedure.dispatched) {
      const ledgerError = record({ phase: 'failed', error: procedure.error, readback });
      claims.release();
      return {
        status: 'failed',
        identity: id,
        before: pre.row,
        dispatched: false,
        error: procedure.error ?? 'activation did not start',
        procedure,
        readback,
        ledger,
        ledgerError,
      };
    }
    // Dispatched, but the close is not visible: keep the claims as a cooldown so nobody dispatches again blindly.
    const status = procedure.outcome === 'end' ? 'unverified' : 'unknown';
    const ledgerError = record({ phase: status, verification: readback, error: procedure.error });
    claims.release({ phase: status, t: now() });
    return {
      status,
      identity: id,
      before: pre.row,
      dispatched: true,
      verification: readback,
      procedure,
      ledger,
      ledgerError,
      cooldownUntil: new Date(now() + COOLDOWN_MS).toISOString(),
    };
  } finally {
    inFlight.delete(key);
    inFlight.delete(orderKey);
  }
}
