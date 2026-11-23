import type { ImpfileSnapshot } from './impfiles-logic.js';

/**
 * Which steps of the mandatory import-file order are proven by Priority data.
 *
 * Order (Assaf, 26.10.2026): receipt into the bonded warehouse (arov) → fill detail → loading
 * calc → close file → release → per-line import costs → costing. Pure: no I/O. A document read
 * that failed is passed as null and yields 'unknown', which blocks — a step is never reported
 * as satisfied on missing data.
 */
export const BONDED_WAREHOUSE = 'arov';
export const FINAL_DOC_STATUS = 'סופית';
export const DRAFT_DOC_STATUS = 'טיוטא';
export const CANCELLED_DOC_STATUS = 'מבוטלת';

export type StepState = 'done' | 'missing' | 'unknown';

export interface ReceiptRow {
  DOCNO: string;
  STATDES: string;
  TOWARHSNAME: string;
  IVNUM: string | null;
}

export interface ReleaseRow {
  DOCNO: string;
  STATDES: string;
}

export interface StageInput {
  snapshot: ImpfileSnapshot;
  /** DOCUMENTS_P rows for the file's goods invoices; null = the read failed. */
  receipts: ReceiptRow[] | null;
  /** DOCUMENTS_J rows of the file; null = the read failed. */
  releases: ReleaseRow[] | null;
}

export interface StageResult {
  closed: boolean;
  steps: {
    /** every linked invoice is final (IVNUM does not start with 'T') */
    invoicesFinal: StepState;
    /** a final receipt into the bonded warehouse */
    bondedReceipt: StepState;
    /** the file's goods content has rows */
    detailFilled: StepState;
    /** the customs estimate covers every part of the goods content */
    calcEvidence: StepState;
    /** a release that is neither cancelled nor a draft */
    released: StepState;
  };
  /** Reasons the file must not be closed now, in the order of the mandatory sequence. */
  closeBlocking: string[];
  /** Things that cannot be proven from Priority data. */
  advisory: string[];
}

export const CALC_ADVISORY =
  'אין בפריוריטי שדה שמוכיח ש"חישוב העמסה" רץ אחרי השינוי האחרון — יש להריץ אותו שוב לפני הסגירה.';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * "מילוי פירוט למחסן ערובה" copies the VAT-from-declaration line of the broker invoice into the
 * file's content. It is not a product and never gets a customs-estimate row.
 */
const VAT_DECLARATION_PART = "מע'מ";

function distinctParts(rows: Array<Record<string, unknown>> | undefined): Set<string> {
  const parts = new Set<string>();
  for (const row of rows ?? []) {
    const part = text(row.PARTNAME);
    if (part && part !== VAT_DECLARATION_PART) parts.add(part);
  }
  return parts;
}

export function computeStage(input: StageInput): StageResult {
  const { snapshot, receipts, releases } = input;
  const header = snapshot.header ?? {};
  const closed = header.CLOSED === 'Y';
  const closeBlocking: string[] = [];

  // 1. invoices final
  const ivnums = (snapshot.invoices ?? []).map((iv) => text(iv.IVNUM)).filter(Boolean);
  const temporary = ivnums.filter((n) => /^T\d/i.test(n));
  let invoicesFinal: StepState = 'done';
  if (ivnums.length === 0) {
    invoicesFinal = 'missing';
    closeBlocking.push('אין חשבונית מקושרת לתיק.');
  } else if (temporary.length > 0) {
    invoicesFinal = 'missing';
    closeBlocking.push(
      `יש חשבונית זמנית מקושרת (${temporary.join(', ')}) — יש לסגור T ל-GI לפני סגירת התיק.`,
    );
  }

  // 2. final receipt into the bonded warehouse
  let bondedReceipt: StepState;
  if (receipts === null) {
    bondedReceipt = 'unknown';
    closeBlocking.push('לא ניתן היה לקרוא את קבלות הסחורה — לא ניתן לאשר קבלה לערובה.');
  } else if (
    receipts.some((r) => r.STATDES === FINAL_DOC_STATUS && r.TOWARHSNAME === BONDED_WAREHOUSE)
  ) {
    bondedReceipt = 'done';
  } else {
    bondedReceipt = 'missing';
    closeBlocking.push(`לא נמצאה קבלה סופית למחסן ${BONDED_WAREHOUSE} מול חשבונית הסחורה.`);
  }

  // 3. detail filled
  const contentParts = distinctParts(snapshot.goodsContent);
  const detailFilled: StepState = (snapshot.goodsContent ?? []).length > 0 ? 'done' : 'missing';
  if (detailFilled === 'missing') {
    closeBlocking.push('פירוט התיק (תכולה במחסני ערובה) ריק — יש להריץ "מילוי פירוט למחסן ערובה".');
  }

  // 4. evidence that the loading calc ran on the current content
  const estimateParts = distinctParts(snapshot.customsEstimate);
  const covered = [...contentParts].filter((p) => estimateParts.has(p)).length;
  const calcEvidence: StepState =
    contentParts.size > 0 && covered === contentParts.size ? 'done' : 'missing';
  if (calcEvidence === 'missing') {
    closeBlocking.push(
      `אומדן המכס ריק או חלקי (${covered}/${contentParts.size} מק"טים) — "חישוב העמסה" לא רץ על התכולה הנוכחית.`,
    );
  }

  // 5. release
  let released: StepState;
  if (releases === null) {
    released = 'unknown';
    closeBlocking.push('לא ניתן היה לקרוא את השחרורים מערובה.');
  } else {
    const live = releases.filter(
      (r) => r.STATDES !== CANCELLED_DOC_STATUS && r.STATDES !== DRAFT_DOC_STATUS,
    );
    released = live.length > 0 ? 'done' : 'missing';
    if (live.length > 0 && !closed) {
      closeBlocking.push(
        `קיים שחרור מערובה (${live.map((r) => r.DOCNO).join(', ')}) לפני סגירת התיק.`,
      );
    }
  }

  return {
    closed,
    steps: { invoicesFinal, bondedReceipt, detailFilled, calcEvidence, released },
    closeBlocking,
    advisory: [CALC_ADVISORY],
  };
}
