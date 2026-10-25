import { createHash, randomBytes } from 'node:crypto';
import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';

export interface HandleBinding {
  scopeId: string;
  policyScope: string;
  queryHash: string;
  generation: number;
}
interface Entry {
  binding: HandleBinding;
  value: unknown;
  bytes: number;
  expiresAt: number;
}
export function queryHashFor(query: unknown): string {
  return createHash('sha256').update(JSON.stringify(query)).digest('hex');
}
export function policyScopeFor(
  config: Pick<Config, 'priorityAllowedTools' | 'priorityBlockedTools' | 'priorityReadOnly'>,
): string {
  return queryHashFor({
    allowed: config.priorityAllowedTools ? [...config.priorityAllowedTools].sort() : null,
    blocked: [...(config.priorityBlockedTools ?? [])].sort(),
    readOnly: config.priorityReadOnly,
  });
}
const incarnations = new WeakMap<object, string>();
export function handleBindingFor(
  client: PriorityClient,
  policyScope: string,
  queryHash: string,
): HandleBinding {
  const incarnation = incarnations.get(client) ?? randomBytes(32).toString('base64url');
  incarnations.set(client, incarnation);
  return {
    scopeId: queryHashFor([client.scopeId ?? 'unconfigured-client', incarnation]),
    policyScope,
    queryHash,
    generation: typeof client.cacheGeneration === 'function' ? client.cacheGeneration() : 0,
  };
}
/** Instance lifetime is the boot namespace; state and random256-bit tokens never persist. */
export class ResultHandles {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly maxBytes: number;
  private readonly maxPerScope: number;
  private readonly ttlMs: number;
  constructor(options: { maxBytes?: number; maxPerScope?: number; ttlMs?: number } = {}) {
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    this.maxPerScope = options.maxPerScope ?? 100;
    this.ttlMs = options.ttlMs ?? 900000;
  }
  create<T>(binding: HandleBinding, value: T): string | null {
    const serialized = JSON.stringify(value);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > this.maxBytes) return null;
    for (const [token, entry] of this.entries)
      if (entry.expiresAt <= Date.now()) this.remove(token);
    const scoped = [...this.entries].filter(
      ([, entry]) => entry.binding.scopeId === binding.scopeId,
    );
    while (scoped.length >= this.maxPerScope) {
      const oldest = scoped.shift();
      if (oldest) this.remove(oldest[0]);
    }
    while (this.bytes + bytes > this.maxBytes) {
      const token = this.entries.keys().next().value;
      if (!token) break;
      this.remove(token);
    }
    const token = randomBytes(32).toString('base64url');
    this.entries.set(token, {
      binding: { ...binding },
      value: JSON.parse(serialized),
      bytes,
      expiresAt: Date.now() + this.ttlMs,
    });
    this.bytes += bytes;
    return token;
  }
  get<T>(token: string, binding: HandleBinding): T {
    const entry = this.entries.get(token);
    if (!entry || entry.expiresAt <= Date.now()) {
      this.remove(token);
      throw new PriorityError('Result handle expired or unavailable; restart the query.', 410);
    }
    if (
      entry.binding.scopeId !== binding.scopeId ||
      entry.binding.policyScope !== binding.policyScope ||
      entry.binding.queryHash !== binding.queryHash ||
      entry.binding.generation !== binding.generation
    )
      throw new PriorityError(
        'Result handle scope, policy, query or generation changed; restart the query.',
        410,
      );
    return structuredClone(entry.value) as T;
  }
  remove(token: string): void {
    const entry = this.entries.get(token);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(token);
  }
  page(
    token: string,
    binding: HandleBinding,
    page: number,
    pageSize = 100,
  ): {
    rows: unknown[];
    totalRows: number;
    page: number;
    pageSize: number;
    nextPage: number | null;
  } {
    if (
      !Number.isSafeInteger(page) ||
      page < 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 100
    )
      throw new PriorityError('Result pages require nonnegative page and pageSize1..100.', 400);
    const value = this.get<{ rows?: unknown[] }>(token, binding);
    if (!Array.isArray(value.rows))
      throw new PriorityError('This result handle has no detail pages.', 400);
    const start = page * pageSize;
    if (start > value.rows.length)
      throw new PriorityError('Result page outside retained detail.', 400);
    return {
      rows: value.rows.slice(start, start + pageSize),
      totalRows: value.rows.length,
      page,
      pageSize,
      nextPage: start + pageSize < value.rows.length ? page + 1 : null,
    };
  }
}
export const resultHandles = new ResultHandles();
