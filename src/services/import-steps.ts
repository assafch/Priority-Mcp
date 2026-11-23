import { PriorityError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { WebSdkSession } from '../client/web-sdk.js';
import type { Config } from '../config.js';
import {
  type ActivationSpec,
  type ActivationTrace,
  probeActivation,
  runActivation,
} from '../lib/form-activation.js';
import {
  BONDED_WAREHOUSE,
  CANCELLED_DOC_STATUS,
  DRAFT_DOC_STATUS,
  FINAL_DOC_STATUS,
  type FileFacts,
  type ReleaseFact,
  VAT_DECLARATION_PART,
  computeOfficialSteps,
  lineIsCosted,
  reconcileImportCosts,
} from '../lib/impfile-official.js';
import { runWithReleaseDraftScope } from '../lib/import-stage-guard.js';
import { type PhaseBStep, gate, gateWarnings } from '../lib/import-step-gates.js';
import { describeError } from '../lib/invoice-close.js';
import { escapeODataString } from '../lib/sanitize.js';
import {
  DEFAULT_STEP_LEDGER_PATH,
  type StepRecord,
  claimStep,
  cooldownReason,
  lastDoneAt,
  recordStep,
} from '../lib/step-ledger.js';
import { type LoadedFileFacts, isEmptyVatReleaseLine, loadFileFacts } from './import-facts.js';

/**
 * The executing import steps (phase B): the reversible steps of Priority's official import-file
 * procedure, each as one function that
 *
 *   reads → reports "already done" from what Priority shows → asks the gate → (preview stops
 *   here) → records the intent → writes → re-reads → reports only what the re-read shows.
 *
 * Nothing here makes a document final, closes an invoice or a file, or runs the costing: those
 * cannot be undone over the API and stay with the owner (phase C).
 */
type Row = Record<string, unknown>;

export type StepStatus =
  /** dryRun: the plan, nothing sent */
  | 'preview'
  /** a precondition is not met, or could not be read; nothing sent */
  | 'refused'
  /** PRIORITY_READ_ONLY=true; nothing sent */
  | 'blocked'
  /** written and confirmed by re-reading */
  | 'done'
  /** Priority already shows the result; nothing sent */
  | 'already-done'
  /** a document exists but is not complete; the next call continues it */
  | 'incomplete'
  /** dispatched, result not visible; wait and re-read before trying again */
  | 'unverified'
  /** a Priority program asked something unexpected and was cancelled */
  | 'cancelled'
  /** nothing was written */
  | 'failed';

export interface PlannedWrite {
  method: 'POST' | 'PATCH' | 'DELETE';
  endpoint: string;
  body: Row;
}

export interface StepOutcome {
  status: StepStatus;
  step: PhaseBStep;
  impfnum: string;
  /** false until this tool passed a supervised run on a real file (see the runbook) */
  piloted: boolean;
  acknowledged: boolean;
  verified: boolean;
  verification: { reason: string };
  reasons?: string[];
  warnings?: string[];
  wouldSend?: PlannedWrite[];
  sent?: PlannedWrite[];
  [key: string]: unknown;
}

export interface StepDeps {
  ledgerPath?: string;
  now?: () => number;
  /** Web SDK session for the tools that run a Priority program; created lazily by the caller. */
  session?: () => WebSdkSession;
  stepTimeoutMs?: number;
  endTimeoutMs?: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rows = (v: unknown): Row[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Row[]) : [];
const dayOf = (v: unknown): string | null => str(v)?.slice(0, 10) ?? null;
/** A line that stands for goods: not the VAT-from-declaration line, not a zeroed duplicate. */
const isProductLine = (l: Row): boolean =>
  !!str(l.PARTNAME) && str(l.PARTNAME) !== VAT_DECLARATION_PART && num(l.TQUANT) !== 0;
/** Carriage billed on a goods invoice; Priority does not pull it into a receipt. */
const CARRIAGE_PART = '000';

/**
 * A write Priority definitely rejected: nothing was created or changed. A 4xx from Priority is
 * that — except 408 and 413, which the client itself raises for a request that was already sent
 * and then timed out, was cancelled, or whose answer could not be read. Those are ambiguous, like
 * a 5xx: the document may exist.
 */
const definitelyRejected = (err: unknown): boolean =>
  err instanceof PriorityError &&
  err.statusCode >= 400 &&
  err.statusCode < 500 &&
  err.statusCode !== 408 &&
  err.statusCode !== 413;

/**
 * Which tools passed their supervised pilot on a real file (runbook, "Mark piloted"). Change a
 * value only after a clean pilot plus clean read-back checks, together with the runbook table.
 */
export const PILOTED: Record<PhaseBStep, boolean> = {
  declaration: true, // 2026-11-23, an open file at step 2
  // First pilot file, 2026-11-23 (one product, duty-free, GBP, full release); see the runbook table.
  receipt: true,
  fillDetail: true, // piloted with the old zeroing; deleting the VAT line has not run live yet
  calc: true,
  releaseDraft: true, // needed the VAT line deleted by hand; the code now ignores an empty one
  lineCosts: true,
};

/**
 * True when an unfiltered read of the form finds at least one row. These forms are never empty
 * in a working company, so an empty answer means the reads cannot be trusted: on 2026-11-23
 * PINVOICES answered 200 with an empty list, unfiltered, for a while. A filtered read that comes
 * back empty in such a moment looks like "no such document" — and a create on top of it makes a
 * duplicate. Throws when the read itself fails.
 */
async function formAnswers(client: PriorityClient, form: string, key: string): Promise<boolean> {
  const res = await client.list<Row>(form, new ODataBuilder().select(key).top(1).build(), {
    cache: false,
  });
  return Array.isArray(res?.value) && res.value.length > 0;
}

/** The refusal reason when a form's reads come back empty, or null when it answers. */
async function blindReason(
  client: PriorityClient,
  form: string,
  key: string,
): Promise<string | null> {
  let answers: boolean;
  try {
    answers = await formAnswers(client, form, key);
  } catch (err) {
    return `לא ניתן היה לוודא שהקריאות מ-${form} עובדות (${describeError(err)}). לא נשלח דבר.`;
  }
  return answers
    ? null
    : `${form} החזיר רשימה ריקה גם בקריאה בלי סינון, ולכן אי אפשר לסמוך על קריאה ריקה ממנו עכשיו. לא נשלח דבר; מנסים שוב בעוד כמה דקות.`;
}

function outcomes(step: PhaseBStep, impfnum: string) {
  const base = { step, impfnum, piloted: PILOTED[step] };
  return {
    refused: (reasons: string[], extra: Row = {}): StepOutcome => ({
      status: 'refused',
      ...base,
      acknowledged: false,
      verified: false,
      verification: { reason: 'Refused before anything was sent.' },
      reasons,
      ...extra,
    }),
    preview: (wouldSend: PlannedWrite[], extra: Row = {}): StepOutcome => ({
      status: 'preview',
      ...base,
      dryRun: true,
      acknowledged: false,
      verified: false,
      verification: { reason: 'Preview only; nothing was sent. Set dryRun=false to execute.' },
      wouldSend,
      ...extra,
    }),
    blocked: (): StepOutcome => ({
      status: 'blocked',
      ...base,
      acknowledged: false,
      verified: false,
      verification: { reason: 'Server read-only policy blocks execution.' },
      error: 'Server is in read-only mode (PRIORITY_READ_ONLY=true). Nothing was sent.',
    }),
    /** Reads cannot be trusted right now (see blindReason): nothing was sent. */
    blind: (reason: string): StepOutcome => ({
      status: 'blocked',
      ...base,
      acknowledged: false,
      verified: false,
      verification: { reason: 'Reads came back empty even unfiltered; nothing was sent.' },
      reasons: [reason],
    }),
    alreadyDone: (reason: string, extra: Row = {}, verified = true): StepOutcome => ({
      status: 'already-done',
      ...base,
      acknowledged: false,
      verified,
      verification: { reason },
      ...extra,
    }),
    done: (reason: string, extra: Row = {}): StepOutcome => ({
      status: 'done',
      ...base,
      acknowledged: true,
      verified: true,
      verification: { reason },
      ...extra,
    }),
    notDone: (
      status: 'incomplete' | 'unverified' | 'failed' | 'cancelled',
      reason: string,
      extra: Row = {},
    ): StepOutcome => ({
      status,
      ...base,
      acknowledged: status !== 'failed',
      verified: false,
      verification: { reason },
      ...extra,
    }),
  };
}

/**
 * Take a step for a write: the exclusive claim (another process on this machine), the cooldown
 * after an earlier unconfirmed send (only for a write that must not be repeated), and the intent
 * record. Nothing awaits in here, so two calls in one process cannot both pass. Returns the
 * outcome to return right away, or `release` to call when the write and its re-read are over.
 */
function beginStep(
  out: ReturnType<typeof outcomes>,
  ledgerPath: string,
  record: Omit<StepRecord, 'phase'>,
  now: number,
  opts: { cooldown: boolean },
): { stop: StepOutcome } | { release: () => void } {
  let claim: ReturnType<typeof claimStep>;
  try {
    claim = claimStep(ledgerPath, record.impfnum, record.step, now);
  } catch (err) {
    return {
      stop: out.notDone(
        'failed',
        `לא ניתן לכתוב ליומן הצעדים (${describeError(err)}); בלי רישום לא שולחים דבר לפריוריטי.`,
      ),
    };
  }
  if (!claim.ok) return { stop: out.refused([claim.reason]) };
  if (opts.cooldown) {
    const cooling = cooldownReason(ledgerPath, record.impfnum, record.step, now);
    if (cooling) {
      claim.release();
      return { stop: out.refused([cooling]) };
    }
  }
  try {
    recordStep(ledgerPath, { ...record, phase: 'in_flight' });
  } catch (err) {
    claim.release();
    return {
      stop: out.notDone(
        'failed',
        `לא ניתן לכתוב ליומן הצעדים (${describeError(err)}); בלי רישום לא שולחים דבר לפריוריטי.`,
      ),
    };
  }
  return { release: claim.release };
}

/** Record after a write was dispatched: a ledger failure must never hide the outcome. */
function recordAfter(path: string, record: StepRecord, outcome: StepOutcome): StepOutcome {
  try {
    recordStep(path, record);
    return outcome;
  } catch (err) {
    return { ...outcome, ledgerError: describeError(err) };
  }
}

async function readFacts(
  client: PriorityClient,
  impfnum: string,
): Promise<LoadedFileFacts | { error: string }> {
  try {
    return await loadFileFacts(client, impfnum);
  } catch (err) {
    return { error: `לא ניתן היה לקרוא את תיק היבוא ${impfnum}: ${describeError(err)}` };
  }
}

const PINVOICE_KEYS = (ivnum: string) => ({ IVNUM: ivnum, DEBIT: 'D', IVTYPE: 'P' });
const INVOICE_LINES = 'PINVOICEITEMS_SUBFORM';

/** One supplier invoice with its lines; null when it does not exist. Throws when the read fails. */
async function readInvoice(client: PriorityClient, ivnum: string): Promise<Row | null> {
  const qb = new ODataBuilder()
    .filter(`IVNUM eq '${escapeODataString(ivnum)}' and DEBIT eq 'D' and IVTYPE eq 'P'`)
    .expand(`${INVOICE_LINES}($select=KLINE,PARTNAME,TQUANT,CUSTOMSNUM,CUSTOMSDATE)`)
    .top(2);
  const res = await client.list<Row>('PINVOICES', qb.build(), { cache: false });
  if (!Array.isArray(res?.value)) throw new Error('PINVOICES returned no list');
  if (res.value.length > 1) throw new Error(`יותר מחשבונית אחת עם המספר ${ivnum}`);
  return res.value[0] ?? null;
}

/** "Not found" only when PINVOICES answers at all; otherwise the empty read is not believed. */
async function invoiceMissing(
  client: PriorityClient,
  out: ReturnType<typeof outcomes>,
  ivnum: string,
): Promise<StepOutcome> {
  const blind = await blindReason(client, 'PINVOICES', 'IVNUM');
  return blind ? out.blind(blind) : out.refused([`החשבונית ${ivnum} לא נמצאה בחשבוניות הספק.`]);
}

// ------------------------------------------------------- import declaration (step 2)

export interface DeclarationParams {
  impfnum: string;
  invoiceNumber: string;
  declaration: string;
  /** YYYY-MM-DD */
  declarationDate: string;
  country?: string;
  dryRun: boolean;
}

const VIEW_KEYS = (ivnum: string) => ({ IVNUM: ivnum, DEBIT: 'D', TYPE: 'P' });
const VIEW_LINES = 'IMPFILEIVS_SUBFORM';

/**
 * Write the import declaration (number + date) on every product line of a DRAFT goods invoice.
 * The field locks once the invoice is final, so this is the only moment it can be set.
 */
export async function setDeclaration(
  client: PriorityClient,
  config: Config,
  p: DeclarationParams,
  deps: StepDeps = {},
): Promise<StepOutcome> {
  const step: PhaseBStep = 'declaration';
  const out = outcomes(step, p.impfnum);
  const ledgerPath = deps.ledgerPath ?? DEFAULT_STEP_LEDGER_PATH;

  const loaded = await readFacts(client, p.impfnum);
  if ('error' in loaded) return out.refused([loaded.error]);
  const { facts, snapshot } = loaded;

  const linked = facts.invoices.find((iv) => iv.ivnum === p.invoiceNumber);
  if (!linked) {
    return out.refused([`החשבונית ${p.invoiceNumber} אינה מקושרת לתיק ${p.impfnum}.`]);
  }
  if (!linked.isGoods) {
    return out.refused([
      `החשבונית ${p.invoiceNumber} אינה של ספק הסחורה של התיק (${facts.supplier ?? '?'}). בחשבונית עלויות ההצהרה נרשמת בשורת ${VAT_DECLARATION_PART}, והיא נכתבת על ידי pinvoice_create.`,
    ]);
  }
  const headerDeclaration = str(snapshot.header?.CUSTOMSNUM);
  if (headerDeclaration !== p.declaration) {
    return out.refused([
      headerDeclaration
        ? `בכותרת התיק רשומה הצהרת יבוא אחרת (${headerDeclaration}). מתקנים קודם את הכותרת עם impfile_update, או מעבירים את המספר שבכותרת.`
        : 'בכותרת התיק אין הצהרת יבוא. רושמים אותה קודם בכותרת עם impfile_update (declaration, declarationDate).',
    ]);
  }

  let invoice: Row | null;
  try {
    invoice = await readInvoice(client, p.invoiceNumber);
  } catch (err) {
    return out.refused([`לא ניתן היה לקרוא את החשבונית ${p.invoiceNumber}: ${describeError(err)}`]);
  }
  if (!invoice) return invoiceMissing(client, out, p.invoiceNumber);
  const productLines = rows(invoice[INVOICE_LINES]).filter(isProductLine);
  if (productLines.length === 0) {
    return out.refused([`בחשבונית ${p.invoiceNumber} אין שורות מוצר.`]);
  }

  const plan: PlannedWrite[] = productLines
    .filter(
      (l) => str(l.CUSTOMSNUM) !== p.declaration || dayOf(l.CUSTOMSDATE) !== p.declarationDate,
    )
    .map((l) => ({
      method: 'PATCH' as const,
      endpoint: client.resolveSubformRowUrl(
        'PINVOICES',
        PINVOICE_KEYS(p.invoiceNumber),
        INVOICE_LINES,
        { KLINE: Number(l.KLINE) },
      ),
      body: { CUSTOMSNUM: p.declaration, CUSTOMSDATE: p.declarationDate },
    }));

  const readViewLines = async (): Promise<Row[]> => {
    const qb = new ODataBuilder()
      .filter(`IVNUM eq '${escapeODataString(p.invoiceNumber)}' and DEBIT eq 'D' and TYPE eq 'P'`)
      .expand(VIEW_LINES)
      .top(1);
    const res = await client.list<Row>('IMPFILEIV', qb.build(), { cache: false });
    return rows(res?.value?.[0]?.[VIEW_LINES]).filter(isProductLine);
  };
  if (p.country) {
    // Country of origin is validated against Priority's own table; if that cannot be read the
    // value is not written (it would be a guess).
    try {
      const qb = new ODataBuilder()
        .filter(`COUNTRYNAME eq '${escapeODataString(p.country)}'`)
        .select('COUNTRYNAME')
        .top(1);
      const res = await client.list<Row>('COUNTRIES', qb.build(), { cache: false });
      if (!res?.value?.length) {
        return out.refused([`ארץ המוצא "${p.country}" לא נמצאה בטבלת הארצות של פריוריטי.`]);
      }
      const viewLines = await readViewLines();
      if (viewLines.length === 0) {
        return out.refused([
          `לא נמצאו שורות המוצר של החשבונית ${p.invoiceNumber} בתצוגת "חשבוניות לתיקי יבוא"; ארץ המוצא נכתבת שם, ולכן לא נכתב דבר.`,
        ]);
      }
      for (const l of viewLines) {
        if (str(l.COUNTRYNAME) === p.country) continue;
        plan.push({
          method: 'PATCH',
          endpoint: client.resolveSubformRowUrl(
            'IMPFILEIV',
            VIEW_KEYS(p.invoiceNumber),
            VIEW_LINES,
            { KLINE: Number(l.KLINE) },
          ),
          body: { COUNTRYNAME: p.country },
        });
      }
    } catch (err) {
      return out.refused([
        `לא ניתן לאמת את ארץ המוצא "${p.country}" מול טבלת הארצות של פריוריטי (${describeError(err)}). לא כותבים ארץ מוצא בלי אימות: ממלאים אותה במסך, או מריצים בלי country.`,
      ]);
    }
  }

  if (plan.length === 0) {
    return out.alreadyDone(
      `כל ${productLines.length} שורות המוצר בחשבונית ${p.invoiceNumber} כבר נושאות את הצהרת היבוא ${p.declaration}.`,
      { invoice: p.invoiceNumber },
    );
  }
  const reasons = gate(step, facts, { invoiceNumber: p.invoiceNumber });
  if (reasons.length) return out.refused(reasons);
  if (p.dryRun) return out.preview(plan, { invoice: p.invoiceNumber });
  if (config.priorityReadOnly) return out.blocked();

  const begun = beginStep(
    out,
    ledgerPath,
    { impfnum: p.impfnum, step, docno: p.invoiceNumber },
    (deps.now ?? Date.now)(),
    { cooldown: false }, // line writes are repeatable; only the claim and the intent matter
  );
  if ('stop' in begun) return begun.stop;
  try {
    const sent: PlannedWrite[] = [];
    for (const write of plan) {
      const kline = { KLINE: Number(/KLINE=(\d+)/.exec(write.endpoint)?.[1]) };
      try {
        if ('COUNTRYNAME' in write.body) {
          await client.updateSubformRow(
            'IMPFILEIV',
            VIEW_KEYS(p.invoiceNumber),
            VIEW_LINES,
            kline,
            write.body,
          );
        } else {
          await client.updateSubformRow(
            'PINVOICES',
            PINVOICE_KEYS(p.invoiceNumber),
            INVOICE_LINES,
            kline,
            write.body,
          );
        }
        sent.push(write);
      } catch (err) {
        return recordAfter(
          ledgerPath,
          { impfnum: p.impfnum, step, phase: 'incomplete', docno: p.invoiceNumber },
          out.notDone(
            'incomplete',
            `נכתבו ${sent.length} מתוך ${plan.length} שורות; הכתיבה לשורה ${kline.KLINE} נכשלה: ${describeError(err)}. קריאה נוספת ממשיכה מהשורות שנשארו.`,
            { invoice: p.invoiceNumber, sent, error: describeError(err) },
          ),
        );
      }
    }

    // Read-back: only what Priority now shows counts.
    let missing: number;
    try {
      const after = await readInvoice(client, p.invoiceNumber);
      missing = rows(after?.[INVOICE_LINES])
        .filter(isProductLine)
        .filter(
          (l) => str(l.CUSTOMSNUM) !== p.declaration || dayOf(l.CUSTOMSDATE) !== p.declarationDate,
        ).length;
      if (p.country) {
        missing += (await readViewLines()).filter((l) => str(l.COUNTRYNAME) !== p.country).length;
      }
    } catch (err) {
      return recordAfter(
        ledgerPath,
        { impfnum: p.impfnum, step, phase: 'unverified', docno: p.invoiceNumber },
        out.notDone(
          'unverified',
          `השורות נכתבו אך הקריאה החוזרת נכשלה: ${describeError(err)}. קוראים שוב את החשבונית לפני שממשיכים.`,
          { invoice: p.invoiceNumber, sent },
        ),
      );
    }
    if (missing > 0) {
      return recordAfter(
        ledgerPath,
        { impfnum: p.impfnum, step, phase: 'incomplete', docno: p.invoiceNumber },
        out.notDone(
          'incomplete',
          `אחרי הכתיבה עדיין ${missing} שורות בלי הערך המבוקש — פריוריטי לא שמר את כולן.`,
          { invoice: p.invoiceNumber, sent },
        ),
      );
    }
    return recordAfter(
      ledgerPath,
      { impfnum: p.impfnum, step, phase: 'done', docno: p.invoiceNumber },
      out.done(
        `כל ${productLines.length} שורות המוצר בחשבונית ${p.invoiceNumber} נושאות את הצהרת היבוא ${p.declaration} (נקרא מחדש מפריוריטי).`,
        {
          invoice: p.invoiceNumber,
          sent,
          nextStep: 'אסף: סגירת החשבונית (priority_close_invoice), ואחריה bonded_receipt.',
        },
      ),
    );
  } finally {
    begun.release();
  }
}

// ------------------------------------------------- receipt into the bonded warehouse (step 4)

export interface ReceiptParams {
  impfnum: string;
  /** the real arrival date, YYYY-MM-DD */
  date: string;
  invoiceNumber?: string;
  dryRun: boolean;
}

const RECEIPT_KEYS = (docno: string) => ({ DOCNO: docno, TYPE: 'P' });
const RECEIPT_LINES = 'TRANSORDER_P_SUBFORM';
/** Local dates run ahead of UTC by at most this much; beyond it a date is in the future. */
const MAX_ZONE_AHEAD_MS = 14 * 3_600_000;

function futureDate(date: string, now: number): string | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return `התאריך ${date} אינו תקין (YYYY-MM-DD).`;
  return t > now + MAX_ZONE_AHEAD_MS
    ? `התאריך ${date} עתידי — רושמים את תאריך ההגעה האמיתי של הסחורה.`
    : null;
}

async function readReceiptDocs(
  client: PriorityClient,
  by: { ivnum: string } | { docno: string },
): Promise<Row[]> {
  const filter =
    'ivnum' in by
      ? `IVNUM eq '${escapeODataString(by.ivnum)}'`
      : `DOCNO eq '${escapeODataString(by.docno)}'`;
  const qb = new ODataBuilder()
    .filter(filter)
    .select('DOCNO', 'STATDES', 'TOWARHSNAME', 'TOLOCNAME', 'IVNUM', 'TOTPRICE', 'CURDATE')
    .expand(`${RECEIPT_LINES}($select=KLINE,PARTNAME,TQUANT,PQUANT)`)
    .top(20);
  const res = await client.list<Row>('DOCUMENTS_P', qb.build(), { cache: false });
  if (!Array.isArray(res?.value)) throw new Error('DOCUMENTS_P returned no list');
  return res.value;
}

function sumByPart(lines: Row[], field: string): Map<string, number> {
  const total = new Map<string, number>();
  for (const l of lines) {
    const part = str(l.PARTNAME);
    if (part) total.set(part, (total.get(part) ?? 0) + (num(l[field]) ?? 0));
  }
  return total;
}

/**
 * Create (or continue) a DRAFT receipt of the goods invoice into the bonded warehouse, with the
 * invoice quantities. Making it final stays with the owner.
 */
export async function createBondedReceipt(
  client: PriorityClient,
  config: Config,
  p: ReceiptParams,
  deps: StepDeps = {},
): Promise<StepOutcome> {
  const step: PhaseBStep = 'receipt';
  const out = outcomes(step, p.impfnum);
  const ledgerPath = deps.ledgerPath ?? DEFAULT_STEP_LEDGER_PATH;
  const now = deps.now ?? Date.now;

  const badDate = futureDate(p.date, now());
  if (badDate) return out.refused([badDate]);

  const loaded = await readFacts(client, p.impfnum);
  if ('error' in loaded) return out.refused([loaded.error]);
  const { facts } = loaded;

  const finals = facts.invoices.filter((iv) => iv.isGoods && iv.isFinal).map((iv) => iv.ivnum);
  if (finals.length === 0) {
    const reasons = gate(step, facts);
    return out.refused(reasons.length ? reasons : ['אין חשבונית סחורה סופית בתיק.']);
  }
  if (p.invoiceNumber && !finals.includes(p.invoiceNumber)) {
    return out.refused([
      `החשבונית ${p.invoiceNumber} אינה חשבונית סחורה סופית של התיק (קיימות: ${finals.join(', ')}).`,
    ]);
  }
  if (!p.invoiceNumber && finals.length > 1) {
    return out.refused([
      `בתיק יש כמה חשבוניות סחורה סופיות (${finals.join(', ')}) — מעבירים invoiceNumber כדי לבחור איזו מתקבלת.`,
    ]);
  }
  const ivnum = p.invoiceNumber ?? finals[0];

  let invoice: Row | null;
  let existing: Row[];
  try {
    [invoice, existing] = await Promise.all([
      readInvoice(client, ivnum),
      readReceiptDocs(client, { ivnum }),
    ]);
  } catch (err) {
    // An unreadable list is never "no receipt": that is how a second receipt gets created.
    return out.refused([
      `לא ניתן היה לקרוא את החשבונית ${ivnum} או את הקבלות הקיימות שלה: ${describeError(err)}`,
    ]);
  }
  if (!invoice) return invoiceMissing(client, out, ivnum);

  const live = existing.filter((r) => str(r.STATDES) !== CANCELLED_DOC_STATUS);
  if (live.length > 1) {
    return out.refused([
      `לחשבונית ${ivnum} כבר יש יותר מקבלה אחת שאינה מבוטלת (${live.map((r) => `${String(r.DOCNO)} ${String(r.STATDES)}`).join(', ')}) — בודקים במסך.`,
    ]);
  }
  const current = live[0];
  if (current && str(current.TOWARHSNAME) !== BONDED_WAREHOUSE) {
    return out.refused([
      `לחשבונית ${ivnum} כבר יש קבלה למחסן אחר: ${String(current.DOCNO)} (${String(current.TOWARHSNAME)}).`,
    ]);
  }
  if (current && str(current.STATDES) === FINAL_DOC_STATUS) {
    return out.alreadyDone(
      `הקבלה ${String(current.DOCNO)} של החשבונית ${ivnum} כבר סופית במחסן ${BONDED_WAREHOUSE}.`,
      { docno: current.DOCNO, documentStatus: current.STATDES, invoice: ivnum },
    );
  }

  /** Quantities already on a draft that this call did not create are never overwritten. */
  const enteredByOthers = (doc: Row): string[] =>
    rows(doc[RECEIPT_LINES])
      .filter((l) => (num(l.TQUANT) ?? 0) !== 0 && num(l.TQUANT) !== num(l.PQUANT))
      .map((l) => `${String(l.PARTNAME)}: ${num(l.TQUANT)} (בחשבונית ${num(l.PQUANT)})`);
  const foreignReason = (doc: Row, entered: string[]) =>
    `בטיוטת הקבלה ${String(doc.DOCNO)} כבר רשומות כמויות שאינן כמויות החשבונית: ${entered.join('; ')}. הכלי אינו דורס ספירה שהוזנה; משלימים את הקבלה במסך.`;
  if (current) {
    const entered = enteredByOthers(current);
    if (entered.length) return out.refused([foreignReason(current, entered)]);
  }

  const reasons = gate(step, facts);
  if (reasons.length) return out.refused(reasons);
  const warnings = gateWarnings(step, facts);

  const currency = str(invoice.CODE);
  if (!facts.supplier || !currency) {
    return out.refused(['לא ניתן היה לקרוא את ספק התיק או את מטבע החשבונית.']);
  }
  const header: Row = {
    CURDATE: p.date,
    SUPNAME: facts.supplier,
    TOWARHSNAME: BONDED_WAREHOUSE,
    TOLOCNAME: '0',
    IVNUM: ivnum,
    CODE: currency,
  };
  const invoiceLines = rows(invoice[INVOICE_LINES]).filter(isProductLine);

  if (p.dryRun) {
    return out.preview(
      current
        ? quantityWrites(client, String(current.DOCNO), rows(current[RECEIPT_LINES]))
        : [{ method: 'POST', endpoint: client.resolveEntityUrl('DOCUMENTS_P'), body: header }],
      {
        invoice: ivnum,
        ...(current ? { continues: current.DOCNO } : {}),
        afterwards:
          'אחרי יצירת הכותרת: קריאת השורות שפריוריטי משך מהחשבונית, השוואה לחשבונית, וכתיבת TQUANT=PQUANT בכל שורה. הקבלה נשארת בטיוטה.',
        invoiceProductLines: invoiceLines.map((l) => ({ part: l.PARTNAME, qty: l.TQUANT })),
        warnings,
      },
    );
  }
  if (config.priorityReadOnly) return out.blocked();

  // Only the create is not repeatable; continuing a draft needs the claim but no cooldown.
  const begun = beginStep(
    out,
    ledgerPath,
    { impfnum: p.impfnum, step, ...(current ? { docno: String(current.DOCNO) } : {}) },
    now(),
    { cooldown: !current },
  );
  if ('stop' in begun) return begun.stop;
  try {
    const sent: PlannedWrite[] = [];
    let docno = current ? String(current.DOCNO) : undefined;
    if (!docno) {
      // Look once more right before creating: a server on another machine does not share the
      // claim or the ledger, and may have created the receipt since the first look.
      let nowLive: Row[];
      try {
        nowLive = (await readReceiptDocs(client, { ivnum })).filter(
          (r) => str(r.STATDES) !== CANCELLED_DOC_STATUS,
        );
      } catch (err) {
        return recordAfter(
          ledgerPath,
          { impfnum: p.impfnum, step, phase: 'failed' },
          out.refused([
            `לא ניתן היה לקרוא שוב את הקבלות של החשבונית ${ivnum} לפני היצירה: ${describeError(err)}`,
          ]),
        );
      }
      if (nowLive.length > 0) {
        const appeared = nowLive[0];
        const entered = enteredByOthers(appeared);
        if (
          nowLive.length > 1 ||
          str(appeared.TOWARHSNAME) !== BONDED_WAREHOUSE ||
          str(appeared.STATDES) === FINAL_DOC_STATUS ||
          entered.length
        ) {
          return recordAfter(
            ledgerPath,
            { impfnum: p.impfnum, step, phase: 'failed' },
            out.refused([
              `בין הבדיקה ליצירה כבר נוצרה קבלה לחשבונית ${ivnum} (${nowLive.map((r) => `${String(r.DOCNO)} ${String(r.STATDES)}`).join(', ')}). לא נוצרה קבלה נוספת; קוראים שוב את הכלי כדי לראות את מצבה.`,
            ]),
          );
        }
        docno = String(appeared.DOCNO);
      }
    }
    if (!docno) {
      // An empty re-read is believed only when the form answers at all.
      const blind = await blindReason(client, 'DOCUMENTS_P', 'DOCNO');
      if (blind) {
        return recordAfter(
          ledgerPath,
          { impfnum: p.impfnum, step, phase: 'failed' },
          out.blind(blind),
        );
      }
    }
    if (!docno) {
      const post: PlannedWrite = {
        method: 'POST',
        endpoint: client.resolveEntityUrl('DOCUMENTS_P'),
        body: header,
      };
      let created: Row;
      try {
        created = await client.create<Row>('DOCUMENTS_P', header);
      } catch (err) {
        const rejected = definitelyRejected(err);
        return recordAfter(
          ledgerPath,
          { impfnum: p.impfnum, step, phase: rejected ? 'failed' : 'unverified' },
          out.notDone(
            rejected ? 'failed' : 'unverified',
            rejected
              ? `פריוריטי דחה את יצירת הקבלה: ${describeError(err)}. לא נוצר מסמך.`
              : `יצירת הקבלה נשלחה אך לא התקבלה תשובה ברורה (${describeError(err)}). ייתכן שהקבלה נוצרה: לא שולחים שוב; קוראים שוב בעוד כמה דקות, והכלי ימשיך טיוטה קיימת אם נוצרה.`,
            { invoice: ivnum, error: describeError(err) },
          ),
        );
      }
      sent.push(post);
      const createdDocno = str(created?.DOCNO);
      if (!createdDocno) {
        return recordAfter(
          ledgerPath,
          { impfnum: p.impfnum, step, phase: 'unverified' },
          out.notDone(
            'unverified',
            'הקבלה נשלחה אך פריוריטי לא החזיר מספר מסמך. קוראים שוב את הקבלות של החשבונית.',
            { invoice: ivnum, sent },
          ),
        );
      }
      docno = createdDocno;
    }
    const receipt = docno;

    const stop = (reason: string, extra: Row = {}) =>
      recordAfter(
        ledgerPath,
        { impfnum: p.impfnum, step, phase: 'incomplete', docno: receipt },
        out.notDone('incomplete', reason, {
          docno: receipt,
          invoice: ivnum,
          sent,
          warnings,
          doNotCreateAgain: `הטיוטה ${receipt} קיימת. קריאה נוספת של bonded_receipt ממשיכה אותה ואינה יוצרת קבלה שנייה.`,
          ...extra,
        }),
      );

    let doc: Row | undefined;
    try {
      doc = (await readReceiptDocs(client, { docno: receipt }))[0];
    } catch (err) {
      return stop(`לא ניתן היה לקרוא את הקבלה ${receipt} אחרי היצירה: ${describeError(err)}`);
    }
    if (!doc) return stop(`הקבלה ${receipt} לא נמצאה בקריאה חוזרת.`);

    // The lines Priority pulled must be the invoice's product lines, part by part.
    const lines = rows(doc[RECEIPT_LINES]);
    const want = sumByPart(invoiceLines, 'TQUANT');
    const got = sumByPart(lines, 'PQUANT');
    const problems: string[] = [];
    for (const [part, qty] of got) {
      if (want.get(part) !== qty) {
        problems.push(`${part}: בקבלה ${qty}, בחשבונית ${want.get(part) ?? 'אין שורה כזו'}`);
      }
    }
    const notPulled = [...want.keys()].filter((part) => !got.has(part));
    const missingProducts = notPulled.filter((part) => part !== CARRIAGE_PART);
    if (missingProducts.length) {
      problems.push(`מק"טים בחשבונית שלא נמשכו לקבלה: ${missingProducts.join(', ')}`);
    }
    if (problems.length) {
      return stop(
        `השורות שפריוריטי משך לקבלה ${receipt} אינן זהות לשורות המוצר בחשבונית ${ivnum}: ${problems.join('; ')}. הטיוטה נשארה כמות שהיא; בודקים במסך.`,
        { receiptLines: lines },
      );
    }

    for (const write of quantityWrites(client, receipt, lines)) {
      const kline = Number(/KLINE=(\d+)/.exec(write.endpoint.split('/').pop() ?? '')?.[1]);
      try {
        await client.updateSubformRow(
          'DOCUMENTS_P',
          RECEIPT_KEYS(receipt),
          RECEIPT_LINES,
          { KLINE: kline, TYPE: 'P' },
          write.body,
        );
        sent.push(write);
      } catch (err) {
        return stop(
          `כתיבת הכמות בשורה ${kline} של הקבלה ${receipt} נכשלה: ${describeError(err)}.`,
          { error: describeError(err) },
        );
      }
    }

    let after: Row | undefined;
    try {
      after = (await readReceiptDocs(client, { docno: receipt }))[0];
    } catch (err) {
      return stop(
        `הכמויות נכתבו אך הקריאה החוזרת של הקבלה ${receipt} נכשלה: ${describeError(err)}.`,
      );
    }
    const afterLines = rows(after?.[RECEIPT_LINES]);
    const open = afterLines.filter((l) => num(l.TQUANT) !== num(l.PQUANT));
    if (!after || afterLines.length !== lines.length || open.length) {
      return stop(
        `בקבלה ${receipt} נשארו ${open.length} שורות שהכמות בהן אינה כמות החשבונית, או שמספר השורות השתנה (נקרא מחדש).`,
        { receiptLines: afterLines },
      );
    }
    // "A draft in arov" is stated only if the re-read shows exactly that.
    if (str(after.STATDES) !== DRAFT_DOC_STATUS || str(after.TOWARHSNAME) !== BONDED_WAREHOUSE) {
      return stop(
        `הכמויות בקבלה ${receipt} נכונות, אך היא במחסן "${String(after.TOWARHSNAME)}" ובסטטוס "${String(after.STATDES)}" — ולא טיוטה במחסן ${BONDED_WAREHOUSE}. בודקים במסך.`,
        { receiptLines: afterLines, documentStatus: after.STATDES },
      );
    }
    const receiptTotal = num(after.TOTPRICE);
    const invoiceTotal = num(invoice.TOTPRICE);
    if (notPulled.length) {
      warnings.push(
        `שורת ${notPulled.join(', ')} שבחשבונית אינה מוצר ולא נמשכה לקבלה; לכן סכום הקבלה (${receiptTotal ?? '?'}) לא הושווה לסכום החשבונית (${invoiceTotal ?? '?'}).`,
      );
    } else if (
      receiptTotal === null ||
      invoiceTotal === null ||
      Math.abs(receiptTotal - invoiceTotal) > 0.005
    ) {
      return stop(
        `הכמויות בקבלה ${receipt} תואמות, אך סכום הקבלה (${receiptTotal ?? '?'}) שונה מסכום החשבונית (${invoiceTotal ?? '?'}). בודקים במסך לפני שהופכים לסופית.`,
        { receiptLines: afterLines },
      );
    }

    return recordAfter(
      ledgerPath,
      { impfnum: p.impfnum, step, phase: 'done', docno: receipt },
      out.done(
        `הקבלה ${receipt} בטיוטה במחסן ${BONDED_WAREHOUSE}: ${afterLines.length} שורות, כל כמות שווה לכמות החשבונית ${ivnum} (נקרא מחדש מפריוריטי).`,
        {
          docno: receipt,
          documentStatus: after.STATDES,
          invoice: ivnum,
          receiptTotal,
          invoiceTotal,
          lines: afterLines.map((l) => ({ part: l.PARTNAME, qty: l.TQUANT })),
          sent,
          warnings,
          nextStep: 'אסף: לשנות את סטטוס הקבלה לסופית במסך "קבלות סחורה מספק".',
        },
      ),
    );
  } finally {
    begun.release();
  }
}

/** One PATCH per receipt line whose received quantity is not yet the invoice quantity. */
function quantityWrites(client: PriorityClient, docno: string, lines: Row[]): PlannedWrite[] {
  return lines
    .filter((l) => num(l.TQUANT) !== num(l.PQUANT))
    .map((l) => ({
      method: 'PATCH' as const,
      endpoint: client.resolveSubformRowUrl('DOCUMENTS_P', RECEIPT_KEYS(docno), RECEIPT_LINES, {
        KLINE: Number(l.KLINE),
        TYPE: 'P',
      }),
      body: { TQUANT: num(l.PQUANT) },
    }));
}

// ------------------------------------------------ Priority's own programs (steps 5 and 6)

export interface ProgramParams {
  impfnum: string;
  dryRun: boolean;
  /** with dryRun: also log into the Web SDK and locate the row, read-only */
  probe?: boolean;
  /** exact warning texts that may be answered OK; default none */
  acceptPrompts?: string[];
}

const PROGRAM_TITLES: Record<string, string> = {
  FILL_IMPFILES: 'מילוי פירוט למחסן ערובה',
  IMPFILE2: 'חישוב העמסה',
  IMPORTCOSTPERLINE: 'רישום עלויות יבוא לשורה',
};

/** The SDK row of the import-file form must be this file, and open. */
function openFileRow(impfnum: string): ActivationSpec['checkRow'] {
  return (row) => {
    if (row.IMPFNUM !== impfnum) return `IMPFNUM ${String(row.IMPFNUM)}`;
    if (row.CLOSED === 'Y') return 'CLOSED Y — התיק סגור';
    return null;
  };
}

const sdkTimeouts = (deps: StepDeps) => ({
  ...(deps.stepTimeoutMs ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
  ...(deps.endTimeoutMs ? { endTimeoutMs: deps.endTimeoutMs } : {}),
});

/** Preview of a program run; with `probe` the row is also located through the SDK, read-only. */
async function programPreview(
  out: ReturnType<typeof outcomes>,
  spec: ActivationSpec,
  p: { probe?: boolean },
  deps: StepDeps,
  extra: Row = {},
): Promise<StepOutcome> {
  const preview = out.preview([], {
    program: spec.activation,
    wouldRun: {
      form: spec.form,
      activation: spec.activation,
      title: PROGRAM_TITLES[spec.activation],
      row: spec.filter,
      acceptPrompts: spec.acceptPrompts ?? [],
    },
    ...extra,
  });
  if (!p.probe) return preview;
  if (!deps.session) return { ...preview, probe: { error: 'Web SDK session is not configured.' } };
  try {
    const probe = await probeActivation(deps.session(), spec, sdkTimeouts(deps));
    const { sdkRow, ...rest } = probe;
    return {
      ...preview,
      probe: {
        ...rest,
        sdkRow: sdkRow
          ? Object.fromEntries(
              ['IMPFNUM', 'DOCNO', 'CLOSED', 'STATDES']
                .filter((k) => k in sdkRow)
                .map((k) => [k, sdkRow[k]]),
            )
          : undefined,
      },
    };
  } catch (err) {
    return { ...preview, probe: { error: describeError(err) } };
  }
}

/**
 * Dispatch one program, with the ledger around it. Returns the outcome to return right away, or
 * the trace of a program that ran to its end and now has to be verified by re-reading.
 */
async function dispatchProgram(args: {
  out: ReturnType<typeof outcomes>;
  step: PhaseBStep;
  impfnum: string;
  docno?: string;
  spec: ActivationSpec;
  deps: StepDeps;
  ledgerPath: string;
  now: () => number;
}): Promise<{ stop: StepOutcome } | { trace: ActivationTrace }> {
  const { out, step, impfnum, docno, spec, deps, ledgerPath } = args;
  const program = spec.activation;
  const title = PROGRAM_TITLES[program] ?? program;
  // Resolve the SDK before anything is recorded: a missing SDK must not leave a "sent" record.
  let session: WebSdkSession;
  try {
    if (!deps.session) throw new Error('Web SDK session is not configured.');
    session = deps.session();
  } catch (err) {
    return {
      stop: out.notDone(
        'failed',
        `לא ניתן להפעיל את ה-Web SDK של פריוריטי (${describeError(err)}); התוכנית "${title}" לא הופעלה.`,
        { program },
      ),
    };
  }
  const begun = beginStep(out, ledgerPath, { impfnum, step, docno }, args.now(), {
    cooldown: true,
  });
  if ('stop' in begun) return { stop: { ...begun.stop, program } };

  let trace: ActivationTrace;
  try {
    trace = await runActivation(session, spec, sdkTimeouts(deps));
  } finally {
    begun.release();
  }
  if (!trace.dispatched) {
    return {
      stop: recordAfter(
        ledgerPath,
        { impfnum, step, phase: 'failed', docno, detail: trace.error },
        out.notDone('failed', `התוכנית "${title}" לא הופעלה: ${trace.error ?? ''}`, {
          program,
          procedure: trace,
        }),
      ),
    };
  }
  if (trace.outcome === 'cancelled' && trace.cancelConfirmed === false) {
    // The cancel got no answer: the program may still be running or waiting at its prompt.
    return {
      stop: recordAfter(
        ledgerPath,
        { impfnum, step, phase: 'unverified', docno, detail: trace.error },
        out.notDone(
          'unverified',
          `התוכנית "${title}" הציגה שאלה לא צפויה, והביטול שלה לא אושר על ידי פריוריטי (${trace.error ?? ''}). ייתכן שהיא עדיין רצה או ממתינה: לא מפעילים שוב; קוראים את התיק מחדש בעוד כמה דקות.`,
          { program, procedure: trace },
        ),
      ),
    };
  }
  if (trace.outcome === 'cancelled') {
    return {
      stop: recordAfter(
        ledgerPath,
        { impfnum, step, phase: 'failed', docno, detail: trace.error },
        out.notDone(
          'cancelled',
          `התוכנית "${title}" הציגה שאלה או מסך קלט שלא נצפו מראש, והכלי ביטל אותה בלי לענות (${trace.error ?? ''}). הצעדים מפורטים ב-procedure.steps. קוראים את התיק מחדש כדי לראות אם משהו השתנה. אזהרה מאשרים רק אחרי שאסף ראה את הטקסט שלה ואישר אותו: אז מעבירים את הטקסט המדויק ב-acceptPrompts. הודעת שגיאה או מסך קלט אינם מאושרים כך.`,
          { program, procedure: trace },
        ),
      ),
    };
  }
  if (trace.outcome === 'failed') {
    return {
      stop: recordAfter(
        ledgerPath,
        { impfnum, step, phase: 'unverified', docno, detail: trace.error },
        out.notDone(
          'unverified',
          `התוכנית "${title}" נשלחה אך לא הסתיימה בצורה ברורה (${trace.error ?? ''}). ייתכן שרצה: לא מפעילים שוב; קוראים את התיק מחדש בעוד כמה דקות.`,
          { program, procedure: trace },
        ),
      ),
    };
  }
  return { trace };
}

/** What the program said against itself at its end, or null when it ended silently. */
const programComplaint = (trace: ActivationTrace | undefined): string | null =>
  trace && (trace.outcome === 'end-with-message' || trace.error) ? (trace.error ?? null) : null;

/** Compare the file's content with the product lines of its goods invoices, part by part. */
function contentVsInvoice(facts: FileFacts): { matches: boolean; problems: string[] } {
  const want = new Map<string, number>();
  for (const iv of facts.invoices.filter((x) => x.isGoods)) {
    for (const l of iv.lines) {
      if (!l.part || l.part === VAT_DECLARATION_PART) continue;
      want.set(l.part, (want.get(l.part) ?? 0) + (l.qty ?? 0));
    }
  }
  const got = new Map<string, number>();
  for (const c of facts.content) got.set(c.part, (got.get(c.part) ?? 0) + c.qty);
  const problems: string[] = [];
  for (const [part, qty] of got) {
    if (want.get(part) !== qty) {
      problems.push(`${part}: בתכולה ${qty}, בחשבונית ${want.get(part) ?? 'אין שורה כזו'}`);
    }
  }
  const missing = [...want.keys()].filter((part) => !got.has(part) && part !== CARRIAGE_PART);
  if (missing.length) problems.push(`מק"טים בחשבונית הסחורה שאינם בתכולה: ${missing.join(', ')}`);
  return { matches: facts.content.length > 0 && problems.length === 0, problems };
}

const CONTENT_LINES = 'IMPFILEITEMS_SUBFORM';

/** The "מע'מ" (VAT-from-declaration) rows of the file content, whatever their quantity. */
const vatContentRows = (snapshot: LoadedFileFacts['snapshot']): Row[] =>
  (snapshot.goodsContent ?? []).filter((c) => str(c.PARTNAME) === VAT_DECLARATION_PART);
const hasQty = (c: Row) => (num(c.TQUANT) ?? 0) !== 0;

/**
 * Step 5 — run "מילוי פירוט למחסן ערובה" (FILL_IMPFILES) and delete the VAT-from-declaration
 * line the program copies into the content. A line that is only zeroed stays in the content, and
 * a new release pulls it in (the first pilot file and its release, 2026-11-23); so the line is removed. When
 * Priority refuses the delete, the line's quantity is set to 0 instead, as before.
 */
export async function fillDetail(
  client: PriorityClient,
  config: Config,
  p: ProgramParams,
  deps: StepDeps = {},
): Promise<StepOutcome> {
  const step: PhaseBStep = 'fillDetail';
  const program = 'FILL_IMPFILES';
  const out = outcomes(step, p.impfnum);
  const ledgerPath = deps.ledgerPath ?? DEFAULT_STEP_LEDGER_PATH;
  const now = deps.now ?? Date.now;

  const loaded = await readFacts(client, p.impfnum);
  if ('error' in loaded) return out.refused([loaded.error], { program });
  const { facts } = loaded;
  const before = contentVsInvoice(facts);
  const vatBefore = vatContentRows(loaded.snapshot);
  if (before.matches && vatBefore.length === 0) {
    return out.alreadyDone(
      `תכולת התיק כבר זהה לשורות המוצר בחשבונית הסחורה (${facts.content.length} מק"טים) ואין בה שורת ${VAT_DECLARATION_PART}.`,
      { program, content: facts.content },
    );
  }
  // A closed file is not changed. A VAT line with no quantity there is left as it is.
  if (before.matches && facts.closed && !vatBefore.some(hasQty)) {
    return out.alreadyDone(
      `תכולת התיק זהה לשורות המוצר בחשבונית הסחורה (${facts.content.length} מק"טים).`,
      {
        program,
        content: facts.content,
        warnings: [
          `בתכולה נשארה שורת ${VAT_DECLARATION_PART} בכמות 0, והתיק סגור ולכן הכלי אינו מוחק אותה. bonded_release_draft מתעלם משורה כזו כשפריוריטי מושך אותה לתעודת השחרור.`,
        ],
      },
    );
  }
  // Products already in place and only the VAT line left: the program is not run again.
  const vatOnly = before.matches;
  const reasons = vatOnly
    ? facts.closed
      ? ['התיק סגור — לא משנים את התכולה של תיק סגור.']
      : []
    : gate(step, facts);
  if (reasons.length) return out.refused(reasons, { program });

  const removal = (c: Row): PlannedWrite => ({
    method: 'DELETE',
    endpoint: client.resolveSubformRowUrl('IMPFILES', p.impfnum, CONTENT_LINES, {
      KLINE: Number(c.KLINE),
    }),
    body: {},
  });
  const spec: ActivationSpec = {
    form: 'IMPFILES',
    activation: program,
    filter: { field: 'IMPFNUM', value: p.impfnum },
    checkRow: openFileRow(p.impfnum),
    acceptPrompts: p.acceptPrompts ?? [],
  };
  if (p.dryRun && vatOnly) {
    return out.preview(vatBefore.map(removal), {
      program,
      note: `המוצרים כבר בתכולה; התוכנית לא תופעל שוב. תימחק רק שורת ${VAT_DECLARATION_PART} (אם פריוריטי ידחה את המחיקה — הכמות שלה תאופס).`,
    });
  }
  if (p.dryRun) {
    return programPreview(out, spec, p, deps, {
      afterwards: `קריאה חוזרת של התכולה; אם התוכנית העתיקה שורת ${VAT_DECLARATION_PART}, מחיקתה (DELETE; אם פריוריטי דוחה — איפוס הכמות, PATCH TQUANT=0); השוואה לחשבונית הסחורה.`,
    });
  }
  if (config.priorityReadOnly) return out.blocked();

  let trace: ActivationTrace | undefined;
  let release = () => {};
  if (vatOnly) {
    // No program runs. The removal is repeatable, but it still takes the claim and is recorded.
    const begun = beginStep(out, ledgerPath, { impfnum: p.impfnum, step }, now(), {
      cooldown: false,
    });
    if ('stop' in begun) return { ...begun.stop, program };
    release = begun.release;
  } else {
    const run = await dispatchProgram({
      out,
      step,
      impfnum: p.impfnum,
      spec,
      deps,
      ledgerPath,
      now,
    });
    if ('stop' in run) return run.stop;
    trace = run.trace;
  }
  try {
    const sofar = trace ? 'התוכנית רצה, אך' : 'המוצרים כבר בתכולה, אך';
    const unverified = (reason: string, extra: Row = {}) =>
      recordAfter(
        ledgerPath,
        { impfnum: p.impfnum, step, phase: 'unverified' },
        out.notDone('unverified', reason, { program, procedure: trace, ...extra }),
      );

    let after = await readFacts(client, p.impfnum);
    if ('error' in after) return unverified(`${sofar} הקריאה החוזרת נכשלה: ${after.error}`);
    const sent: PlannedWrite[] = [];
    const warnings: string[] = [];
    const vatRows = vatContentRows(after.snapshot);
    if (vatRows.length) {
      const incomplete = (reason: string) =>
        recordAfter(
          ledgerPath,
          { impfnum: p.impfnum, step, phase: 'incomplete' },
          out.notDone('incomplete', reason, { program, procedure: trace, sent }),
        );
      if (vatRows.some((c) => num(c.KLINE) === null)) {
        return incomplete(
          `בתכולה יש שורת ${VAT_DECLARATION_PART}, אך לא נמצא מספר השורה שלה. מוחקים אותה במסך "תכולה במחסני ערובה".`,
        );
      }
      // Every VAT-from-declaration line is removed, not only the first one.
      for (const row of vatRows) {
        const kline = num(row.KLINE) as number;
        const write = removal(row);
        try {
          await client.deleteSubformRow('IMPFILES', p.impfnum, CONTENT_LINES, { KLINE: kline });
          sent.push(write);
          continue;
        } catch (err) {
          // An unclear answer is judged by the re-read below; the delete may have happened.
          if (!definitelyRejected(err)) {
            sent.push(write);
            continue;
          }
          warnings.push(
            `פריוריטי דחה את מחיקת שורת ${VAT_DECLARATION_PART} (שורה ${kline}): ${describeError(err)}.${hasQty(row) ? ' הכמות שלה אופסה במקום.' : ''} השורה נשארה בתכולה בכמות 0; bonded_release_draft מתעלם ממנה, ואפשר למחוק אותה במסך "תכולה במחסני ערובה".`,
          );
        }
        if (!hasQty(row)) continue;
        const zero: PlannedWrite = {
          method: 'PATCH',
          endpoint: write.endpoint,
          body: { TQUANT: 0 },
        };
        try {
          await client.updateSubformRow(
            'IMPFILES',
            p.impfnum,
            CONTENT_LINES,
            { KLINE: kline },
            zero.body,
          );
          sent.push(zero);
        } catch (err) {
          return incomplete(
            `המוצרים בתכולה, אך לא ניתן היה למחוק את שורת ${VAT_DECLARATION_PART} (שורה ${kline}) או לאפס אותה: ${describeError(err)}. קריאה נוספת תנסה רק את השורה הזו.`,
          );
        }
      }
      after = await readFacts(client, p.impfnum);
      if ('error' in after) {
        return unverified(`השורה טופלה, אך הקריאה החוזרת נכשלה: ${after.error}`, { sent });
      }
    }

    const check = contentVsInvoice(after.facts);
    const vatLeft = vatContentRows(after.snapshot);
    if (!check.matches || vatLeft.some(hasQty)) {
      return unverified(
        `${trace ? `אחרי "${PROGRAM_TITLES[program]}"` : `אחרי הטיפול בשורת ${VAT_DECLARATION_PART}`} התכולה אינה זהה לחשבונית הסחורה: ${
          check.problems.join('; ') ||
          (after.facts.content.length === 0
            ? 'התכולה ריקה'
            : `שורת ${VAT_DECLARATION_PART} עדיין בתכולה עם כמות`)
        }. בודקים במסך "תכולה במחסני ערובה"; לא מריצים שוב את התוכנית.`,
        { content: after.facts.content, sent },
      );
    }
    if (vatLeft.length && warnings.length === 0) {
      warnings.push(
        `המחיקה נשלחה, אך בקריאה החוזרת עדיין יש בתכולה שורת ${VAT_DECLARATION_PART} בכמות 0. bonded_release_draft מתעלם ממנה; אפשר למחוק אותה במסך "תכולה במחסני ערובה".`,
      );
    }
    // The content itself is the proof here; what the program said at its end is passed on.
    const complaint = programComplaint(trace);
    if (complaint) {
      warnings.push(`התוכנית הסתיימה עם הודעה: ${complaint}. התכולה נבדקה ונמצאה תקינה.`);
    }
    return recordAfter(
      ledgerPath,
      { impfnum: p.impfnum, step, phase: 'done' },
      out.done(
        `תכולת התיק זהה לשורות המוצר בחשבונית הסחורה (${after.facts.content.length} מק"טים) ${
          vatLeft.length
            ? `ושורת ${VAT_DECLARATION_PART} שבה בכמות 0`
            : `ואין בה שורת ${VAT_DECLARATION_PART}`
        } (נקרא מחדש מפריוריטי).`,
        {
          program,
          procedure: trace,
          content: after.facts.content,
          sent,
          warnings,
          nextStep: 'impfile_run_calc (חישוב העמסה), ואז בדיקה עם impfile_close.',
        },
      ),
    );
  } finally {
    release();
  }
}

/** Step 6 — run "חישוב העמסה" (IMPFILE2). May be repeated while the file is open. */
export async function runLoadingCalc(
  client: PriorityClient,
  config: Config,
  p: ProgramParams,
  deps: StepDeps = {},
): Promise<StepOutcome> {
  const step: PhaseBStep = 'calc';
  const program = 'IMPFILE2';
  const out = outcomes(step, p.impfnum);
  const ledgerPath = deps.ledgerPath ?? DEFAULT_STEP_LEDGER_PATH;
  const now = deps.now ?? Date.now;

  const loaded = await readFacts(client, p.impfnum);
  if ('error' in loaded) return out.refused([loaded.error], { program });
  const reasons = gate(step, loaded.facts);
  if (reasons.length) return out.refused(reasons, { program });

  const spec: ActivationSpec = {
    form: 'IMPFILES',
    activation: program,
    filter: { field: 'IMPFNUM', value: p.impfnum },
    checkRow: openFileRow(p.impfnum),
    acceptPrompts: p.acceptPrompts ?? [],
  };
  if (p.dryRun) {
    return programPreview(out, spec, p, deps, {
      afterwards:
        'קריאה חוזרת של התיק: אומדן המכס חייב לכסות כל מק"ט בתכולה, עם ארץ מוצא בכל שורה.',
      lastCalcViaTool: lastDoneAt(ledgerPath, p.impfnum, step),
    });
  }
  if (config.priorityReadOnly) return out.blocked();

  const run = await dispatchProgram({ out, step, impfnum: p.impfnum, spec, deps, ledgerPath, now });
  if ('stop' in run) return run.stop;
  const { trace } = run;
  const unverified = (reason: string, extra: Row = {}) =>
    recordAfter(
      ledgerPath,
      { impfnum: p.impfnum, step, phase: 'unverified' },
      out.notDone('unverified', reason, { program, procedure: trace, ...extra }),
    );

  const after = await readFacts(client, p.impfnum);
  if ('error' in after) return unverified(`התוכנית רצה אך הקריאה החוזרת נכשלה: ${after.error}`);
  // The customs estimate may have been complete before this run, so it proves nothing about the
  // run. If the program said anything against itself at its end, the run is not confirmed.
  const complaint = programComplaint(trace);
  if (complaint) {
    return unverified(
      `"${PROGRAM_TITLES[program]}" הסתיימה עם הודעה: ${complaint}. אין בנתונים הוכחה שהחישוב בוצע; בודקים את ההודעה במסך ומריצים שוב.`,
    );
  }
  const f = after.facts;
  const parts = [...new Set(f.content.map((c) => c.part))];
  const covered = parts.filter((part) => f.customsEstimateParts.includes(part)).length;
  const noCountry = f.customsEstimateWithoutCountry ?? 0;
  const stage = computeOfficialSteps(f);
  const stageSummary = { currentStep: stage.currentStep, nextAction: stage.nextAction };
  const customsEstimateLines = (after.snapshot.customsEstimate ?? []).length;
  if (parts.length === 0 || covered !== parts.length || noCountry > 0) {
    const gaps = [
      ...(covered !== parts.length || parts.length === 0
        ? [`אומדן המכס מכסה ${covered}/${parts.length} מק"טים`]
        : []),
      ...(noCountry > 0 ? [`${noCountry} שורות באומדן המכס בלי ארץ מוצא`] : []),
    ];
    return unverified(
      `"${PROGRAM_TITLES[program]}" הסתיימה, אך התוצאה אינה שלמה: ${gaps.join('; ')}.`,
      { customsEstimateLines, stage: stageSummary },
    );
  }
  const result = recordAfter(
    ledgerPath,
    { impfnum: p.impfnum, step, phase: 'done' },
    out.done(
      `"${PROGRAM_TITLES[program]}" רצה; אומדן המכס מכסה את כל ${parts.length} המק"טים בתכולה, עם ארץ מוצא בכל שורה (נקרא מחדש מפריוריטי).`,
      {
        program,
        procedure: trace,
        customsEstimateLines,
        stage: stageSummary,
        note: 'לפי הנוהל מריצים שוב אחרי כל שינוי בתיק (חשבונית, תכולה, עלות), ובכל מקרה לפני "סגירת התיק".',
        nextStep: 'impfile_close לבדיקת מוכנות, ואז אסף: "סגירת התיק" במסך תיקי יבוא.',
      },
    ),
  );
  return { ...result, ranAt: lastDoneAt(ledgerPath, p.impfnum, step) };
}

// ------------------------------------------- draft release from the bonded warehouse (step 8)

export interface ReleaseDraftParams {
  impfnum: string;
  /** release date, YYYY-MM-DD */
  date: string;
  /** the import declaration issued for THIS release */
  declaration: string;
  /** omitted = the whole balance in bond */
  quantities?: Array<{ part: string; qty: number }>;
  toWarehouse: string;
  toLocation: string;
  allowWithoutCostInvoice: boolean;
  dryRun: boolean;
}

const RELEASE_KEYS = (docno: string) => ({ DOCNO: docno, TYPE: 'J' });
const RELEASE_LINES = 'TRANSORDER_J_SUBFORM';

async function readReleaseDoc(client: PriorityClient, docno: string): Promise<Row | undefined> {
  const qb = new ODataBuilder()
    .filter(`DOCNO eq '${escapeODataString(docno)}'`)
    .select('DOCNO', 'STATDES', 'DOCREF', 'IMPFNUM', 'CURDATE', 'TOWARHSNAME', 'TOLOCNAME')
    .expand(`${RELEASE_LINES}($select=KLINE,PARTNAME,PQUANT,TQUANT)`)
    .top(2);
  const res = await client.list<Row>('DOCUMENTS_J', qb.build(), { cache: false });
  if (!Array.isArray(res?.value)) throw new Error('DOCUMENTS_J returned no list');
  return res.value[0];
}

/** The quantity each release line should carry, by line number; problems stop the step. */
function releaseTargets(
  lines: Row[],
  quantities: ReleaseDraftParams['quantities'],
): { targets: Map<number, number>; problems: string[] } {
  const targets = new Map<number, number>();
  const problems: string[] = [];
  for (const l of lines) targets.set(Number(l.KLINE), quantities ? 0 : (num(l.PQUANT) ?? 0));
  for (const q of quantities ?? []) {
    const ofPart = lines.filter((l) => str(l.PARTNAME) === q.part);
    if (ofPart.length === 0) problems.push(`${q.part}: אין שורה כזו בתעודה`);
    else if (ofPart.length > 1) {
      problems.push(
        `${q.part}: מופיע ב-${ofPart.length} שורות בתעודה — כמות חלקית למק"ט כזה קובעים במסך`,
      );
    } else if (q.qty > (num(ofPart[0].PQUANT) ?? 0)) {
      problems.push(`${q.part}: התבקשו ${q.qty}, בתעודה זמינים ${num(ofPart[0].PQUANT) ?? 0}`);
    } else targets.set(Number(ofPart[0].KLINE), q.qty);
  }
  return { targets, problems };
}

/**
 * Create (or continue) a DRAFT release from the bonded warehouse and set its quantities. The
 * per-line import costs are registered on this draft (bonded_line_costs) before the owner makes
 * it final — SOP LBI2400656, ד׳ 13–15.
 */
export async function createReleaseDraft(
  client: PriorityClient,
  config: Config,
  p: ReleaseDraftParams,
  deps: StepDeps = {},
): Promise<StepOutcome> {
  const step: PhaseBStep = 'releaseDraft';
  const out = outcomes(step, p.impfnum);
  const ledgerPath = deps.ledgerPath ?? DEFAULT_STEP_LEDGER_PATH;
  const now = deps.now ?? Date.now;

  const badDate = futureDate(p.date, now());
  if (badDate) return out.refused([badDate]);

  const loaded = await readFacts(client, p.impfnum);
  if ('error' in loaded) return out.refused([loaded.error]);
  const { facts, snapshot } = loaded;

  // What the caller asked for must fit what is in bond.
  const balance = new Map<string, number>();
  for (const c of facts.content) {
    if (c.balance > 0) balance.set(c.part, (balance.get(c.part) ?? 0) + c.balance);
  }
  const contentRows = new Map<string, number>();
  for (const c of facts.content) {
    if (c.balance > 0) contentRows.set(c.part, (contentRows.get(c.part) ?? 0) + 1);
  }
  const asked = new Map<string, number>();
  const inputProblems: string[] = [];
  for (const q of p.quantities ?? []) {
    if (asked.has(q.part)) inputProblems.push(`המק"ט ${q.part} מופיע פעמיים ברשימת הכמויות.`);
    asked.set(q.part, q.qty);
    if ((contentRows.get(q.part) ?? 0) > 1) {
      inputProblems.push(
        `${q.part}: מופיע ב-${contentRows.get(q.part)} שורות בתכולת התיק — כמות חלקית למק"ט כזה קובעים במסך, שורה שורה.`,
      );
    }
    const available = balance.get(q.part);
    if (available === undefined) {
      inputProblems.push(`המק"ט ${q.part} אינו בתכולת התיק או שאין לו יתרה בערובה.`);
    } else if (q.qty > available) {
      inputProblems.push(`${q.part}: התבקשו ${q.qty}, היתרה בערובה ${available}.`);
    }
  }
  const partial =
    !!p.quantities && [...balance].some(([part, available]) => (asked.get(part) ?? 0) < available);
  if (p.allowWithoutCostInvoice && !partial) {
    inputProblems.push(
      'allowWithoutCostInvoice מותר רק בשחרור חלקי (quantities) שמשאיר יתרה בערובה; שחרור מלא בלי חשבונית עלויות מכניס את כל הסחורה למלאי בלי עלויות נלוות.',
    );
  }
  if (inputProblems.length) return out.refused(inputProblems);

  // One open draft with the same declaration is continued; any other open draft stops the step.
  const drafts = (facts.releases ?? []).filter(
    (r) => r.status !== FINAL_DOC_STATUS && r.status !== CANCELLED_DOC_STATUS,
  );
  let continues: string | undefined;
  if (drafts.length === 1) {
    if (drafts[0].declaration !== p.declaration) {
      return out.refused([
        `כבר קיימת תעודת שחרור שאינה סופית לתיק: ${drafts[0].docno} (${drafts[0].status}), עם הצהרת יבוא ${drafts[0].declaration ?? 'ריקה'} — והתבקשה ${p.declaration}. ממשיכים אותה עם ההצהרה שלה, או מבטלים אותה במסך.`,
      ]);
    }
    continues = drafts[0].docno;
  }

  /**
   * Priority pulls the file content's "מע'מ" line into a new release. With no quantity it is not
   * goods: left out of the comparison and of the quantity writes, and reported as a warning. With
   * a quantity it would move a VAT part into stock, so it stops the step.
   */
  const planFor = (docno: string, allLines: Row[]) => {
    const problems: string[] = [];
    const lines = allLines.filter((l) => !isEmptyVatReleaseLine(l));
    for (const l of lines.filter((x) => str(x.PARTNAME) === VAT_DECLARATION_PART)) {
      problems.push(
        `בשורה ${String(l.KLINE)} של התעודה יש שורת ${VAT_DECLARATION_PART} בכמות ${num(l.PQUANT) ?? 0} (מבוקש ${num(l.TQUANT) ?? 0}). היא אינה מוצר ואסור שתיכנס למלאי; מוחקים אותה במסך.`,
      );
    }
    const pulled = sumByPart(
      lines.filter((l) => str(l.PARTNAME) !== VAT_DECLARATION_PART),
      'PQUANT',
    );
    for (const [part, qty] of pulled) {
      if (balance.get(part) !== qty) {
        problems.push(`${part}: בתעודה ${qty}, יתרה בערובה ${balance.get(part) ?? 'אין'}`);
      }
    }
    const absent = [...balance.keys()].filter((part) => !pulled.has(part));
    if (absent.length) problems.push(`מק"טים עם יתרה בערובה שאינם בתעודה: ${absent.join(', ')}`);
    const { targets, problems: targetProblems } = releaseTargets(lines, p.quantities);
    problems.push(...targetProblems);
    const ignoredVat = allLines.length - lines.length;
    const writes: PlannedWrite[] = lines
      .filter((l) => num(l.TQUANT) !== targets.get(Number(l.KLINE)))
      .map((l) => ({
        method: 'PATCH' as const,
        endpoint: client.resolveSubformRowUrl('DOCUMENTS_J', RELEASE_KEYS(docno), RELEASE_LINES, {
          KLINE: Number(l.KLINE),
          TYPE: 'J',
        }),
        body: { TQUANT: targets.get(Number(l.KLINE)) ?? 0 },
      }));
    return { problems, targets, writes, goodsLines: lines, ignoredVat };
  };
  const vatWarning = (docno: string, count: number) =>
    `בתעודת השחרור ${docno} יש ${count === 1 ? 'שורת' : `${count} שורות`} ${VAT_DECLARATION_PART} בכמות 0 שפריוריטי משך מתכולת התיק. הכלי מתעלם ממנה: היא אינה מוצר ואין לה עלות. לא נבדק עדיין אם פריוריטי מאפשר להפוך את התעודה לסופית כשהיא בה; אם לא — מוחקים אותה במסך לפני שהופכים לסופית.`;
  const describeLines = (lines: Row[]) =>
    lines.map((l) => ({ part: l.PARTNAME, qty: l.TQUANT, available: l.PQUANT }));

  /**
   * Why a draft this call did not create must not be continued: it goes somewhere else than
   * asked, or it already carries quantities other than the requested ones.
   */
  const draftBlockers = (doc: Row): string[] => {
    const docno = String(doc.DOCNO);
    const reasons: string[] = [];
    if (str(doc.TOWARHSNAME) !== p.toWarehouse || str(doc.TOLOCNAME) !== p.toLocation) {
      reasons.push(
        `תעודת השחרור ${docno} שבטיוטה היא למחסן ${String(doc.TOWARHSNAME)}/${String(doc.TOLOCNAME)}, ולא ${p.toWarehouse}/${p.toLocation} כמבוקש. הכלי אינו משנה יעד של תעודה קיימת.`,
      );
    }
    const lines = rows(doc[RELEASE_LINES]).filter((l) => !isEmptyVatReleaseLine(l));
    const { targets } = releaseTargets(lines, p.quantities);
    const entered = lines
      .filter((l) => (num(l.TQUANT) ?? 0) !== 0 && num(l.TQUANT) !== targets.get(Number(l.KLINE)))
      .map(
        (l) =>
          `${String(l.PARTNAME)}: ${num(l.TQUANT)} (התבקש ${targets.get(Number(l.KLINE)) ?? 0})`,
      );
    if (entered.length) {
      reasons.push(
        `בטיוטת השחרור ${docno} כבר רשומות כמויות אחרות מהמבוקש: ${entered.join('; ')}. הכלי אינו דורס כמויות שהוזנו; מתקנים במסך, או מבקשים את הכמויות שבטיוטה.`,
      );
    }
    return reasons;
  };

  let current: Row | undefined;
  if (continues) {
    try {
      current = await readReleaseDoc(client, continues);
    } catch (err) {
      return out.refused([`לא ניתן היה לקרוא את תעודת השחרור ${continues}: ${describeError(err)}`]);
    }
    if (!current) return out.refused([`תעודת השחרור ${continues} לא נמצאה בקריאה חוזרת.`]);
    const blockers = draftBlockers(current);
    if (blockers.length) return out.refused(blockers);
    const lines = rows(current[RELEASE_LINES]);
    const plan = planFor(continues, lines);
    if (plan.goodsLines.length > 0 && plan.problems.length === 0 && plan.writes.length === 0) {
      return out.alreadyDone(
        `תעודת השחרור ${continues} בטיוטה וכבר נושאת את הכמויות המבוקשות (${plan.goodsLines.length} שורות).`,
        {
          docno: continues,
          documentStatus: current.STATDES,
          lines: describeLines(lines),
          ...(plan.ignoredVat ? { warnings: [vatWarning(continues, plan.ignoredVat)] } : {}),
          nextStep: 'bonded_line_costs על התעודה, ואז אסף משנה את הסטטוס לסופית.',
        },
      );
    }
  }

  const reasons = gate(step, facts, {
    releaseDocno: continues,
    allowWithoutCostInvoice: p.allowWithoutCostInvoice,
  });
  if (reasons.length) return out.refused(reasons);

  const warnings: string[] = [];
  const headerDeclaration = str(snapshot.header?.CUSTOMSNUM);
  if (headerDeclaration !== p.declaration) {
    warnings.push(
      `הצהרת היבוא של השחרור (${p.declaration}) שונה מזו שבכותרת התיק (${headerDeclaration ?? 'ריקה'}). זה תקין בשחרור חלקי עם רשומון משלו; אם זו טעות, עוצרים כאן.`,
    );
  }
  if (current && dayOf(current.CURDATE) !== p.date) {
    warnings.push(
      `תאריך הטיוטה ${String(current.DOCNO)} הוא ${dayOf(current.CURDATE) ?? '?'} ולא ${p.date} כמבוקש; הכלי אינו משנה תאריך של תעודה קיימת.`,
    );
  }
  const header: Row = {
    CURDATE: p.date,
    IMPFNUM: p.impfnum,
    WARHSNAME: BONDED_WAREHOUSE,
    LOCNAME: '0',
    TOWARHSNAME: p.toWarehouse,
    TOLOCNAME: p.toLocation,
    DOCREF: p.declaration,
  };
  const post: PlannedWrite = {
    method: 'POST',
    endpoint: client.resolveEntityUrl('DOCUMENTS_J'),
    body: header,
  };

  if (p.dryRun) {
    return out.preview(
      current && continues ? planFor(continues, rows(current[RELEASE_LINES])).writes : [post],
      {
        ...(continues ? { continues } : {}),
        afterwards:
          'אחרי יצירת הכותרת: קריאת השורות שפריוריטי משך מתכולת התיק, השוואה ליתרה בערובה, וכתיבת הכמות בכל שורה. התעודה נשארת בטיוטה; לא נכתב סטטוס.',
        balanceInBond: [...balance].map(([part, qty]) => ({ part, qty })),
        requested: p.quantities ?? 'כל היתרה',
        warnings,
      },
    );
  }
  if (config.priorityReadOnly) return out.blocked();

  const begun = beginStep(
    out,
    ledgerPath,
    { impfnum: p.impfnum, step, ...(continues ? { docno: continues } : {}) },
    now(),
    { cooldown: !continues },
  );
  if ('stop' in begun) return begun.stop;
  try {
    const sent: PlannedWrite[] = [];
    let found = continues;
    if (!found) {
      // Look once more right before creating: a server on another machine shares neither the
      // claim nor the ledger, and may have opened a release since the first look.
      const refuseNow = (reason: string) =>
        recordAfter(
          ledgerPath,
          { impfnum: p.impfnum, step, phase: 'failed' },
          out.refused([reason]),
        );
      let openNow: Row[];
      try {
        const qb = new ODataBuilder()
          .filter(`IMPFNUM eq '${escapeODataString(p.impfnum)}'`)
          .select('DOCNO', 'STATDES', 'DOCREF')
          .top(200);
        const res = await client.list<Row>('DOCUMENTS_J', qb.build(), { cache: false });
        if (!Array.isArray(res?.value)) throw new Error('DOCUMENTS_J returned no list');
        openNow = res.value.filter(
          (r) => str(r.STATDES) !== FINAL_DOC_STATUS && str(r.STATDES) !== CANCELLED_DOC_STATUS,
        );
      } catch (err) {
        return refuseNow(
          `לא ניתן היה לקרוא שוב את תעודות השחרור של התיק לפני היצירה: ${describeError(err)}`,
        );
      }
      if (openNow.length > 0) {
        const appeared = openNow.length === 1 ? openNow[0] : undefined;
        let appearedDoc: Row | undefined;
        try {
          appearedDoc =
            appeared && str(appeared.DOCREF) === p.declaration
              ? await readReleaseDoc(client, String(appeared.DOCNO))
              : undefined;
        } catch {
          appearedDoc = undefined;
        }
        if (!appearedDoc || draftBlockers(appearedDoc).length) {
          return refuseNow(
            `בין הבדיקה ליצירה כבר נפתחה תעודת שחרור לתיק (${openNow.map((r) => `${String(r.DOCNO)} ${String(r.STATDES)}`).join(', ')}). לא נוצרה תעודה נוספת; קוראים שוב את הכלי כדי לראות את מצבה.`,
          );
        }
        found = String(appearedDoc.DOCNO);
      }
    }
    if (!found) {
      // An empty re-read is believed only when the form answers at all.
      const blind = await blindReason(client, 'DOCUMENTS_J', 'DOCNO');
      if (blind) {
        return recordAfter(
          ledgerPath,
          { impfnum: p.impfnum, step, phase: 'failed' },
          out.blind(blind),
        );
      }
    }
    if (!found) {
      let created: Row;
      try {
        // The only header a release may be created with; the lock blocks anything else.
        created = await runWithReleaseDraftScope(() => client.create<Row>('DOCUMENTS_J', header));
      } catch (err) {
        const rejected = definitelyRejected(err);
        return recordAfter(
          ledgerPath,
          { impfnum: p.impfnum, step, phase: rejected ? 'failed' : 'unverified' },
          out.notDone(
            rejected ? 'failed' : 'unverified',
            rejected
              ? `פריוריטי דחה את יצירת תעודת השחרור: ${describeError(err)}. לא נוצר מסמך.`
              : `יצירת תעודת השחרור נשלחה אך לא התקבלה תשובה ברורה (${describeError(err)}). ייתכן שהתעודה נוצרה: לא שולחים שוב; קוראים שוב בעוד כמה דקות, והכלי ימשיך טיוטה קיימת אם נוצרה.`,
            { error: describeError(err) },
          ),
        );
      }
      sent.push(post);
      const createdDocno = str(created?.DOCNO);
      if (!createdDocno) {
        return recordAfter(
          ledgerPath,
          { impfnum: p.impfnum, step, phase: 'unverified' },
          out.notDone(
            'unverified',
            'תעודת השחרור נשלחה אך פריוריטי לא החזיר מספר מסמך. קוראים שוב את תעודות השחרור של התיק.',
            { sent },
          ),
        );
      }
      found = createdDocno;
    }
    const docno = found;

    const stop = (reason: string, extra: Row = {}) =>
      recordAfter(
        ledgerPath,
        { impfnum: p.impfnum, step, phase: 'incomplete', docno },
        out.notDone('incomplete', reason, {
          docno,
          sent,
          warnings,
          doNotCreateAgain: `הטיוטה ${docno} קיימת. קריאה נוספת של bonded_release_draft עם אותה הצהרת יבוא ממשיכה אותה ואינה יוצרת תעודה שנייה.`,
          ...extra,
        }),
      );

    let doc: Row | undefined;
    try {
      doc = await readReleaseDoc(client, docno);
    } catch (err) {
      return stop(`לא ניתן היה לקרוא את תעודת השחרור ${docno} אחרי היצירה: ${describeError(err)}`);
    }
    const lines = rows(doc?.[RELEASE_LINES]);
    const plan = planFor(docno, lines);
    if (plan.ignoredVat) warnings.push(vatWarning(docno, plan.ignoredVat));
    if (!doc || plan.goodsLines.length === 0) {
      return stop(`בתעודת השחרור ${docno} אין שורות — פריוריטי לא משך את תכולת התיק. בודקים במסך.`);
    }
    if (plan.problems.length) {
      return stop(
        `השורות בתעודת השחרור ${docno} אינן תואמות את היתרה בערובה או את הכמויות שהתבקשו: ${plan.problems.join('; ')}. הטיוטה נשארה כמות שהיא; בודקים במסך.`,
        { lines: describeLines(lines) },
      );
    }
    for (const write of plan.writes) {
      const kline = Number(/KLINE=(\d+)/.exec(write.endpoint.split('/').pop() ?? '')?.[1]);
      try {
        await runWithReleaseDraftScope(() =>
          client.updateSubformRow(
            'DOCUMENTS_J',
            RELEASE_KEYS(docno),
            RELEASE_LINES,
            { KLINE: kline, TYPE: 'J' },
            write.body,
          ),
        );
        sent.push(write);
      } catch (err) {
        return stop(
          `כתיבת הכמות בשורה ${kline} של תעודת השחרור ${docno} נכשלה: ${describeError(err)}.`,
          { error: describeError(err) },
        );
      }
    }

    let after: Row | undefined;
    try {
      after = await readReleaseDoc(client, docno);
    } catch (err) {
      return stop(`הכמויות נכתבו אך הקריאה החוזרת של ${docno} נכשלה: ${describeError(err)}.`);
    }
    const afterLines = rows(after?.[RELEASE_LINES]);
    const wrong = afterLines
      .filter((l) => !isEmptyVatReleaseLine(l))
      .filter((l) => num(l.TQUANT) !== plan.targets.get(Number(l.KLINE)));
    if (!after || afterLines.length !== lines.length || wrong.length) {
      return stop(
        `בתעודת השחרור ${docno} נשארו ${wrong.length} שורות שהכמות בהן אינה הכמות המבוקשת (נקרא מחדש).`,
        { lines: describeLines(afterLines) },
      );
    }
    if (str(after.STATDES) !== DRAFT_DOC_STATUS) {
      return stop(
        `הכמויות בתעודת השחרור ${docno} נכונות, אך הסטטוס שלה הוא "${String(after.STATDES)}" ולא ${DRAFT_DOC_STATUS}.`,
        { lines: describeLines(afterLines), documentStatus: after.STATDES },
      );
    }
    // The result states the file, the declaration and the destination only as re-read.
    const differs = [
      str(after.IMPFNUM) !== p.impfnum ? `תיק ${String(after.IMPFNUM)} ולא ${p.impfnum}` : null,
      str(after.DOCREF) !== p.declaration
        ? `הצהרת יבוא ${String(after.DOCREF)} ולא ${p.declaration}`
        : null,
      str(after.TOWARHSNAME) !== p.toWarehouse || str(after.TOLOCNAME) !== p.toLocation
        ? `יעד ${String(after.TOWARHSNAME)}/${String(after.TOLOCNAME)} ולא ${p.toWarehouse}/${p.toLocation}`
        : null,
    ].filter((x): x is string => x !== null);
    if (differs.length) {
      return stop(
        `הכמויות בתעודת השחרור ${docno} נכונות, אך התעודה אינה כפי שהתבקש: ${differs.join('; ')}. בודקים במסך.`,
        { lines: describeLines(afterLines) },
      );
    }
    return recordAfter(
      ledgerPath,
      { impfnum: p.impfnum, step, phase: 'done', docno },
      out.done(
        `תעודת השחרור ${docno} בטיוטה, ${afterLines.filter((l) => !isEmptyVatReleaseLine(l)).length} שורות מוצר, כל כמות כמבוקש (נקרא מחדש מפריוריטי). לא נכתב סטטוס.`,
        {
          docno,
          documentStatus: after.STATDES,
          declaration: after.DOCREF,
          toWarehouse: after.TOWARHSNAME,
          toLocation: after.TOLOCNAME,
          fullRelease: !partial,
          lines: describeLines(afterLines),
          sent,
          warnings,
          nextStep: 'bonded_line_costs על התעודה, ואז אסף משנה את הסטטוס לסופית.',
        },
      ),
    );
  } finally {
    begun.release();
  }
}

// ------------------------------------------------ per-line import costs on the release (step 9)

export interface LineCostsParams {
  impfnum: string;
  /** the release document, e.g. BD99000001 */
  release: string;
  /** repair path: run on a release that is already final */
  onFinalRelease: boolean;
  /** run although every line already carries costs */
  rerun: boolean;
  dryRun: boolean;
  probe?: boolean;
  acceptPrompts?: string[];
}

const costLines = (release: ReleaseFact | undefined) =>
  (release?.lines ?? []).map((l) => ({
    part: l.part,
    qty: l.qty,
    goodsILS: l.goodsILS,
    importILS: l.importILS,
    totalILS: l.totalILS,
  }));

/**
 * When this release takes everything that is left in bond, the import costs registered on the
 * file's releases can be compared with the file's cost invoices — counting this release as
 * released even while it is a draft. Returns null for a partial release.
 */
function wholeBalanceReconciliation(facts: FileFacts, release: ReleaseFact) {
  if (facts.releases === null) return null;
  const otherDraft = facts.releases.some(
    (r) =>
      r.docno !== release.docno &&
      r.status !== FINAL_DOC_STATUS &&
      r.status !== CANCELLED_DOC_STATUS,
  );
  if (otherDraft) return null;
  // Decided from quantities, not from the balance in bond: whether a draft release already
  // lowers the content balance is not known on this tenant. Everything is released when, part
  // by part, the content quantity equals what the final releases plus this release carry.
  const released = new Map<string, number>();
  for (const r of facts.releases) {
    if (r.status !== FINAL_DOC_STATUS && r.docno !== release.docno) continue;
    for (const l of r.lines) released.set(l.part, (released.get(l.part) ?? 0) + l.qty);
  }
  const content = new Map<string, number>();
  for (const c of facts.content) content.set(c.part, (content.get(c.part) ?? 0) + c.qty);
  const takesAll =
    content.size > 0 &&
    [...content].every(([part, qty]) => Math.abs((released.get(part) ?? 0) - qty) < 1e-6);
  if (!takesAll) return null;
  return reconcileImportCosts({
    ...facts,
    content: facts.content.map((c) => ({ ...c, balance: 0 })),
    releases: facts.releases.map((r) =>
      r.docno === release.docno ? { ...r, status: FINAL_DOC_STATUS } : r,
    ),
  });
}

/**
 * Step 9 — run "רישום עלויות יבוא לשורה" (IMPORTCOSTPERLINE) on a release of a closed file. The
 * SOP order is on the DRAFT release (LBI2400656, ד׳ 13–14); a final release is the repair path.
 */
export async function registerLineCosts(
  client: PriorityClient,
  config: Config,
  p: LineCostsParams,
  deps: StepDeps = {},
): Promise<StepOutcome> {
  const step: PhaseBStep = 'lineCosts';
  const program = 'IMPORTCOSTPERLINE';
  const out = outcomes(step, p.impfnum);
  const ledgerPath = deps.ledgerPath ?? DEFAULT_STEP_LEDGER_PATH;
  const now = deps.now ?? Date.now;

  const loaded = await readFacts(client, p.impfnum);
  if ('error' in loaded) return out.refused([loaded.error], { program });
  const { facts } = loaded;
  // An amount of 0 proves a registration only when the file has no cost invoice at all.
  const zeroIsValid = !facts.invoices.some((iv) => !iv.isGoods);
  const costed = (l: ReleaseFact['lines'][number]) => lineIsCosted(l, zeroIsValid);
  const find = (f: FileFacts) => f.releases?.find((r) => r.docno === p.release);
  const before = find(facts);
  const summary = (f: FileFacts, release: ReleaseFact) => {
    const reconciliation = wholeBalanceReconciliation(f, release);
    // Spec step 9: the registered import costs must tie to the file's cost invoices.
    const tieProblem =
      reconciliation?.status === 'differs'
        ? `עלויות היבוא שנרשמו בשחרורי התיק (${reconciliation.importCostsOnReleases + reconciliation.customsOnReleases} ₪) אינן שוות לסך חשבוניות העלות של התיק (${reconciliation.costInvoiceLinesTotal} ₪); הפרש ${reconciliation.difference} ₪. לא הופכים את התעודה לסופית לפני שמבררים את ההפרש.`
        : null;
    return {
      tieProblem,
      info: {
        program,
        release: release.docno,
        documentStatus: release.status,
        lines: costLines(release),
        ...(reconciliation
          ? {
              reconciliation,
              reconciliationBasis:
                release.status === FINAL_DOC_STATUS
                  ? 'כל שחרורי התיק סופיים'
                  : 'תחזית: התעודה נספרה כמשוחררת אף שהיא עדיין טיוטה',
            }
          : {}),
        warnings: [
          ...(reconciliation
            ? []
            : [
                'שחרור חלקי (או תעודת שחרור נוספת פתוחה): ההשוואה של עלויות היבוא לסך חשבוניות העלות של התיק אפשרית רק כשכל היתרה משוחררת.',
              ]),
          ...(tieProblem ? [tieProblem] : []),
          ...(release.ignoredVatLines
            ? [
                `בתעודה ${release.docno} יש שורת ${VAT_DECLARATION_PART} בכמות 0 (נמשכה מתכולת התיק). היא אינה מוצר, ולכן אינה נדרשת לשאת עלות ואינה נספרת כאן.`,
              ]
            : []),
        ],
      },
    };
  };

  if (
    before &&
    before.status !== CANCELLED_DOC_STATUS &&
    before.lines.length > 0 &&
    before.lines.every(costed) &&
    !p.rerun
  ) {
    const state = summary(facts, before);
    return out.alreadyDone(
      `כל ${before.lines.length} השורות בתעודת השחרור ${before.docno} כבר נושאות עלויות יבוא. להרצה חוזרת מעבירים rerun=true.${state.tieProblem ? ` ${state.tieProblem}` : ''}`,
      state.info,
      !state.tieProblem,
    );
  }
  const reasons = gate(step, facts, {
    releaseDocno: p.release,
    onFinalRelease: p.onFinalRelease,
  });
  if (reasons.length || !before) {
    return out.refused(
      reasons.length ? reasons : [`לא נמצאה תעודת שחרור ${p.release} בתיק ${p.impfnum}.`],
      { program },
    );
  }

  const spec: ActivationSpec = {
    form: 'DOCUMENTS_J',
    activation: program,
    filter: { field: 'DOCNO', value: p.release },
    checkRow: (row) => {
      if (row.DOCNO !== p.release) return `DOCNO ${String(row.DOCNO)}`;
      if (row.IMPFNUM !== p.impfnum) return `IMPFNUM ${String(row.IMPFNUM)}`;
      if (row.STATDES === DRAFT_DOC_STATUS) return null;
      if (row.STATDES === FINAL_DOC_STATUS && p.onFinalRelease) return null;
      return `STATDES ${String(row.STATDES)}`;
    },
    acceptPrompts: p.acceptPrompts ?? [],
  };
  if (p.dryRun) {
    return programPreview(out, spec, p, deps, {
      release: before.docno,
      documentStatus: before.status,
      linesWithoutCost: before.lines.filter((l) => !costed(l)).length,
      lines: costLines(before),
      afterwards:
        'קריאה חוזרת של התעודה (שורות העלות נקראות בלי $select): כל שורה חייבת לשאת עלויות יבוא.',
    });
  }
  if (config.priorityReadOnly) return out.blocked();

  const run = await dispatchProgram({
    out,
    step,
    impfnum: p.impfnum,
    docno: p.release,
    spec,
    deps,
    ledgerPath,
    now,
  });
  if ('stop' in run) return run.stop;
  const { trace } = run;
  const unverified = (reason: string, extra: Row = {}) =>
    recordAfter(
      ledgerPath,
      { impfnum: p.impfnum, step, phase: 'unverified', docno: p.release },
      out.notDone('unverified', reason, { program, procedure: trace, ...extra }),
    );

  const after = await readFacts(client, p.impfnum);
  if ('error' in after) return unverified(`התוכנית רצה אך הקריאה החוזרת נכשלה: ${after.error}`);
  const release = find(after.facts);
  if (!release) {
    return unverified(`התוכנית רצה אך תעודת השחרור ${p.release} לא נמצאה בקריאה החוזרת.`);
  }
  const uncosted = release.lines.filter((l) => !costed(l)).map((l) => l.part);
  if (release.lines.length === 0 || uncosted.length) {
    return unverified(
      `"${PROGRAM_TITLES[program]}" הסתיימה, אך ${uncosted.length} שורות בתעודה ${release.docno} עדיין בלי עלויות יבוא: ${uncosted.join(', ')}. לא הופכים את התעודה לסופית; בודקים במסך "עלויות יבוא לשורה".`,
      summary(after.facts, release).info,
    );
  }

  // Was anything registered by THIS run? Judged from the rows before and after, not from a clock.
  // Lines are matched by their line number; position is a fallback for facts without one.
  const hadUncosted = before.lines.some((l) => !costed(l));
  const beforeByLine = new Map(before.lines.map((l, i) => [l.kline ?? `#${i}`, l]));
  const rowsChanged =
    before.lines.length !== release.lines.length ||
    release.lines.some((l, i) => {
      const b = beforeByLine.get(l.kline ?? `#${i}`);
      return (
        !b ||
        b.costRegisteredAt !== l.costRegisteredAt ||
        b.importILS !== l.importILS ||
        b.totalILS !== l.totalILS
      );
    });
  const { info, tieProblem } = summary(after.facts, release);
  const rerunEffect = hadUncosted ? undefined : rowsChanged ? 'changed' : 'not-provable';
  const details = { ...info, procedure: trace, ...(rerunEffect ? { rerunEffect } : {}) };

  // A rerun has no before/after proof of its own, so a program that said something against
  // itself at its end, or rows that did not change at all, leave the rerun unconfirmed.
  const complaint = programComplaint(trace);
  if (!hadUncosted && complaint) {
    return unverified(
      `הרצה חוזרת של "${PROGRAM_TITLES[program]}" הסתיימה עם הודעה: ${complaint}. אין בנתונים הוכחה שהעלויות נרשמו מחדש.`,
      details,
    );
  }
  if (rerunEffect === 'not-provable') {
    return unverified(
      'הרצה חוזרת: שורות העלות זהות לאלה שלפני ההרצה (סכומים וחותמת זמן), ולכן אי אפשר להוכיח מהנתונים שהעלויות נרשמו מחדש. העלויות הקיימות בשורות לא השתנו.',
      details,
    );
  }
  if (tieProblem) {
    return unverified(
      `כל ${release.lines.length} השורות בתעודה ${release.docno} נושאות עלויות יבוא, אך ההתאמה נכשלה. ${tieProblem}`,
      details,
    );
  }

  const isDraft = release.status !== FINAL_DOC_STATUS;
  return recordAfter(
    ledgerPath,
    { impfnum: p.impfnum, step, phase: 'done', docno: p.release },
    out.done(
      `כל ${release.lines.length} השורות בתעודת השחרור ${release.docno} נושאות עלויות יבוא (נקרא מחדש מפריוריטי).`,
      {
        ...details,
        warnings: [
          ...info.warnings,
          ...(complaint ? [`התוכנית הסתיימה עם הודעה: ${complaint}.`] : []),
          ...(isDraft
            ? []
            : [
                'העלויות נרשמו על תעודה שכבר סופית (מסלול תיקון). לפי הנוהל רושמים אותן כשהתעודה בטיוטה.',
              ]),
        ],
        nextStep: isDraft
          ? 'בודקים את העלות לכל שורה (lines) ואת ההתאמה (reconciliation); אז אסף משנה את סטטוס התעודה לסופית, ואחריו תמחיר לתאריך נוכחי.'
          : 'אסף: תמחיר לתאריך נוכחי. בדיקה: impfile_cost_report.',
      },
    ),
  );
}
