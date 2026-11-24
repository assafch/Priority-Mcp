import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { WebSdkSession } from '../client/web-sdk.js';
import type { Config } from '../config.js';
import {
  DEFAULT_APPROVAL_DIR,
  checkApproval,
  consumeApproval,
  issueApproval,
} from '../lib/approval-codes.js';
import { runCostingProgram } from '../lib/costing-program.js';
import type { ActivationSpec, ActivationTrace } from '../lib/form-activation.js';
import {
  BONDED_WAREHOUSE,
  CANCELLED_DOC_STATUS,
  DRAFT_DOC_STATUS,
  FINAL_DOC_STATUS,
  VAT_DECLARATION_PART,
  lineIsCosted,
} from '../lib/impfile-official.js';
import { computeStage } from '../lib/impfile-stage.js';
import { preflight } from '../lib/impfiles-logic.js';
import { runWithReleaseFinalScope } from '../lib/import-stage-guard.js';
import { type ImportStep, gate } from '../lib/import-step-gates.js';
import { describeError } from '../lib/invoice-close.js';
import { escapeODataString } from '../lib/sanitize.js';
import {
  DEFAULT_STEP_LEDGER_PATH,
  lastDoneTime,
  lastRecord,
  recordsAfter,
} from '../lib/step-ledger.js';
import { loadCostingReadiness, readLastCostingAt } from './import-facts.js';
import {
  CARRIAGE_PART,
  INVOICE_LINES,
  type PlannedWrite,
  RECEIPT_LINES,
  type Row,
  type StepDeps,
  type StepOutcome,
  beginStep,
  blindReason,
  definitelyRejected,
  dispatchProgram,
  isProductLine,
  num,
  openFileRow,
  outcomes,
  programComplaint,
  programPreview,
  readFacts,
  readInvoice,
  readReceiptDocs,
  readReleaseDoc,
  recordAfter,
  rows,
  str,
} from './import-steps.js';

/**
 * The irreversible import steps (phase C): receipt final (4b), file close (7), release final (10)
 * and the costing (11). Each runs only with an approval code that its own preview issued:
 *
 *   read → checks → preview issues a code bound to (tool, document, fingerprint of what it showed)
 *   real run: code checked → claim → read again → same checks → code spent → ONE write or program
 *   → re-read → report only what the re-read shows.
 *
 * The code is spent as the very last thing before the write, so a refusal never spends it; a
 * changed document never accepts it. It does not prove the owner approved — the result says to
 * pass it only after the owner saw the preview and approved it in chat.
 */
export interface FinalDeps extends StepDeps {
  approvalDir?: string;
}

export const APPROVAL_RULE =
  "מעבירים את approvalCode רק אחרי שהבעלים ראה את התצוגה המקדימה הזו ואישר אותה בצ'אט. הקוד תקף 10 דקות, לשימוש אחד, ורק אם המסמך לא השתנה מאז.";

const TOOLS = {
  receiptFinal: 'bonded_receipt_finalize',
  close: 'impfile_close_run',
  releaseFinal: 'bonded_release_finalize',
  costing: 'costing_run',
} as const satisfies Partial<Record<ImportStep, string>>;

/** The ledger / claim subject of the costing, which belongs to no file. */
export const COMPANY_SUBJECT = 'COMPANY';
/**
 * The costing may run for minutes. Its claim and cooldown outlast the longest run the program
 * driver allows (start 30 s + run 240 s + up to 8 × 30 s of messages + cancel 15 s ≈ 9 minutes).
 */
export const COSTING_WINDOW_MS = 600_000;

type Out = ReturnType<typeof outcomes>;

interface Ctx {
  out: Out;
  tool: string;
  subject: string;
  ledgerPath: string;
  approvalDir: string;
  now: () => number;
}

function ctx(step: keyof typeof TOOLS, impfnum: string, subject: string, deps: FinalDeps): Ctx {
  return {
    out: outcomes(step, impfnum),
    tool: TOOLS[step],
    subject,
    ledgerPath: deps.ledgerPath ?? DEFAULT_STEP_LEDGER_PATH,
    approvalDir: deps.approvalDir ?? DEFAULT_APPROVAL_DIR,
    now: deps.now ?? Date.now,
  };
}

/** A preview with its approval code. */
function previewWithCode(
  c: Ctx,
  state: unknown,
  wouldSend: PlannedWrite[],
  extra: Row = {},
): StepOutcome {
  let code: { approvalCode: string; approvalExpiresAt: string };
  try {
    code = issueApproval(c.approvalDir, { tool: c.tool, subject: c.subject, state }, c.now());
  } catch (err) {
    return c.out.notDone(
      'failed',
      `לא ניתן היה להנפיק קוד אישור (${describeError(err)}). לא נשלח דבר.`,
    );
  }
  return c.out.preview(wouldSend, {
    ...code,
    approvalRule: APPROVAL_RULE,
    verification: {
      reason:
        'Preview only; nothing was sent. To execute: dryRun=false with approvalCode — only after the owner saw this preview and approved it in chat.',
    },
    ...extra,
  });
}

/** Refusal when the real run brings no code, or one that would not be accepted now. */
function codeProblem(c: Ctx, code: string | undefined, state: unknown): StepOutcome | null {
  if (!code) {
    return c.out.refused([
      'הרצה אמיתית דורשת approvalCode מהתצוגה המקדימה של הכלי הזה. מריצים קודם dryRun=true, מציגים לבעלים, ומעבירים את הקוד רק אחרי שאישר.',
    ]);
  }
  const check = checkApproval(
    c.approvalDir,
    { tool: c.tool, subject: c.subject, state, code },
    c.now(),
  );
  return check.ok ? null : c.out.refused([check.reason]);
}

/** Spend the code; the refusal to return when it is not accepted. */
function spend(c: Ctx, code: string, state: unknown): StepOutcome | null {
  const r = consumeApproval(
    c.approvalDir,
    { tool: c.tool, subject: c.subject, state, code },
    c.now(),
  );
  return r.ok ? null : c.out.refused([r.reason]);
}

// ------------------------------------------------------------------ stock

type Stock = Map<string, Map<string, number>>;
/** "warehouse/location"; an empty location is Priority's default location 0. */
const place = (warehouse: unknown, location: unknown) =>
  `${String(warehouse ?? '')}/${String(location ?? '') || '0'}`;

/** Balance per part and warehouse/location, from the part card. Throws when a read fails. */
export async function readStock(client: PriorityClient, parts: string[]): Promise<Stock> {
  const stock: Stock = new Map();
  for (const part of parts) {
    const res = await client.listSubform<Row>('LOGPART', part, 'PARTBALANCE_SUBFORM', undefined, {
      cache: false,
    });
    const byPlace = new Map<string, number>();
    for (const r of rows(res?.value)) {
      const key = place(r.WARHSNAME, r.LOCNAME);
      byPlace.set(key, (byPlace.get(key) ?? 0) + (num(r.BALANCE) ?? 0));
    }
    stock.set(part, byPlace);
  }
  return stock;
}

const stockView = (stock: Stock, places: string[]) =>
  Object.fromEntries(
    [...stock].map(([part, byPlace]) => [
      part,
      Object.fromEntries(places.map((p) => [p, byPlace.get(p) ?? 0])),
    ]),
  );

/** Expected change per part and place vs what the stock shows; the mismatches. */
function stockMismatches(
  before: Stock,
  after: Stock,
  expected: Array<{ part: string; place: string; delta: number }>,
): string[] {
  const problems: string[] = [];
  for (const e of expected) {
    const was = before.get(e.part)?.get(e.place) ?? 0;
    const is = after.get(e.part)?.get(e.place) ?? 0;
    if (Math.abs(is - was - e.delta) > 1e-6) {
      problems.push(`${e.part} ב-${e.place}: השתנה ב-${is - was}, צפוי ${e.delta}`);
    }
  }
  return problems;
}

const sumBy = (lines: Row[], field: string): Map<string, number> => {
  const total = new Map<string, number>();
  for (const l of lines) {
    const part = str(l.PARTNAME);
    if (part) total.set(part, (total.get(part) ?? 0) + (num(l[field]) ?? 0));
  }
  return total;
};

const byKline = (a: Row, b: Row) => Number(a.KLINE) - Number(b.KLINE);

// ---------------------------------------------------------- receipt final (step 4b)

export interface FinalizeParams {
  impfnum: string;
  docno: string;
  dryRun: boolean;
  approvalCode?: string;
}

const RECEIPT_KEYS = (docno: string) => ({ DOCNO: docno, TYPE: 'P' });

type Inspection =
  | { kind: 'stop'; outcome: StepOutcome }
  | {
      kind: 'ok';
      state: unknown;
      doc: Row;
      expected: Array<{ part: string; place: string; delta: number }>;
      extra: Row;
    };

async function readReceipt(client: PriorityClient, docno: string): Promise<Row | undefined> {
  const qb = new ODataBuilder()
    .filter(`DOCNO eq '${escapeODataString(docno)}'`)
    .select('DOCNO', 'STATDES', 'TOWARHSNAME', 'TOLOCNAME', 'IVNUM', 'UDATE')
    .expand(`${RECEIPT_LINES}($select=KLINE,PARTNAME,TQUANT,PQUANT)`)
    .top(2);
  const res = await client.list<Row>('DOCUMENTS_P', qb.build(), { cache: false });
  if (!Array.isArray(res?.value)) throw new Error('DOCUMENTS_P returned no list');
  return res.value[0];
}

async function inspectReceipt(
  client: PriorityClient,
  c: Ctx,
  p: FinalizeParams,
): Promise<Inspection> {
  const { out } = c;
  const stop = (outcome: StepOutcome): Inspection => ({ kind: 'stop', outcome });
  const loaded = await readFacts(client, p.impfnum);
  if ('error' in loaded) return stop(out.refused([loaded.error]));
  const { facts } = loaded;

  let doc: Row | undefined;
  try {
    doc = await readReceipt(client, p.docno);
  } catch (err) {
    return stop(out.refused([`לא ניתן היה לקרוא את הקבלה ${p.docno}: ${describeError(err)}`]));
  }
  if (!doc) {
    const blind = await blindReason(client, 'DOCUMENTS_P', 'DOCNO');
    return stop(blind ? out.blind(blind) : out.refused([`הקבלה ${p.docno} לא נמצאה.`]));
  }
  const status = str(doc.STATDES);
  const ivnum = str(doc.IVNUM);
  const base = { docno: p.docno, documentStatus: status, invoice: ivnum };
  const goods = facts.invoices.find((iv) => iv.isGoods && iv.ivnum === ivnum);
  if (!ivnum || !goods) {
    // Checked before "already final": a final receipt of another file proves nothing here.
    return stop(
      out.refused(
        [
          `הקבלה ${p.docno} אינה של חשבונית סחורה של התיק ${p.impfnum} (חשבונית: ${ivnum ?? 'אין'}).`,
        ],
        base,
      ),
    );
  }
  if (status === FINAL_DOC_STATUS) {
    return stop(out.alreadyDone(`הקבלה ${p.docno} כבר סופית.`, base));
  }
  if (status !== DRAFT_DOC_STATUS) {
    return stop(out.refused([`הקבלה ${p.docno} בסטטוס "${status ?? ''}", לא טיוטה.`], base));
  }

  const reasons: string[] = [];
  if (facts.closed) reasons.push('התיק סגור — הקבלה לערובה שייכת לשלבים שלפני סגירת התיק.');
  if (str(doc.TOWARHSNAME) !== BONDED_WAREHOUSE || str(doc.TOLOCNAME) !== '0') {
    reasons.push(
      `הקבלה ${p.docno} היא למחסן ${String(doc.TOWARHSNAME ?? '')}/${String(doc.TOLOCNAME ?? '')}, לא ${BONDED_WAREHOUSE}/0.`,
    );
  }
  if (!goods.isFinal) {
    reasons.push(`חשבונית הסחורה ${ivnum} עדיין זמנית — סוגרים אותה לפני שהקבלה הופכת לסופית.`);
  }
  if (reasons.length) return stop(out.refused(reasons, base));

  let invoice: Row | null;
  let siblings: Row[];
  try {
    [invoice, siblings] = await Promise.all([
      readInvoice(client, ivnum as string),
      readReceiptDocs(client, { ivnum: ivnum as string }),
    ]);
  } catch (err) {
    return stop(
      out.refused(
        [`לא ניתן היה לקרוא את החשבונית ${ivnum} או את הקבלות שלה: ${describeError(err)}`],
        base,
      ),
    );
  }
  if (!invoice) return stop(out.refused([`החשבונית ${ivnum} לא נמצאה בחשבוניות הספק.`], base));
  const others = siblings.filter(
    (r) => str(r.DOCNO) !== p.docno && str(r.STATDES) !== CANCELLED_DOC_STATUS,
  );
  if (others.length) {
    reasons.push(
      `לחשבונית ${ivnum} יש קבלה נוספת שאינה מבוטלת: ${others.map((r) => `${String(r.DOCNO)} ${String(r.STATDES)}`).join(', ')}.`,
    );
  }

  const lines = rows(doc[RECEIPT_LINES]).sort(byKline);
  const strays = lines.filter(
    (l) => str(l.PARTNAME) === CARRIAGE_PART || str(l.PARTNAME) === VAT_DECLARATION_PART,
  );
  if (strays.length) {
    reasons.push(
      `בקבלה יש שורות שאינן סחורה: ${strays.map((l) => `${String(l.PARTNAME)} (שורה ${String(l.KLINE)})`).join(', ')} — מוחקים אותן מהטיוטה לפני שהיא הופכת לסופית.`,
    );
  }
  const open = lines.filter((l) => (num(l.TQUANT) ?? 0) <= 0 || num(l.TQUANT) !== num(l.PQUANT));
  if (open.length) {
    reasons.push(
      `שורות שהכמות בהן חסרה או שונה מכמות החשבונית: ${open.map((l) => `${String(l.PARTNAME)} ${num(l.TQUANT) ?? 0}/${num(l.PQUANT) ?? 0}`).join(', ')}.`,
    );
  }
  const want = sumBy(
    rows(invoice[INVOICE_LINES]).filter(
      (l) => isProductLine(l) && str(l.PARTNAME) !== CARRIAGE_PART,
    ),
    'TQUANT',
  );
  const got = sumBy(
    lines.filter((l) => !strays.includes(l)),
    'TQUANT',
  );
  for (const part of new Set([...want.keys(), ...got.keys()])) {
    if (want.get(part) !== got.get(part)) {
      reasons.push(`${part}: בקבלה ${got.get(part) ?? 0}, בחשבונית ${want.get(part) ?? 0}.`);
    }
  }
  if (lines.length === 0) reasons.push(`בקבלה ${p.docno} אין שורות.`);
  if (reasons.length) return stop(out.refused(reasons, base));

  const state = {
    docno: p.docno,
    status,
    warehouse: str(doc.TOWARHSNAME),
    location: str(doc.TOLOCNAME),
    ivnum,
    udate: str(doc.UDATE),
    lines: lines.map((l) => ({
      kline: num(l.KLINE),
      part: str(l.PARTNAME),
      tquant: num(l.TQUANT),
      pquant: num(l.PQUANT),
    })),
  };
  const bonded = place(BONDED_WAREHOUSE, '0');
  return {
    kind: 'ok',
    state,
    doc,
    expected: [...got].map(([part, qty]) => ({ part, place: bonded, delta: qty })),
    extra: { ...base, lines: state.lines.map((l) => ({ part: l.part, qty: l.tquant })) },
  };
}

/** Step 4b — make the bonded receipt final. */
export async function finalizeBondedReceipt(
  client: PriorityClient,
  config: Config,
  p: FinalizeParams,
  deps: FinalDeps = {},
): Promise<StepOutcome> {
  const step = 'receiptFinal' as const;
  const c = ctx(step, p.impfnum, `${p.impfnum}/${p.docno}`, deps);
  const write: PlannedWrite = {
    method: 'PATCH',
    endpoint: client.resolveCompositeUrl('DOCUMENTS_P', RECEIPT_KEYS(p.docno)),
    body: { STATDES: FINAL_DOC_STATUS },
  };
  return finalizeDocument(client, config, p, c, {
    step,
    write,
    inspect: () => inspectReceipt(client, c, p),
    send: () =>
      client.updateComposite('DOCUMENTS_P', RECEIPT_KEYS(p.docno), { STATDES: FINAL_DOC_STATUS }),
    reread: async () => str((await readReceipt(client, p.docno))?.STATDES),
    places: [place(BONDED_WAREHOUSE, '0')],
    what: `הקבלה ${p.docno}`,
    next: 'bonded_fill_detail (מילוי פירוט למחסן ערובה).',
  });
}

/** The shared run of the two status writes (receipt final, release final). */
async function finalizeDocument(
  client: PriorityClient,
  config: Config,
  p: FinalizeParams,
  c: Ctx,
  d: {
    step: ImportStep;
    write: PlannedWrite;
    inspect: () => Promise<Inspection>;
    send: () => Promise<unknown>;
    reread: () => Promise<string | null>;
    places: string[];
    what: string;
    next: string;
    note?: string;
  },
): Promise<StepOutcome> {
  const { out } = c;
  const first = await d.inspect();
  if (first.kind === 'stop') return first.outcome;
  const parts = [...new Set(first.expected.map((e) => e.part))];

  if (p.dryRun) {
    let stockBefore: unknown;
    try {
      stockBefore = stockView(await readStock(client, parts), d.places);
    } catch (err) {
      stockBefore = { error: describeError(err) };
    }
    return previewWithCode(c, first.state, [d.write], {
      ...first.extra,
      stockBefore,
      afterwards: `קריאה חוזרת: ${d.what} בסטטוס סופית, והמלאי השתנה בכמויות השורות.`,
      ...(d.note ? { note: d.note } : {}),
    });
  }
  if (config.priorityReadOnly) return out.blocked();
  const early = codeProblem(c, p.approvalCode, first.state);
  if (early) return early;

  const record = { impfnum: p.impfnum, step: d.step, docno: p.docno };
  const begun = beginStep(out, c.ledgerPath, record, c.now(), { cooldown: true });
  if ('stop' in begun) return begun.stop;
  const failedBefore = (outcome: StepOutcome) =>
    recordAfter(c.ledgerPath, { ...record, phase: 'failed' }, outcome);
  try {
    // Everything is read again under the claim: the code is accepted only for what is there now.
    const fresh = await d.inspect();
    if (fresh.kind === 'stop') return failedBefore(fresh.outcome);
    let before: Stock;
    try {
      before = await readStock(client, parts);
    } catch (err) {
      return failedBefore(
        out.refused([
          `לא ניתן היה לקרוא את המלאי לפני השינוי (${describeError(err)}); בלי מצב לפני אי אפשר לאמת. לא נשלח דבר.`,
        ]),
      );
    }
    const refusal = spend(c, p.approvalCode as string, fresh.state);
    if (refusal) return failedBefore(refusal);

    try {
      await d.send();
    } catch (err) {
      const rejected = definitelyRejected(err);
      return recordAfter(
        c.ledgerPath,
        { ...record, phase: rejected ? 'failed' : 'unverified' },
        out.notDone(
          rejected ? 'failed' : 'unverified',
          rejected
            ? `פריוריטי דחה את שינוי הסטטוס של ${d.what}: ${describeError(err)}. לא השתנה דבר.`
            : `שינוי הסטטוס של ${d.what} נשלח אך לא התקבלה תשובה ברורה (${describeError(err)}). לא שולחים שוב; קוראים שוב בעוד כמה דקות.`,
          { ...fresh.extra, error: describeError(err) },
        ),
      );
    }
    const sent = [d.write];
    const unverified = (reason: string, extra: Row = {}) =>
      recordAfter(
        c.ledgerPath,
        { ...record, phase: 'unverified' },
        out.notDone('unverified', reason, { ...fresh.extra, sent, ...extra }),
      );
    let status: string | null;
    try {
      status = await d.reread();
    } catch (err) {
      return unverified(`הסטטוס נשלח אך הקריאה החוזרת של ${d.what} נכשלה: ${describeError(err)}.`);
    }
    if (status !== FINAL_DOC_STATUS) {
      return unverified(`הסטטוס נשלח, אך ${d.what} נקראה מחדש בסטטוס "${status ?? ''}".`);
    }
    let after: Stock;
    try {
      after = await readStock(client, parts);
    } catch (err) {
      return unverified(
        `${d.what} סופית, אך לא ניתן היה לקרוא את המלאי אחרי השינוי (${describeError(err)}). בודקים מלאי במסך.`,
      );
    }
    const stock = {
      stockBefore: stockView(before, d.places),
      stockAfter: stockView(after, d.places),
    };
    const mismatches = stockMismatches(before, after, fresh.expected);
    if (mismatches.length) {
      return unverified(
        `${d.what} סופית (נקרא מחדש), אך המלאי לא השתנה כצפוי: ${mismatches.join('; ')}. לא שולחים שוב; בודקים במסך.`,
        { ...stock, ...(d.note ? { note: d.note } : {}) },
      );
    }
    return recordAfter(
      c.ledgerPath,
      { ...record, phase: 'done' },
      out.done(`${d.what} סופית, והמלאי השתנה בדיוק בכמויות השורות (נקרא מחדש מפריוריטי).`, {
        ...fresh.extra,
        documentStatus: status,
        sent,
        ...stock,
        nextStep: d.next,
      }),
    );
  } finally {
    begun.release();
  }
}

// ---------------------------------------------------------- release final (step 10)

const RELEASE_KEYS = (docno: string) => ({ DOCNO: docno, TYPE: 'J' });
const NOT_CLOSED =
  'התיק אינו סגור — לפי הנוהל של פריוריטי סוגרים את התיק לפני שתעודת השחרור הופכת לסופית.';

async function inspectRelease(
  client: PriorityClient,
  c: Ctx,
  p: FinalizeParams,
): Promise<Inspection> {
  const { out } = c;
  const stop = (outcome: StepOutcome): Inspection => ({ kind: 'stop', outcome });
  const loaded = await readFacts(client, p.impfnum);
  if ('error' in loaded) return stop(out.refused([loaded.error]));
  const { facts } = loaded;

  let raw: Row | undefined;
  try {
    raw = await readReleaseDoc(client, p.docno);
  } catch (err) {
    return stop(
      out.refused([`לא ניתן היה לקרוא את תעודת השחרור ${p.docno}: ${describeError(err)}`]),
    );
  }
  if (!raw) {
    const blind = await blindReason(client, 'DOCUMENTS_J', 'DOCNO');
    return stop(blind ? out.blind(blind) : out.refused([`תעודת השחרור ${p.docno} לא נמצאה.`]));
  }
  if (str(raw.IMPFNUM) !== p.impfnum) {
    return stop(
      out.refused([
        `תעודת השחרור ${p.docno} שייכת לתיק ${String(raw.IMPFNUM ?? '')}, לא ל-${p.impfnum}.`,
      ]),
    );
  }
  const status = str(raw.STATDES);
  const base = { docno: p.docno, release: p.docno, documentStatus: status };
  if (status === FINAL_DOC_STATUS)
    return stop(out.alreadyDone(`תעודת השחרור ${p.docno} כבר סופית.`, base));
  if (status !== DRAFT_DOC_STATUS) {
    return stop(out.refused([`תעודת השחרור ${p.docno} בסטטוס "${status ?? ''}", לא טיוטה.`], base));
  }
  if (facts.releases === null)
    return stop(out.refused(['לא ניתן היה לקרוא את תעודות השחרור של התיק.'], base));
  const fact = facts.releases.find((r) => r.docno === p.docno);
  if (!fact) return stop(out.refused([`תעודת השחרור ${p.docno} לא נמצאה בתעודות של התיק.`], base));

  const reasons: string[] = [];
  if (!facts.closed) reasons.push(NOT_CLOSED);
  const lines = rows(raw.TRANSORDER_J_SUBFORM).sort(byKline);
  // Any VAT line, even an empty one: making a release final with it was never tried here.
  const vat = lines.filter((l) => str(l.PARTNAME) === VAT_DECLARATION_PART);
  if (vat.length)
    reasons.push(
      `בתעודה יש שורת ${VAT_DECLARATION_PART} (גם בכמות 0) — היא אינה סחורה; מוחקים אותה במסך "קבלות סחורה ממחסן ערובה" לפני שהופכים לסופית.`,
    );
  const goods = lines.filter((l) => str(l.PARTNAME) !== VAT_DECLARATION_PART);
  if (goods.length === 0) reasons.push(`בתעודת השחרור ${p.docno} אין שורות סחורה.`);
  const zero = goods.filter((l) => (num(l.TQUANT) ?? 0) <= 0);
  if (zero.length) {
    reasons.push(
      `שורות בכמות 0: ${zero.map((l) => String(l.PARTNAME)).join(', ')} — הכלי אינו הופך לסופית תעודה עם שורה ריקה (גם לא בשחרור חלקי); מוחקים את השורה במסך או משחררים אותה.`,
    );
  }
  const over = goods.filter((l) => (num(l.TQUANT) ?? 0) > (num(l.PQUANT) ?? 0));
  if (over.length) {
    reasons.push(
      `כמות גדולה מהיתרה בערובה: ${over.map((l) => `${String(l.PARTNAME)} ${num(l.TQUANT)}/${num(l.PQUANT) ?? 0}`).join(', ')}.`,
    );
  }
  const zeroIsValid = !facts.invoices.some((iv) => !iv.isGoods);
  const uncosted = fact.lines.filter((l) => !lineIsCosted(l, zeroIsValid));
  if (uncosted.length) {
    reasons.push(
      `שורות בלי עלויות יבוא (או עם עלות 0 שאינה מוכחת): ${uncosted.map((l) => l.part).join(', ')} — מריצים bonded_line_costs על התעודה ובודקים, ורק אז הופכים לסופית.`,
    );
  }
  if (reasons.length) return stop(out.refused(reasons, base));

  const state = {
    docno: p.docno,
    status,
    udate: fact.updatedAt,
    warehouse: str(raw.TOWARHSNAME),
    location: str(raw.TOLOCNAME),
    lines: goods.map((l) => ({
      kline: num(l.KLINE),
      part: str(l.PARTNAME),
      tquant: num(l.TQUANT),
      pquant: num(l.PQUANT),
    })),
    costs: fact.lines
      .map((l) => ({
        kline: l.kline ?? null,
        part: l.part,
        qty: l.qty,
        totalILS: l.totalILS,
        importILS: l.importILS,
        customsILS: l.customsILS,
        at: l.costRegisteredAt,
      }))
      .sort((a, b) => Number(a.kline) - Number(b.kline) || a.part.localeCompare(b.part)),
  };
  const target = place(raw.TOWARHSNAME, raw.TOLOCNAME);
  const bonded = place(BONDED_WAREHOUSE, '0');
  if (target === bonded) {
    return stop(
      out.refused([`תעודת השחרור ${p.docno} היא אל ${bonded} עצמו — אין לאן לשחרר.`], base),
    );
  }
  const qty = sumBy(goods, 'TQUANT');
  return {
    kind: 'ok',
    state,
    doc: raw,
    expected: [...qty].flatMap(([part, n]) => [
      { part, place: bonded, delta: -n },
      { part, place: target, delta: n },
    ]),
    extra: {
      ...base,
      toWarehouse: state.warehouse,
      toLocation: state.location,
      lines: fact.lines.map((l) => ({
        part: l.part,
        qty: l.qty,
        importILS: l.importILS,
        totalILS: l.totalILS,
      })),
    },
  };
}

/** Step 10 — make the release from bond final, through the lock's one narrow opening. */
export async function finalizeBondedRelease(
  client: PriorityClient,
  config: Config,
  p: FinalizeParams,
  deps: FinalDeps = {},
): Promise<StepOutcome> {
  const step = 'releaseFinal' as const;
  const c = ctx(step, p.impfnum, `${p.impfnum}/${p.docno}`, deps);
  const first = await readReleaseDoc(client, p.docno).catch(() => undefined);
  const places = [place(BONDED_WAREHOUSE, '0'), place(first?.TOWARHSNAME, first?.TOLOCNAME)];
  return finalizeDocument(client, config, p, c, {
    step,
    write: {
      method: 'PATCH',
      endpoint: client.resolveCompositeUrl('DOCUMENTS_J', RELEASE_KEYS(p.docno)),
      body: { STATDES: FINAL_DOC_STATUS },
    },
    inspect: () => inspectRelease(client, c, p),
    send: () =>
      runWithReleaseFinalScope(() =>
        client.updateComposite('DOCUMENTS_J', RELEASE_KEYS(p.docno), { STATDES: FINAL_DOC_STATUS }),
      ),
    reread: async () => str((await readReleaseDoc(client, p.docno))?.STATDES),
    places,
    what: `תעודת השחרור ${p.docno}`,
    next: 'costing_run (תמחיר לתאריך נוכחי) — תצוגה מקדימה, ואישור הבעלים.',
    note: `לא נבדק עדיין אם טיוטת שחרור כבר מורידה את היתרה ב-${BONDED_WAREHOUSE}; הפיילוט הראשון רושם מה קרה למלאי (stockBefore / stockAfter).`,
  });
}

// ---------------------------------------------------------- file close (step 7)

export interface CloseParams {
  impfnum: string;
  dryRun: boolean;
  probe?: boolean;
  approvalCode?: string;
}

/** Steps whose later record means the calc no longer reflects the file. */
const CHANGES_AFTER_CALC: ReadonlySet<string> = new Set([
  'declaration',
  'receipt',
  'receiptFinal',
  'fillDetail',
  'fileChange',
]);
const CALC_LIMITS = [
  'חישוב העמסה נחשב עדכני לפי יומן הצעדים בלבד: שינוי שנעשה במסך אחרי החישוב אינו מזוהה.',
  'היומן הוא לכל מכונה: חישוב העמסה והסגירה חייבים לרוץ מאותו שרת (ה-Mac או הבוט).',
];

async function inspectClose(
  client: PriorityClient,
  c: Ctx,
  p: CloseParams,
): Promise<{ kind: 'stop'; outcome: StepOutcome } | { kind: 'ok'; state: unknown; extra: Row }> {
  const { out } = c;
  const stop = (outcome: StepOutcome) => ({ kind: 'stop' as const, outcome });
  const loaded = await readFacts(client, p.impfnum);
  if ('error' in loaded) return stop(out.refused([loaded.error]));
  const { facts, snapshot, receipts } = loaded;
  if (facts.closed) return stop(out.alreadyDone(`התיק ${p.impfnum} כבר סגור.`, { closed: true }));

  const reasons: string[] = [...gate('calc', facts)];
  const pf = preflight(snapshot);
  const stage = computeStage({
    snapshot,
    receipts,
    releases:
      facts.releases === null
        ? null
        : facts.releases.map((r) => ({ DOCNO: r.docno, STATDES: r.status })),
  });
  reasons.push(...pf.blocking, ...stage.closeBlocking);
  if (typeof facts.contentVatLineQty === 'number' && facts.contentVatLineQty !== 0) {
    reasons.push(
      `בתכולת התיק נשארה שורת ${VAT_DECLARATION_PART} עם כמות — מריצים bonded_fill_detail או מוחקים אותה במסך.`,
    );
  }
  const calcAt = lastDoneTime(c.ledgerPath, p.impfnum, 'calc');
  const lastCalc = lastRecord(c.ledgerPath, p.impfnum, 'calc');
  if (lastCalc && lastCalc.phase !== 'done') {
    reasons.push(
      `הריצה האחרונה של "חישוב העמסה" הסתיימה במצב ${lastCalc.phase}, לא done. מריצים impfile_run_calc שוב עד שהוא מאומת.`,
    );
  } else if (calcAt === null) {
    reasons.push(
      '"חישוב העמסה" לא רץ דרך impfile_run_calc על התיק הזה (לפי יומן הצעדים של השרת הזה). מריצים אותו קודם.',
    );
  } else {
    const later = recordsAfter(c.ledgerPath, p.impfnum, calcAt).filter((r) =>
      CHANGES_AFTER_CALC.has(r.step),
    );
    if (later.length) {
      reasons.push(
        `אחרי "חישוב העמסה" האחרון נרשם בתיק צעד נוסף (${[...new Set(later.map((r) => r.step))].join(', ')}). מריצים impfile_run_calc שוב לפני הסגירה.`,
      );
    }
  }
  const unique = [...new Set(reasons)];
  if (unique.length) return stop(out.refused(unique, { limits: CALC_LIMITS }));

  const state = {
    closed: facts.closed,
    content: facts.content
      .map((x) => ({ part: x.part, qty: x.qty }))
      .sort((a, b) => a.part.localeCompare(b.part) || a.qty - b.qty),
    // What the close and the calc are computed from: header, invoices with their lines, the
    // customs estimate and the allocations, as Priority returned them.
    file: {
      header: snapshot.header ?? null,
      invoices: snapshot.invoices ?? null,
      customsEstimate: snapshot.customsEstimate ?? null,
      goodsContent: snapshot.goodsContent ?? null,
      manualCostAllocations: snapshot.manualCostAllocations ?? null,
    },
    invoices: facts.invoices
      .map((iv) => ({ ivnum: iv.ivnum, final: iv.isFinal }))
      .sort((a, b) => a.ivnum.localeCompare(b.ivnum)),
    receipts: (facts.receipts ?? [])
      .map((r) => ({ docno: r.docno, status: r.status }))
      .sort((a, b) => a.docno.localeCompare(b.docno)),
    vat: facts.contentVatLineQty ?? null,
    calcAt,
  };
  return {
    kind: 'ok',
    state,
    extra: {
      lastCalcViaTool: calcAt ? new Date(calcAt).toISOString() : null,
      limits: CALC_LIMITS,
      advisory: pf.advisory,
    },
  };
}

/** Step 7 — "סגירת התיק" (IMPFILE1) on an import file whose earlier steps are proven. */
export async function closeImportFile(
  client: PriorityClient,
  config: Config,
  p: CloseParams,
  deps: FinalDeps = {},
): Promise<StepOutcome> {
  const step = 'close' as const;
  const program = 'IMPFILE1';
  const c = ctx(step, p.impfnum, p.impfnum, deps);
  const { out } = c;
  const spec: ActivationSpec = {
    form: 'IMPFILES',
    activation: program,
    filter: { field: 'IMPFNUM', value: p.impfnum },
    checkRow: openFileRow(p.impfnum),
    acceptPrompts: [],
  };
  const first = await inspectClose(client, c, p);
  if (first.kind === 'stop') return { ...first.outcome, program };

  if (p.dryRun) {
    const preview = previewWithCode(c, first.state, [], {
      program,
      ...first.extra,
      afterwards: 'קריאה חוזרת של התיק: CLOSED = Y.',
    });
    if (preview.status !== 'preview' || !p.probe) return preview;
    const probed = await programPreview(out, spec, p, deps);
    return { ...preview, probe: probed.probe, wouldRun: probed.wouldRun };
  }
  if (config.priorityReadOnly) return out.blocked();
  const early = codeProblem(c, p.approvalCode, first.state);
  if (early) return { ...early, program };

  const fresh = await inspectClose(client, c, p);
  if (fresh.kind === 'stop') return { ...fresh.outcome, program };
  const run = await dispatchProgram({
    out,
    step,
    impfnum: p.impfnum,
    spec,
    deps,
    ledgerPath: c.ledgerPath,
    now: c.now,
    beforeDispatch: () => spend(c, p.approvalCode as string, fresh.state),
    cancelHint:
      'לכלי הזה אין acceptPrompts: מראים לבעלים את הטקסט המדויק; הסגירה נעשית במסך, או שהכלי מעודכן לשאלה הזו.',
  });
  if ('stop' in run) return run.stop;
  const { trace } = run;
  const unverified = (reason: string) =>
    recordAfter(
      c.ledgerPath,
      { impfnum: p.impfnum, step, phase: 'unverified' },
      out.notDone('unverified', reason, { program, procedure: trace }),
    );
  const after = await readFacts(client, p.impfnum);
  if ('error' in after)
    return unverified(`"סגירת התיק" רצה אך הקריאה החוזרת נכשלה: ${after.error}`);
  const complaint = programComplaint(trace);
  if (!after.facts.closed) {
    return unverified(
      `"סגירת התיק" רצה, אך התיק נקרא מחדש כפתוח${complaint ? ` (הודעה: ${complaint})` : ''}. לא מפעילים שוב; בודקים במסך.`,
    );
  }
  return recordAfter(
    c.ledgerPath,
    { impfnum: p.impfnum, step, phase: 'done' },
    out.done(`התיק ${p.impfnum} סגור (CLOSED = Y, נקרא מחדש מפריוריטי).`, {
      program,
      procedure: trace,
      programMessages: messagesOf(trace),
      ...(complaint ? { warnings: [`התוכנית הסתיימה עם הודעה: ${complaint}`] } : {}),
      nextStep: 'bonded_release_draft (תעודת שחרור בטיוטה).',
    }),
  );
}

const messagesOf = (trace: ActivationTrace): string[] =>
  trace.steps
    .map((s) => s.message)
    .filter((m): m is string => typeof m === 'string' && m.length > 0);

// ---------------------------------------------------------- costing (step 11)

export interface CostingParams {
  dryRun: boolean;
  probe?: boolean;
  rerun?: boolean;
  since?: string;
  approvalCode?: string;
}

async function inspectCosting(
  client: PriorityClient,
  c: Ctx,
  p: CostingParams,
): Promise<
  | { kind: 'stop'; outcome: StepOutcome }
  | { kind: 'ok'; state: unknown; extra: Row; lastCostingAt: string | null }
> {
  const { out } = c;
  const stop = (outcome: StepOutcome) => ({ kind: 'stop' as const, outcome });
  // An empty release scan would hide every blocker: believe it only when the form answers.
  const blind =
    (await blindReason(client, 'DOCUMENTS_J', 'DOCNO')) ??
    // An empty costing log would read as "never ran": every release would look pending.
    (await blindReason(client, 'COSTINGLOG', 'UDATE'));
  if (blind) return stop(out.blind(blind));
  let loaded: Awaited<ReturnType<typeof loadCostingReadiness>>;
  try {
    loaded = await loadCostingReadiness(client, p.since, c.now());
  } catch (err) {
    return stop(out.refused([`לא ניתן היה לבדוק מוכנות לתמחיר: ${describeError(err)}`]));
  }
  const r = loaded.readiness;
  if (!r) return stop(out.refused(['לא ניתן היה לקרוא את יומן התמחיר (COSTINGLOG).']));
  const extra = {
    since: loaded.since,
    lastCostingAt: r.lastCostingAt,
    pendingFiles: r.pendingFiles,
    ambiguousFiles: r.ambiguousFiles,
    draftReleases: r.draftReleases,
    scanned: r.scanned,
  };
  if (!r.readyToRun) return stop(out.refused(r.blockers, extra));
  if (!r.costingNeeded && r.ambiguousFiles.length === 0 && !p.rerun) {
    return stop(
      out.alreadyDone('אין תיק שהשתנה אחרי התמחיר האחרון. להרצה בכל זאת: rerun=true.', extra),
    );
  }
  return {
    kind: 'ok',
    state: {
      since: loaded.since,
      lastCostingAt: r.lastCostingAt,
      pendingFiles: r.pendingFiles,
      ambiguousFiles: r.ambiguousFiles,
      draftReleases: r.draftReleases,
    },
    extra,
    lastCostingAt: r.lastCostingAt,
  };
}

/** Step 11 — "תמחיר לתאריך נוכחי" (FNCCOSTINGPART), company-wide. */
export async function runCosting(
  client: PriorityClient,
  config: Config,
  p: CostingParams,
  deps: FinalDeps = {},
): Promise<StepOutcome> {
  const step = 'costing' as const;
  const c = ctx(step, COMPANY_SUBJECT, COMPANY_SUBJECT, deps);
  const { out } = c;
  const program = 'FNCCOSTINGPART';
  const first = await inspectCosting(client, c, p);
  if (first.kind === 'stop') return { ...first.outcome, program };

  if (p.dryRun) {
    const preview = previewWithCode(c, first.state, [], {
      program,
      ...first.extra,
      afterwards:
        'התוכנית רצה על כל המק"טים בחברה. קריאה חוזרת: יומן התמחיר (COSTINGLOG) התקדם, ואין תיקים ממתינים. דוח "אזהרות תמחיר" נפתח במסך.',
    });
    if (preview.status !== 'preview' || !p.probe) return preview;
    try {
      if (!deps.session) throw new Error('Web SDK session is not configured.');
      await deps.session().ensureLogin();
      return { ...preview, probe: { login: 'ok', procStart: 'not called' } };
    } catch (err) {
      return { ...preview, probe: { error: describeError(err) } };
    }
  }
  if (config.priorityReadOnly) return out.blocked();
  const early = codeProblem(c, p.approvalCode, first.state);
  if (early) return { ...early, program };

  let session: WebSdkSession;
  try {
    if (!deps.session) throw new Error('Web SDK session is not configured.');
    session = deps.session();
  } catch (err) {
    return out.notDone(
      'failed',
      `לא ניתן להפעיל את ה-Web SDK (${describeError(err)}); התמחיר לא הופעל.`,
      { program },
    );
  }
  const record = { impfnum: COMPANY_SUBJECT, step };
  const begun = beginStep(out, c.ledgerPath, record, c.now(), {
    cooldown: true,
    windowMs: COSTING_WINDOW_MS,
  });
  if ('stop' in begun) return { ...begun.stop, program };
  let trace: ActivationTrace;
  let before: string | null;
  try {
    const fresh = await inspectCosting(client, c, p);
    if (fresh.kind === 'stop') {
      return recordAfter(
        c.ledgerPath,
        { ...record, phase: 'failed' },
        { ...fresh.outcome, program },
      );
    }
    const refusal = spend(c, p.approvalCode as string, fresh.state);
    if (refusal)
      return recordAfter(c.ledgerPath, { ...record, phase: 'failed' }, { ...refusal, program });
    before = fresh.lastCostingAt;
    trace = await runCostingProgram(session, {
      ...(deps.stepTimeoutMs ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
      ...(deps.endTimeoutMs ? { endTimeoutMs: deps.endTimeoutMs } : {}),
    });
  } finally {
    begun.release();
  }

  const after = await readLastCostingAt(client);
  const advanced =
    typeof after === 'string' && (before === null || Date.parse(after) > Date.parse(before));
  const extra = {
    program,
    procedure: trace,
    lastCostingBefore: before,
    lastCostingAt: after ?? null,
  };
  const finish = (phase: 'failed' | 'unverified' | 'done', outcome: StepOutcome) =>
    recordAfter(c.ledgerPath, { ...record, phase }, outcome);

  if (!trace.dispatched) {
    return finish('failed', out.notDone('failed', `התמחיר לא הופעל: ${trace.error ?? ''}`, extra));
  }
  if (trace.outcome === 'cancelled' || trace.outcome === 'failed') {
    if (advanced || trace.cancelConfirmed === false || trace.outcome === 'failed') {
      return finish(
        'unverified',
        out.notDone(
          'unverified',
          `התמחיר הופעל ולא הסתיים בצורה ברורה (${trace.error ?? ''})${advanced ? '; יומן התמחיר כן התקדם' : ''}. לא מפעילים שוב; בודקים במסך את יומן התמחיר ואת דוח "אזהרות תמחיר".`,
          extra,
        ),
      );
    }
    return finish(
      'failed',
      out.notDone(
        'cancelled',
        `התמחיר הציג שאלה או מסך קלט שלא נצפו מראש, והכלי ביטל אותו בלי לענות (${trace.error ?? ''}). הצעדים ב-procedure.steps.`,
        extra,
      ),
    );
  }
  const endKind = String(trace.steps.at(-1)?.messagetype ?? '').toLowerCase();
  if (trace.outcome === 'end-with-message' && endKind !== 'warning') {
    return finish(
      'unverified',
      out.notDone(
        'unverified',
        `התוכנית הסתיימה עם הודעה מסוג ${endKind}: ${trace.error ?? ''}${advanced ? '; יומן התמחיר כן התקדם' : ''}. אין הוכחה שהתמחיר הושלם; לא מפעילים שוב; בודקים במסך את יומן התמחיר ואת דוח "אזהרות תמחיר".`,
        extra,
      ),
    );
  }
  if (!advanced) {
    return finish(
      'unverified',
      out.notDone(
        'unverified',
        after === undefined
          ? 'התוכנית הסתיימה, אך לא ניתן היה לקרוא את יומן התמחיר (COSTINGLOG). לא מפעילים שוב; בודקים במסך.'
          : 'התוכנית הסתיימה, אך יומן התמחיר (COSTINGLOG) לא התקדם. לא מפעילים שוב; בודקים במסך.',
        extra,
      ),
    );
  }
  let pending: string[] | null = null;
  try {
    pending =
      (await loadCostingReadiness(client, p.since, c.now())).readiness?.pendingFiles ?? null;
  } catch {
    pending = null;
  }
  if (pending === null || pending.length) {
    return finish(
      'unverified',
      out.notDone(
        'unverified',
        pending === null
          ? 'יומן התמחיר התקדם, אך לא ניתן היה לקרוא שוב את המוכנות לתמחיר.'
          : `יומן התמחיר התקדם, אך עדיין יש תיקים ממתינים: ${pending.join(', ')}.`,
        { ...extra, pendingFiles: pending },
      ),
    );
  }
  const message = trace.steps.at(-1)?.message ?? trace.error ?? null;
  return finish(
    'done',
    out.done('התמחיר רץ: יומן התמחיר התקדם ואין תיקים ממתינים (נקרא מחדש מפריוריטי).', {
      ...extra,
      programMessage: message,
      programMessages: messagesOf(trace),
      nextStep:
        'לפתוח במסך את הדוח "אזהרות תמחיר" (כספים ← תמחיר מסחרי ← עלויות מוצר). הכלי אינו קורא אותו.',
    }),
  );
}
