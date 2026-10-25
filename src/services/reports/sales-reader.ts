import { PriorityError } from '../../client/errors.js';
import type { PriorityClient } from '../../client/priority-client.js';
import { dateRange, dateRangeFilter } from '../../lib/dates.js';
import { fetchAllPages } from '../../lib/paginate.js';
import { knowledgeFor } from '../../lib/schema-service.js';
import { withOperation } from '../../runtime/operation-context.js';
import type { OperationContext } from '../../runtime/types.js';
import {
  type Contribution,
  type SalesLine,
  type SalesParams,
  type SalesState,
  type SalesWindow,
  aggregateSales,
} from './sales-aggregate.js';
import { type WindowProgress, runWindows } from './window-runner.js';
export function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
export function salesWindows(params: SalesParams, source: SalesWindow['source']): SalesWindow[] {
  const result: SalesWindow[] = [];
  for (let from = params.fromDate; from <= params.toDate; ) {
    const to = [addDays(from, params.windowDays - 1), params.toDate].sort()[0];
    result.push({ source, from, to });
    from = addDays(to, 1);
  }
  return result;
}
const transient = (error: unknown) =>
  error instanceof PriorityError
    ? [408, 429, 500, 502, 503, 504].includes(error.statusCode)
    : error instanceof Error && /terminat|timeout|socket|ECONNRESET/i.test(error.message);
const key = (w: SalesWindow) => JSON.stringify([w.source, w.from, w.to]);
export async function runSalesReport(
  client: PriorityClient,
  params: SalesParams,
  options: {
    concurrency: number;
    ctx: OperationContext;
    previous?: SalesState;
    fullRefresh?: boolean;
    onProgress?: (progress: WindowProgress) => void | Promise<void>;
  },
) {
  dateRange(params.fromDate, params.toDate);
  const controller = new AbortController();
  const remaining = options.ctx.deadlineAt - Date.now();
  const timer = setTimeout(() => controller.abort(new Error('deadline')), Math.max(0, remaining));
  timer.unref?.();
  const ctx = { ...options.ctx, signal: AbortSignal.any([options.ctx.signal, controller.signal]) };
  const stopped = () => ctx.signal.aborted || Date.now() >= ctx.deadlineAt;
  const reason = () =>
    options.ctx.signal.aborted && Date.now() < ctx.deadlineAt ? 'cancelled' : 'deadline';
  const missing = (window: SalesWindow, why: string): Contribution => ({
    ...window,
    complete: false,
    stopReason: why,
    records: [],
    rows: 0,
    pages: 0,
    observedAt: null,
    endedAt: null,
    scanStartedAt: null,
    expandedLinesComplete: false,
    warnings: [],
  });
  const request = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (stopped()) throw new Error(reason());
    let abort: () => void = () => {};
    try {
      return await Promise.race([
        run(ctx.signal),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error(reason()));
          ctx.signal.addEventListener('abort', abort, { once: true });
          if (ctx.signal.aborted) abort();
        }),
      ]);
    } finally {
      ctx.signal.removeEventListener('abort', abort);
    }
  };
  const read = async (window: SalesWindow): Promise<Contribution[]> => {
    if (stopped()) return [missing(window, reason())];
    const contribution = missing(window, 'readFailure');
    try {
      const invoice = window.source === 'AINVOICES';
      const field = invoice ? 'AINVOICEITEMS_SUBFORM' : 'TRANSORDER_D_SUBFORM';
      const dateField = invoice ? 'IVDATE' : 'CURDATE';
      const filter = `${dateRangeFilter(dateField, window.from, window.to)}${invoice ? " and STATDES eq 'סופית'" : ''}`;
      const partFilter = params.products
        .map((p) => `PARTNAME eq '${p.replace(/'/g, "''")}'`)
        .join(' or ');
      const requiredParent = invoice ? ['IVNUM', 'DEBIT', 'IVTYPE'] : ['DOCNO'];
      const verifiedKeys = async (
        entity: string,
        required: string[] = [],
        parent?: string,
      ): Promise<string[]> => {
        try {
          // Use current authoritative parent and declared navigation metadata.
          const schemas = knowledgeFor(client).schemas;
          const schema = parent
            ? await schemas.getSubform(
                parent,
                entity,
                { purpose: 'write', allowFullScan: true },
                ctx,
              )
            : await schemas.get(entity, { purpose: 'write' }, ctx);
          const fields = new Set(schema.schema.fields.map((property) => property.name));
          const keys = [...new Set([...schema.schema.key, ...required])];
          return keys.length &&
            keys.every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && fields.has(name))
            ? keys
            : [];
        } catch {
          return [];
        }
      };
      const [parentKeys, lineKeys] = await Promise.all([
        verifiedKeys(window.source, requiredParent),
        verifiedKeys(field, [], window.source),
      ]);
      const projection = [
        ...new Set([...lineKeys, 'PARTNAME', 'TQUANT', 'QPRICE', ...(!invoice ? ['IVNUM'] : [])]),
      ];
      const expand = `${field}($select=${projection.join(',')};$filter=${partFilter}${lineKeys.length ? `;$orderby=${lineKeys.join(',')}` : ''})`;
      const sourceRead = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
        const value = await request((signal) => {
          if (!contribution.scanStartedAt) contribution.scanStartedAt = new Date().toISOString();
          return run(signal);
        });
        const at = new Date().toISOString();
        if (!contribution.observedAt) contribution.observedAt = at;
        contribution.endedAt = at;
        return value;
      };
      const invalid = (why: string) => {
        contribution.complete = false;
        contribution.expandedLinesComplete = false;
        contribution.stopReason = why;
      };
      const select = [
        ...new Set([
          ...(invoice
            ? ['IVNUM', 'DEBIT', 'IVTYPE', 'IVDATE', 'STATDES']
            : ['DOCNO', 'CURDATE', 'STATDES', 'IVALL']),
          ...parentKeys,
        ]),
      ].join(',');
      const order = [
        ...new Set([dateField, ...(parentKeys.length ? parentKeys : requiredParent)]),
      ].join(',');
      const scan = await fetchAllPages<Record<string, unknown>>(
        (skip, top) =>
          sourceRead((signal) =>
            client.list(
              window.source,
              `?$select=${select}&$filter=${encodeURIComponent(filter)}&$expand=${encodeURIComponent(expand)}&$orderby=${order}&$top=${top}&$skip=${skip}`,
              { signal, cache: false },
            ),
          ),
        {
          maxRows: 20000,
          signal: ctx.signal,
          deadlineAt: ctx.deadlineAt,
          fetchNext: (link) => sourceRead((signal) => client.listNext(link, { signal })),
        },
      );
      contribution.rows = scan.rows.length;
      contribution.pages = scan.pages;
      contribution.complete = scan.complete;
      contribution.expandedLinesComplete = scan.complete;
      contribution.stopReason = scan.stopReason;
      for (const row of scan.rows) {
        if (
          invoice ? row.STATDES !== undefined && row.STATDES !== 'סופית' : row.STATDES !== 'סופית'
        )
          continue;
        const validKey = (value: unknown) =>
          typeof value === 'string'
            ? value.length > 0
            : typeof value === 'number' && Number.isFinite(value);
        if (!parentKeys.length) {
          invalid('unverifiedParentIdentity');
          contribution.warnings.push(
            `Cannot establish full ${window.source} parent identities from current targeted metadata; those rows were not summed.`,
          );
          continue;
        }
        if (!parentKeys.every((name) => validKey(row[name]))) {
          invalid('missingParentIdentity');
          continue;
        }
        const parentIdentity = parentKeys.map((name) => row[name]);
        const date = String(row[dateField] ?? '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          invalid(invoice ? 'missingInvoiceDate' : 'missingDocumentDate');
          continue;
        }
        if (!Array.isArray(row[field])) {
          invalid('missingExpandedCollection');
          continue;
        }
        const initial = row[field] as SalesLine[];
        const lines = initial.slice(0, 20000);
        if (initial.length > 20000) {
          invalid('nestedIncomplete');
        }
        let next = row[`${field}@odata.nextLink`] as string | undefined;
        const seen = new Set<string>();
        while (next) {
          if (seen.has(next) || lines.length >= 20000) {
            invalid('nestedIncomplete');
            break;
          }
          seen.add(next);
          const link = next;
          const page = await sourceRead((signal) => client.listNext<SalesLine>(link, { signal }));
          if (!Array.isArray(page.value)) {
            invalid('missingExpandedCollection');
            break;
          }
          const room = 20000 - lines.length;
          lines.push(...page.value.slice(0, room));
          if (page.value.length > room) {
            invalid('nestedIncomplete');
            break;
          }
          next = page['@odata.nextLink'];
        }
        const identified = new Map<string, SalesLine>();
        if (lines.length && !lineKeys.length) {
          invalid('unverifiedLineIdentity');
          contribution.warnings.push(
            `Cannot establish full ${field} line identities from current declared navigation metadata; those rows were not summed.`,
          );
        } else
          for (const line of lines) {
            if (
              !line ||
              typeof line !== 'object' ||
              !lineKeys.every((name) => validKey(line[name]))
            ) {
              invalid('missingLineIdentity');
              continue;
            }
            if (typeof line.PARTNAME !== 'string' || !line.PARTNAME) {
              invalid('missingLineProduct');
              continue;
            }
            if (params.products.includes(line.PARTNAME)) {
              const selected = params.metric === 'quantity' ? 'TQUANT' : 'QPRICE';
              const value: unknown = line[selected];
              if (
                !(
                  (typeof value === 'number' ||
                    (typeof value === 'string' && value.trim().length > 0)) &&
                  Number.isFinite(Number(value))
                )
              ) {
                invalid('missingLineMeasure');
                continue;
              }
            }
            identified.set(
              JSON.stringify([...parentIdentity, ...lineKeys.map((name) => line[name])]),
              line,
            );
          }
        contribution.records.push({
          key: JSON.stringify(parentIdentity),
          number: String(invoice ? (row.IVNUM ?? '') : (row.DOCNO ?? '')),
          date,
          lines: [...identified.values()].filter(
            (line) => line.PARTNAME && params.products.includes(line.PARTNAME),
          ),
          ...(!invoice ? { uninvoiced: !row.IVALL || row.IVALL === 'N' } : {}),
        });
      }
      return [contribution];
    } catch (error) {
      contribution.expandedLinesComplete = false;
      if (stopped()) {
        contribution.complete = false;
        contribution.stopReason = reason();
        return [contribution];
      }
      if (!transient(error)) throw error;
      const span = (Date.parse(window.to) - Date.parse(window.from)) / 86400000 + 1;
      // Splitting changes the query/window; no report-layer retry repeats the failed query.
      if (span > 1) {
        const mid = addDays(window.from, Math.floor(span / 2));
        return [
          ...(await read({ ...window, to: addDays(mid, -1) })),
          ...(await read({ ...window, from: mid })),
        ];
      }
      contribution.complete = false;
      contribution.stopReason = 'transientReadFailure';
      return [contribution];
    }
  };
  try {
    return await withOperation(ctx, async () => {
      let completedBefore = 0;
      const old = !options.fullRefresh ? (options.previous?.contributions ?? []) : [];
      const retained: Contribution[] = [];
      const recomputed: SalesWindow[] = [];
      const contributions: Contribution[] = [];
      const select = (source: SalesWindow['source']) => {
        const prior = old
          .filter((c) => c.source === source)
          .sort((a, b) => a.from.localeCompare(b.from));
        if (!prior.length) return salesWindows(params, source);
        const last = prior.filter((c) => c.complete).at(-1);
        return prior.flatMap((c) => {
          if (c.complete && c !== last) {
            retained.push(c);
            return [];
          }
          return [{ source: c.source, from: c.from, to: c.to }];
        });
      };
      const execute = async (source: SalesWindow['source'], blocked = false) => {
        const windows = select(source);
        recomputed.push(...windows);
        if (blocked) {
          contributions.push(...windows.map((w) => missing(w, 'invoiceScanIncomplete')));
          return;
        }
        const base = completedBefore;
        const total =
          old.length ||
          salesWindows(params, 'AINVOICES').length * (params.includeDeliveryNotes ? 2 : 1);
        const result = await runWindows(
          windows,
          {
            concurrency: options.concurrency,
            ctx,
            onProgress: options.onProgress
              ? (progress) => options.onProgress?.({ completed: base + progress.completed, total })
              : undefined,
          },
          read,
        );
        completedBefore += result.results.length;
        contributions.push(
          ...result.results.flatMap((r) => r.value),
          ...result.missing.map((m) => missing(m.window, m.reason)),
        );
      };
      await execute('AINVOICES');
      const invoiceComplete = [...retained, ...contributions]
        .filter((c) => c.source === 'AINVOICES')
        .every((c) => c.complete);
      if (params.includeDeliveryNotes) await execute('DOCUMENTS_D', !invoiceComplete);
      contributions.push(...retained);
      contributions.sort((a, b) => key(a).localeCompare(key(b)));
      const result = aggregateSales(
        params,
        contributions,
        retained.map(({ source, from, to }) => ({ source, from, to })),
        recomputed,
      );
      const state: SalesState = {
        kind: 'sales-report',
        params,
        contributions,
        rows: result.rows,
        firstObservedAt: result.meta.firstObservedAt,
        lastObservedAt: result.meta.lastObservedAt,
        evidence: structuredClone(result.meta),
        warnings: [...result.warnings],
      };
      return { result, state };
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
