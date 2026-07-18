/**
 * Fetch EVERY row matching a query by walking $skip pages until a short page (fewer than
 * pageSize rows) signals the end of the result set — the same end-of-data convention the
 * other tools use (see priority_get_unpaid_invoices_for_customer). This exists because
 * PriorityClient.list() returns a single page: any tool that AGGREGATES over a result set
 * (sums, rankings) must page it itself or it silently computes over only the first page.
 *
 * Bounded by maxRows so an unbounded date range can't run away; `capped` reports whether the
 * cap was hit — i.e. some matching rows were NOT scanned, so any total derived from `rows` is
 * incomplete and the caller must say so.
 */
export interface PageScan<T> {
  rows: T[];
  /** Number of page requests issued (including the final short/empty probe). */
  pages: number;
  /** True when maxRows was reached before the result set was exhausted. */
  capped: boolean;
}

export async function fetchAllPages<T>(
  fetchPage: (skip: number, top: number) => Promise<T[]>,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<PageScan<T>> {
  const pageSize = opts.pageSize ?? 500;
  const maxRows = opts.maxRows ?? 10000;
  const rows: T[] = [];
  let skip = 0;
  let pages = 0;
  let capped = false;
  for (;;) {
    const page = await fetchPage(skip, pageSize);
    pages++;
    rows.push(...page);
    if (page.length < pageSize) break; // short page ⇒ result set exhausted
    if (rows.length >= maxRows) {
      capped = true;
      break;
    }
    skip += pageSize;
  }
  return { rows, pages, capped };
}
