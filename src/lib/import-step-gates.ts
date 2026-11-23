import {
  BONDED_WAREHOUSE,
  CANCELLED_DOC_STATUS,
  FINAL_DOC_STATUS,
  type FileFacts,
  type OfficialStage,
  computeOfficialSteps,
} from './impfile-official.js';

/**
 * Preconditions of the six executing import steps (phase B). Pure: each gate takes the facts that
 * were read from Priority and returns the reasons to refuse, in Hebrew. An empty list means the
 * step may run.
 *
 * Two rules hold for every gate:
 *  - a fact that could not be read (null) is a reason to refuse, never a reason to proceed;
 *  - the order is Priority's official one (SOP LBI2400273 / LBI2400656): nothing before the
 *    close may run on a closed file, nothing after it on an open one.
 */
export type PhaseBStep =
  | 'declaration'
  | 'receipt'
  | 'fillDetail'
  | 'calc'
  | 'releaseDraft'
  | 'lineCosts';

export interface GateInput {
  /** declaration: the draft invoice the declaration is written on */
  invoiceNumber?: string;
  /** releaseDraft: the draft release being continued; lineCosts: the release to cost */
  releaseDocno?: string;
  /** lineCosts: allow the repair path on a release that is already final */
  onFinalRelease?: boolean;
  /** releaseDraft: allow a partial release before any cost invoice is linked */
  allowWithoutCostInvoice?: boolean;
}

const CLOSED = 'התיק סגור — הצעד הזה שייך לשלבים שלפני סגירת התיק.';
const NOT_CLOSED =
  'התיק אינו סגור — לפי הנוהל של פריוריטי סוגרים את התיק ("סגירת התיק") לפני השחרור מהערובה.';
const UNREAD_RECEIPTS = 'לא ניתן היה לקרוא את קבלות הסחורה של התיק.';
const UNREAD_RELEASES = 'לא ניתן היה לקרוא את תעודות השחרור של התיק.';

const stepState = (stage: OfficialStage, n: number) => stage.steps.find((s) => s.n === n);

function notDone(stage: OfficialStage, n: number): string[] {
  const step = stepState(stage, n);
  if (!step || step.state === 'done') return [];
  const why = step.detail.join(' ') || (step.state === 'unknown' ? 'לא ניתן לאמת.' : 'לא בוצע.');
  return [`שלב ${n} (${step.title}) לא הושלם: ${why}`];
}

const temporaryInvoices = (facts: FileFacts, goodsOnly: boolean): string[] =>
  facts.invoices.filter((iv) => !iv.isFinal && (!goodsOnly || iv.isGoods)).map((iv) => iv.ivnum);

function declarationGate(facts: FileFacts, input: GateInput): string[] {
  const reasons: string[] = [];
  if (facts.closed) reasons.push(CLOSED);
  if (!input.invoiceNumber) {
    reasons.push('לא נמסר מספר חשבונית.');
    return reasons;
  }
  const invoice = facts.invoices.find((iv) => iv.ivnum === input.invoiceNumber);
  if (!invoice) {
    reasons.push(`החשבונית ${input.invoiceNumber} אינה מקושרת לתיק ${facts.impfnum}.`);
  } else if (invoice.isFinal) {
    reasons.push(
      `החשבונית ${invoice.ivnum} אינה טיוטה — הצהרת היבוא בשורות ננעלת כשהחשבונית סופית.`,
    );
  }
  return reasons;
}

function receiptGate(facts: FileFacts): string[] {
  const reasons: string[] = [];
  if (facts.closed) reasons.push(CLOSED);
  if (facts.warehouse !== BONDED_WAREHOUSE) {
    reasons.push(
      `מחסן הערובה בתיק הוא "${facts.warehouse ?? ''}" ולא ${BONDED_WAREHOUSE} — יש לתקן את התיק לפני הקבלה.`,
    );
  }
  const goods = facts.invoices.filter((iv) => iv.isGoods);
  const temporary = temporaryInvoices(facts, true);
  if (temporary.length) {
    reasons.push(
      `חשבונית סחורה זמנית: ${temporary.join(', ')} — סוגרים את החשבונית לפני הקבלה לערובה.`,
    );
  }
  if (!goods.some((iv) => iv.isFinal)) {
    reasons.push(goods.length ? 'אין חשבונית סחורה סופית בתיק.' : 'אין חשבונית סחורה מקושרת לתיק.');
  }
  if (goods.some((iv) => iv.isFinal && iv.linesWithoutDeclaration === null)) {
    reasons.push('לא ניתן היה לקרוא את שורות חשבונית הסחורה.');
  }
  if (facts.receipts === null) reasons.push(UNREAD_RECEIPTS);
  // A receipt entered against purchase-order lines carries no invoice number and cannot be found
  // from here. Content or a release proves the goods already entered the bonded warehouse.
  if (facts.content.length > 0) {
    reasons.push(
      'בתכולת התיק כבר יש שורות — הסחורה כבר התקבלה למחסן הערובה בדרך שהכלי אינו מזהה (למשל קבלה מול שורות הזמנה). לא פותחים קבלה נוספת.',
    );
  }
  if (facts.releases === null) reasons.push(UNREAD_RELEASES);
  else {
    const live = facts.releases.filter((r) => r.status !== CANCELLED_DOC_STATUS);
    if (live.length) {
      reasons.push(
        `לתיק כבר יש תעודת שחרור מהערובה (${live.map((r) => r.docno).join(', ')}) — הסחורה כבר התקבלה. לא פותחים קבלה נוספת.`,
      );
    }
  }
  return reasons;
}

/** Every goods invoice must be final and have its own final receipt into the bonded warehouse. */
function goodsNotReceived(facts: FileFacts): string[] {
  if (facts.receipts === null) return [];
  const receipts = facts.receipts;
  const missing = facts.invoices
    .filter((iv) => iv.isGoods)
    .filter(
      (iv) =>
        !iv.isFinal ||
        !receipts.some(
          (r) =>
            r.ivnum === iv.ivnum &&
            r.status === FINAL_DOC_STATUS &&
            r.warehouse === BONDED_WAREHOUSE,
        ),
    )
    .map((iv) => iv.ivnum);
  return missing.length
    ? [
        `חשבוניות סחורה בלי קבלה סופית למחסן ${BONDED_WAREHOUSE}: ${missing.join(', ')} — קודם מקבלים את כל חשבוניות הסחורה של התיק.`,
      ]
    : [];
}

function fillDetailGate(facts: FileFacts): string[] {
  const reasons: string[] = [];
  if (facts.closed) reasons.push(CLOSED);
  if (facts.receipts === null) reasons.push(UNREAD_RECEIPTS);
  else {
    const hasFinal = facts.receipts.some(
      (r) => r.status === FINAL_DOC_STATUS && r.warehouse === BONDED_WAREHOUSE,
    );
    if (!hasFinal) {
      reasons.push(
        `אין קבלה סופית למחסן ${BONDED_WAREHOUSE} שמקושרת לחשבונית הסחורה — מילוי הפירוט בא אחרי הקבלה.`,
      );
    } else reasons.push(...goodsNotReceived(facts));
  }
  if (facts.content.length > 0) {
    reasons.push(
      `בתכולת התיק כבר יש שורות מוצר (${facts.content.length}) שאינן זהות לחשבונית הסחורה — בודקים ומתקנים במסך "תכולה במחסני ערובה", לא מריצים שוב את התוכנית.`,
    );
  }
  return reasons;
}

function calcGate(facts: FileFacts): string[] {
  const reasons: string[] = [];
  if (facts.closed) reasons.push(CLOSED);
  const stage = computeOfficialSteps(facts);
  const steps = [3, 4, 5].flatMap((n) => notDone(stage, n));
  reasons.push(...steps);
  // Step 4 is satisfied by one final receipt; the calculation needs every goods invoice received.
  if (steps.length === 0) reasons.push(...goodsNotReceived(facts));
  return reasons;
}

function releaseDraftGate(facts: FileFacts, input: GateInput): string[] {
  const reasons: string[] = [];
  if (!facts.closed) reasons.push(NOT_CLOSED);
  if (!facts.content.some((c) => c.balance > 0)) {
    reasons.push('אין יתרה בתכולת התיק — אין מה לשחרר מהערובה.');
  }
  if (facts.releases === null) reasons.push(UNREAD_RELEASES);
  else {
    const drafts = facts.releases.filter(
      (r) =>
        r.status !== FINAL_DOC_STATUS &&
        r.status !== CANCELLED_DOC_STATUS &&
        r.docno !== input.releaseDocno,
    );
    if (drafts.length) {
      reasons.push(
        `כבר קיימת תעודת שחרור שאינה סופית לתיק: ${drafts.map((r) => `${r.docno} (${r.status})`).join(', ')} — ממשיכים אותה או מבטלים אותה, לא פותחים שנייה.`,
      );
    }
  }
  if (!facts.invoices.some((iv) => !iv.isGoods) && !input.allowWithoutCostInvoice) {
    reasons.push(
      'אין חשבונית עלויות (הובלה/עמיל) מקושרת לתיק — שחרור עכשיו יכניס את הסחורה למלאי בלי עלויות נלוות.',
    );
  }
  const temporary = temporaryInvoices(facts, false);
  if (temporary.length) reasons.push(`חשבונית זמנית בתיק: ${temporary.join(', ')}.`);
  return reasons;
}

function lineCostsGate(facts: FileFacts, input: GateInput): string[] {
  const reasons: string[] = [];
  if (!facts.closed) reasons.push(NOT_CLOSED);
  if (facts.releases === null) {
    reasons.push(UNREAD_RELEASES);
    return reasons;
  }
  const release = facts.releases.find((r) => r.docno === input.releaseDocno);
  if (!release) {
    reasons.push(
      `לא נמצאה תעודת שחרור ${input.releaseDocno ?? ''} בתיק ${facts.impfnum}.`.replace('  ', ' '),
    );
    return reasons;
  }
  if (release.status === CANCELLED_DOC_STATUS) {
    reasons.push(`תעודת השחרור ${release.docno} מבוטלת.`);
  } else if (release.status === FINAL_DOC_STATUS && !input.onFinalRelease) {
    reasons.push(
      `תעודת השחרור ${release.docno} כבר סופית — לפי הנוהל רושמים עלויות יבוא לשורה כשהתעודה בטיוטה. הרצה על תעודה סופית היא מסלול תיקון ודורשת onFinalRelease=true.`,
    );
  }
  if (release.lines.length === 0) reasons.push(`בתעודת השחרור ${release.docno} אין שורות.`);
  return reasons;
}

/** Reasons to refuse `step` on this file; [] = allowed. */
export function gate(step: PhaseBStep, facts: FileFacts, input: GateInput = {}): string[] {
  switch (step) {
    case 'declaration':
      return declarationGate(facts, input);
    case 'receipt':
      return receiptGate(facts);
    case 'fillDetail':
      return fillDetailGate(facts);
    case 'calc':
      return calcGate(facts);
    case 'releaseDraft':
      return releaseDraftGate(facts, input);
    case 'lineCosts':
      return lineCostsGate(facts, input);
  }
}

/** Things the caller must be told but that do not stop the step. */
export function gateWarnings(step: PhaseBStep, facts: FileFacts): string[] {
  if (step !== 'receipt') return [];
  const missing = facts.invoices
    .filter((iv) => iv.isGoods && iv.isFinal)
    .reduce((sum, iv) => sum + (iv.linesWithoutDeclaration ?? 0), 0);
  return missing > 0
    ? [
        `ב-${missing} שורות סחורה אין הצהרת יבוא. החשבונית כבר סופית ולכן השדה נעול; ממשיכים בקבלה, ובתיקים הבאים ממלאים את ההצהרה לפני סגירת החשבונית (pinvoice_set_declaration).`,
      ]
    : [];
}
