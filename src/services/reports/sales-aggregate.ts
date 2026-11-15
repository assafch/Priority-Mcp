export type SalesSource = 'AINVOICES' | 'DOCUMENTS_D';
export interface SalesLine {
  PARTNAME?: string;
  TQUANT?: number;
  QPRICE?: number;
  IVNUM?: string | null;
  [field: string]: unknown;
}
export interface SalesRecord {
  key: string;
  number?: string;
  date: string;
  lines: SalesLine[];
  uninvoiced?: boolean;
}
export interface SalesWindow {
  source: SalesSource;
  from: string;
  to: string;
}
export interface Contribution extends SalesWindow {
  complete: boolean;
  stopReason: string;
  records: SalesRecord[];
  pages: number;
  rows: number;
  observedAt: string | null;
  endedAt: string | null;
  scanStartedAt: string | null;
  expandedLinesComplete: boolean;
  warnings: string[];
}
export interface SalesParams {
  products: string[];
  fromDate: string;
  toDate: string;
  bucket: 'half-month' | 'month' | 'week';
  metric: 'quantity' | 'value';
  includeDeliveryNotes: boolean;
  windowDays: number;
}
export interface SalesState {
  kind: 'sales-report';
  params: SalesParams;
  contributions: Contribution[];
  rows: Record<string, string | number>[];
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  evidence?: ReturnType<typeof aggregateSales>['meta'];
  warnings?: string[];
}
export function bucketOf(iso: string, mode: SalesParams['bucket']): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (mode === 'month') return iso.slice(0, 7);
  if (mode === 'half-month') return `${iso.slice(0, 7)}-${d <= 15 ? 'H1' : 'H2'}`;
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}
export function aggregateSales(
  params: SalesParams,
  contributions: Contribution[],
  retained: SalesWindow[],
  recomputed: SalesWindow[],
) {
  const grid: Record<string, Record<string, number>> = {};
  const invoiceKeys = new Set<string>();
  const invoiceNumbers = new Set<string>();
  const documentKeys = new Set<string>();
  const warnings = contributions.flatMap((c) => c.warnings);
  let deliveryLines = 0;
  const invoicesComplete = contributions
    .filter((c) => c.source === 'AINVOICES')
    .every((c) => c.complete);
  const add = (record: SalesRecord, line: SalesLine) => {
    if (!line.PARTNAME || !params.products.includes(line.PARTNAME)) return;
    const bucket = bucketOf(record.date, params.bucket);
    if (!grid[bucket]) grid[bucket] = {};
    const row = grid[bucket];
    row[line.PARTNAME] =
      (row[line.PARTNAME] ?? 0) +
      Number(params.metric === 'value' ? (line.QPRICE ?? 0) : (line.TQUANT ?? 0));
  };
  for (const c of contributions.filter((c) => c.source === 'AINVOICES'))
    for (const record of c.records) {
      if (invoiceKeys.has(record.key)) continue;
      invoiceKeys.add(record.key);
      if (record.number) invoiceNumbers.add(record.number);
      for (const line of record.lines) add(record, line);
    }
  if (invoicesComplete)
    for (const c of contributions.filter((c) => c.source === 'DOCUMENTS_D'))
      for (const record of c.records) {
        if (documentKeys.has(record.key)) continue;
        documentKeys.add(record.key);
        for (const line of record.lines) {
          if (
            !line.PARTNAME ||
            !params.products.includes(line.PARTNAME) ||
            (line.IVNUM && invoiceNumbers.has(line.IVNUM))
          )
            continue;
          add(record, line);
          deliveryLines++;
        }
        if (record.uninvoiced)
          warnings.push(
            `Delivery note ${record.number ?? ''} (${record.date}) is not yet invoiced; verify it is not a superseded duplicate.`,
          );
      }
  const periods = Object.keys(grid).sort();
  const rows = periods.map((period) => ({
    period,
    ...Object.fromEntries(params.products.map((p) => [p, grid[period][p] ?? 0])),
    total: params.products.reduce((sum, p) => sum + (grid[period][p] ?? 0), 0),
  }));
  const columnTotals = Object.fromEntries(
    params.products.map((p) => [
      p,
      periods.reduce((sum, period) => sum + (grid[period][p] ?? 0), 0),
    ]),
  );
  const missingWindows = contributions
    .filter((c) => !c.complete)
    .map((c) => ({ source: c.source, from: c.from, to: c.to, reason: c.stopReason }));
  const observations = contributions
    .flatMap((c) => [c.observedAt, c.endedAt])
    .filter(Boolean)
    .sort();
  const complete = missingWindows.length === 0;
  return {
    products: params.products,
    range: { from: params.fromDate, to: params.toDate },
    bucket: params.bucket,
    metric: params.metric,
    rows,
    columnTotals,
    grandTotal: Object.values(columnTotals).reduce((a, b) => a + b, 0),
    meta: {
      complete,
      coverageComplete: complete,
      consistency: 'multi-observation' as const,
      snapshotConsistent: false as const,
      firstObservedAt: observations[0] ?? null,
      lastObservedAt: observations.at(-1) ?? null,
      retainedWindows: retained,
      recomputedWindows: recomputed,
      missingWindows,
      scans: contributions.map(({ records, warnings, ...c }) => c),
      expandedLinesComplete: contributions.every((c) => c.expandedLinesComplete),
      windowsQueried: contributions.filter((c) => c.pages > 0).length,
      deliveryNotesIncluded: params.includeDeliveryNotes,
      deliveryNoteLinesAdded: deliveryLines,
      invoicesCounted: invoiceKeys.size,
      timezone:
        'Date-only ranges use UTC day boundaries; buckets preserve the Priority source calendar date.',
      note: 'Coverage is best effort across multiple observations, not one database snapshot. Earlier retained windows may have changed since they were read.',
    },
    warnings: [...new Set(warnings)],
  };
}

/** Source coverage is retained independently from the currently displayed detail page. */
export function salesStateEvidence(state: SalesState) {
  const evidence = state.evidence ?? aggregateSales(state.params, state.contributions, [], []).meta;
  return { ...structuredClone(evidence), warnings: [...(state.warnings ?? [])] };
}
