import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { dateRange, dateRangeFilter } from '../lib/dates.js';
import { fetchAllPages } from '../lib/paginate.js';
import { textResult } from '../lib/write-guard.js';

/**
 * priority_product_sales_by_period
 *
 * Why this exists: on this installation the flat sales-line forms (SALESINVOICEITEMS,
 * ORDERITEMS) are NOT API-enabled ("לא ניתן להפעיל API למסך זה"), and OData here does NOT
 * support the `any()` collection operator — so you cannot filter invoices by the products on
 * their lines. The only way to get per-product quantities is to expand AINVOICEITEMS_SUBFORM
 * over a date range. A wide expand is heavy and the server times out ("terminated") past a few
 * dozen invoices, so this tool walks the range in adaptive windows: it starts at `windowDays`
 * and, on a timeout/5xx, halves the window and retries down to a single day. The aggregation
 * (half-month / month / week buckets per product) happens server-side, so one tool call replaces
 * dozens of manual chunked queries.
 *
 * Sources (deduplicated, no double counting):
 *  - AINVOICES (tax invoices, STATDES='סופית'), bucketed by IVDATE. Cancelled ('מבוטלת') and
 *    drafts ('טיוטא') are excluded by the status filter. Credit/return lines carry negative
 *    TQUANT and net correctly.
 *  - DOCUMENTS_D (delivery notes), bucketed by CURDATE, optional. A delivery line is added ONLY
 *    when its billed invoice (line.IVNUM) is NOT one of the AINVOICES we already counted — on
 *    this install delivery notes are billed via a separate SI invoice series that does not appear
 *    in AINVOICES, so those are genuine extra (export-channel) sales. Un-invoiced final delivery
 *    notes (IVNUM null) are counted and listed in `warnings` so you can spot superseded duplicates.
 */

const PROD_LINE_SELECT = 'PARTNAME,TQUANT,QPRICE';

/** Half-open day key 'YYYY-MM-DD' → bucket label. */
function bucketOf(isoDate: string, mode: 'half-month' | 'month' | 'week'): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  if (mode === 'month') return `${isoDate.slice(0, 7)}`;
  if (mode === 'half-month') return `${isoDate.slice(0, 7)}-${d <= 15 ? 'H1' : 'H2'}`;
  // week: ISO-ish week starting Monday, labelled by the Monday date.
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // 0 = Monday
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

/** OData string literal with embedded quotes doubled. */
function lit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** `PARTNAME eq 'A' or PARTNAME eq 'B' ...` over a field. */
function orEq(field: string, values: string[]): string {
  return values.map((v) => `${field} eq ${lit(v)}`).join(' or ');
}

/** Add days to a 'YYYY-MM-DD' and return 'YYYY-MM-DD'. */
function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** True for the transient server failures worth retrying with a smaller window. */
function isTransient(err: unknown): boolean {
  if (err instanceof PriorityError) return [408, 429, 500, 502, 503, 504].includes(err.statusCode);
  // The MCP/OData layer surfaces gateway timeouts as a generic "terminated" Error.
  return err instanceof Error && /terminat|timeout|socket|ECONNRESET/i.test(err.message);
}

type Line = { PARTNAME?: string; TQUANT?: number; QPRICE?: number; IVNUM?: string | null };
type InvRow = {
  IVNUM?: string;
  DEBIT?: string;
  IVTYPE?: string;
  IVDATE?: string;
  AINVOICEITEMS_SUBFORM?: Line[];
  [key: string]: unknown;
};
type DocRow = {
  DOCNO?: string;
  CURDATE?: string;
  STATDES?: string;
  IVALL?: string | null;
  TRANSORDER_D_SUBFORM?: Line[];
  [key: string]: unknown;
};

export function registerSalesReportTools(server: McpServer, client: PriorityClient) {
  server.tool(
    'priority_product_sales_by_period',
    `Quantity (or value) of one or more products sold, bucketed by period (half-month / month / week).

One call returns the full grid — it walks the date range in adaptive windows server-side and
aggregates, so you never have to chunk AINVOICES expands by hand. Includes tax invoices and
(optionally) delivery notes, de-duplicated. Cancelled and draft invoices are excluded; returns/
credits net automatically.`,
    {
      deadlineMs: z
        .number()
        .int()
        .min(1)
        .max(300000)
        .default(120000)
        .describe('Overall report work deadline, milliseconds'),
      products: z
        .array(z.string().min(1))
        .min(1)
        .describe('PARTNAME(s) to report on, e.g. ["PO0001","PO0002"]'),
      fromDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Start date YYYY-MM-DD (inclusive)'),
      toDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('End date YYYY-MM-DD (inclusive)'),
      bucket: z.enum(['half-month', 'month', 'week']).default('half-month'),
      metric: z
        .enum(['quantity', 'value'])
        .default('quantity')
        .describe('quantity = units (TQUANT); value = pre-VAT line amount (QPRICE)'),
      includeDeliveryNotes: z
        .boolean()
        .default(true)
        .describe('Add delivery-note (DOCUMENTS_D) lines not billed through AINVOICES'),
      windowDays: z
        .number()
        .int()
        .min(1)
        .max(120)
        .default(31)
        .describe('Initial date-window size for expansion; auto-halves on server timeout'),
    },
    async (params, extra) => {
      const reportAbort = new AbortController();
      const signal = extra?.signal;
      const abortReport = () => reportAbort.abort();
      signal?.addEventListener('abort', abortReport, { once: true });
      if (signal?.aborted) reportAbort.abort();
      const deadline = Date.now() + (params.deadlineMs ?? 120000);
      const deadlineTimer = setTimeout(abortReport, params.deadlineMs ?? 120000);
      try {
        dateRange(params.fromDate, params.toDate); // validate before any backend request
        const products = [...new Set(params.products)];
        const partFilter = orEq('PARTNAME', products);
        const lineExpand = `AINVOICEITEMS_SUBFORM($select=${PROD_LINE_SELECT};$filter=${partFilter})`;
        class ReportStopped extends Error {}
        const request = async <T>(run: (readSignal: AbortSignal) => Promise<T>): Promise<T> => {
          if (reportAbort.signal.aborted || Date.now() >= deadline)
            throw new ReportStopped(signal?.aborted ? 'cancelled' : 'deadline');
          let timer: ReturnType<typeof setTimeout> | undefined;
          let abort: (() => void) | undefined;
          try {
            return await Promise.race([
              run(reportAbort.signal),
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(new ReportStopped('deadline')),
                  Math.max(1, deadline - Date.now()),
                );
                abort = () => reject(new ReportStopped(signal?.aborted ? 'cancelled' : 'deadline'));
                reportAbort.signal.addEventListener('abort', abort, { once: true });
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
            if (abort) reportAbort.signal.removeEventListener('abort', abort);
          }
        };
        const metricOf = (l: Line) =>
          params.metric === 'value' ? Number(l.QPRICE ?? 0) : Number(l.TQUANT ?? 0);
        const grid: Record<string, Record<string, number>> = {};
        const addCell = (bkt: string, part: string, n: number) => {
          let row = grid[bkt];
          if (!row) {
            row = {};
            grid[bkt] = row;
          }
          row[part] = (row[part] ?? 0) + n;
        };
        const countedInvoices = new Set<string>();
        const countedInvoiceNumbers = new Set<string>();
        const warnings: string[] = [];
        const missingWindows: { source: string; from: string; to: string; reason: string }[] = [];
        const scans: {
          source: string;
          from: string;
          to: string;
          complete: boolean;
          stopReason: string;
          rows: number;
          pages: number;
          nextCursor?: unknown;
        }[] = [];
        let windowsQueried = 0;
        let stopped = false;
        let expandedLinesComplete = true;
        const gap = (source: string, from: string, to: string, reason: string) => {
          missingWindows.push({ source, from, to, reason });
        };
        const loadLines = async (row: InvRow | DocRow, field: string): Promise<Line[]> => {
          const lines = [...((row[field] as Line[] | undefined) ?? [])];
          let next = row[`${field}@odata.nextLink`] as string | undefined;
          const seen = new Set<string>();
          while (next) {
            if (seen.has(next) || lines.length >= 20000) {
              expandedLinesComplete = false;
              warnings.push(
                `Expanded ${field} lines incomplete: continuation loop or 20000-line cap.`,
              );
              break;
            }
            seen.add(next);
            const continuation = next;
            const page = await request((readSignal) =>
              client.listNext<Line>(continuation, { signal: readSignal }),
            );
            const remaining = 20000 - lines.length;
            lines.push(...page.value.slice(0, remaining));
            if (page.value.length > remaining) {
              expandedLinesComplete = false;
              warnings.push(`Expanded ${field} lines incomplete: 20000-line cap.`);
              break;
            }
            next = page['@odata.nextLink'];
          }
          return lines;
        };
        const fetchInvoiceWindow = async (
          from: string,
          to: string,
          span: number,
        ): Promise<void> => {
          if (stopped) {
            gap('AINVOICES', from, to, 'deadlineOrCancelled');
            return;
          }
          try {
            const filter = `${dateRangeFilter('IVDATE', from, to)} and STATDES eq ${lit('סופית')}`;
            const scan = await fetchAllPages<InvRow>(
              (skip, top) =>
                request((readSignal) =>
                  client.list(
                    'AINVOICES',
                    `?$select=IVNUM,DEBIT,IVTYPE,IVDATE&$filter=${encodeURIComponent(filter)}` +
                      `&$expand=${encodeURIComponent(lineExpand)}&$orderby=IVDATE,IVNUM,DEBIT,IVTYPE&$top=${top}&$skip=${skip}`,
                    { signal: readSignal },
                  ),
                ),
              {
                maxRows: 20000,
                fetchNext: (link) =>
                  request((readSignal) => client.listNext(link, { signal: readSignal })),
                signal: reportAbort.signal,
              },
            );
            // Finish nested reads before aggregation; splitting a failed window cannot double-count.
            const expanded: { inv: InvRow; lines: Line[] }[] = [];
            for (const inv of scan.rows)
              expanded.push({ inv, lines: await loadLines(inv, 'AINVOICEITEMS_SUBFORM') });
            windowsQueried++;
            scans.push({
              source: 'AINVOICES',
              from,
              to,
              complete: scan.complete,
              stopReason: scan.stopReason,
              rows: scan.rows.length,
              pages: scan.pages,
              nextCursor: scan.nextCursor,
            });
            if (!scan.complete) gap('AINVOICES', from, to, scan.stopReason);
            for (const { inv, lines } of expanded) {
              const key = JSON.stringify([inv.IVNUM, inv.DEBIT, inv.IVTYPE]);
              if (countedInvoices.has(key)) continue;
              countedInvoices.add(key);
              if (inv.IVNUM) countedInvoiceNumbers.add(inv.IVNUM);
              const date = inv.IVDATE?.slice(0, 10);
              if (!date) {
                gap('AINVOICES', from, to, 'missingInvoiceDate');
                continue;
              }
              const bkt = bucketOf(date, params.bucket);
              for (const l of lines)
                if (l.PARTNAME && products.includes(l.PARTNAME))
                  addCell(bkt, l.PARTNAME, metricOf(l));
            }
          } catch (err) {
            if (err instanceof ReportStopped || reportAbort.signal.aborted) {
              stopped = true;
              gap('AINVOICES', from, to, err instanceof Error ? err.message : 'cancelled');
              return;
            }
            if (!isTransient(err)) throw err;
            if (span > 1) {
              const half = Math.floor(span / 2);
              const mid = addDays(from, half);
              await fetchInvoiceWindow(from, addDays(mid, -1), half);
              await fetchInvoiceWindow(mid, to, span - half);
            } else gap('AINVOICES', from, to, 'transientReadFailure');
          }
        };
        for (let cur = params.fromDate; cur <= params.toDate; ) {
          if (stopped) {
            gap('AINVOICES', cur, params.toDate, 'deadlineOrCancelled');
            break;
          }
          const end = addDays(cur, params.windowDays - 1);
          const winEnd = end > params.toDate ? params.toDate : end;
          const span =
            (Date.parse(`${winEnd}T00:00:00Z`) - Date.parse(`${cur}T00:00:00Z`)) / 86400000 + 1;
          await fetchInvoiceWindow(cur, winEnd, span);
          cur = addDays(winEnd, 1);
        }
        let deliveryNotesAdded = 0;
        if (params.includeDeliveryNotes) {
          // Missing invoices make invoice-number deduplication unsafe; do not add potentially duplicated deliveries.
          if (stopped || missingWindows.length)
            gap('DOCUMENTS_D', params.fromDate, params.toDate, 'invoiceScanIncomplete');
          else
            try {
              const filter = dateRangeFilter('CURDATE', params.fromDate, params.toDate);
              const expand = `TRANSORDER_D_SUBFORM($select=${PROD_LINE_SELECT},IVNUM;$filter=${partFilter})`;
              const scan = await fetchAllPages<DocRow>(
                (skip, top) =>
                  request((readSignal) =>
                    client.list(
                      'DOCUMENTS_D',
                      `?$select=DOCNO,CURDATE,STATDES,IVALL&$filter=${encodeURIComponent(filter)}` +
                        `&$expand=${encodeURIComponent(expand)}&$orderby=CURDATE,DOCNO&$top=${top}&$skip=${skip}`,
                      { signal: readSignal },
                    ),
                  ),
                {
                  maxRows: 20000,
                  fetchNext: (link) =>
                    request((readSignal) => client.listNext(link, { signal: readSignal })),
                  signal: reportAbort.signal,
                },
              );
              windowsQueried++;
              scans.push({
                source: 'DOCUMENTS_D',
                from: params.fromDate,
                to: params.toDate,
                complete: scan.complete,
                stopReason: scan.stopReason,
                rows: scan.rows.length,
                pages: scan.pages,
                nextCursor: scan.nextCursor,
              });
              if (!scan.complete)
                gap('DOCUMENTS_D', params.fromDate, params.toDate, scan.stopReason);
              for (const doc of scan.rows) {
                if (doc.STATDES !== 'סופית') continue;
                const date = doc.CURDATE?.slice(0, 10);
                if (!date) {
                  gap('DOCUMENTS_D', params.fromDate, params.toDate, 'missingDocumentDate');
                  continue;
                }
                const bkt = bucketOf(date, params.bucket);
                for (const l of await loadLines(doc, 'TRANSORDER_D_SUBFORM')) {
                  if (
                    !l.PARTNAME ||
                    !products.includes(l.PARTNAME) ||
                    (l.IVNUM && countedInvoiceNumbers.has(l.IVNUM))
                  )
                    continue;
                  addCell(bkt, l.PARTNAME, metricOf(l));
                  deliveryNotesAdded++;
                }
                if (!doc.IVALL || doc.IVALL === 'N')
                  warnings.push(
                    `Delivery note ${doc.DOCNO} (${date}) is not yet invoiced; verify it is not a superseded duplicate.`,
                  );
              }
            } catch (err) {
              if (
                !(err instanceof ReportStopped) &&
                !isTransient(err) &&
                !reportAbort.signal.aborted
              )
                throw err;
              gap(
                'DOCUMENTS_D',
                params.fromDate,
                params.toDate,
                err instanceof Error ? err.message : 'readFailure',
              );
            }
        }
        // --- Shape the grid into sorted rows + column/grand totals. ---
        const periods = Object.keys(grid).sort();
        const rows = periods.map((p) => {
          const cells = Object.fromEntries(products.map((pn) => [pn, grid[p]?.[pn] ?? 0]));
          const total = products.reduce((s, pn) => s + (grid[p]?.[pn] ?? 0), 0);
          return { period: p, ...cells, total };
        });
        const columnTotals = Object.fromEntries(
          products.map((pn) => [pn, periods.reduce((s, p) => s + (grid[p]?.[pn] ?? 0), 0)]),
        );
        const grandTotal = Object.values(columnTotals).reduce((s, n) => s + n, 0);

        return textResult({
          products,
          range: { from: params.fromDate, to: params.toDate },
          bucket: params.bucket,
          metric: params.metric,
          rows,
          columnTotals,
          grandTotal,
          meta: {
            complete: missingWindows.length === 0 && expandedLinesComplete,
            missingWindows,
            scans,
            expandedLinesComplete,
            timezone:
              'Date-only ranges use UTC day boundaries. Period buckets use the calendar date returned by Priority (IVDATE/CURDATE prefix), preserving source business dates.',
            windowsQueried,
            deliveryNotesIncluded: params.includeDeliveryNotes,
            deliveryNoteLinesAdded: deliveryNotesAdded,
            invoicesCounted: countedInvoices.size,
            note: 'Tax invoices (STATDES=סופית) bucketed by IVDATE; delivery notes by CURDATE. Cancelled/draft excluded; returns net.',
          },
          warnings: [...new Set(warnings)],
        });
      } catch (err) {
        throw toMcpError(err);
      } finally {
        clearTimeout(deadlineTimer);
        signal?.removeEventListener('abort', abortReport);
        reportAbort.abort();
      }
    },
  );
}
