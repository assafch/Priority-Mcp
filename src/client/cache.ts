interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * Simple in-memory LRU cache with TTL.
 */
export class Cache {
  private store = new Map<string, CacheEntry<unknown>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // Move to end (most recently used)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  set<T>(key: string, value: T): void {
    if (this.store.size >= this.maxEntries) {
      // Evict oldest (first key)
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidate(pattern?: string): void {
    if (!pattern) {
      this.store.clear();
      return;
    }
    for (const key of this.store.keys()) {
      if (key.includes(pattern)) this.store.delete(key);
    }
  }
}
