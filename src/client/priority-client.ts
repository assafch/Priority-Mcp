import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { basicAuthHeader } from './auth.js';
import { Cache } from './cache.js';
import { PriorityError, parsePriorityErrorBody } from './errors.js';
import { RateLimiter } from './rate-limit.js';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  cache?: boolean;
}

export class PriorityClient {
  private readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly cache: Cache;
  private readonly rateLimiter: RateLimiter;
  private readonly logger: Logger;
  private readonly readOnly: boolean;

  constructor(config: Config, logger: Logger) {
    // Pattern: {BASE_URL}/{ENV}/odata/Priority/tabula.ini/{COMPANY}
    this.baseUrl = `${config.priorityApiUrl.replace(/\/+$/, '')}/${config.priorityEnvironment}/odata/Priority/tabula.ini/${config.priorityCompany}`;
    this.authHeader = basicAuthHeader(config.priorityUsername, config.priorityPassword);
    this.cache = new Cache(config.cacheTtlSeconds * 1000);
    this.rateLimiter = new RateLimiter(config.rateLimitPerMinute);
    this.logger = logger;
    this.readOnly = config.priorityReadOnly;
  }

  /** Build full URL for an entity, optionally with key and query string */
  private entityUrl(entity: string, key?: string, query?: string): string {
    let url = `${this.baseUrl}/${entity}`;
    if (key) url += `('${encodeURIComponent(key)}')`;
    if (query) url += query;
    return url;
  }

  /** Core request method with retry, rate limiting, caching */
  async request<T = unknown>(entity: string, key?: string, query?: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';

    if (this.readOnly && method !== 'GET') {
      throw new PriorityError(
        'Server is in read-only mode. Write operations are disabled.',
        403,
        undefined,
        'Set PRIORITY_READ_ONLY=false to enable writes.',
      );
    }

    const url = this.entityUrl(entity, key, query);

    // Check cache for GET requests
    if (method === 'GET' && options.cache !== false) {
      const cached = this.cache.get<T>(url);
      if (cached !== undefined) {
        this.logger.debug({ url }, 'Cache hit');
        return cached;
      }
    }

    await this.rateLimiter.acquire();

    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.logger.debug({ method, url, attempt }, 'Priority API request');

        const res = await fetch(url, {
          method,
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
        });

        if (!res.ok) {
          const body = await res.json().catch(() => res.text());
          const parsed = parsePriorityErrorBody(body);
          throw new PriorityError(parsed.message, res.status, parsed.code);
        }

        // DELETE often returns 204 no content
        if (res.status === 204) return undefined as T;

        const data = (await res.json()) as T;

        // Cache GET responses
        if (method === 'GET' && options.cache !== false) {
          this.cache.set(url, data);
        }

        return data;
      } catch (err) {
        lastError = err;
        if (err instanceof PriorityError && err.statusCode < 500 && err.statusCode !== 429) {
          throw err; // Don't retry client errors (except 429)
        }
        if (attempt < 2) {
          const delay = Math.pow(2, attempt) * 500;
          this.logger.warn({ err, attempt, delay }, 'Retrying...');
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    throw lastError;
  }

  /** GET entity list with OData query */
  async list<T = unknown>(entity: string, query?: string): Promise<{ value: T[] }> {
    return this.request<{ value: T[] }>(entity, undefined, query);
  }

  /** GET single entity by key */
  async get<T = unknown>(entity: string, key: string, query?: string): Promise<T> {
    return this.request<T>(entity, key, query);
  }

  /** POST create */
  async create<T = unknown>(entity: string, body: unknown): Promise<T> {
    this.cache.invalidate(entity);
    return this.request<T>(entity, undefined, undefined, { method: 'POST', body });
  }

  /** PATCH update */
  async update<T = unknown>(entity: string, key: string, body: unknown): Promise<T> {
    this.cache.invalidate(entity);
    return this.request<T>(entity, key, undefined, { method: 'PATCH', body });
  }

  /** DELETE */
  async delete(entity: string, key: string): Promise<void> {
    this.cache.invalidate(entity);
    await this.request(entity, key, undefined, { method: 'DELETE' });
  }
}
