/**
 * Pure business logic for the import-file (IMPFILES) tools — no Priority calls, fully unit-tested.
 * These builders turn structured chat input into the exact OData write bodies, encoding the
 * §3.1 recording rules from kb/impfiles_mapping.md so the logic never relies on chat-Claude's memory.
 */

/**
 * The system part that carries the import VAT from the customs declaration onto a broker invoice
 * (verified live 2026-07-18: PARTNAME="מע'מ", PARTDES="סכום המע'מ ברשומון של המכס", ASCII apostrophe).
 * Its amount adds to the invoice VAT bucket, not the pre-VAT sum (spec §3.1). Overridable per call.
 */
export const VAT_DECLARATION_PART = "מע'מ";

export interface InvoiceHeaderInput {
  supplier: string; // SUPNAME (goods supplier, or forwarder/broker)
  invoiceNumber: string; // BOOKNUM — the supplier's printed invoice number
  invoiceDate: string; // IVDATE (YYYY-MM-DD)
  currency: string; // CODE (foreign for goods, usually ILS for broker)
  impfnum: string; // IMPFNUM — links the invoice to the import file
  po?: string; // ORDNAME (goods invoices created from a PO)
}

export interface GoodsLine {
  part: string; // PARTNAME (purchased SKU)
  qty: number; // TQUANT
  price?: number; // PRICE (unit price; omit to take it from the order)
  /** A charge on the supplier's invoice that is NOT on the purchase order (carriage, pallets). */
  extra?: boolean;
  description?: string; // PDES for an extra line on a generic part
}

export interface CostLine {
  part: string; // PARTNAME of a cost part (e.g. AVI001 freight)
  amount: number; // PRICE (line amount, source currency)
  vat?: boolean; // VATFLAG='Y' when the cost is VAT-taxable
}

export interface DeclarationVat {
  amount: number; // import VAT amount from the declaration (posts to invoice VAT)
  declaration?: string; // CUSTOMSNUM (הצהרת יבוא) — one line per declaration
  declarationDate?: string; // CUSTOMSDATE
}

export interface DutyLine {
  part: string; // the C-loaded customs (מכס) part — company is duty-free today
  amount: number;
  declaration?: string;
  declarationDate?: string;
  vat?: boolean;
}

type WriteBody = Record<string, unknown>;

/** Header fields shared by goods and broker supplier invoices. DEBIT='D' (חיוב), OTYPE='P' (import). */
function buildHeader(h: InvoiceHeaderInput): WriteBody {
  const body: WriteBody = {
    SUPNAME: h.supplier,
    IVDATE: h.invoiceDate,
    BOOKNUM: h.invoiceNumber,
    CODE: h.currency,
    DEBIT: 'D',
    OTYPE: 'P',
    IMPFNUM: h.impfnum,
  };
  if (h.po) body.ORDNAME = h.po;
  return body;
}

/**
 * Goods (supplier) invoice: foreign supplier + currency, one line per purchased SKU. Price is taken
 * from the order when omitted (Priority resolves PRSOURCENAME='הזמנה'). Deep-inserts the lines.
 */
export function buildGoodsInvoiceBody(input: {
  header: InvoiceHeaderInput;
  lines: GoodsLine[];
}): WriteBody {
  const items = input.lines.map((l) => {
    const line: WriteBody = { PARTNAME: l.part, TQUANT: l.qty };
    if (l.price !== undefined) line.PRICE = l.price;
    return line;
  });
  return { ...buildHeader(input.header), PINVOICEITEMS_SUBFORM: items };
}

/**
 * Broker/forwarder invoice (§3.1): cost lines on dedicated cost parts, an optional C-loaded customs
 * (duty) line, and one VAT-from-declaration line per declaration on the `מע'מ` system part (VATFLAG=Y,
 * carrying CUSTOMSNUM/CUSTOMSDATE). Amounts stay in the source currency — Priority applies FX.
 */
export function buildBrokerInvoiceBody(input: {
  header: InvoiceHeaderInput;
  costLines?: CostLine[];
  customsDuty?: DutyLine[];
  declarationVat?: DeclarationVat[];
  vatDeclarationPart?: string;
}): WriteBody {
  // `||` (not `??`) so a defined-but-empty override falls back to the default part instead of
  // emitting VAT lines on a blank PARTNAME (which Priority would reject / mis-post).
  const vatPart = input.vatDeclarationPart || VAT_DECLARATION_PART;
  const items: WriteBody[] = [];

  for (const c of input.costLines ?? []) {
    const line: WriteBody = { PARTNAME: c.part, TQUANT: 1, PRICE: c.amount };
    if (c.vat) line.VATFLAG = 'Y';
    items.push(line);
  }
  for (const d of input.customsDuty ?? []) {
    const line: WriteBody = { PARTNAME: d.part, TQUANT: 1, PRICE: d.amount };
    if (d.vat) line.VATFLAG = 'Y';
    if (d.declaration) line.CUSTOMSNUM = d.declaration;
    if (d.declarationDate) line.CUSTOMSDATE = d.declarationDate;
    items.push(line);
  }
  for (const v of input.declarationVat ?? []) {
    const line: WriteBody = { PARTNAME: vatPart, TQUANT: 1, PRICE: v.amount, VATFLAG: 'Y' };
    if (v.declaration) line.CUSTOMSNUM = v.declaration;
    if (v.declarationDate) line.CUSTOMSDATE = v.declarationDate;
    items.push(line);
  }

  return { ...buildHeader(input.header), PINVOICEITEMS_SUBFORM: items };
}

/** True when a broker invoice has at least one line to record. */
export function brokerHasLines(input: {
  costLines?: CostLine[];
  customsDuty?: DutyLine[];
  declarationVat?: DeclarationVat[];
}): boolean {
  return (
    (input.costLines?.length ?? 0) +
      (input.customsDuty?.length ?? 0) +
      (input.declarationVat?.length ?? 0) >
    0
  );
}

// --------------------------------------------------------------------- Slice 3

type Row = Record<string, unknown>;
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n: number): number => Math.round(n * 100) / 100;
/** Float-tolerant equality for summed quantities (kg/meters can sum to 9.9999999998 in binary float). */
const qtyEq = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

/**
 * Split a file's linked invoices into goods (from the file's own supplier) and cost (forwarder /
 * broker). Returns supplierKnown=false when the header SUPNAME is blank — callers must NOT classify
 * in that case, since an undefined supplier would otherwise bucket EVERY invoice as cost.
 */
export function classifyInvoices(
  invoices: Row[],
  supplier: unknown,
): { goods: Row[]; cost: Row[]; supplierKnown: boolean } {
  if (!supplier) return { goods: [], cost: [], supplierKnown: false };
  return {
    goods: invoices.filter((iv) => iv.SUPNAME === supplier),
    cost: invoices.filter((iv) => iv.SUPNAME !== supplier),
    supplierKnown: true,
  };
}

/** Sum a quantity field across rows, bucketed by part name. */
function qtyByPart(rows: Row[], qtyField: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const part = String(r.PARTNAME ?? '');
    if (!part) continue;
    m.set(part, (m.get(part) ?? 0) + num(r[qtyField]));
  }
  return m;
}

/**
 * Read-back summary of an import file's goods content (IMPFILEITEMS_SUBFORM): line count and the
 * total UNRELEASED quantity (Σ TBALANCE). Defensive against a non-array subform value (Priority may
 * serialize a single line as an object) — mirrors normalizeSnapshot's Array.isArray guard.
 */
export function goodsReadback(items: unknown): { goodsLines: number; unreleasedQty: number } {
  const rows: Row[] = Array.isArray(items) ? (items as Row[]) : [];
  return {
    goodsLines: rows.length,
    unreleasedQty: round2(rows.reduce((s, it) => s + num(it.TBALANCE), 0)),
  };
}

export interface MatchLine {
  part: string;
  description?: string;
  ordered: number;
  received: number;
  invoiced: number;
  balance: number; // ordered − received
  unitPrice?: number;
  currency?: string;
  verdict:
    | 'matched'
    | 'qty-gap'
    | 'ordered-not-arrived'
    | 'arrived-not-ordered'
    | 'received-not-invoiced'
    | 'invoiced-not-received';
}

/**
 * Three-way match (spec §1 tool 8) from a purchase order's three sub-forms — ordered
 * (PORDERITEMS), received (PORDERTRANS = קבלות סחורה מספק), invoiced (PORDERIV = חש. ספק מרכזות) —
 * joined by PARTNAME (quantities summed across duplicate lines). Balance = ordered − received.
 * unitPrice is the quantity-weighted average of the order lines for that part.
 */
export function matchThreeWay(
  orderItems: Row[],
  transItems: Row[],
  invItems: Row[],
): { lines: MatchLine[]; summary: { parts: number; matched: number; issues: number } } {
  const ordered = qtyByPart(orderItems, 'TQUANT');
  const received = qtyByPart(transItems, 'TQUANT');
  const invoiced = qtyByPart(invItems, 'TQUANT');

  // Aggregate order-line metadata per part: quantity-weighted unit price + first description/currency
  // (a part can span several order lines at different prices — the LAST line alone would misprice it).
  const meta = new Map<
    string,
    { valueSum: number; qtySum: number; description?: string; currency?: string }
  >();
  for (const r of orderItems) {
    const part = String(r.PARTNAME ?? '');
    if (!part) continue;
    const m = meta.get(part) ?? { valueSum: 0, qtySum: 0 };
    const q = num(r.TQUANT);
    if (r.PRICE !== undefined) m.valueSum += num(r.PRICE) * q;
    m.qtySum += q;
    if (m.description === undefined && r.PDES) m.description = String(r.PDES);
    if (m.currency === undefined && r.CODE) m.currency = String(r.CODE);
    meta.set(part, m);
  }

  const parts = new Set<string>([...ordered.keys(), ...received.keys(), ...invoiced.keys()]);
  const lines: MatchLine[] = [];
  for (const part of parts) {
    const o = ordered.get(part) ?? 0;
    const r = received.get(part) ?? 0;
    const i = invoiced.get(part) ?? 0;
    // qty-gap (ordered ≠ received) is checked BEFORE received-not-invoiced so a partial receipt
    // isn't mislabeled as "fully received, awaiting invoice". Float-tolerant to avoid false gaps.
    let verdict: MatchLine['verdict'];
    if (o === 0 && r === 0 && i > 0) verdict = 'invoiced-not-received';
    else if (o === 0 && r > 0) verdict = 'arrived-not-ordered';
    else if (o > 0 && r === 0) verdict = 'ordered-not-arrived';
    else if (!qtyEq(o, r)) verdict = 'qty-gap';
    else if (!qtyEq(r, i)) verdict = 'received-not-invoiced';
    else verdict = 'matched';
    const m = meta.get(part);
    lines.push({
      part,
      description: m?.description,
      ordered: round2(o),
      received: round2(r),
      invoiced: round2(i),
      balance: round2(o - r),
      unitPrice: m && m.qtySum > 0 && m.valueSum > 0 ? round2(m.valueSum / m.qtySum) : undefined,
      currency: m?.currency,
      verdict,
    });
  }
  lines.sort((a, b) => a.part.localeCompare(b.part));
  const matched = lines.filter((l) => l.verdict === 'matched').length;
  return { lines, summary: { parts: lines.length, matched, issues: lines.length - matched } };
}

export interface ImpfileSnapshot {
  header?: Row;
  invoices?: Row[];
  customsEstimate?: Row[];
  goodsContent?: Row[];
  extraProductLines?: Row[];
  manualCostAllocations?: Row[];
  [k: string]: unknown;
}

export interface PreflightResult {
  ok: boolean;
  blocking: string[];
  advisory: string[];
  info: string[];
}

/**
 * Pre-close diagnostics (spec §3.7). Blocking issues must be cleared (or explicitly overridden)
 * before impfile_close runs. Some checks are ADVISORY-only because the backing data is not API-
 * readable on this install (loading method per cost part; last-calc timestamp).
 */
export function preflight(snapshot: ImpfileSnapshot): PreflightResult {
  const blocking: string[] = [];
  const advisory: string[] = [];
  const info: string[] = [];
  const invoices = snapshot.invoices ?? [];
  const goods = snapshot.goodsContent ?? [];
  const extra = snapshot.extraProductLines ?? [];
  const customs = snapshot.customsEstimate ?? [];
  const supplier = snapshot.header?.SUPNAME;
  const { goods: goodsInvoices, supplierKnown } = classifyInvoices(invoices, supplier);

  // §3.7.2 — the file must have product content: goods rows, extra product lines, or a goods invoice.
  const hasProductContent = goods.length > 0 || extra.length > 0;
  if (!hasProductContent && !(supplierKnown && goodsInvoices.length > 0)) {
    if (!supplierKnown && invoices.length > 0) {
      // Can't tell goods from cost invoices without a header supplier — advise rather than block.
      advisory.push(
        'Cannot confirm a goods invoice — the file header supplier (SUPNAME) is blank; verify a product invoice is linked (§3.7.2).',
      );
    } else {
      blocking.push(
        'No product content / goods invoice linked — the file has only cost lines (§3.7.2).',
      );
    }
  }

  // §3.6 / §3.7.6 — unhandled credit or storno on a linked invoice (STORNOFLAG='Y', not merely truthy).
  const storno = invoices.filter((iv) => iv.STORNOFLAG === 'Y' || iv.DEBIT === 'C');
  if (storno.length) {
    blocking.push(
      `${storno.length} linked invoice(s) are credit/storno — resolve per §3.6 before closing.`,
    );
  }

  // §3.7.4 — country of origin present on each customs-estimate line.
  const noCountry = customs.filter((c) => !c.COUNTRYNAME).length;
  if (noCountry) {
    advisory.push(`${noCountry} customs-estimate line(s) have no country of origin (§3.7.4).`);
  }

  // §3.7.3 — weight-based loading needs item weights (flag partial coverage too, like §3.7.5).
  if (goods.length) {
    const noWeight = goods.filter((g) => !num(g.WEIGHT)).length;
    if (noWeight === goods.length) {
      advisory.push(
        'No item weights populated — weight-based loading would split evenly (§3.7.3).',
      );
    } else if (noWeight > 0) {
      advisory.push(
        `${noWeight} of ${goods.length} item(s) have no weight — weight-based loading would mis-split them (§3.7.3).`,
      );
    }
  }

  // §3.7.5 — customs item on each duty-liable part (this company is duty-free).
  if (customs.length) {
    const noItem = customs.filter((c) => !c.CUSTOMSITEMNAME).length;
    if (noItem === customs.length) {
      info.push('All parts are duty-free (no customs item) — expected for this company (§3.7.5).');
    } else if (noItem > 0) {
      advisory.push(
        `${noItem} of ${customs.length} customs lines have no customs item — verify they are duty-exempt (§3.7.5).`,
      );
    }
  }

  // §3.7.1 / §3.7.7 — not API-verifiable here → advisory.
  advisory.push(
    'Verify each cost part has a loading method (אופן העמסה) — the part financial-settings form is not API-exposed (§3.7.1).',
  );
  advisory.push(
    'Ensure the loading calculation (חישוב העמסה) was re-run after the last change before closing (§3.7.7).',
  );

  return { ok: blocking.length === 0, blocking, advisory, info };
}

export interface LandedCostLine {
  part: string;
  description?: string;
  qty: number;
  goodsValueILS: number;
  allocatedCostILS: number;
  landedCostILS: number;
  unitLandedCostILS: number;
}

/**
 * Self-computed landed-cost ESTIMATE (spec §3.5 fallback) when Priority's own calc result isn't
 * read back. Value-weighted: each part's ILS goods value (from the customs estimate) plus a pro-rata
 * share of the ancillary costs (pre-VAT DISPRICE of the cost invoices — the recoverable import VAT is
 * NOT a landed cost). NOTE: Priority's actual calc spreads each cost by that cost part's loading
 * method (weight/volume/duty%), which this value-weighted estimate cannot replicate.
 */
export function computeLandedCost(snapshot: ImpfileSnapshot): {
  basis: string;
  ancillaryCostsILS: number;
  totalGoodsValueILS: number;
  lines: LandedCostLine[];
  warnings: string[];
  note: string;
} {
  const customs = snapshot.customsEstimate ?? [];
  const goods = snapshot.goodsContent ?? [];
  const invoices = snapshot.invoices ?? [];
  const supplier = snapshot.header?.SUPNAME;
  const warnings: string[] = [];

  // Ancillary = pre-VAT DISPRICE of the COST invoices (import VAT excluded — recoverable). Guard the
  // blank-supplier case: without a header supplier we can't tell goods from cost invoices.
  const { cost, supplierKnown } = classifyInvoices(invoices, supplier);
  if (!supplierKnown && invoices.length > 0) {
    warnings.push(
      'File header supplier (SUPNAME) is blank — cannot separate goods from cost invoices; ancillary costs treated as 0.',
    );
  }
  const ancillary = cost.reduce((s, iv) => s + num(iv.DISPRICE), 0);

  // Aggregate the customs estimate BY PART — a part may span several lines (e.g. two origins).
  const qtys = qtyByPart(goods, 'TQUANT');
  const byPart = new Map<string, { value: number; description?: string }>();
  for (const c of customs) {
    const part = String(c.PARTNAME ?? '');
    if (!part) continue;
    const cur = byPart.get(part) ?? { value: 0 };
    cur.value += num(c.PRICE);
    if (cur.description === undefined && c.PARTDES) cur.description = String(c.PARTDES);
    byPart.set(part, cur);
  }
  const parts = [...byPart.entries()].map(([part, v]) => ({
    part,
    description: v.description,
    value: v.value,
    qty: qtys.get(part) ?? 0,
  }));

  // Prefer value-weighting; if the estimate isn't valued yet (all PRICE=0), fall back to quantity,
  // then to an even split — so ancillary costs are never silently dropped.
  const totalValue = parts.reduce((s, p) => s + p.value, 0);
  const totalQty = parts.reduce((s, p) => s + p.qty, 0);
  let basis: string;
  let weightOf: (p: { value: number; qty: number }) => number;
  let totalWeight: number;
  if (totalValue > 0) {
    basis = 'value-weighted (estimate)';
    weightOf = (p) => p.value;
    totalWeight = totalValue;
  } else if (totalQty > 0) {
    basis = 'quantity-weighted (customs estimate not yet valued)';
    weightOf = (p) => p.qty;
    totalWeight = totalQty;
    if (ancillary > 0) {
      warnings.push(
        'Customs estimate has no ILS values yet — ancillary costs spread by quantity instead of value (run the calc for the authoritative figure).',
      );
    }
  } else {
    basis = 'evenly split (no values or quantities)';
    weightOf = () => 1;
    totalWeight = parts.length || 1;
    if (ancillary > 0) {
      warnings.push(
        'Customs estimate has neither values nor quantities — ancillary costs split evenly.',
      );
    }
  }

  const lines: LandedCostLine[] = parts.map((p) => {
    const alloc = totalWeight > 0 ? (weightOf(p) / totalWeight) * ancillary : 0;
    const landed = p.value + alloc;
    return {
      part: p.part,
      description: p.description,
      qty: p.qty,
      goodsValueILS: round2(p.value),
      allocatedCostILS: round2(alloc),
      landedCostILS: round2(landed),
      unitLandedCostILS: p.qty > 0 ? round2(landed / p.qty) : 0,
    };
  });
  return {
    basis,
    ancillaryCostsILS: round2(ancillary),
    totalGoodsValueILS: round2(totalValue),
    lines,
    warnings,
    note: "Estimate only — Priority's calc spreads each cost by its part's loading method; the authoritative landed cost is the product cost after תמחיר. Import VAT is excluded (recoverable).",
  };
}

// ───────────────────────────────────────────── Goods invoice against a purchase order
//
// When ORDNAME is on a PINVOICES header, Priority copies the order's lines into the invoice by
// itself (PRSOURCENAME='הזמנה', line ORDNAME set). Sending the same lines in the POST therefore
// doubled them: a draft of 15.11.2026 ended with every line twice and twice the total, and an
// older final invoice carries a zero-quantity twin of the same kind. So the header is sent
// ALONE and the lines Priority pulled are then brought to the invoice: quantity/price corrected,
// order lines that are not on this invoice removed. Nothing here talks to Priority.

type Line = Record<string, unknown>;
/** Money totals: equal to the cent. Quantities and unit prices use the exact qtyEq instead. */
const close = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** Header-only body for a goods invoice against a PO — no lines (Priority pulls them). */
export function buildGoodsInvoiceHeader(header: InvoiceHeaderInput): WriteBody {
  return buildHeader(header);
}

export interface PlannedGoodsLine {
  part: string;
  qty: number;
  price: number;
  priceSource: 'invoice' | 'order';
  lineTotal: number;
  /** The order line this invoice line is linked to; null for a charge that is not on the order. */
  poLine: unknown;
  poOpenQuantity: number | null;
  notOnOrder?: true;
}

export interface GoodsPlan {
  ok: boolean;
  /** Reasons nothing may be sent. */
  problems: string[];
  warnings: string[];
  lines: PlannedGoodsLine[];
  expectedTotal: number;
  /** Open order lines Priority will pull that are NOT on this invoice (they get removed). */
  orderLinesNotOnInvoice: Array<{ poLine: unknown; part: unknown; openQuantity: number }>;
}

/**
 * Check the requested lines against the purchase order BEFORE anything is written, and work out
 * the invoice Priority should end with. A part that is not on the order, or sits on two order
 * lines, is a problem: the tool refuses instead of guessing which line is meant.
 */
export function planGoodsInvoice(input: {
  supplier: string;
  currency: string;
  po: string;
  order: Line | null | undefined;
  lines: GoodsLine[];
}): GoodsPlan {
  const problems: string[] = [];
  const warnings: string[] = [];
  const planned: PlannedGoodsLine[] = [];
  const order = input.order;
  if (!order) {
    return {
      ok: false,
      problems: [`Purchase order ${input.po} was not found.`],
      warnings,
      lines: [],
      expectedTotal: 0,
      orderLinesNotOnInvoice: [],
    };
  }
  if (order.SUPNAME !== undefined && String(order.SUPNAME) !== input.supplier)
    problems.push(
      `Purchase order ${input.po} belongs to supplier ${order.SUPNAME}, not ${input.supplier}.`,
    );
  if (order.CODE !== undefined && String(order.CODE) !== input.currency)
    warnings.push(`The order is in ${order.CODE}; the invoice was given as ${input.currency}.`);
  const orderLines = ((order.PORDERITEMS_SUBFORM as Line[] | undefined) ?? []).filter(
    (l) => l.CLOSEDBOOL !== 'Y',
  );
  const seen = new Set<string>();
  for (const line of input.lines) {
    if (seen.has(line.part)) {
      problems.push(
        `Part ${line.part} appears twice in goodsLines; send one line per part (sum the quantities).`,
      );
      continue;
    }
    seen.add(line.part);
    const matches = orderLines.filter((l) => l.PARTNAME === line.part);
    if (line.extra) {
      if (matches.length)
        problems.push(
          `Part ${line.part} was given in extraLines but it IS on purchase order ${input.po}; send it in goodsLines.`,
        );
      else if (line.price === undefined)
        problems.push(`Extra line ${line.part} needs a price (it has no order to take one from).`);
      else
        planned.push({
          part: line.part,
          qty: line.qty,
          price: line.price,
          priceSource: 'invoice',
          lineTotal: round2(line.qty * line.price),
          poLine: null,
          poOpenQuantity: null,
          notOnOrder: true,
        });
      continue;
    }
    if (matches.length === 0) {
      problems.push(
        `Part ${line.part} has no open line on purchase order ${input.po}. If it is a charge on the supplier's invoice that is not on the order (carriage, pallets…), send it in extraLines.`,
      );
      continue;
    }
    if (matches.length > 1) {
      problems.push(
        `Part ${line.part} is on ${matches.length} open lines of ${input.po} (lines ${matches
          .map((m) => m.KLINE)
          .join(', ')}); the tool will not guess which one this invoice covers.`,
      );
      continue;
    }
    const po = matches[0];
    const open = num(po.TBALANCE);
    const price = line.price ?? num(po.PRICE);
    if (line.qty > open + 1e-9)
      warnings.push(
        `Part ${line.part}: invoice quantity ${line.qty} is more than the order's open quantity ${open}.`,
      );
    if (line.price !== undefined && !qtyEq(line.price, num(po.PRICE)))
      warnings.push(
        `Part ${line.part}: invoice price ${line.price} differs from the order price ${num(po.PRICE)}.`,
      );
    planned.push({
      part: line.part,
      qty: line.qty,
      price,
      priceSource: line.price === undefined ? 'order' : 'invoice',
      lineTotal: round2(line.qty * price),
      poLine: po.KLINE,
      poOpenQuantity: open,
    });
  }
  const orderLinesNotOnInvoice = orderLines
    .filter((l) => !seen.has(String(l.PARTNAME)) && num(l.TBALANCE) > 0)
    .map((l) => ({ poLine: l.KLINE, part: l.PARTNAME, openQuantity: num(l.TBALANCE) }));
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    lines: planned,
    expectedTotal: round2(planned.reduce((s, l) => s + l.lineTotal, 0)),
    orderLinesNotOnInvoice,
  };
}

export type GoodsStep =
  | { op: 'PATCH'; kline: number; part: string; body: WriteBody }
  | { op: 'DELETE'; kline: number; part: string; reason: string }
  | { op: 'POST'; part: string; body: WriteBody };

/**
 * Compare the lines Priority actually put on the new draft with the invoice, and list the row
 * changes that bring the draft to the invoice. `problems` means the draft cannot be finished
 * automatically (a requested part was not pulled from the order, or was pulled twice).
 */
export function reconcileGoodsLines(input: {
  po: string;
  requested: GoodsLine[];
  actual: Line[];
}): { steps: GoodsStep[]; problems: string[] } {
  const steps: GoodsStep[] = [];
  const problems: string[] = [];
  const keep = new Set<unknown>();
  const adds: GoodsStep[] = [];
  for (const want of input.requested) {
    if (want.extra) {
      // Not on the order, so Priority pulled nothing for it: it is added as a manual line.
      const body: WriteBody = { PARTNAME: want.part, TQUANT: want.qty, PRICE: want.price };
      if (want.description) body.PDES = want.description;
      adds.push({ op: 'POST', part: want.part, body });
      continue;
    }
    const pulled = input.actual.filter((l) => l.PARTNAME === want.part && l.ORDNAME === input.po);
    if (pulled.length !== 1) {
      problems.push(
        pulled.length === 0
          ? `Priority did not pull a line for part ${want.part} from ${input.po}.`
          : `Priority pulled ${pulled.length} lines for part ${want.part} from ${input.po}.`,
      );
      for (const l of pulled) keep.add(l.KLINE);
      continue;
    }
    const line = pulled[0];
    keep.add(line.KLINE);
    const body: WriteBody = {};
    if (!qtyEq(num(line.TQUANT), want.qty)) body.TQUANT = want.qty;
    if (want.price !== undefined && !qtyEq(num(line.PRICE), want.price)) body.PRICE = want.price;
    if (Object.keys(body).length)
      steps.push({ op: 'PATCH', kline: num(line.KLINE), part: want.part, body });
  }
  for (const line of input.actual) {
    if (keep.has(line.KLINE)) continue;
    steps.push({
      op: 'DELETE',
      kline: num(line.KLINE),
      part: String(line.PARTNAME),
      reason:
        line.ORDNAME === input.po
          ? 'order line that is not on this invoice'
          : 'line not linked to the purchase order',
    });
  }
  // Corrections and removals first, on the lines read from the draft; new lines last.
  steps.push(...adds);
  return { steps, problems };
}

export interface GoodsInvoiceCheck {
  verified: boolean;
  expected: { lineCount: number; total: number };
  observed: { lineCount: number; total: number; headerTotal: number | null };
  mismatches: string[];
}

/**
 * The read-back check: exactly the invoice's lines, each goods line linked to the order (extra
 * charges are the only unlinked ones), quantities and prices as sent, and the header's pre-VAT
 * total equal to Σ quantity × price.
 */
export function checkGoodsInvoice(input: {
  po: string;
  requested: GoodsLine[];
  invoice: Line;
}): GoodsInvoiceCheck {
  const actual = (input.invoice.PINVOICEITEMS_SUBFORM as Line[] | undefined) ?? [];
  const mismatches: string[] = [];
  if (actual.length !== input.requested.length)
    mismatches.push(`The invoice has ${actual.length} lines; ${input.requested.length} were sent.`);
  let expectedTotal = 0;
  for (const want of input.requested) {
    const lines = actual.filter((l) => l.PARTNAME === want.part);
    if (lines.length !== 1) {
      mismatches.push(`Part ${want.part} is on ${lines.length} lines (expected 1).`);
      expectedTotal += round2(want.qty * (want.price ?? num(lines[0]?.PRICE)));
      continue;
    }
    const line = lines[0];
    const price = want.price ?? num(line.PRICE);
    expectedTotal += round2(want.qty * price);
    if (!qtyEq(num(line.TQUANT), want.qty))
      mismatches.push(`Part ${want.part}: quantity ${line.TQUANT}, sent ${want.qty}.`);
    if (!qtyEq(num(line.PRICE), price))
      mismatches.push(`Part ${want.part}: price ${line.PRICE}, sent ${price}.`);
    if (want.extra) {
      if (line.ORDNAME === input.po)
        mismatches.push(`Part ${want.part}: sent as not-on-order but the line is linked to it.`);
    } else if (line.ORDNAME !== input.po)
      mismatches.push(`Part ${want.part}: the line is not linked to order ${input.po}.`);
  }
  for (const line of actual)
    if (!input.requested.some((w) => w.part === line.PARTNAME))
      mismatches.push(`Line ${line.KLINE} (${line.PARTNAME}) is not on the invoice that was sent.`);
  const total = round2(expectedTotal);
  const observedTotal = round2(actual.reduce((s, l) => s + num(l.QPRICE), 0));
  const headerTotal =
    input.invoice.QPRICE === undefined || input.invoice.QPRICE === null
      ? null
      : round2(num(input.invoice.QPRICE));
  if (!close(observedTotal, total))
    mismatches.push(`The lines add up to ${observedTotal}; the invoice sent adds up to ${total}.`);
  if (headerTotal === null) mismatches.push('The header total (QPRICE) could not be read.');
  else if (!close(headerTotal, total))
    mismatches.push(`The header total is ${headerTotal}; the invoice sent adds up to ${total}.`);
  return {
    verified: mismatches.length === 0,
    expected: { lineCount: input.requested.length, total },
    observed: { lineCount: actual.length, total: observedTotal, headerTotal },
    mismatches,
  };
}
