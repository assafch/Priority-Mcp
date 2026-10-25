import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import { type ImpfileSnapshot, classifyInvoices } from '../lib/impfiles-logic.js';

/**
 * The seven load-bearing sub-forms of an import file, mapped to friendly snapshot keys.
 * Line-level linked costs/items do NOT appear inside the invoices sub-form, so impfile_get
 * MUST expand all of these to give a complete picture (mapping doc §2).
 */
export const IMPFILE_SUBFORMS: ReadonlyArray<{ subform: string; key: string }> = [
  { subform: 'IMPFILEINV_SUBFORM', key: 'invoices' },
  { subform: 'MANIVDUTIES_SUBFORM', key: 'manualCostAllocations' },
  { subform: 'MANIVPARTS2_SUBFORM', key: 'extraProductLines' },
  { subform: 'EXPIVDUTIES_SUBFORM', key: 'expectedCosts' },
  { subform: 'IMPFILECUSTOMS_SUBFORM', key: 'customsEstimate' },
  { subform: 'IMPFILEITEMS_SUBFORM', key: 'goodsContent' },
  { subform: 'IMPFILEPORDI_SUBFORM', key: 'linkedPoLines' },
];

type Row = Record<string, unknown>;

/** Sum a numeric field across rows, bucketed by a currency field. */
function sumByCurrency(
  rows: Row[],
  amountField: string,
  codeField = 'CODE',
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const r of rows) {
    const amt = Number(r[amountField]);
    if (!Number.isFinite(amt)) continue;
    const code = String(r[codeField] ?? '?');
    totals[code] = (totals[code] ?? 0) + amt;
  }
  return totals;
}

/**
 * Build a normalized, decision-ready snapshot from a raw IMPFILES record whose sub-forms were
 * expanded. Splits header from sub-forms, renames sub-forms to friendly keys, and adds a `derived`
 * summary (per-currency invoice totals, goods-vs-cost invoice split, customs-estimate flags).
 */
export function normalizeSnapshot(
  record: Row,
  options: { strict?: boolean } = {},
): ImpfileSnapshot {
  const header: Row = {};
  const sections: Row = {};
  const bySubform = new Map(IMPFILE_SUBFORMS.map((s) => [s.subform, s.key]));

  for (const [k, v] of Object.entries(record)) {
    const friendly = bySubform.get(k);
    if (friendly) {
      sections[friendly] = Array.isArray(v) ? v : [];
    } else if (!k.endsWith('_SUBFORM')) {
      header[k] = v;
    }
    // Unmapped *_SUBFORM keys (notes, attachments, versions…) are intentionally dropped from
    // the snapshot to keep it focused; fetch them via priority_query if needed.
  }

  const invoices = (sections.invoices as Row[]) ?? [];
  // Goods invoices come from the file's own supplier; broker/forwarder invoices from others.
  // Shared with preflight / computeLandedCost so all three classify identically (and safely when
  // the header supplier is blank — an undefined supplier would otherwise bucket every invoice as cost).
  const { goods, cost, supplierKnown } = classifyInvoices(invoices, header.SUPNAME);
  const customs = (sections.customsEstimate as Row[]) ?? [];

  const derived = {
    invoiceCount: invoices.length,
    supplierKnown,
    goodsInvoices: supplierKnown ? goods.length : null,
    costInvoices: supplierKnown ? cost.length : null,
    invoiceTotalsByCurrency: sumByCurrency(invoices, 'TOTPRICE'),
    hasManualCostAllocations: ((sections.manualCostAllocations as Row[]) ?? []).length > 0,
    hasExpectedCosts: ((sections.expectedCosts as Row[]) ?? []).length > 0,
    goodsLineCount: ((sections.goodsContent as Row[]) ?? []).length,
    customsEstimate: {
      lineCount: customs.length,
      totalDuty: customs.reduce((s, c) => s + (Number(c.CUSTOMS) || 0), 0),
      partsWithoutCustomsItem: customs.filter((c) => !c.CUSTOMSITEMNAME).length,
    },
  };

  const knownNumber = (value: unknown) =>
    (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
    Number.isFinite(Number(value));
  const monetarySourcesKnown =
    invoices.every(
      (row) =>
        knownNumber(row.TOTPRICE) &&
        typeof row.CODE === 'string' &&
        row.CODE.trim() !== '' &&
        row.CODE !== '?',
    ) && customs.every((row) => knownNumber(row.CUSTOMS));
  const totalsFinite =
    Object.values(derived.invoiceTotalsByCurrency).every(Number.isFinite) &&
    Number.isFinite(derived.customsEstimate.totalDuty);
  return {
    header,
    ...sections,
    derived: options.strict && (!monetarySourcesKnown || !totalsFinite) ? null : derived,
  };
}

export interface ImportReadOptions {
  cache?: boolean;
  signal?: AbortSignal;
  subformTop?: number;
}
export async function loadImportRecord(
  client: PriorityClient,
  impfnum: string,
  options: ImportReadOptions = {},
): Promise<Row> {
  const qb = new ODataBuilder();
  if (options.subformTop === undefined || options.subformTop > 0)
    qb.expand(
      ...IMPFILE_SUBFORMS.map(({ subform }) =>
        options.subformTop === undefined ? subform : `${subform}($top=${options.subformTop})`,
      ),
    );
  return client.get<Row>('IMPFILES', impfnum, qb.build(), {
    cache: options.cache,
    signal: options.signal,
  });
}
export async function loadSnapshot(
  client: PriorityClient,
  impfnum: string,
  options: ImportReadOptions = {},
): Promise<ImpfileSnapshot> {
  return normalizeSnapshot(await loadImportRecord(client, impfnum, options));
}
