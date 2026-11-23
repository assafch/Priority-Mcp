/**
 * The import-file process exactly as Priority's own SOPs define it, as pure functions over facts
 * read from Priority. No I/O here.
 *
 * Sources (both dated 2 Jan 2025, read in full 23.11.2026):
 *   - "תיקי יבוא"            LBI2400273 — SOP_ShipVouch
 *   - "עבודה עם מחסן ערובה"  LBI2400656 — SOP_BondedWarhs
 *
 * Official order for a bonded import:
 *   1 open file → 2 link invoices (import declaration + country of origin per line) →
 *   3 invoices final → 4 receipt into the bonded warehouse → 5 "מילוי פירוט למחסן ערובה" →
 *   6 "חישוב העמסה" (review) → 7 "סגירת התיק" → 8 release document (draft) →
 *   9 "רישום עלויות יבוא לשורה" (file closed, release still a draft) → 10 release final →
 *   11 "תמחיר לתאריך נוכחי" → 12 landed cost per product.
 *
 * Field titles of the per-line cost screen ("עלויות יבוא לשורה", TRANSIMPFILE) were read live:
 *   TRANSCOST "ערך טובין בשקלים" · TRANSCOST3/CODE3/EXCH3 "ערך טובין במט"ח / מט"ח / שער מט"ח" ·
 *   CUSTOMSSUM "סכום המכס" · DUTYPERCENT "אחוז עלויות נוספות" · DUTYCOST "עלויות נוספות" ·
 *   IMPFCOST "עלויות יבוא כלליות" · TOTCOST "סה"כ עלות בשקלים".
 *
 * A read that failed is represented as null/undefined and yields 'unknown' — a step is never
 * reported as done on missing data.
 */

export const BONDED_WAREHOUSE = 'arov';
export const FINAL_DOC_STATUS = 'סופית';
export const DRAFT_DOC_STATUS = 'טיוטא';
export const CANCELLED_DOC_STATUS = 'מבוטלת';
export const VAT_DECLARATION_PART = "מע'מ";
export const LOCAL_CURRENCY = 'ש"ח';

export type OfficialState = 'done' | 'missing' | 'partial' | 'unknown';

export interface InvoiceLineFact {
  part: string;
  qty: number | null;
  qprice: number | null;
  currency: string | null;
  country: string | null;
}

export interface InvoiceFact {
  ivnum: string;
  supplier: string | null;
  debit: string | null;
  /** true when the invoice's supplier is the file's goods supplier */
  isGoods: boolean;
  /** false while the invoice still carries a temporary number (T…) */
  isFinal: boolean;
  lines: InvoiceLineFact[];
  /**
   * Goods lines that carry no import declaration (PINVOICEITEMS.CUSTOMSNUM); null = the invoice
   * lines could not be read.
   */
  linesWithoutDeclaration: number | null;
}

export interface ReceiptFact {
  docno: string;
  status: string;
  warehouse: string;
  ivnum: string | null;
}

export interface ReleaseLineFact {
  /** line number within the release (KLINE); absent in hand-built facts */
  kline?: number | null;
  part: string;
  /** product description as printed on the release line */
  description?: string | null;
  qty: number;
  /** "ערך טובין בשקלים" */
  goodsILS: number | null;
  /** "סכום המכס" */
  customsILS: number | null;
  /** "עלויות נוספות" */
  additionalILS: number | null;
  /** "עלויות יבוא כלליות" */
  importILS: number | null;
  /** "סה"כ עלות בשקלים" */
  totalILS: number | null;
  /** "ת. חתימה" of the cost row; null = no cost row / never registered */
  costRegisteredAt: string | null;
}

export interface ReleaseFact {
  docno: string;
  status: string;
  date: string | null;
  updatedAt: string | null;
  /** "הצהרת יבוא" on the release (DOCREF) */
  declaration: string | null;
  /** "חשבונית מכס" on the release (IVNUM) */
  customsInvoice: string | null;
  lines: ReleaseLineFact[];
  /**
   * "מע'מ" (VAT-from-declaration) lines with no quantity that Priority pulled into the release
   * from the file content. They are not goods: left out of `lines`, counted here.
   */
  ignoredVatLines?: number;
}

export interface FileFacts {
  impfnum: string;
  closed: boolean;
  supplier: string | null;
  warehouse: string | null;
  invoices: InvoiceFact[];
  /** null = the receipts read failed */
  receipts: ReceiptFact[] | null;
  /** goods content of the file ("תכולה במחסני ערובה"), without the VAT-from-declaration line */
  content: Array<{ part: string; qty: number; balance: number }>;
  /**
   * "מילוי פירוט למחסן ערובה" also copies the VAT-from-declaration line of the broker invoice into
   * the content. It is not a product and has to be zeroed. This is the summed absolute quantity
   * of ALL such lines (0 only when every one is zero); null when the content has none.
   */
  contentVatLineQty?: number | null;
  /** distinct parts that have a customs-estimate row */
  customsEstimateParts: string[];
  /** customs-estimate rows that carry no country of origin */
  customsEstimateWithoutCountry?: number;
  /** null = the releases read failed */
  releases: ReleaseFact[] | null;
  /** start time of the last costing run; null = never ran; undefined = the read failed */
  lastCostingAt: string | null | undefined;
}

export interface OfficialStep {
  n: number;
  key: string;
  title: string;
  /** SOP clause this step comes from */
  sop: string;
  /** Priority screen or program (internal name in brackets where known) */
  program: string;
  state: OfficialState;
  detail: string[];
}

export interface OfficialStage {
  steps: OfficialStep[];
  /**
   * The first step that is not done and can still be acted on; null when none is left. On a
   * closed file the steps before the close (2–6) can no longer be acted on, so they are listed
   * under historicalGaps instead.
   */
  currentStep: number | null;
  nextAction: string;
  /** steps 2–6 that were not proven on a file that is already closed */
  historicalGaps: string[];
  /** things already done in an order the SOP does not allow */
  violations: string[];
}

const cents = (n: number | null | undefined): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) : 0;
const fromCents = (c: number): number => Math.round(c) / 100;
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
/**
 * Priority timestamps have minute resolution, so two events in the same minute cannot be ordered.
 */
export function costingVsChange(
  costingAt: string | null | undefined,
  changeAt: string | null | undefined,
): 'after' | 'same-minute' | 'before' {
  if (!costingAt) return 'before';
  if (!changeAt) return 'before';
  const c = Date.parse(costingAt);
  const x = Date.parse(changeAt);
  if (Number.isNaN(c) || Number.isNaN(x)) return 'before';
  if (c > x) return 'after';
  return c === x ? 'same-minute' : 'before';
}
const maxTime = (values: Array<string | null | undefined>): string | null => {
  let best: string | null = null;
  for (const v of values) {
    if (v && !Number.isNaN(Date.parse(v)) && (!best || Date.parse(v) > Date.parse(best))) best = v;
  }
  return best;
};

const liveReleases = (releases: ReleaseFact[]): ReleaseFact[] =>
  releases.filter((r) => r.status !== CANCELLED_DOC_STATUS);
const finalReleases = (releases: ReleaseFact[]): ReleaseFact[] =>
  releases.filter((r) => r.status === FINAL_DOC_STATUS);
/**
 * A release line counts as costed once its cost row was registered and carries the file's costs.
 * An amount of exactly 0 proves nothing unless the file has no cost invoices at all: no uncosted
 * final line was ever observed on this tenant, so 0 is treated as "not proven".
 */
export const lineIsCosted = (line: ReleaseLineFact, zeroIsValid = false): boolean =>
  !!line.costRegisteredAt &&
  isNum(line.totalILS) &&
  isNum(line.importILS) &&
  (zeroIsValid || line.importILS !== 0 || (line.customsILS ?? 0) !== 0);

// --------------------------------------------------------------- reconciliation

export interface CostReconciliation {
  /** Σ "עלויות יבוא כלליות" over final releases */
  importCostsOnReleases: number;
  /** Σ "סכום המכס" over final releases */
  customsOnReleases: number;
  /** Σ "עלויות נוספות" over final releases (costs by %, not from the file's invoices) */
  additionalOnReleases: number;
  /** Σ lines of the cost invoices linked to the file, without the VAT-from-declaration line */
  costInvoiceLinesTotal: number | null;
  /** registered (import + customs) minus the invoice total */
  difference: number | null;
  status:
    | 'ties'
    | 'ties-within-rounding'
    | 'differs'
    | 'partial-release'
    | 'not-released'
    | 'not-comparable'
    | 'unknown';
  notes: string[];
}

/**
 * Do the import costs registered on the release lines equal the cost invoices of the file?
 * Comparable only when the whole file was released and every cost invoice is in local currency.
 */
export function reconcileImportCosts(facts: FileFacts): CostReconciliation {
  const notes: string[] = [];
  if (facts.releases === null) {
    return {
      importCostsOnReleases: 0,
      customsOnReleases: 0,
      additionalOnReleases: 0,
      costInvoiceLinesTotal: null,
      difference: null,
      status: 'unknown',
      notes: ['לא ניתן היה לקרוא את תעודות השחרור.'],
    };
  }
  const finals = finalReleases(facts.releases);
  let imp = 0;
  let customs = 0;
  let additional = 0;
  for (const line of finals.flatMap((r) => r.lines)) {
    imp += cents(line.importILS);
    customs += cents(line.customsILS);
    additional += cents(line.additionalILS);
  }

  const costInvoices = facts.invoices.filter((iv) => !iv.isGoods);
  let invoiceTotal: number | null = 0;
  for (const iv of costInvoices) {
    if (iv.debit && iv.debit !== 'D') {
      invoiceTotal = null;
      notes.push(`חשבונית ${iv.ivnum} היא זיכוי (DEBIT=${iv.debit}) — ההשוואה לא בוצעה.`);
      break;
    }
    for (const line of iv.lines) {
      if (line.part === VAT_DECLARATION_PART) continue;
      if (line.currency !== LOCAL_CURRENCY || !isNum(line.qprice)) {
        invoiceTotal = null;
        notes.push(
          `בחשבונית ${iv.ivnum} יש שורת עלות שאינה ב${LOCAL_CURRENCY} — אין שער מוכח להשוואה.`,
        );
        break;
      }
      invoiceTotal = (invoiceTotal as number) + cents(line.qprice);
    }
    if (invoiceTotal === null) break;
  }
  const goodsExtras = facts.invoices
    .filter((iv) => iv.isGoods)
    .flatMap((iv) => iv.lines)
    .filter((l) => !facts.content.some((c) => c.part === l.part));
  if (goodsExtras.length) {
    notes.push(
      `בחשבונית הסחורה יש ${goodsExtras.length} שורות שאינן מוצר בתכולת התיק (${[
        ...new Set(goodsExtras.map((l) => l.part)),
      ].join(', ')}) — הן לא נכללות בסכום ההשוואה.`,
    );
  }
  if (customs !== 0) {
    notes.push('נרשם "סכום המכס" בשורות השחרור — מסלול המכס טרם נבדק בחברה זו.');
  }
  if (additional !== 0) {
    notes.push('"עלויות נוספות" (לפי אחוז) אינן מגיעות מחשבוניות התיק ואינן חלק מההשוואה.');
  }

  const base = {
    importCostsOnReleases: fromCents(imp),
    customsOnReleases: fromCents(customs),
    additionalOnReleases: fromCents(additional),
    costInvoiceLinesTotal: invoiceTotal === null ? null : fromCents(invoiceTotal),
  };
  if (finals.length === 0) {
    return { ...base, difference: null, status: 'not-released', notes };
  }
  if (invoiceTotal === null) {
    return { ...base, difference: null, status: 'not-comparable', notes };
  }
  const difference = fromCents(imp + customs - invoiceTotal);
  const unreleased = facts.content.some((c) => c.balance > 0);
  if (unreleased) {
    notes.push('התיק שוחרר חלקית — הסכום שנרשם אמור להיות קטן מסך החשבוניות עד לשחרור המלא.');
    return { ...base, difference, status: 'partial-release', notes };
  }
  if (difference === 0) return { ...base, difference, status: 'ties', notes };
  // Tolerance (our assumption, not a documented Priority rule): spreading the costs over the
  // released lines and rounding each line to the agora can move the total by up to half an agora
  // per line. Anything beyond that is reported as a difference.
  const lineCount = finals.reduce((n, r) => n + r.lines.length, 0);
  const boundCents = Math.ceil(lineCount / 2);
  if (Math.abs(imp + customs - invoiceTotal) <= boundCents) {
    notes.push(
      `הפרש של ${difference} ₪ — בתוך סף הסבילות שהוגדר לעיגול: חצי אגורה לכל אחת מ-${lineCount} השורות (עד ${fromCents(boundCents)} ₪).`,
    );
    return { ...base, difference, status: 'ties-within-rounding', notes };
  }
  return { ...base, difference, status: 'differs', notes };
}

// ------------------------------------------------------------------ the 12 steps

export function computeOfficialSteps(facts: FileFacts): OfficialStage {
  const violations: string[] = [];
  const steps: OfficialStep[] = [];
  const push = (
    n: number,
    key: string,
    title: string,
    sop: string,
    program: string,
    state: OfficialState,
    detail: string[] = [],
  ) => steps.push({ n, key, title, sop, program, state, detail });

  // 1 — the file exists
  push(1, 'fileOpened', 'פתיחת תיק יבוא', 'תיקי יבוא, שלב א׳', 'תיקי יבוא (IMPFILES)', 'done', [
    ...(facts.warehouse === BONDED_WAREHOUSE
      ? []
      : [`מחסן הערובה בתיק הוא "${facts.warehouse ?? ''}" ולא ${BONDED_WAREHOUSE}.`]),
  ]);

  // 2 — invoices linked, with import declaration and country of origin on each goods line
  const goods = facts.invoices.filter((iv) => iv.isGoods);
  const costInvoices = facts.invoices.filter((iv) => !iv.isGoods);
  {
    const detail: string[] = [];
    let state: OfficialState = 'done';
    if (goods.length === 0) {
      state = 'missing';
      detail.push('אין חשבונית סחורה מקושרת לתיק.');
    } else {
      const noCountry = goods.flatMap((iv) => iv.lines).filter((l) => !l.country).length;
      if (noCountry > 0) {
        detail.push(
          `ב-${noCountry} שורות סחורה לא מולאה ארץ מוצא בשורת החשבונית — פריוריטי משתמש בארץ הספק; יש לוודא מול הרשומון (נבדק באומדן המכס בשלב 6).`,
        );
      }
      const unknownDecl = goods.some((iv) => iv.linesWithoutDeclaration === null);
      const noDecl = goods.reduce((sum, iv) => sum + (iv.linesWithoutDeclaration ?? 0), 0);
      if (noDecl > 0) {
        state = 'missing';
        detail.push(`${noDecl} שורות סחורה בלי הצהרת יבוא.`);
      } else if (unknownDecl && state === 'done') {
        state = 'unknown';
        detail.push('לא ניתן היה לקרוא את הצהרת היבוא בשורות החשבונית.');
      }
    }
    if (costInvoices.length === 0) {
      detail.push('עדיין אין חשבונית עלויות (הובלה/עמיל) מקושרת — נדרשת לפני סגירת התיק.');
    }
    push(
      2,
      'invoicesLinked',
      'קישור חשבוניות לתיק, הצהרת יבוא וארץ מוצא לכל שורה',
      'תיקי יבוא, שלב ב׳',
      'חשבוניות ספק מרכזות (PINVOICES) / חשבוניות לתיקי יבוא (IMPFILEIV)',
      state,
      detail,
    );
  }

  // 3 — invoices final
  {
    const temporary = facts.invoices.filter((iv) => !iv.isFinal).map((iv) => iv.ivnum);
    const state: OfficialState =
      facts.invoices.length === 0 || temporary.length > 0 ? 'missing' : 'done';
    push(
      3,
      'invoicesFinal',
      'סגירת החשבוניות (T ל-GI)',
      'הנחת עבודה ב-SOP: "קיימות חשבוניות"',
      'סגירת חשבונית (CLOSEANINVOICE)',
      state,
      temporary.length ? [`חשבוניות זמניות: ${temporary.join(', ')}.`] : [],
    );
  }

  // 4 — final receipt into the bonded warehouse
  {
    let state: OfficialState;
    const detail: string[] = [];
    if (facts.receipts === null) {
      state = 'unknown';
      detail.push('לא ניתן היה לקרוא את קבלות הסחורה.');
    } else if (
      facts.receipts.some((r) => r.status === FINAL_DOC_STATUS && r.warehouse === BONDED_WAREHOUSE)
    ) {
      state = 'done';
    } else {
      state = 'missing';
      const wrong = facts.receipts.filter(
        (r) => r.status !== CANCELLED_DOC_STATUS && r.warehouse !== BONDED_WAREHOUSE,
      );
      if (wrong.length) {
        detail.push(
          `קבלה למחסן אחר: ${wrong.map((r) => `${r.docno} (${r.warehouse})`).join(', ')}.`,
        );
      }
      const drafts = facts.receipts.filter(
        (r) => r.status === DRAFT_DOC_STATUS && r.warehouse === BONDED_WAREHOUSE,
      );
      if (drafts.length) detail.push(`קבלה בטיוטה: ${drafts.map((r) => r.docno).join(', ')}.`);
      if (!wrong.length && !drafts.length) {
        detail.push(
          'לא נמצאה קבלה למחסן הערובה שמקושרת לחשבונית הסחורה. קבלה שנרשמה מול שורות הזמנה, בלי מספר החשבונית בכותרת, אינה מזוהה כאן.',
        );
        // Goods that were already released from the bonded warehouse must have entered it; the
        // receipt exists but cannot be tied to the file from here.
        const released = (facts.releases ?? []).some((r) => r.status === FINAL_DOC_STATUS);
        if (released) state = 'unknown';
      }
    }
    push(
      4,
      'bondedReceipt',
      `קבלת הסחורה למחסן הערובה (${BONDED_WAREHOUSE})`,
      'מחסן ערובה, שלב ב׳',
      'קבלות סחורה מספק (DOCUMENTS_P)',
      state,
      detail,
    );
  }

  // 5 — detail of the goods in the file
  const contentParts = [...new Set(facts.content.map((c) => c.part))];
  {
    const invoiceParts = new Set(goods.flatMap((iv) => iv.lines).map((l) => l.part));
    const detail: string[] = [];
    let state: OfficialState = facts.content.length > 0 ? 'done' : 'missing';
    if (state === 'done') {
      const notInContent = [...invoiceParts].filter(
        (p) => p !== VAT_DECLARATION_PART && !contentParts.includes(p),
      );
      if (notInContent.length) {
        detail.push(`מק"טים בחשבונית הסחורה שאינם בתכולה: ${notInContent.join(', ')}.`);
      }
    } else {
      detail.push('תכולת התיק ריקה.');
    }
    if ((facts.contentVatLineQty ?? 0) !== 0) {
      state = 'missing';
      detail.push(
        `בתכולה יש שורת ${VAT_DECLARATION_PART} בכמות ${facts.contentVatLineQty} — היא אינה מוצר ויש למחוק אותה (bonded_fill_detail) לפני חישוב ההעמסה.`,
      );
    }
    push(
      5,
      'detailFilled',
      'פירוט המוצרים בתיק',
      'מחסן ערובה, שלב ג׳ 1–4',
      'מילוי פירוט למחסן ערובה (FILL_IMPFILES) ← תכולה במחסני ערובה',
      state,
      detail,
    );
  }

  // 6 — loading calculation (evidence only: the customs estimate covers the content)
  {
    const covered = contentParts.filter((p) => facts.customsEstimateParts.includes(p)).length;
    const noCountry = facts.customsEstimateWithoutCountry ?? 0;
    const fullyCovered = contentParts.length > 0 && covered === contentParts.length;
    const state: OfficialState = fullyCovered && noCountry === 0 ? 'done' : 'missing';
    push(
      6,
      'loadingCalc',
      'חישוב העמסה (בדיקה לפני סגירה)',
      'תיקי יבוא, שלבים ג׳, ד׳, ה׳',
      'חישוב העמסה (IMPFILE2)',
      state,
      [
        ...(fullyCovered ? [] : [`אומדן המכס מכסה ${covered}/${contentParts.length} מק"טים.`]),
        ...(noCountry > 0 ? [`${noCountry} שורות באומדן המכס בלי ארץ מוצא.`] : []),
        'אין בפריוריטי שדה שמוכיח שהחישוב רץ אחרי השינוי האחרון — מריצים שוב לפני הסגירה.',
      ],
    );
  }

  // 7 — file closed
  push(
    7,
    'fileClosed',
    'סגירת התיק',
    'תיקי יבוא, שלב ה׳; מחסן ערובה, שלב ג׳ 5',
    'סגירת התיק (IMPFILE1)',
    facts.closed ? 'done' : 'missing',
    facts.closed || costInvoices.length > 0
      ? []
      : ['אין חשבונית עלויות מקושרת — סגירה עכשיו תשאיר את התיק בלי עלויות נלוות.'],
  );

  // 8–10 — release
  const zeroCostIsValid = costInvoices.length === 0;
  const costed = (l: ReleaseLineFact) => lineIsCosted(l, zeroCostIsValid);
  const releases = facts.releases;
  const unreleased = facts.content.filter((c) => c.balance > 0);
  if (releases === null) {
    for (const [n, key, title, sop, program] of [
      [8, 'releaseOpened', 'תעודת שחרור ממחסן הערובה', 'מחסן ערובה, שלב ד׳ 1–12', 'DOCUMENTS_J'],
      [9, 'lineCosts', 'רישום עלויות יבוא לשורה', 'מחסן ערובה, שלב ד׳ 13–14', 'IMPORTCOSTPERLINE'],
      [10, 'releaseFinal', 'תעודת השחרור סופית', 'מחסן ערובה, שלב ד׳ 15', 'DOCUMENTS_J'],
    ] as const) {
      push(n, key, title, sop, program, 'unknown', ['לא ניתן היה לקרוא את תעודות השחרור.']);
    }
  } else {
    const live = liveReleases(releases);
    const finals = finalReleases(releases);
    const drafts = live.filter((r) => r.status !== FINAL_DOC_STATUS);
    push(
      8,
      'releaseOpened',
      'תעודת שחרור ממחסן הערובה',
      'מחסן ערובה, שלב ד׳ 1–12',
      'קבלות סחורה ממחסן ערובה (DOCUMENTS_J)',
      live.length > 0 ? 'done' : 'missing',
      [
        ...live
          .filter((r) => !r.declaration)
          .map((r) => `בתעודה ${r.docno} חסר מספר רשומון (הצהרת יבוא).`),
        ...(drafts.length ? [`בטיוטה: ${drafts.map((r) => r.docno).join(', ')}.`] : []),
      ],
    );

    const uncosted = live
      .map((r) => ({ docno: r.docno, n: r.lines.filter((l) => !costed(l)).length }))
      .filter((r) => r.n > 0);
    const emptyDocs = live.filter((r) => r.lines.length === 0).map((r) => r.docno);
    let costState: OfficialState = 'done';
    if (live.length === 0 || live.every((r) => r.lines.length === 0)) costState = 'missing';
    else if (uncosted.length > 0) costState = 'missing';
    push(
      9,
      'lineCosts',
      'רישום עלויות יבוא לשורה',
      'מחסן ערובה, שלב ד׳ 13–14 (לפני שהתעודה סופית; התיק חייב להיות סגור)',
      'רישום עלויות יבוא לשורה (IMPORTCOSTPERLINE) ← עלויות יבוא לשורה',
      costState,
      [
        ...uncosted.map((r) => `בתעודה ${r.docno}: ${r.n} שורות בלי עלויות יבוא.`),
        ...(emptyDocs.length ? [`תעודות בלי שורות: ${emptyDocs.join(', ')}.`] : []),
      ],
    );

    let finalState: OfficialState;
    const finalDetail: string[] = [];
    if (finals.length === 0) finalState = 'missing';
    else if (unreleased.length > 0 || drafts.length > 0) {
      finalState = 'partial';
      if (unreleased.length) {
        finalDetail.push(
          `נשארה יתרה בערובה: ${unreleased.map((c) => `${c.part}×${c.balance}`).join(', ')}.`,
        );
      }
      if (drafts.length) {
        finalDetail.push(`תעודות שחרור בטיוטה: ${drafts.map((r) => r.docno).join(', ')}.`);
      }
    } else finalState = 'done';
    push(
      10,
      'releaseFinal',
      'תעודת השחרור סופית (כל הסחורה שוחררה)',
      'מחסן ערובה, שלב ד׳ 15',
      'קבלות סחורה ממחסן ערובה (DOCUMENTS_J) — סטטוס סופית',
      finalState,
      finalDetail,
    );

    if (live.length > 0 && !facts.closed) {
      violations.push(
        `קיימת תעודת שחרור (${live.map((r) => r.docno).join(', ')}) והתיק אינו סגור — לפי ה-SOP התיק נסגר לפני השחרור.`,
      );
    }
    const finalUncosted = finals.filter((r) => r.lines.some((l) => !costed(l)));
    if (finalUncosted.length) {
      violations.push(
        `תעודת שחרור סופית בלי עלויות יבוא בכל השורות (${finalUncosted.map((r) => r.docno).join(', ')}) — המלאי נכנס בלי העלויות הנלוות.`,
      );
    }
  }
  if (facts.closed) {
    const temporary = facts.invoices.filter((iv) => !iv.isFinal).map((iv) => iv.ivnum);
    if (temporary.length) {
      violations.push(`התיק סגור אך יש בו חשבונית זמנית (${temporary.join(', ')}).`);
    }
  }

  // 11 — costing after the last change
  {
    const finals = releases ? finalReleases(releases) : [];
    const lastChange = maxTime(
      finals.flatMap((r) => [r.updatedAt, ...r.lines.map((l) => l.costRegisteredAt)]),
    );
    let state: OfficialState;
    const detail: string[] = [];
    if (releases === null || facts.lastCostingAt === undefined) {
      state = 'unknown';
      detail.push('לא ניתן היה לקרוא את השחרורים או את יומן התמחיר.');
    } else if (finals.length === 0) {
      state = 'missing';
      detail.push('אין עדיין שחרור סופי — התמחיר אינו מתחשב בסחורה שבערובה.');
    } else if (facts.lastCostingAt === null) {
      state = 'missing';
      detail.push('ביומן התמחיר אין אף ריצה.');
    } else if (costingVsChange(facts.lastCostingAt, lastChange) === 'after') {
      state = 'done';
      detail.push(`תמחיר אחרון: ${facts.lastCostingAt}.`);
    } else if (costingVsChange(facts.lastCostingAt, lastChange) === 'same-minute') {
      state = 'unknown';
      detail.push(
        `התמחיר האחרון והשינוי האחרון בשחרור נרשמו באותה דקה (${facts.lastCostingAt}) — לא ניתן להכריע מי קדם. הרצה נוספת של התמחיר מסירה את הספק.`,
      );
    } else {
      state = 'missing';
      detail.push(
        `התמחיר האחרון (${facts.lastCostingAt}) קדם לשינוי האחרון בשחרור (${lastChange ?? '?'}).`,
      );
    }
    push(
      11,
      'costing',
      'תמחיר',
      'תיקי יבוא, הערות ותוצאות',
      'תמחיר לתאריך נוכחי (FNCCOSTINGPART) — רץ על כל המק"טים בחברה',
      state,
      detail,
    );
  }

  // 12 — landed cost per product, reconciled
  {
    const rec = reconcileImportCosts(facts);
    const prior = steps
      .slice(0, 11)
      .every((s) => s.state === 'done' || (facts.closed && s.n >= 2 && s.n <= 6));
    let state: OfficialState;
    if (rec.status === 'unknown') state = 'unknown';
    else if (prior && (rec.status === 'ties' || rec.status === 'ties-within-rounding'))
      state = 'done';
    else if (prior && rec.status === 'not-comparable') state = 'unknown';
    else state = 'missing';
    push(
      12,
      'landedCost',
      'עלות מועמסת לכל מוצר',
      'תיקי יבוא, תוצאות',
      'עלויות יבוא לשורה; כרטיס פריט — תנועות אחרונות, עלות ות. תמחיר (דוח: impfile_cost_report)',
      state,
      [
        ...(rec.status === 'differs'
          ? [
              `עלויות היבוא בשחרורים (${rec.importCostsOnReleases}) שונות מסך חשבוניות העלות (${rec.costInvoiceLinesTotal}); הפרש ${rec.difference}.`,
            ]
          : []),
        ...rec.notes,
      ],
    );
  }

  const beforeClose = (s: OfficialStep) => s.n >= 2 && s.n <= 6;
  const historical = facts.closed ? steps.filter((s) => beforeClose(s) && s.state !== 'done') : [];
  const current = steps.find((s) => s.state !== 'done' && !historical.includes(s));
  return {
    steps,
    currentStep: current ? current.n : null,
    nextAction: current
      ? nextActionFor(current)
      : historical.length
        ? 'אין צעד פתוח. בתיק הסגור נשארו פערים היסטוריים בשלבים שלפני הסגירה (historicalGaps).'
        : 'כל 12 השלבים הושלמו ואומתו.',
    historicalGaps: historical.map(
      (s) => `שלב ${s.n} — ${s.title}: ${s.detail.join(' ') || 'לא הוכח.'}`,
    ),
    violations,
  };
}

/**
 * Who performs each step. The reversible steps have an executing tool; the steps that cannot be
 * undone over the API (invoice close, receipt final, file close, release final, costing) stay
 * with the owner.
 */
const STEP_ACTOR: Record<number, string> = {
  2: 'מבצע: pinvoice_create / impfile_link_invoice לקישור חשבונית; pinvoice_set_declaration להצהרת היבוא בשורות, כשהחשבונית עוד טיוטה.',
  3: 'מבצע: אסף — סגירת החשבוניות (priority_close_invoice, באישורו לכל חשבונית).',
  4: 'מבצע: bonded_receipt (קבלה בטיוטה), ואחריו אסף משנה את סטטוס הקבלה לסופית.',
  5: 'מבצע: bonded_fill_detail.',
  6: 'מבצע: impfile_run_calc.',
  7: 'מבצע: אסף — "סגירת התיק" במסך תיקי יבוא (בדיקת מוכנות: impfile_close).',
  8: 'מבצע: bonded_release_draft (תעודת שחרור בטיוטה).',
  9: 'מבצע: bonded_line_costs (על התעודה, כשהיא עוד טיוטה).',
  10: 'מבצע: אסף — שינוי סטטוס תעודת השחרור לסופית, אחרי בדיקת העלויות לשורה.',
  11: 'מבצע: אסף — "תמחיר לתאריך נוכחי" (בדיקת מוכנות: impfile_costing_readiness).',
  12: 'דוח: impfile_cost_report.',
};

function nextActionFor(step: OfficialStep): string {
  const head = `שלב ${step.n} — ${step.title}: ${step.program}.`;
  const actor = STEP_ACTOR[step.n] ? ` ${STEP_ACTOR[step.n]}` : '';
  if (step.state === 'unknown') {
    return `${head} לא ניתן לאמת כרגע: ${step.detail.join(' ')}${actor}`;
  }
  return `${step.detail.length ? `${head} ${step.detail.join(' ')}` : head}${actor}`;
}

// -------------------------------------------------------------- cost report

export interface PartCostFact {
  part: string;
  /** "עלות" on the product card */
  itemCost: number | null;
  /** "ת. תמחיר" on the product card */
  costingDate: string | null;
  /** cost of the stock movements of this part, by document number */
  movementCostByDoc: Record<string, number>;
}

export interface CostReportLine {
  part: string;
  qty: number;
  goodsILS: number | null;
  customsILS: number | null;
  additionalILS: number | null;
  importILS: number | null;
  totalILS: number | null;
  /** total ÷ quantity, 4 decimals */
  unitLandedILS: number | null;
  costRegisteredAt: string | null;
}

export interface CostReport {
  impfnum: string;
  closed: boolean;
  fullyReleased: boolean;
  releases: Array<{
    docno: string;
    status: string;
    date: string | null;
    declaration: string | null;
    lines: CostReportLine[];
  }>;
  byPart: Array<{
    part: string;
    description?: string;
    qty: number;
    goodsILS: number;
    importILS: number;
    totalILS: number;
    unitLandedILS: number | null;
    /** what Priority recorded as the cost of the stock entry, summed over the file's releases */
    movementCostILS: number | null;
    movementMatches: boolean | null;
    itemCostILS: number | null;
    costingDate: string | null;
  }>;
  reconciliation: CostReconciliation;
  costing: { lastRunAt: string | null | undefined; afterLastChange: boolean | null };
  warnings: string[];
}

const unit = (totalCents: number, qty: number): number | null =>
  qty > 0 ? Math.round((totalCents / 100 / qty) * 10000) / 10000 : null;

/**
 * Landed cost per product of one import file, from Priority's own figures only. Final releases
 * count; draft releases are listed with whatever is registered on them so far.
 */
export function buildCostReport(
  facts: FileFacts,
  partCosts: PartCostFact[] | null,
  stage: OfficialStage = computeOfficialSteps(facts),
): CostReport {
  const warnings: string[] = [...stage.violations];
  const releases = facts.releases ? liveReleases(facts.releases) : [];
  if (facts.releases === null) warnings.push('לא ניתן היה לקרוא את תעודות השחרור.');
  if (partCosts === null) warnings.push('לא ניתן היה לקרוא את כרטיסי הפריט (עלות ותנועות).');

  const reportReleases = releases.map((r) => ({
    docno: r.docno,
    status: r.status,
    date: r.date,
    declaration: r.declaration,
    lines: r.lines.map((l) => ({
      part: l.part,
      qty: l.qty,
      goodsILS: l.goodsILS,
      customsILS: l.customsILS,
      additionalILS: l.additionalILS,
      importILS: l.importILS,
      totalILS: l.totalILS,
      unitLandedILS: isNum(l.totalILS) ? unit(cents(l.totalILS), l.qty) : null,
      costRegisteredAt: l.costRegisteredAt,
    })),
  }));

  const finals = releases.filter((r) => r.status === FINAL_DOC_STATUS);
  const zeroCostIsValid = !facts.invoices.some((iv) => !iv.isGoods);
  const agg = new Map<
    string,
    {
      qty: number;
      goods: number;
      imp: number;
      total: number;
      complete: boolean;
      docs: Set<string>;
      description?: string;
    }
  >();
  for (const r of finals) {
    for (const l of r.lines) {
      const a = agg.get(l.part) ?? {
        qty: 0,
        goods: 0,
        imp: 0,
        total: 0,
        complete: true,
        docs: new Set<string>(),
      };
      a.qty += l.qty;
      a.goods += cents(l.goodsILS);
      a.imp += cents(l.importILS) + cents(l.customsILS) + cents(l.additionalILS);
      a.total += cents(l.totalILS);
      if (!lineIsCosted(l, zeroCostIsValid)) a.complete = false;
      if (l.description && !a.description) a.description = l.description;
      a.docs.add(r.docno);
      agg.set(l.part, a);
    }
  }
  const costByPart = new Map((partCosts ?? []).map((p) => [p.part, p]));
  const byPart = [...agg.entries()].map(([part, a]) => {
    const pc = costByPart.get(part);
    let movement: number | null = null;
    if (pc) {
      const found = [...a.docs].filter((d) => d in pc.movementCostByDoc);
      if (found.length === a.docs.size) {
        movement = fromCents(found.reduce((sum, d) => sum + cents(pc.movementCostByDoc[d]), 0));
      }
    }
    return {
      part,
      ...(a.description ? { description: a.description } : {}),
      qty: a.qty,
      goodsILS: fromCents(a.goods),
      importILS: fromCents(a.imp),
      totalILS: fromCents(a.total),
      unitLandedILS: a.complete ? unit(a.total, a.qty) : null,
      movementCostILS: movement,
      movementMatches: movement === null ? null : cents(movement) === a.total,
      itemCostILS: pc?.itemCost ?? null,
      costingDate: pc?.costingDate ?? null,
    };
  });
  for (const p of byPart) {
    if (p.unitLandedILS === null) {
      warnings.push(`למק"ט ${p.part} יש שורת שחרור בלי עלויות יבוא — אין עלות מועמסת מלאה.`);
    }
    if (p.movementMatches === false) {
      warnings.push(
        `מק"ט ${p.part}: עלות תנועת הכניסה בפריוריטי (${p.movementCostILS}) שונה מסה"כ העלות בשורות השחרור (${p.totalILS}).`,
      );
    }
  }

  const costingStep = stage.steps.find((s) => s.key === 'costing');
  return {
    impfnum: facts.impfnum,
    closed: facts.closed,
    fullyReleased: finals.length > 0 && !facts.content.some((c) => c.balance > 0),
    releases: reportReleases,
    byPart,
    reconciliation: reconcileImportCosts(facts),
    costing: {
      lastRunAt: facts.lastCostingAt,
      afterLastChange:
        costingStep?.state === 'done' ? true : costingStep?.state === 'unknown' ? null : false,
    },
    warnings,
  };
}

// ------------------------------------------------- company-wide costing readiness

export interface ReleaseScanRow {
  docno: string;
  impfnum: string;
  status: string;
  updatedAt: string | null;
  lines: ReleaseLineFact[];
}

export interface CostingReadiness {
  /** true when nothing found would make a costing run record wrong costs */
  readyToRun: boolean;
  /** true when a final release or its costs changed after the last costing run */
  costingNeeded: boolean;
  lastCostingAt: string | null;
  blockers: string[];
  /** files whose releases changed after the last costing run */
  pendingFiles: string[];
  /** files whose last change falls in the same minute as the last costing run: order unknown */
  ambiguousFiles: string[];
  draftReleases: string[];
  scanned: { releases: number; complete: boolean };
}

/**
 * The costing program runs on every part in the company, so its precondition is company-wide:
 * no final release with a line that carries no import costs, and no final release on a file that
 * is not closed (the costing program only takes closed files into account).
 */
export function computeCostingReadiness(input: {
  releases: ReleaseScanRow[];
  scanComplete: boolean;
  closedByFile: Record<string, boolean>;
  lastCostingAt: string | null;
}): CostingReadiness {
  const blockers: string[] = [];
  const pending = new Set<string>();
  const ambiguous = new Set<string>();
  const drafts: string[] = [];
  for (const r of input.releases) {
    if (r.status === CANCELLED_DOC_STATUS) continue;
    if (r.status !== FINAL_DOC_STATUS) {
      drafts.push(`${r.docno} (${r.impfnum})`);
      continue;
    }
    const uncosted = r.lines.filter((l) => !lineIsCosted(l, true)).length;
    if (uncosted > 0) {
      blockers.push(
        `שחרור סופי ${r.docno} (תיק ${r.impfnum}): ${uncosted} שורות בלי עלויות יבוא — "רישום עלויות יבוא לשורה" לא רץ.`,
      );
    }
    const zero = r.lines.filter((l) => lineIsCosted(l, true) && !lineIsCosted(l)).length;
    if (zero > 0) {
      blockers.push(
        `שחרור סופי ${r.docno} (תיק ${r.impfnum}): ${zero} שורות עם עלויות יבוא 0 — לא ניתן להוכיח שהעלויות נרשמו; לבדוק ב-impfile_cost_report.`,
      );
    }
    if (input.closedByFile[r.impfnum] !== true) {
      blockers.push(
        `שחרור סופי ${r.docno} על תיק ${r.impfnum} שאינו סגור — התמחיר מתחשב רק בתיקים סגורים.`,
      );
    }
    const lastChange = maxTime([r.updatedAt, ...r.lines.map((l) => l.costRegisteredAt)]);
    const order = costingVsChange(input.lastCostingAt, lastChange);
    if (order === 'before') pending.add(r.impfnum);
    else if (order === 'same-minute') ambiguous.add(r.impfnum);
  }
  if (!input.scanComplete) {
    blockers.push('סריקת תעודות השחרור לא הושלמה — לא ניתן לאשר מוכנות לתמחיר.');
  }
  return {
    readyToRun: blockers.length === 0,
    costingNeeded: pending.size > 0,
    lastCostingAt: input.lastCostingAt,
    blockers,
    pendingFiles: [...pending].sort(),
    ambiguousFiles: [...ambiguous].filter((f) => !pending.has(f)).sort(),
    draftReleases: drafts,
    scanned: { releases: input.releases.length, complete: input.scanComplete },
  };
}
