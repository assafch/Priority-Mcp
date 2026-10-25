interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  observedAt: number;
  bytes: number;
}

/**
 * Simple in-memory LRU cache with TTL.
 */
export class Cache {
  private epoch = 0;
  private store = new Map<string, CacheEntry<unknown>>();
  private bytes = 0;

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
    private readonly maxBytes = 32 * 1024 * 1024,
    private readonly maxEntryBytes = 2 * 1024 * 1024,
  ) {}

  get<T>(key: string): T | undefined {
    return this.getEntry<T>(key)?.value;
  }

  getEntry<T>(key: string): { value: T; observedAt: number } | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.remove(key);
      return undefined;
    }
    // Move to end (most recently used)
    this.store.delete(key);
    this.store.set(key, entry);
    return { value: entry.value as T, observedAt: entry.observedAt };
  }

  /** Generation changes even when the invalidated entry has not finished loading yet. */
  generation(): number {
    return this.epoch;
  }

  get accountedBytes(): number {
    return this.bytes;
  }

  private remove(key: string): void {
    const entry = this.store.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.store.delete(key);
  }

  set<T>(
    key: string,
    value: T,
    generation = this.epoch,
    accountedBytes?: number,
    options: { ttlMs?: number; observedAt?: number } = {},
  ): void {
    if (generation !== this.epoch) return;
    const bytes = accountedBytes ?? Buffer.byteLength(JSON.stringify(value) ?? '');
    this.remove(key);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.maxEntryBytes || bytes > this.maxBytes)
      return;
    while (this.store.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const firstKey = this.store.keys().next().value;
      if (firstKey === undefined) return;
      this.remove(firstKey);
    }
    const observedAt = options.observedAt ?? Date.now();
    this.store.set(key, {
      value,
      bytes,
      observedAt,
      expiresAt: observedAt + Math.min(this.ttlMs, options.ttlMs ?? this.ttlMs),
    });
    this.bytes += bytes;
  }

  invalidate(pattern?: string, generation?: number): void {
    this.epoch = generation ?? this.epoch + 1;
    if (!pattern) {
      this.store.clear();
      this.bytes = 0;
      return;
    }
    for (const key of this.store.keys()) {
      if (key.includes(pattern)) this.remove(key);
    }
  }
}
