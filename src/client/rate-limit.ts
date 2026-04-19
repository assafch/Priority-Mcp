/**
 * Simple sliding-window rate limiter.
 */
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly maxPerMinute: number) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);

    if (this.timestamps.length >= this.maxPerMinute) {
      const waitMs = 60_000 - (now - this.timestamps[0]!);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return this.acquire();
    }

    this.timestamps.push(now);
  }
}
