import { setTimeout as delay } from 'node:timers/promises';

/** Sliding window, used by the scheduler before every backend attempt. */
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(private maxPerMinute: number) {}

  setLimit(limit: number): void {
    this.maxPerMinute = limit;
  }

  nextAllowedAt(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    return this.timestamps.length >= this.maxPerMinute
      ? (this.timestamps[this.timestamps.length - this.maxPerMinute] ?? now) + 60_000
      : now;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const waitMs = this.nextAllowedAt() - Date.now();
    if (waitMs > 0) {
      await delay(waitMs, undefined, { signal });
      return this.acquire(signal);
    }
    this.timestamps.push(Date.now());
  }
}
