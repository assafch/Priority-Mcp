import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { dateFrom, dateTo } from '../lib/dates.js';
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True for the transient server failures worth retrying with a smaller window. */
function isTransient(err: unknown): boolean {
  if (err instanceof PriorityError) return err.statusCode >= 500 || err.statusCode === 429;
  // The MCP/OData layer surfaces gateway timeouts as a generic "terminated" Error.
  return err instanceof Error && /terminat|timeout|socket|ECONNRESET/i.test(err.message);
}

type Line = { PARTNAME?: string; TQUANT?: number; QPRICE?: number; IVNUM?: string | null };
type InvRow = { IVNUM?: string; IVDATE?: string; AINVOICEITEMS_SUBFORM?: Line[] };
type DocRow = {
  DOCNO?: string;
  CURDATE?: string;
  STATDES?: string;
  IVALL?: string | null;
  TRANSORDER_D_SUBFORM?: Line[];
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
    async (params) => {
      try {
        const { products } = params;
        const partFilter = orEq('PARTNAME', products);
        const lineExpand = `AINVOICEITEMS_SUBFORM($select=${PROD_LINE_SELECT};$filter=${partFilter})`;
        const metricOf = (l: Line) =>
          params.metric === 'value' ? Number(l.QPRICE ?? 0) : Number(l.TQUANT ?? 0);

        // grid[bucket][PARTNAME] = number
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
        const warnings: string[] = [];
        let windowsQueried = 0;

        // --- Adaptive-window fetch of AINVOICES (final only) with line expand. ---
        const fetchInvoiceWindow = async (
          from: string,
          to: string,
          span: number,
        ): Promise<void> => {
          const filter = `IVDATE ge ${dateFrom(from)} and IVDATE le ${dateTo(to)} and STATDES eq ${lit('סופית')}`;
          const query =
            `?$select=IVNUM,IVDATE&$filter=${encodeURIComponent(filter)}` +
            `&$expand=${encodeURIComponent(lineExpand)}`;
          // This installation throttles heavy expands: a wide window times out ("terminated"),
          // and after a failure it stays cold for a short cooldown. So retry the SAME window a
          // few times with growing backoff before shrinking — waiting often clears the cooldown
          // without losing the wider (fewer-request) window.
          for (let attempt = 0; ; attempt++) {
            try {
              const res = await client.list<InvRow>('AINVOICES', query);
              windowsQueried++;
              for (const inv of res.value) {
                if (inv.IVNUM) countedInvoices.add(inv.IVNUM);
                const date = inv.IVDATE?.slice(0, 10);
                if (!date) continue;
                const bkt = bucketOf(date, params.bucket);
                for (const l of inv.AINVOICEITEMS_SUBFORM ?? []) {
                  if (l.PARTNAME && products.includes(l.PARTNAME))
                    addCell(bkt, l.PARTNAME, metricOf(l));
                }
              }
              return;
            } catch (err) {
              if (!isTransient(err)) throw err;
              // This install's expand throttle has a ~minute-scale cooldown, so back off long
              // enough to let it clear before shrinking the (cheaper, fewer-request) window.
              const BACKOFF_MS = [8_000, 30_000, 75_000];
              if (attempt < BACKOFF_MS.length) {
                await sleep(BACKOFF_MS[attempt] ?? 75_000);
                continue;
              }
              if (span > 1) {
                // Still failing after backoff: split and retry each half (down to one day).
                const mid = addDays(from, Math.floor(span / 2));
                await fetchInvoiceWindow(from, addDays(mid, -1), Math.floor(span / 2));
                await fetchInvoiceWindow(mid, to, span - Math.floor(span / 2));
                return;
              }
              // Single day still failing after full backoff: record the gap and keep the rest of
              // the report rather than discarding everything to one stubbornly-throttled day.
              warnings.push(
                `Could not fetch invoices for ${from} after retries (server throttled) — that day is missing from the totals.`,
              );
              return;
            }
          }
        };

        // Walk [fromDate, toDate] in windowDays-sized spans.
        for (let cur = params.fromDate; cur <= params.toDate; ) {
          const end = addDays(cur, params.windowDays - 1);
          const winEnd = end > params.toDate ? params.toDate : end;
          const span =
            (Date.parse(`${winEnd}T00:00:00Z`) - Date.parse(`${cur}T00:00:00Z`)) / 86_400_000 + 1;
          await fetchInvoiceWindow(cur, winEnd, span);
          cur = addDays(winEnd, 1);
        }

        // --- Delivery notes (optional). Few per period; one pass over the range. ---
        let deliveryNotesAdded = 0;
        if (params.includeDeliveryNotes) {
          const dFilter = `CURDATE ge ${dateFrom(params.fromDate)} and CURDATE le ${dateTo(params.toDate)}`;
          const dExpand = `TRANSORDER_D_SUBFORM($select=${PROD_LINE_SELECT},IVNUM;$filter=${partFilter})`;
          const dQuery =
            `?$select=DOCNO,CURDATE,STATDES,IVALL&$filter=${encodeURIComponent(dFilter)}` +
            `&$expand=${encodeURIComponent(dExpand)}`;
          const dRes = await client.list<DocRow>('DOCUMENTS_D', dQuery);
          windowsQueried++;
          for (const doc of dRes.value) {
            // Count ONLY final delivery notes (matches the invoice pass and this tool's contract).
            // This excludes cancelled ('מבוטלת') AND drafts ('טיוטא') — the draft overcount bug.
            if (doc.STATDES !== 'סופית') continue;
            const date = doc.CURDATE?.slice(0, 10);
            if (!date) continue;
            const bkt = bucketOf(date, params.bucket);
            const unInvoiced = !doc.IVALL || doc.IVALL === 'N';
            for (const l of doc.TRANSORDER_D_SUBFORM ?? []) {
              if (!l.PARTNAME || !products.includes(l.PARTNAME)) continue;
              // Skip lines already billed into an AINVOICES we counted (avoid double count).
              if (l.IVNUM && countedInvoices.has(l.IVNUM)) continue;
              addCell(bkt, l.PARTNAME, metricOf(l));
              deliveryNotesAdded++;
            }
            if (unInvoiced) {
              warnings.push(
                `Delivery note ${doc.DOCNO} (${date}) is not yet invoiced (IVALL=${doc.IVALL ?? 'null'}) — counted, but verify it is not a superseded duplicate.`,
              );
            }
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
      }
    },
  );
}
