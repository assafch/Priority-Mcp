import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { buildAuthHeaders } from './auth.js';
import { Cache } from './cache.js';
import { PriorityError, parsePriorityErrorBody, parseRetryAfterMs } from './errors.js';
import { RateLimiter } from './rate-limit.js';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  cache?: boolean;
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
  try {
    decoded = decodeURIComponent(entity);
  } catch {
    /* keep raw if it isn't valid percent-encoding */
  }
  const traversal = /(^|[/\\])\.\.([/\\]|$)/;
  return !(traversal.test(entity) || traversal.test(decoded) || /^[/\\]/.test(decoded));
}

export class PriorityClient {
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly cache: Cache;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;
  private readonly readOnly: boolean;
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

  /** Public: resolve the full URL for an entity (+ optional key + query) — used for dry-run previews. */
  resolveEntityUrl(entity: string, key?: string, query?: string): string {
    this.assertSafeEntity(entity);
    let url = `${this.baseUrl}/${entity}`;
    if (key) url += this.keyPredicate(key);
    if (query) url += query;
    return url;
  }

  /** Public: resolve the URL of a sub-form (navigation property) on a record. */
  resolveSubformUrl(form: string, key: string, subform: string): string {
    this.assertSafeEntity(form);
    this.assertSafeEntity(subform);
    return `${this.baseUrl}/${form}${this.keyPredicate(key)}/${subform}`;
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
    const predicate = Object.entries(keys)
      .map(([k, v]) =>
        typeof v === 'number'
          ? `${k}=${v}`
          : `${k}='${encodeURIComponent(String(v).replace(/'/g, "''"))}'`,
      )
      .join(',');
    let url = `${this.baseUrl}/${entity}(${predicate})`;
    if (query) url += query;
    return url;
  }

  /** Public: resolve the GetMetadataFor(entity='X') function URL (Priority 25.0+). */
  metadataForUrl(entity: string): string {
    this.assertSafeEntity(entity);
    return `${this.baseUrl}/GetMetadataFor(entity='${entity.replace(/'/g, "''")}')`;
  }

  /** Low-level send: rate-limit + retry + read-only guard + cache + error surfacing. */
  private async send<T>(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
    useCache = true,
  ): Promise<T> {
    if (this.readOnly && method !== 'GET') {
      throw new PriorityError(
        'Server is in read-only mode. Write operations are disabled.',
        403,
        undefined,
        'Set PRIORITY_READ_ONLY=false to enable writes.',
      );
    }

    if (method === 'GET' && useCache) {
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
      try {
        this.logger.debug({ method, url, attempt }, 'Priority API request');

        let res: Response;
        try {
          res = await fetch(url, {
            method,
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });
        } catch (fetchErr) {
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
          // Surface the raw response body verbatim so the model can self-correct.
          throw new PriorityError(
            parsed.message,
            res.status,
            parsed.code,
            undefined,
            raw || undefined,
            retryAfterMs,
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
            );
          }
        } else {
          data = text as T;
        }

        if (method === 'GET' && useCache) this.cache.set(url, data);
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
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError;
  }

  /** Core request: build URL from entity/key/query then send. */
  async request<T = unknown>(
    entity: string,
    key?: string,
    query?: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const url = this.resolveEntityUrl(entity, key, query);
    return this.send<T>(url, method, options.body, options.cache !== false);
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
  async list<T = unknown>(entity: string, query?: string): Promise<{ value: T[] }> {
    return this.request<{ value: T[] }>(entity, undefined, query);
  }

  /** GET single entity by key. */
  async get<T = unknown>(entity: string, key: string, query?: string): Promise<T> {
    return this.request<T>(entity, key, query);
  }

  /** GET a sub-form (navigation property) collection on a record, e.g. an order's attachments. */
  async listSubform<T = unknown>(
    form: string,
    key: string,
    subform: string,
    query?: string,
  ): Promise<{ value: T[] }> {
    const url = this.resolveSubformUrl(form, key, subform) + (query ?? '');
    return this.send<{ value: T[] }>(url, 'GET', undefined, true);
  }

  /** POST create (supports OData deep-insert: header object + nested subform arrays). */
  async create<T = unknown>(entity: string, body: unknown): Promise<T> {
    this.cache.invalidate(entity);
    return this.request<T>(entity, undefined, undefined, { method: 'POST', body });
  }

  /** PATCH update by key. */
  async update<T = unknown>(entity: string, key: string, body: unknown): Promise<T> {
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
    key: string,
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
