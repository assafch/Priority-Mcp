/** Capability-aware bounded search with explicit coverage and safe OData continuation. */
import { PriorityError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import { currentOperation } from '../runtime/operation-context.js';
import { type PageScan, fetchAllPages } from './paginate.js';
import { getSchema } from './priority-schema.js';
import { handleBindingFor, queryHashFor, resultHandles } from './result-handles.js';
import { escapeODataString } from './sanitize.js';
import { knowledgeFor } from './schema-service.js';

// Legacy inspection hooks retain their shape; production evidence is per-form and expires.
let inspected = new WeakMap<PriorityClient, { form: string; value: boolean }>();
export function _resetStringFnSupport(): void {
  inspected = new WeakMap();
}
export function _stringFnSupport(client: PriorityClient): boolean | undefined {
  const last = inspected.get(client);
  if (!last) return undefined;
  return supportFor(client, last.form);
}
function supportFor(client: PriorityClient, form: string): boolean | undefined {
  const status = knowledgeFor(client).capabilities.get(form, 'contains')?.status;
  return status === 'supported' ? true : status === 'unsupported' ? false : undefined;
}
function rememberSupport(client: PriorityClient, form: string, value: boolean): void {
  knowledgeFor(client).capabilities.put(form, 'contains', value ? 'supported' : 'unsupported');
  inspected.set(client, { form, value });
}
export function isUnsupportedFunctionError(err: unknown): boolean {
  if (!(err instanceof PriorityError)) return false;
  if (err.statusCode === 501) return true;
  const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body ?? '');
  const hay = `${err.message} ${body}`.toLowerCase();
  return (
    hay.includes('is not supported') &&
    ['contains', 'startswith', 'substringof', 'tolower'].some((fn) => hay.includes(fn))
  );
}

export interface SearchOptions {
  form: string;
  query: string;
  /** Fields to match; always included in the projection. */
  fields: string[];
  select?: string[];
  top?: number;
  baseFilter?: string;
  /** Comma-separated ordering; all known key fields are appended as tie-breakers. */
  orderby?: string;
  /** Full form key when supplied by schema-aware callers. */
  keyFields?: string[];
  /** Maximum rows scanned by client filtering (default 2000). */
  scanCap?: number;
  signal?: AbortSignal;
  /** Absolute operation deadline, including every page and the native capability attempt. */
  deadlineAt?: number;
  /** Opaque scoped continuation; raw URLs are never accepted. */
  cursor?: string;
}
export interface SearchResult<T> {
  value: T[];
  meta: {
    strategy: 'contains' | 'client-filter';
    scanned?: number;
    scanCapped?: boolean;
    truncated?: boolean;
    /** True only when source coverage and returned matching rows are both complete. */
    complete: boolean;
    stopReason: PageScan<T>['stopReason'] | 'maxResults';
    /** Bound to the original query, authenticated client, policy and cache generation. */
    nextCursor: string | null;
  };
}
function applyOrderby(qb: ODataBuilder, orderby: string | undefined, keys: string[]): void {
  const ordered = new Set<string>();
  for (const spec of orderby?.split(',') ?? []) {
    const [field, dir] = spec.trim().split(/\s+/);
    if (!field) continue;
    qb.orderBy(field, dir?.toLowerCase() === 'desc' ? 'desc' : 'asc');
    ordered.add(field);
  }
  for (const key of keys) if (!ordered.has(key)) qb.orderBy(key);
}

export async function searchForm<T = Record<string, unknown>>(
  client: PriorityClient,
  opts: SearchOptions,
): Promise<SearchResult<T>> {
  const policyScope = currentOperation()?.policyScope;
  if (opts.cursor !== undefined && (!policyScope || !/^[A-Za-z0-9_-]{43}$/.test(opts.cursor)))
    throw new Error('Search cursor requires an active matching policy scope; restart the search.');
  const queryHash = queryHashFor({
    form: opts.form,
    query: opts.query,
    fields: opts.fields,
    select: opts.select ?? null,
    top: opts.top ?? 20,
    baseFilter: opts.baseFilter ?? null,
    orderby: opts.orderby ?? null,
    keyFields: opts.keyFields ?? null,
    scanCap: opts.scanCap ?? 2000,
  });
  const binding = handleBindingFor(
    client,
    policyScope ?? 'isolated-unconfigured-search',
    queryHash,
  );
  interface SearchState {
    kind: 'search';
    strategy: 'contains' | 'client-filter';
    skip: number;
    nextLink?: string;
    pending: T[];
    sourceComplete: boolean;
  }
  const previous = opts.cursor ? resultHandles.get<SearchState>(opts.cursor, binding) : undefined;
  if (previous && previous.kind !== 'search')
    throw new Error('Cursor is not a search; restart the search.');
  const top = opts.top ?? 20;
  const scanCap = opts.scanCap ?? 2000;
  if (
    !Number.isSafeInteger(top) ||
    top < 1 ||
    !Number.isSafeInteger(top + 1) ||
    !Number.isSafeInteger(scanCap) ||
    scanCap < 1
  )
    throw new Error('top and scanCap must be positive safe integers');
  if (opts.deadlineAt !== undefined && !Number.isFinite(opts.deadlineAt))
    throw new Error('deadlineAt must be a finite timestamp');
  const keys = opts.keyFields ?? getSchema(opts.form)?.key ?? [];
  const projection = [...new Set([...(opts.select ?? opts.fields), ...opts.fields, ...keys])];
  const controller = new AbortController();
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.deadlineAt !== undefined) {
    const remaining = opts.deadlineAt - Date.now();
    if (remaining <= 0) controller.abort();
    else {
      timer = setTimeout(() => controller.abort(), Math.min(remaining, 2_147_483_647));
      timer.unref?.();
    }
  }
  const scan = (native: boolean): Promise<PageScan<T>> => {
    const expr = opts.fields
      .map((f) => `contains(${f},'${escapeODataString(opts.query)}')`)
      .join(' or ');
    const filter = native
      ? opts.baseFilter
        ? `(${expr}) and (${opts.baseFilter})`
        : expr
      : opts.baseFilter;
    return fetchAllPages<T>(
      async (skip, take) => {
        if (previous?.nextLink && skip === 0)
          return client.listNext<T>(previous.nextLink, { signal });
        const qb = new ODataBuilder().top(take);
        if (skip || previous?.skip) qb.skip(skip + (previous?.skip ?? 0));
        if (filter) qb.filter(filter);
        if (projection.length) qb.select(...projection);
        applyOrderby(qb, opts.orderby, keys);
        return client.list<T>(opts.form, qb.build(), { signal });
      },
      {
        pageSize: 500,
        maxRows: native ? Math.max(1, top + 1 - (previous?.pending.length ?? 0)) : scanCap,
        signal,
        deadlineAt: opts.deadlineAt,
        ...(typeof client.listNext === 'function'
          ? {
              fetchNext: (link: string) => client.listNext<T>(link, { signal }),
            }
          : {}),
      },
    );
  };
  try {
    let result: PageScan<T> | undefined;
    let strategy: SearchResult<T>['meta']['strategy'] = previous?.strategy ?? 'contains';
    if (previous && (previous.sourceComplete || previous.pending.length > top))
      result = {
        rows: [],
        pages: 0,
        capped: false,
        complete: previous.sourceComplete,
        stopReason: previous.sourceComplete ? 'exhausted' : 'maxRows',
        mode: 'skip',
      };
    if (
      !result &&
      (previous?.strategy === 'contains' || (!previous && supportFor(client, opts.form) !== false))
    ) {
      try {
        result = await scan(true);
        if (result.pages) rememberSupport(client, opts.form, true);
      } catch (err) {
        // Schema errors remain visible: never silently fetch every column or omit match fields.
        if (!isUnsupportedFunctionError(err)) throw err;
        rememberSupport(client, opts.form, false);
      }
    }
    if (!result) {
      strategy = 'client-filter';
      result = await scan(false);
    }
    const needle = opts.query.toLowerCase();
    const newMatches =
      strategy === 'contains'
        ? result.rows
        : result.rows.filter((row) =>
            opts.fields.some((f) => {
              const value = (row as Record<string, unknown>)[f];
              return value != null && String(value).toLowerCase().includes(needle);
            }),
          );
    const matches = [...(previous?.pending ?? []), ...newMatches];
    const truncated = matches.length > top;
    const state: SearchState = {
      kind: 'search',
      strategy,
      skip: (previous?.skip ?? 0) + result.rows.length,
      ...(result.nextCursor?.nextLink ? { nextLink: result.nextCursor.nextLink } : {}),
      pending: matches.slice(top),
      sourceComplete: result.complete,
    };
    if (!result.rows.length && previous?.nextLink && !result.complete)
      state.nextLink = previous.nextLink;
    const nextCursor =
      policyScope && (!result.complete || truncated) ? resultHandles.create(binding, state) : null;
    return {
      value: matches.slice(0, top),
      meta: {
        strategy,
        ...(strategy === 'client-filter'
          ? { scanned: result.rows.length, scanCapped: result.capped }
          : {}),
        truncated,
        complete: result.complete && !truncated,
        stopReason:
          truncated && (result.complete || (strategy === 'contains' && result.capped))
            ? 'maxResults'
            : result.stopReason,
        nextCursor,
      },
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
