import { setTimeout as abortableDelay } from 'node:timers/promises';
import type { Config } from '../config.js';
import { getSchema } from '../lib/priority-schema.js';
import { type NamedKeys, type RecordKey, validateNamedKeys } from '../lib/record-key.js';
import type { Logger } from '../logger.js';
import { buildAuthHeaders } from './auth.js';
import { Cache } from './cache.js';
import { PriorityError, parsePriorityErrorBody, parseRetryAfterMs } from './errors.js';
import { RateLimiter } from './rate-limit.js';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  cache?: boolean;
  signal?: AbortSignal;
}

/**
 * Whether a failed attempt is worth retrying.
 *  - Deterministic client errors (4xx except 429) never succeed on retry → false.
 *  - GET is idempotent → retry on 429 and on any 5xx / network failure (status undefined).
 *  - Non-idempotent methods (POST/PATCH/DELETE) retry ONLY a clean 429: a 5xx or network
 *    failure leaves the write's commit state AMBIGUOUS (Priority may have already inserted the
 *    record before the response was lost), so re-sending could create a duplicate document.
 */
export function isRetryable(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  status: number | undefined,
): boolean {
  if (status !== undefined && status < 500 && status !== 429) return false;
  // 501 (Not Implemented) / 505 (HTTP version) are permanent server-side limitations on this
  // install — e.g. an unsupported OData function. Retrying just repeats the same doomed request.
  if (status === 501 || status === 505) return false;
  if (method !== 'GET' && status !== 429) return false;
  return true;
}

/**
 * Reject entity/form names that could traverse out of the configured company path (e.g.
 * "../otherCompany/CUSTOMERS"). Legitimate form names and OData navigation such as
 * "AINVOICES(IVNUM='x')/AINVOICEITEMS_SUBFORM" never contain a ".." segment or a leading slash.
 */
export function isSafeEntityName(entity: string): boolean {
  let decoded = entity;
  for (let i = 0; i < 8; i++) {
    if (
      !decoded ||
      /[?#\\]/.test(decoded) ||
      /(^|\/)\.{1,2}(\/|$)/.test(decoded) ||
      decoded.startsWith('/')
    )
      return false;
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (next === decoded) return true;
    decoded = next;
  }
  return false;
}

export class PriorityClient {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly cache: Cache;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;
  private readonly readOnly: boolean;
  private activeWrites = 0;
  private readonly requestTimeoutMs: number;

  constructor(config: Config, logger: Logger) {
    this.baseUrl = PriorityClient.buildBaseUrl(config);
    this.authHeaders = buildAuthHeaders(config);
    this.cache = new Cache(config.cacheTtlSeconds * 1000);
    this.rateLimiter = new RateLimiter(config.rateLimitPerMinute);
    this.logger = logger;
    this.readOnly = config.priorityReadOnly;
    this.requestTimeoutMs = config.requestTimeoutMs;
  }

  /**
   * Assemble the OData service root (everything before the entity name, no trailing slash).
   *
   * Priority's canonical format is:
   *   https://<server>/odata/Priority/<env>[,<langcode>]/<company>
   * where <env> is the system .ini segment (almost always `tabula.ini`). Either:
   *   - set PRIORITY_SERVICE_ROOT to the full root verbatim, or
   *   - set PRIORITY_API_URL (the part up to and including /odata/Priority),
   *     PRIORITY_ENVIRONMENT (default `tabula.ini`), and PRIORITY_COMPANY.
   */
  static buildBaseUrl(config: Config): string {
    const strip = (s: string) => s.replace(/\/+$/, '');
    // 1. Explicit full root wins.
    if (config.priorityServiceRoot) return strip(config.priorityServiceRoot);
    // 2. PRIORITY_BASE_URL already includes the .ini segment; just append the company.
    if (config.priorityBaseUrl) return `${strip(config.priorityBaseUrl)}/${config.priorityCompany}`;
    // 3. PRIORITY_API_URL + environment(.ini) + company.
    const apiUrl = strip(config.priorityApiUrl ?? '');
    return `${apiUrl}/${config.priorityEnvironment}/${config.priorityCompany}`;
  }

  /** The service-root URL (with trailing slash) — returns the OData service document. */
  serviceRootUrl(): string {
    return `${this.baseUrl}/`;
  }

  /** Build the OData key predicate for a string key: ('value') with quotes doubled + encoded. */
  private keyPredicate(key: string): string {
    return `('${encodeURIComponent(key.replace(/'/g, "''"))}')`;
  }

  /** Throw a 400 if the entity/form name looks like path traversal (company-scoping bypass). */
  private assertSafeEntity(entity: string): void {
    if (!isSafeEntityName(entity)) {
      throw new PriorityError(
        `Illegal entity/form name: "${entity}"`,
        400,
        undefined,
        'Entity/form names cannot contain path-traversal sequences ("..") or a leading slash.',
      );
    }
  }

  private assertSafeQuery(query: string): void {
    if (!query.startsWith('?') || query.includes('#'))
      throw new PriorityError('Query must start with ? and cannot contain a fragment.', 400);
  }

  /** Public: resolve the full URL for an entity (+ optional key + query) — used for dry-run previews. */
  resolveEntityUrl(entity: string, key?: RecordKey, query?: string): string {
    this.assertSafeEntity(entity);
    if (key !== undefined && typeof key !== 'string')
      validateNamedKeys(key, getSchema(entity)?.key);
    let url = `${this.baseUrl}/${entity}`;
    if (key !== undefined)
      url +=
        typeof key === 'string'
          ? this.keyPredicate(key)
          : `(${PriorityClient.namedPredicate(key)})`;
    if (query) {
      this.assertSafeQuery(query);
      url += query;
    }
    return url;
  }

  /** Public: resolve the URL of a sub-form (navigation property) on a record. */
  resolveSubformUrl(form: string, key: RecordKey, subform: string): string {
    this.assertSafeEntity(form);
    this.assertSafeEntity(subform);
    return `${this.resolveEntityUrl(form, key)}/${subform}`;
  }

  /**
   * Public: resolve the URL for a COMPOSITE-keyed record, e.g.
   * PINVOICES(IVNUM='GI25000025',DEBIT='D',IVTYPE='P'). String values are single-quoted (embedded
   * quotes doubled) and percent-encoded, exactly like keyPredicate; numbers are emitted bare.
   * Use for forms whose key has >1 field (AINVOICES, PINVOICES) — a single-value URL 404s on those.
   */
  resolveCompositeUrl(
    entity: string,
    keys: Record<string, string | number>,
    query?: string,
  ): string {
    this.assertSafeEntity(entity);
    validateNamedKeys(keys, getSchema(entity)?.key);
    let url = `${this.baseUrl}/${entity}(${PriorityClient.namedPredicate(keys)})`;
    if (query) {
      this.assertSafeQuery(query);
      url += query;
    }
    return url;
  }

  /** Build a NAMED key predicate body: K1='v',K2=3 (strings quoted + encoded, numbers bare). */
  private static namedPredicate(keys: Record<string, string | number>): string {
    validateNamedKeys(keys);
    return Object.entries(keys)
      .map(([k, v]) =>
        typeof v === 'number'
          ? `${k}=${v}`
          : `${k}='${encodeURIComponent(String(v).replace(/'/g, "''"))}'`,
      )
      .join(',');
  }

  /**
   * Public: resolve ONE ROW of a sub-form under a (possibly composite-keyed) parent, e.g.
   * IMPFILEIV(IVNUM='GI25000029',DEBIT='D',TYPE='P')/IMPFILEIVS_SUBFORM(KLINE=1).
   * Verified live 2026-07-29: both the named form above and the positional `(1)` form resolve.
   */
  resolveSubformRowUrl(
    entity: string,
    keys: RecordKey,
    subform: string,
    subKeys: Record<string, string | number>,
    query?: string,
  ): string {
    this.assertSafeEntity(entity);
    this.assertSafeEntity(subform);
    let url = `${this.resolveEntityUrl(entity, keys)}/${subform}(${PriorityClient.namedPredicate(subKeys)})`;
    if (query) {
      this.assertSafeQuery(query);
      url += query;
    }
    return url;
  }

  /** GET one sub-form row (see resolveSubformRowUrl). */
  async getSubformRow<T = unknown>(
    entity: string,
    keys: RecordKey,
    subform: string,
    subKeys: Record<string, string | number>,
    query?: string,
    options: { cache?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.send<T>(
      this.resolveSubformRowUrl(entity, keys, subform, subKeys, query),
      'GET',
      undefined,
      options.cache !== false,
      options.signal,
    );
  }

  /** PATCH one sub-form row (see resolveSubformRowUrl). */
  async updateSubformRow<T = unknown>(
    entity: string,
    keys: RecordKey,
    subform: string,
    subKeys: Record<string, string | number>,
    body: unknown,
  ): Promise<T> {
    this.cache.invalidate(entity);
    return this.send<T>(
      this.resolveSubformRowUrl(entity, keys, subform, subKeys),
      'PATCH',
      body,
      false,
    );
  }

  /**
   * Parse a request URL back into the form it targeted, so an error can name it (a bare
   * "Not found:" is un-actionable). Returns undefined for the service root and for URLs that
   * aren't under this company's base — never guesses.
   */
  private requestedResource(url: string): { form: string; keyed: boolean } | undefined {
    if (!url.startsWith(this.baseUrl)) return undefined;
    const rest = url.slice(this.baseUrl.length).replace(/^\//, '');
    const form = rest.match(/^[^(/?]+/)?.[0];
    if (!form || form.startsWith('$')) return undefined;
    return { form, keyed: rest.slice(form.length).startsWith('(') };
  }

  /** Public: resolve the GetMetadataFor(entity='X') function URL (Priority 25.0+). */
  metadataForUrl(entity: string): string {
    this.assertSafeEntity(entity);
    return `${this.baseUrl}/GetMetadataFor(entity='${entity.replace(/'/g, "''")}')`;
  }

  /** Any ERP mutation may affect balances/derived forms. Fence all tenant reads around it. */
  private async send<T>(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
    useCache = true,
    signal?: AbortSignal,
  ): Promise<T> {
    if (method === 'GET' || this.readOnly)
      return this.sendRequest<T>(url, method, body, useCache, signal);
    this.activeWrites++;
    this.cache.invalidate();
    try {
      return await this.sendRequest<T>(url, method, body, false, signal);
    } finally {
      // An ambiguous write may have committed; all cached derived forms must be refreshed too.
      this.cache.invalidate();
      this.activeWrites--;
    }
  }

  /** Low-level send: rate-limit + retry + read-only guard + cache + error surfacing. */
  private async sendRequest<T>(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
    useCache = true,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (this.readOnly && method !== 'GET') {
      throw new PriorityError(
        'Server is in read-only mode. Write operations are disabled.',
        403,
        undefined,
        'Set PRIORITY_READ_ONLY=false to enable writes.',
      );
    }

    const cacheGeneration = this.cache.generation();
    if (method === 'GET' && useCache && this.activeWrites === 0) {
      const cached = this.cache.get<T>(url);
      if (cached !== undefined) {
        this.logger.debug({ url }, 'Cache hit');
        return cached;
      }
    }

    const headers: Record<string, string> = {
      ...this.authHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Acquire a rate-limiter slot per ATTEMPT so retries also count against the limit
      // (otherwise a burst of retries during a 429 storm hammers the already-throttled server).
      await this.rateLimiter.acquire();
      signal?.throwIfAborted();
      try {
        this.logger.debug({ method, url, attempt }, 'Priority API request');

        let res: Response;
        try {
          res = await fetch(url, {
            method,
            redirect: 'error',
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)])
              : AbortSignal.timeout(this.requestTimeoutMs),
          });
        } catch (fetchErr) {
          if (signal?.aborted) throw new PriorityError('Read cancelled by caller.', 408);
          // Our own timeout (AbortSignal.timeout). Surface as a non-retryable 408 so a hung
          // endpoint fails fast instead of blocking for timeout × 3 attempts.
          if (
            fetchErr instanceof Error &&
            (fetchErr.name === 'TimeoutError' || fetchErr.name === 'AbortError')
          ) {
            throw new PriorityError(
              `Request timed out after ${this.requestTimeoutMs}ms`,
              408,
              undefined,
              'The Priority endpoint did not respond in time; narrow the query (smaller $top, a shorter date window, or fewer $expand sub-forms).',
              undefined,
              undefined,
              this.requestedResource(url),
            );
          }
          throw fetchErr; // genuine network error → normal retry path
        }

        if (!res.ok) {
          const raw = await res.text().catch(() => '');
          let parsedBody: unknown = raw;
          try {
            parsedBody = raw ? JSON.parse(raw) : raw;
          } catch {
            /* keep raw text */
          }
          const parsed = parsePriorityErrorBody(parsedBody);
          const retryAfterMs =
            res.status === 429 ? parseRetryAfterMs(res.headers.get('retry-after')) : undefined;
          // Surface the raw response body verbatim so the model can self-correct, and carry the
          // form this request targeted so the error can name it (404s come back with an empty body).
          throw new PriorityError(
            parsed.message,
            res.status,
            parsed.code,
            undefined,
            raw || undefined,
            retryAfterMs,
            this.requestedResource(url),
          );
        }

        // 204/empty responses (common on DELETE / some PATCH).
        if (res.status === 204) return undefined as T;
        const text = await res.text();
        if (!text) return undefined as T;
        // JSON by default; return raw text for non-JSON bodies (e.g. $metadata XML).
        const contentType = res.headers.get('content-type') ?? '';
        let data: T;
        if (contentType.includes('json')) {
          try {
            data = JSON.parse(text) as T;
          } catch {
            // A 2xx response with a malformed/truncated JSON body (proxy/gateway quirk):
            // surface the status + raw body instead of a bare SyntaxError, and don't retry.
            throw new PriorityError(
              'Priority returned a success response with an invalid JSON body.',
              res.status,
              undefined,
              undefined,
              text,
              undefined,
              this.requestedResource(url),
            );
          }
        } else {
          data = text as T;
        }

        if (method === 'GET' && useCache && this.activeWrites === 0)
          this.cache.set(url, data, cacheGeneration);
        return data;
      } catch (err) {
        lastError = err;
        const status = err instanceof PriorityError ? err.statusCode : undefined;
        if (!isRetryable(method, status)) {
          throw err;
        }
        if (attempt < 2) {
          // Honor a 429 Retry-After when present; otherwise exponential backoff.
          const retryAfter = err instanceof PriorityError ? err.retryAfterMs : undefined;
          const delay = retryAfter ?? 2 ** attempt * 500;
          this.logger.warn({ err, attempt, delay, method }, 'Retrying...');
          await abortableDelay(delay, undefined, { signal });
        }
      }
    }

    throw lastError;
  }

  /** Core request: build URL from entity/key/query then send. */
  async request<T = unknown>(
    entity: string,
    key?: RecordKey,
    query?: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const url = this.resolveEntityUrl(entity, key, query);
    return this.send<T>(url, method, options.body, options.cache !== false, options.signal);
  }

  /** Safe GET-only continuation. Reject raw traversal before URL normalization can hide it. */
  async listNext<T = unknown>(
    nextLink: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ value: T[]; '@odata.nextLink'?: string }> {
    let decoded = nextLink.split(/[?#]/, 1)[0];
    for (let i = 0; i < 8; i++) {
      if (/(^|[\\/])\.{1,2}([\\/]|$)/.test(decoded) || decoded.includes('\\'))
        throw new PriorityError('Unsafe continuation path.', 400);
      let next: string;
      try {
        next = decodeURIComponent(decoded);
      } catch {
        throw new PriorityError('Malformed continuation path.', 400);
      }
      if (next === decoded) break;
      decoded = next;
      if (i === 7) throw new PriorityError('Over-encoded continuation path.', 400);
    }
    const root = new URL(`${this.baseUrl}/`);
    let url: URL;
    try {
      url = new URL(nextLink, root);
    } catch {
      throw new PriorityError('Invalid continuation URL.', 400);
    }
    if (
      nextLink.includes('#') ||
      url.origin !== root.origin ||
      !url.pathname.startsWith(root.pathname) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new PriorityError(
        'Continuation URL must remain within the exact configured company.',
        400,
      );
    return this.send(url.href, 'GET', undefined, false, options.signal);
  }

  /** Composite read with optional cache bypass for verification and operational helpers. */
  async getComposite<T = unknown>(
    entity: string,
    keys: NamedKeys,
    query?: string,
    options: { cache?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.get<T>(entity, keys, query, options);
  }

  /** GET the OData service document (lists API-exposed entity sets / forms). */
  async serviceRoot<T = unknown>(): Promise<T> {
    return this.send<T>(this.serviceRootUrl(), 'GET', undefined, true);
  }

  /** GET GetMetadataFor(entity='X') — field names, types, titles, mandatory flags (Priority 25.0+). */
  async getMetadataFor<T = unknown>(entity: string): Promise<T> {
    return this.send<T>(this.metadataForUrl(entity), 'GET', undefined, true);
  }

  /** GET entity list with OData query. */
  async list<T = unknown>(
    entity: string,
    query?: string,
    options: { cache?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ value: T[]; '@odata.nextLink'?: string }> {
    return this.request(entity, undefined, query, options);
  }

  /** GET single entity by key. */
  async get<T = unknown>(
    entity: string,
    key: RecordKey,
    query?: string,
    options: { cache?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    return this.request<T>(entity, key, query, options);
  }

  /** GET a sub-form (navigation property) collection on a record, e.g. an order's attachments. */
  async listSubform<T = unknown>(
    form: string,
    key: RecordKey,
    subform: string,
    query?: string,
    options: { cache?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ value: T[] }> {
    if (query) this.assertSafeQuery(query);
    const url = this.resolveSubformUrl(form, key, subform) + (query ?? '');
    return this.send<{ value: T[] }>(
      url,
      'GET',
      undefined,
      options.cache !== false,
      options.signal,
    );
  }

  /** POST create (supports OData deep-insert: header object + nested subform arrays). */
  async create<T = unknown>(entity: string, body: unknown): Promise<T> {
    this.cache.invalidate(entity);
    return this.request<T>(entity, undefined, undefined, { method: 'POST', body });
  }

  /** PATCH update by key. */
  async update<T = unknown>(entity: string, key: RecordKey, body: unknown): Promise<T> {
    this.cache.invalidate(entity);
    return this.request<T>(entity, key, undefined, { method: 'PATCH', body });
  }

  /** PATCH a record identified by a COMPOSITE key (single-value update() 404s on such forms). */
  async updateComposite<T = unknown>(
    entity: string,
    keys: Record<string, string | number>,
    body: unknown,
  ): Promise<T> {
    this.cache.invalidate(entity);
    return this.send<T>(this.resolveCompositeUrl(entity, keys), 'PATCH', body, false);
  }

  /**
   * Public: drop cached GET responses whose URL contains `pattern` (e.g. a form name). Use after a
   * write whose effect surfaces through a DIFFERENT form than the one written — e.g. a PINVOICES
   * write appears inside an IMPFILES snapshot (IMPFILEINV_SUBFORM), which the automatic per-entity
   * invalidation on create/update/updateComposite does not cover.
   */
  invalidateCache(pattern: string): void {
    this.cache.invalidate(pattern);
  }

  /** POST a new line to a sub-form (navigation property) on an existing record. */
  async addLine<T = unknown>(
    form: string,
    key: RecordKey,
    subform: string,
    body: unknown,
  ): Promise<T> {
    this.cache.invalidate(form);
    return this.send<T>(this.resolveSubformUrl(form, key, subform), 'POST', body, false);
  }

  /** DELETE by key. */
  async delete(entity: string, key: string): Promise<void> {
    this.cache.invalidate(entity);
    await this.request(entity, key, undefined, { method: 'DELETE' });
  }
}
