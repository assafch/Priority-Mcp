/**
 * Capability-aware fuzzy search over a Priority form.
 *
 * Why this exists: some Priority installations' OData providers do NOT implement string
 * functions and reject `contains(...)` / `startswith(...)` with HTTP 501
 * ("Function 'contains' is not supported"). The dedicated search tools and the `search`
 * params on the list tools used to hard-fail on those installs. searchForm() tries the
 * native `contains()` filter once, and on a 501 transparently falls back to fetching a
 * PROJECTED page of rows and filtering them in-process — returning only the matches, so the
 * model never receives a giant unfiltered dump. The "string functions unsupported" verdict
 * is memoized per authenticated client, so subsequent searches skip the doomed `contains` round-trip.
 */

import { PriorityError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import { escapeODataString } from './sanitize.js';

// Tenant-scoped capability memo.
let stringFnSupport = new WeakMap<PriorityClient, boolean>();

/** Test hook: forget the cached capability verdict. */
export function _resetStringFnSupport(): void {
  stringFnSupport = new WeakMap();
}

/** Test/inspection hook: current capability verdict (undefined until first probe). */
export function _stringFnSupport(client: PriorityClient): boolean | undefined {
  return stringFnSupport.get(client);
}

/** Does this error mean the installation rejects an OData function (contains/startswith/…)? */
export function isUnsupportedFunctionError(err: unknown): boolean {
  if (!(err instanceof PriorityError)) return false;
  if (err.statusCode === 501) return true;
  const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body ?? '');
  const hay = `${err.message} ${body}`.toLowerCase();
  return (
    hay.includes('is not supported') &&
    (hay.includes('contains') ||
      hay.includes('startswith') ||
      hay.includes('substringof') ||
      hay.includes('tolower'))
  );
}

/** Does this 400 mean a field name in $select/$filter doesn't exist on the form? */
function isUnknownPropertyError(err: unknown): boolean {
  return (
    err instanceof PriorityError &&
    err.statusCode === 400 &&
    /could not find a property/i.test(err.message)
  );
}

export interface SearchOptions {
  form: string;
  query: string;
  /** Fields to match the query against. */
  fields: string[];
  /** Fields to return (defaults to `fields`). Match fields are always added to the projection. */
  select?: string[];
  /** Max matches to return. */
  top?: number;
  /** Extra server-side $filter ANDed onto the search (applied in both strategies). */
  baseFilter?: string;
  /** Sort spec applied server-side, e.g. "CUSTDES asc". */
  orderby?: string;
  /** Max rows to scan in the client-filter fallback (default 2000). */
  scanCap?: number;
}

export interface SearchResult<T> {
  value: T[];
  meta: {
    strategy: 'contains' | 'client-filter';
    /** Rows fetched/scanned in the fallback strategy. */
    scanned?: number;
    /** True when the scan stopped at `scanCap` — there may be unscanned rows beyond it. */
    scanCapped?: boolean;
    /** True when more than `top` matches existed and the surplus was dropped. */
    truncated?: boolean;
  };
}

function containsExpr(fields: string[], query: string): string {
  const esc = escapeODataString(query);
  return fields.map((f) => `contains(${f},'${esc}')`).join(' or ');
}

function applyOrderby(qb: ODataBuilder, orderby?: string): void {
  if (!orderby) return;
  const [field, dir] = orderby.trim().split(/\s+/);
  if (field) qb.orderBy(field, dir?.toLowerCase() === 'desc' ? 'desc' : 'asc');
}

export async function searchForm<T = Record<string, unknown>>(
  client: PriorityClient,
  opts: SearchOptions,
): Promise<SearchResult<T>> {
  const top = opts.top ?? 20;
  const select = opts.select ?? opts.fields;
  const scanCap = opts.scanCap ?? 2000;

  // 1) Native contains() — unless we already learned this install rejects string functions.
  if (stringFnSupport.get(client) !== false) {
    try {
      const expr = containsExpr(opts.fields, opts.query);
      const filter = opts.baseFilter ? `(${expr}) and ${opts.baseFilter}` : expr;
      const qb = new ODataBuilder().filter(filter);
      if (select.length) qb.select(...select);
      applyOrderby(qb, opts.orderby);
      qb.top(top + 1); // one extra row reveals whether more matches exist beyond `top`
      const res = await client.list<T>(opts.form, qb.build());
      stringFnSupport.set(client, true);
      const rows = res.value ?? [];
      return {
        value: rows.slice(0, top),
        meta: { strategy: 'contains', truncated: rows.length > top },
      };
    } catch (err) {
      if (isUnsupportedFunctionError(err)) {
        stringFnSupport.set(client, false); // remember; skip the doomed round-trip next time
      } else if (!isUnknownPropertyError(err)) {
        // A bad/missing field in our expr or projection is recoverable via the client-side
        // fallback (it drops the projection and skips absent fields); anything else is real.
        throw err;
      }
    }
  }

  // 2) Fallback: page through projected rows (+ base filter) and match in-process.
  const { rows, more } = await fetchForClientFilter<T>(client, opts, select, scanCap);
  const needle = opts.query.toLowerCase();
  const matches = rows.filter((row) =>
    opts.fields.some((f) => {
      const v = (row as Record<string, unknown>)[f];
      return v != null && String(v).toLowerCase().includes(needle);
    }),
  );
  return {
    value: matches.slice(0, top),
    meta: {
      strategy: 'client-filter',
      scanned: rows.length,
      scanCapped: more,
      truncated: matches.length > top,
    },
  };
}

/**
 * Page through up to `scanCap` projected rows. Priority OData servers often cap a single
 * response below an explicit large $top and don't expose a row count, so we page with $skip
 * rather than trusting one big request. `more` is true when we stopped at the cap with a full
 * final page (rows may remain beyond the scan window) — so scanCapped never under-reports.
 */
async function fetchForClientFilter<T>(
  client: PriorityClient,
  opts: SearchOptions,
  select: string[],
  scanCap: number,
): Promise<{ rows: T[]; more: boolean }> {
  // Project to the match fields + requested fields so we can filter locally on tiny rows.
  const projection = Array.from(new Set([...select, ...opts.fields]));
  const pageSize = Math.min(scanCap, 500);
  const rows: T[] = [];
  let skip = 0;
  let useProjection = true;
  let more = false;

  while (rows.length < scanCap) {
    const take = Math.min(pageSize, scanCap - rows.length);
    const build = (sel: string[]): string => {
      const qb = new ODataBuilder();
      if (opts.baseFilter) qb.filter(opts.baseFilter);
      if (sel.length) qb.select(...sel);
      applyOrderby(qb, opts.orderby);
      qb.top(take);
      if (skip > 0) qb.skip(skip);
      return qb.build();
    };

    let page: T[];
    try {
      page = (await client.list<T>(opts.form, build(useProjection ? projection : []))).value ?? [];
    } catch (err) {
      // A field in the projection doesn't exist — retry this page pulling all columns.
      if (useProjection && isUnknownPropertyError(err)) {
        useProjection = false;
        continue;
      }
      throw err;
    }

    rows.push(...page);
    if (page.length < take) break; // short page ⇒ end of data; `more` stays false
    skip += page.length;
    if (rows.length >= scanCap) {
      more = true; // stopped at the cap with a full page — there may be more
      break;
    }
  }

  return { rows, more };
}
