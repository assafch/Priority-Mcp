/** An OData envelope retains server continuation even when a page is shorter than requested. */
export interface PageEnvelope<T> {
  value: T[];
  '@odata.nextLink'?: string;
  nextLink?: string;
}
export interface PageScan<T> {
  rows: T[];
  pages: number;
  capped: boolean;
  complete: boolean;
  stopReason:
    | 'exhausted'
    | 'maxRows'
    | 'continuationUnavailable'
    | 'continuationLoop'
    | 'cancelled';
  nextCursor?: { nextLink?: string; skip?: number };
  mode: 'skip' | 'nextLink' | 'mixed';
}

/**
 * Array callers retain the tested Priority short-page convention. Envelope callers preserve
 * next links; without one they probe by actual rows received until an empty page confirms end.
 * fetchNext MUST validate tenant/origin paths (PriorityClient.listNext does so).
 */
export async function fetchAllPages<T>(
  fetchPage: (skip: number, top: number) => Promise<T[] | PageEnvelope<T>>,
  opts: {
    pageSize?: number;
    maxRows?: number;
    fetchNext?: (nextLink: string) => Promise<PageEnvelope<T>>;
    signal?: AbortSignal;
  } = {},
): Promise<PageScan<T>> {
  const pageSize = opts.pageSize ?? 500;
  const maxRows = opts.maxRows ?? 10000;
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1
  )
    throw new Error('pageSize and maxRows must be positive safe integers');
  const rows: T[] = [];
  const seen = new Set<string>();
  let skip = 0;
  let pages = 0;
  let link: string | undefined;
  let usedNext = false;
  let usedSkip = false;
  const done = (
    stopReason: PageScan<T>['stopReason'],
    nextCursor?: PageScan<T>['nextCursor'],
  ): PageScan<T> => ({
    rows,
    pages,
    capped: stopReason === 'maxRows',
    complete: stopReason === 'exhausted',
    stopReason,
    ...(nextCursor ? { nextCursor } : {}),
    mode: usedNext ? (usedSkip ? 'mixed' : 'nextLink') : 'skip',
  });
  for (;;) {
    if (opts.signal?.aborted) return done('cancelled', link ? { nextLink: link } : { skip });
    let result: T[] | PageEnvelope<T>;
    if (link) {
      if (!opts.fetchNext) return done('continuationUnavailable', { nextLink: link });
      if (seen.has(link)) return done('continuationLoop', { nextLink: link });
      seen.add(link);
      usedNext = true;
      result = await opts.fetchNext(link);
    } else {
      // The first request is common to both modes; only subsequent offset probes count as skip.
      if (pages) usedSkip = true;
      result = await fetchPage(skip, Math.min(pageSize, maxRows - rows.length));
    }
    pages++;
    const arrayMode = Array.isArray(result);
    const page = Array.isArray(result) ? result : result.value;
    const next = Array.isArray(result) ? undefined : (result['@odata.nextLink'] ?? result.nextLink);
    const remaining = maxRows - rows.length;
    rows.push(...page.slice(0, remaining));
    skip += Math.min(page.length, remaining);
    // A server that ignores $top must not silently discard the rest of an oversized page.
    if (page.length > remaining) return done('maxRows', { skip });
    if (!next && (page.length === 0 || (arrayMode && page.length < Math.min(pageSize, remaining))))
      return done('exhausted');
    if (rows.length >= maxRows) return done('maxRows', next ? { nextLink: next } : { skip });
    link = next;
  }
}
