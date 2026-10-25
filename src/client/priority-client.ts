import { createHash } from 'node:crypto';
import { setTimeout as abortableDelay } from 'node:timers/promises';
import type { Config } from '../config.js';
import { getSchema } from '../lib/priority-schema.js';
import { type NamedKeys, type RecordKey, validateNamedKeys } from '../lib/record-key.js';
import type { Logger } from '../logger.js';
import { MetricsCollector, metricFormLabel } from '../runtime/metrics.js';
import {
  createOperation,
  currentOperation,
  recordReadObservation,
} from '../runtime/operation-context.js';
import type { OperationContext } from '../runtime/types.js';
import { buildAuthHeaders } from './auth.js';
import { Cache } from './cache.js';
import { PriorityError, parsePriorityErrorBody, parseRetryAfterMs } from './errors.js';
import { ReadCoalescer } from './read-coalescer.js';
import { acquireReadFence } from './read-fence.js';
import { acquireScheduler } from './request-scheduler.js';

export interface ReadOptions {
  cache?: boolean;
  signal?: AbortSignal;
  deadlineAt?: number;
  budgetMs?: number;
}

interface RequestOptions extends ReadOptions {
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
  readonly metrics = new MetricsCollector();
  private readonly baseUrl: string;
  private readonly authHeaders: Record<string, string>;
  private readonly cache: Cache;
  readonly scopeId: string;
  private readonly schedulerLease: ReturnType<typeof acquireScheduler>;
  private readonly coalesceReads: boolean;
  private readonly coalescer = new ReadCoalescer();
  private readonly shutdown = new AbortController();
  private readonly maxReadBodyBytes: number;
  private readonly maxMetadataBodyBytes: number;
  private readonly logger: Logger;
  private readonly readOnly: boolean;
  private readonly readFence: ReturnType<typeof acquireReadFence>;
  private get activeWrites(): number {
    return this.readFence.activeWrites();
  }
  private readonly requestTimeoutMs: number;

  constructor(config: Config, logger: Logger) {
    this.coalesceReads = config.priorityCoalesceReads !== false;
    this.baseUrl = PriorityClient.buildBaseUrl(config);
    this.authHeaders = buildAuthHeaders(config);
    this.cache = new Cache(
      Math.min(60_000, config.cacheTtlSeconds * 1000),
      500,
      config.cacheMaxBytes ?? 32 * 1024 * 1024,
    );
    this.schedulerLease = acquireScheduler(config);
    this.scopeId = createHash('sha256')
      .update(JSON.stringify([this.baseUrl, this.authHeaders, config.priorityLanguage]))
      .digest('hex');
    this.readFence = acquireReadFence(this.scopeId, (generation, pattern) =>
      this.cache.invalidate(pattern, generation),
    );
    this.maxReadBodyBytes = config.priorityMaxReadBodyBytes ?? 16 * 1024 * 1024;
    this.maxMetadataBodyBytes = config.priorityMaxMetadataBodyBytes ?? 32 * 1024 * 1024;
    this.logger = logger;
    this.readOnly = config.priorityReadOnly;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 120000;
  }

  cacheGeneration(): number {
    return this.readFence.generation();
  }

  close(): void {
    if (this.shutdown.signal.aborted) return;
    this.shutdown.abort(new Error('Priority client closed'));
    this.cache.invalidate();
    this.readFence.release();
    this.schedulerLease.release();
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
    options: ReadOptions = {},
  ): Promise<T> {
    return this.send<T>(
      this.resolveSubformRowUrl(entity, keys, subform, subKeys, query),
      'GET',
      undefined,
      options.cache !== false,
      options.signal,
      options,
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
    this.invalidateCache(entity);
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
    budget: ReadOptions = {},
  ): Promise<T> {
    if (method === 'GET' || this.readOnly)
      return this.sendRequest<T>(url, method, body, useCache, signal, budget);
    this.readFence.beginWrite();
    try {
      return await this.sendRequest<T>(url, method, body, false, signal, budget);
    } finally {
      // An ambiguous write may have committed; all cached derived forms must be refreshed too.
      this.readFence.endWrite();
    }
  }

  /** Cacheable reads share work, never subscriber cancellation or authorization scope. */
  private async sendRequest<T>(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body?: unknown,
    useCache = true,
    signal?: AbortSignal,
    budget: ReadOptions = {},
  ): Promise<T> {
    const inherited =
      currentOperation() ??
      createOperation('client', url.endsWith('/$metadata') ? { workClass: 'discovery' } : {});
    const ctx: OperationContext = {
      ...inherited,
      signal: AbortSignal.any([
        inherited.signal,
        this.shutdown.signal,
        ...(signal ? [signal] : []),
      ]),
      deadlineAt: Math.min(
        inherited.deadlineAt,
        budget.deadlineAt ?? Number.POSITIVE_INFINITY,
        budget.budgetMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + budget.budgetMs,
      ),
    };
    ctx.signal.throwIfAborted();
    if (ctx.deadlineAt <= Date.now()) throw new PriorityError('Request deadline exceeded.', 408);
    if (this.readOnly && method !== 'GET')
      throw new PriorityError(
        'Server is in read-only mode. Write operations are disabled.',
        403,
        undefined,
        'Set PRIORITY_READ_ONLY=false to enable writes.',
      );
    const metric = { form: this.requestedResource(url)?.form, method };
    const generation = this.readFence.generation();
    const sensitive = this.shortTtlRead(url, ctx);
    const observe = (result: { data: T; observedAt: number }, cached = false): T => {
      if (method === 'GET') recordReadObservation(ctx, result.observedAt, cached, sensitive);
      return result.data;
    };
    const cacheable = method === 'GET' && useCache && this.activeWrites === 0;
    if (cacheable) {
      const cached = this.cache.getEntry<T>(url);
      if (cached !== undefined) {
        this.metrics.record({ ...metric, phase: 'cache', cache: 'hit' });
        this.logger.debug(
          { method, form: metricFormLabel(metric.form), traceId: ctx.traceId },
          'Cache hit',
        );
        return observe({ data: cached.value, observedAt: cached.observedAt }, true);
      }
    }
    if (!cacheable) {
      this.metrics.record({ ...metric, phase: 'cache', cache: 'bypass' });
      return observe(await this.sendAttempts<T>(url, method, body, false, generation, ctx));
    }
    if (!this.coalesceReads)
      return observe(await this.sendAttempts<T>(url, method, body, true, generation, ctx));
    const key = `${this.scopeId}:${generation}:${url}`;
    this.metrics.record({
      ...metric,
      phase: 'cache',
      cache: this.coalescer.has(key) ? 'coalesced' : 'miss',
    });
    const result = await this.coalescer.run<{ data: T; observedAt: number }>(
      key,
      ctx,
      (sharedSignal) =>
        this.sendAttempts<T>(url, method, body, true, generation, {
          ...ctx,
          // Subscribers enforce their own deadlines; one short-lived subscriber cannot terminate
          // a later subscriber's work. All leaving aborts this shared signal immediately.
          signal: AbortSignal.any([sharedSignal, this.shutdown.signal]),
          deadlineAt: Number.POSITIVE_INFINITY,
        }),
    );
    return observe(result);
  }

  private shortTtlRead(url: string, ctx: OperationContext): boolean {
    const form = this.requestedResource(url)?.form ?? '';
    return (
      /OBLIGO|LOGPART|PARTBALANCE|BALANCE|CREDIT|DEBT|CASH|STOCK|INVOICE|IMPFILE|ACCOUNTS|AGED/.test(
        form,
      ) ||
      /PARTBALANCE|STOCK|OBLIGO/.test(new URL(url).searchParams.get('$expand') ?? '') ||
      /balance|stock|debt|cash|invoice|landed_cost|sales_by_period|revenue/.test(ctx.toolName)
    );
  }

  /** Count decoded streaming bytes, including compressed responses, and cancel promptly. */
  private async readBody(res: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let onAbort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void reader.cancel().catch(() => {});
        reject(new PriorityError('Request deadline exceeded or cancelled.', 408));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      while (true) {
        const chunk = await Promise.race([reader.read(), cancelled]);
        signal.throwIfAborted();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          void reader.cancel().catch(() => {});
          throw new PriorityError(
            'Priority response body exceeded the configured decoded-byte limit; result is incomplete.',
            413,
          );
        }
        chunks.push(chunk.value);
      }
      return Buffer.concat(chunks, bytes).toString('utf8');
    } finally {
      signal.removeEventListener('abort', onAbort);
      reader.releaseLock();
    }
  }

  /** One retry owner; every attempt reacquires the shared quota and concurrency slot. */
  private async sendAttempts<T>(
    url: string,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    body: unknown,
    useCache: boolean,
    generation: number,
    ctx: OperationContext,
  ): Promise<{ data: T; observedAt: number }> {
    const metric = { form: this.requestedResource(url)?.form, method };
    const deadline = new AbortController();
    const deadlineTimer = Number.isFinite(ctx.deadlineAt)
      ? setTimeout(
          () => deadline.abort(new Error('Request deadline exceeded')),
          Math.max(0, ctx.deadlineAt - Date.now()),
        )
      : undefined;
    deadlineTimer?.unref?.();
    const signal = AbortSignal.any([ctx.signal, deadline.signal]);
    const attemptContext = { ...ctx, signal };
    const headers = {
      ...this.authHeaders,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    const maxBytes = url.endsWith('/$metadata') ? this.maxMetadataBodyBytes : this.maxReadBodyBytes;
    try {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const queuedAt = performance.now();
        let release: (() => void) | undefined;
        try {
          release = await this.schedulerLease.scheduler.acquire(attemptContext);
        } finally {
          this.metrics.record({
            ...metric,
            phase: 'queue',
            durationMs: performance.now() - queuedAt,
            outcome: signal.aborted ? 'cancelled' : 'ok',
          });
        }
        const networkStarted = performance.now();
        let networkRecorded = false;
        const recordNetwork = (outcome: 'ok' | 'error' | 'cancelled', bytes = 0) => {
          if (networkRecorded) return;
          networkRecorded = true;
          this.metrics.record({
            ...metric,
            phase: 'network',
            durationMs: performance.now() - networkStarted,
            bytes,
            outcome,
          });
        };
        const timeout = new AbortController();
        const timeoutTimer = setTimeout(
          () => timeout.abort(new Error('Request timeout exceeded')),
          this.requestTimeoutMs,
        );
        timeoutTimer.unref?.();
        const attemptSignal = AbortSignal.any([signal, timeout.signal]);
        try {
          attemptSignal.throwIfAborted();
          this.logger.debug(
            { method, form: metricFormLabel(metric.form), traceId: ctx.traceId, attempt },
            'Priority API request',
          );
          const res = await fetch(url, {
            method,
            redirect: 'error',
            headers,
            body: body !== undefined ? JSON.stringify(body) : undefined,
            signal: attemptSignal,
          });
          if (res.status === 204) {
            recordNetwork('ok');
            return { data: undefined as T, observedAt: Date.now() };
          }
          const text = await this.readBody(res, maxBytes, attemptSignal);
          if (!res.ok) {
            let parsedBody: unknown = text;
            try {
              parsedBody = text ? JSON.parse(text) : text;
            } catch {
              /* preserve raw error */
            }
            recordNetwork('error', Buffer.byteLength(text));
            const parsed = parsePriorityErrorBody(parsedBody);
            const retryAfterMs =
              res.status === 429 ? parseRetryAfterMs(res.headers.get('retry-after')) : undefined;
            if (res.status === 429) this.schedulerLease.scheduler.pause(retryAfterMs ?? 500);
            throw new PriorityError(
              parsed.message,
              res.status,
              parsed.code,
              undefined,
              text || undefined,
              retryAfterMs,
              this.requestedResource(url),
            );
          }
          recordNetwork('ok', Buffer.byteLength(text));
          if (!text) return { data: undefined as T, observedAt: Date.now() };
          let data: T;
          if ((res.headers.get('content-type') ?? '').includes('json')) {
            const parseStarted = performance.now();
            try {
              data = JSON.parse(text) as T;
            } catch {
              throw new PriorityError(
                'Priority returned a success response with an invalid JSON body.',
                res.status,
                undefined,
                undefined,
                text,
                undefined,
                this.requestedResource(url),
              );
            } finally {
              this.metrics.record({
                ...metric,
                phase: 'parse',
                durationMs: performance.now() - parseStarted,
                bytes: Buffer.byteLength(text),
              });
            }
          } else data = text as T;
          if (
            method === 'GET' &&
            data &&
            typeof data === 'object' &&
            Array.isArray((data as { value?: unknown }).value)
          ) {
            this.metrics.record({
              ...metric,
              phase: 'rows',
              value: ((data as { value?: unknown }).value as unknown[]).length,
            });
            this.metrics.record({ ...metric, phase: 'pages', value: 1 });
          }
          const observedAt = Date.now();
          if (method === 'GET' && useCache && this.activeWrites === 0 && !signal.aborted)
            this.cache.set(url, data, generation, Buffer.byteLength(text), {
              observedAt,
              ttlMs: this.shortTtlRead(url, ctx) ? 15_000 : 60_000,
            });
          return { data, observedAt };
        } catch (error) {
          recordNetwork(attemptSignal.aborted ? 'cancelled' : 'error');
          if (attemptSignal.aborted)
            throw new PriorityError('Request deadline exceeded or cancelled.', 408);
          lastError = error;
          const status = error instanceof PriorityError ? error.statusCode : undefined;
          if (!isRetryable(method, status)) throw error;
          if (attempt < 2) {
            // Release concurrency before sleeping; the shared 429 pause still prevents admission.
            release();
            release = undefined;
            clearTimeout(timeoutTimer);
            const retryAfter = error instanceof PriorityError ? error.retryAfterMs : undefined;
            const delay =
              retryAfter ?? Math.round(2 ** attempt * 500 * (0.9 + Math.random() * 0.2));
            this.logger.warn(
              {
                status: status ?? 'network',
                form: metricFormLabel(metric.form),
                attempt,
                delay,
                method,
                traceId: ctx.traceId,
              },
              'Retrying Priority request',
            );
            const retryStarted = performance.now();
            try {
              await abortableDelay(delay, undefined, { signal });
            } finally {
              this.metrics.record({
                ...metric,
                phase: 'retry',
                durationMs: performance.now() - retryStarted,
                outcome: signal.aborted ? 'cancelled' : 'ok',
              });
            }
          }
        } finally {
          clearTimeout(timeoutTimer);
          release?.();
        }
      }
      throw lastError;
    } finally {
      clearTimeout(deadlineTimer);
    }
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
    return this.send<T>(
      url,
      method,
      options.body,
      options.cache !== false,
      options.signal,
      options,
    );
  }

  /** Safe GET-only continuation. Reject raw traversal before URL normalization can hide it. */
  async listNext<T = unknown>(
    nextLink: string,
    options: Omit<ReadOptions, 'cache'> = {},
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
    return this.send(url.href, 'GET', undefined, false, options.signal, options);
  }

  /** Composite read with optional cache bypass for verification and operational helpers. */
  async getComposite<T = unknown>(
    entity: string,
    keys: NamedKeys,
    query?: string,
    options: ReadOptions = {},
  ): Promise<T> {
    return this.get<T>(entity, keys, query, options);
  }

  /** GET the OData service document (lists API-exposed entity sets / forms). */
  async serviceRoot<T = unknown>(): Promise<T> {
    return this.send<T>(this.serviceRootUrl(), 'GET', undefined, true);
  }

  /** GET GetMetadataFor(entity='X') — field names, types, titles, mandatory flags (Priority 25.0+). */
  async getMetadataFor<T = unknown>(entity: string, options: ReadOptions = {}): Promise<T> {
    return this.send<T>(
      this.metadataForUrl(entity),
      'GET',
      undefined,
      options.cache !== false,
      options.signal,
      options,
    );
  }

  /** GET entity list with OData query. */
  async list<T = unknown>(
    entity: string,
    query?: string,
    options: ReadOptions = {},
  ): Promise<{ value: T[]; '@odata.nextLink'?: string }> {
    return this.request(entity, undefined, query, options);
  }

  /** GET single entity by key. */
  async get<T = unknown>(
    entity: string,
    key: RecordKey,
    query?: string,
    options: ReadOptions = {},
  ): Promise<T> {
    return this.request<T>(entity, key, query, options);
  }

  /** GET a sub-form (navigation property) collection on a record, e.g. an order's attachments. */
  async listSubform<T = unknown>(
    form: string,
    key: RecordKey,
    subform: string,
    query?: string,
    options: ReadOptions = {},
  ): Promise<{ value: T[] }> {
    if (query) this.assertSafeQuery(query);
    const url = this.resolveSubformUrl(form, key, subform) + (query ?? '');
    return this.send<{ value: T[] }>(
      url,
      'GET',
      undefined,
      options.cache !== false,
      options.signal,
      options,
    );
  }

  /** POST create (supports OData deep-insert: header object + nested subform arrays). */
  async create<T = unknown>(entity: string, body: unknown): Promise<T> {
    this.invalidateCache(entity);
    return this.request<T>(entity, undefined, undefined, { method: 'POST', body });
  }

  /** PATCH update by key. */
  async update<T = unknown>(entity: string, key: RecordKey, body: unknown): Promise<T> {
    this.invalidateCache(entity);
    return this.request<T>(entity, key, undefined, { method: 'PATCH', body });
  }

  /** PATCH a record identified by a COMPOSITE key (single-value update() 404s on such forms). */
  async updateComposite<T = unknown>(
    entity: string,
    keys: Record<string, string | number>,
    body: unknown,
  ): Promise<T> {
    this.invalidateCache(entity);
    return this.send<T>(this.resolveCompositeUrl(entity, keys), 'PATCH', body, false);
  }

  /**
   * Public: drop cached GET responses whose URL contains `pattern` (e.g. a form name). Use after a
   * write whose effect surfaces through a DIFFERENT form than the one written — e.g. a PINVOICES
   * write appears inside an IMPFILES snapshot (IMPFILEINV_SUBFORM), which the automatic per-entity
   * invalidation on create/update/updateComposite does not cover.
   */
  invalidateCache(pattern: string): void {
    this.readFence.invalidate(pattern);
  }

  /** POST a new line to a sub-form (navigation property) on an existing record. */
  async addLine<T = unknown>(
    form: string,
    key: RecordKey,
    subform: string,
    body: unknown,
  ): Promise<T> {
    this.invalidateCache(form);
    return this.send<T>(this.resolveSubformUrl(form, key, subform), 'POST', body, false);
  }

  /** DELETE by key. */
  async delete(entity: string, key: string): Promise<void> {
    this.invalidateCache(entity);
    await this.request(entity, key, undefined, { method: 'DELETE' });
  }
}
