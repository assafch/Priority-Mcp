import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { OperationContext } from '../runtime/types.js';
import { buildAuthHeaders } from './auth.js';
import { RateLimiter } from './rate-limit.js';

export interface SchedulerLimits {
  maxConcurrency?: number;
  maxHeavy?: number;
  maxPending?: number;
  rateLimitPerMinute?: number;
}
type Limits = Required<SchedulerLimits>;
interface Pending {
  ctx: OperationContext;
  heavy: boolean;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}
const defaults: Limits = {
  maxConcurrency: 4,
  maxHeavy: 2,
  maxPending: 100,
  rateLimitPerMinute: 90,
};
const normalize = (limits: SchedulerLimits): Limits => ({
  ...defaults,
  ...Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined)),
});
const heavy = (ctx: OperationContext) =>
  ctx.workClass === 'report' || ctx.workClass === 'discovery';

/** Process-local admission and quota only; no data is stored under a rateScope. */
export class RequestScheduler {
  private limits: Limits;
  private readonly limiter: RateLimiter;
  private readonly queue: Pending[] = [];
  private active = 0;
  private activeHeavy = 0;
  private reportStreak = 0;
  private interactiveStreak = 0;
  private pausedUntil = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(limits: SchedulerLimits = {}) {
    this.limits = normalize(limits);
    this.limiter = new RateLimiter(this.limits.rateLimitPerMinute);
  }
  get pendingCount(): number {
    return this.queue.length;
  }
  setLimits(limits: SchedulerLimits): void {
    this.limits = normalize(limits);
    this.limiter.setLimit(this.limits.rateLimitPerMinute);
    this.drain();
  }
  pause(milliseconds: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + milliseconds);
    this.drain();
  }
  acquire(ctx: OperationContext): Promise<() => void> {
    if (this.closed) return Promise.reject(new Error('Scheduler closed'));
    if (ctx.signal?.aborted) return Promise.reject(ctx.signal.reason);
    if (ctx.deadlineAt <= Date.now()) return Promise.reject(new Error('Request deadline exceeded'));
    if (this.queue.length >= this.limits.maxPending)
      return Promise.reject(
        Object.assign(new Error('Priority request queue full'), { code: 'queue_full' }),
      );
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1);
        entry.cleanup();
        reject(ctx.signal?.aborted ? ctx.signal.reason : new Error('Request deadline exceeded'));
        this.drain();
      };
      const deadline = Number.isFinite(ctx.deadlineAt)
        ? setTimeout(cancel, Math.max(0, ctx.deadlineAt - Date.now()))
        : undefined;
      deadline?.unref?.();
      const entry: Pending = {
        ctx,
        heavy: heavy(ctx),
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(deadline);
          ctx.signal?.removeEventListener('abort', cancel);
        },
      };
      ctx.signal?.addEventListener('abort', cancel, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }
  private drain(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.closed || !this.queue.length || this.active >= this.limits.maxConcurrency) return;
    const availableAt = Math.max(this.pausedUntil, this.limiter.nextAllowedAt());
    if (availableAt > Date.now()) {
      this.timer = setTimeout(() => this.drain(), availableAt - Date.now());
      this.timer.unref?.();
      return;
    }
    const report =
      this.activeHeavy < this.limits.maxHeavy ? this.queue.findIndex((entry) => entry.heavy) : -1;
    const interactive = this.queue.findIndex((entry) => !entry.heavy);
    let index: number;
    if (interactive >= 0 && (report < 0 || this.reportStreak >= 2)) index = interactive;
    else if (report >= 0 && (interactive < 0 || this.interactiveStreak >= 4)) index = report;
    else
      index =
        interactive >= 0 && report >= 0
          ? Math.min(interactive, report)
          : Math.max(interactive, report);
    if (index < 0) return;
    const [entry] = this.queue.splice(index, 1);
    entry.cleanup();
    this.active++;
    if (entry.heavy) {
      this.activeHeavy++;
      this.reportStreak++;
      this.interactiveStreak = 0;
    } else {
      this.interactiveStreak++;
      this.reportStreak = 0;
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active--;
      if (entry.heavy) this.activeHeavy--;
      this.drain();
    };
    // acquire records immediately because drain has checked the rate window synchronously.
    void this.limiter.acquire(entry.ctx.signal).then(
      () => {
        if (entry.ctx.signal?.aborted || entry.ctx.deadlineAt <= Date.now()) {
          release();
          entry.reject(entry.ctx.signal?.reason ?? new Error('Request deadline exceeded'));
        } else entry.resolve(release);
      },
      (error) => {
        release();
        entry.reject(error);
      },
    );
    this.drain();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    for (const entry of this.queue.splice(0)) {
      entry.cleanup();
      entry.reject(new Error('Scheduler closed'));
    }
  }
}

/** Deployment identity excludes company and language; credentials are never exposed as keys. */
export function rateScopeFor(config: Config): string {
  let deployment: URL;
  if (config.priorityServiceRoot) {
    deployment = new URL(config.priorityServiceRoot.replace(/\/+$/, ''));
    deployment.pathname = deployment.pathname.slice(0, deployment.pathname.lastIndexOf('/'));
  } else if (config.priorityBaseUrl) deployment = new URL(config.priorityBaseUrl);
  else
    deployment = new URL(
      `${(config.priorityApiUrl ?? '').replace(/\/+$/, '')}/${config.priorityEnvironment ?? 'tabula.ini'}`,
    );
  deployment.pathname = deployment.pathname.replace(/\/+$/, '').replace(/,[^/]*$/, '');
  const account = config.priorityRateScope
    ? { operatorAccount: config.priorityRateScope }
    : buildAuthHeaders(config);
  return createHash('sha256')
    .update(JSON.stringify([deployment.href, account]))
    .digest('hex');
}
function limitsFor(config: Config): Limits {
  return normalize({
    maxConcurrency: config.priorityMaxConcurrency,
    maxPending: config.priorityMaxPending,
    rateLimitPerMinute: config.rateLimitPerMinute,
  });
}
const pool = new Map<string, { scheduler: RequestScheduler; leases: Map<symbol, Limits> }>();
export function acquireScheduler(config: Config): {
  scheduler: RequestScheduler;
  release: () => void;
} {
  const key = rateScopeFor(config);
  let shared = pool.get(key);
  if (!shared) {
    shared = { scheduler: new RequestScheduler(limitsFor(config)), leases: new Map() };
    pool.set(key, shared);
  }
  const entry = shared;
  const id = Symbol();
  const update = () => {
    const active = [...entry.leases.values()];
    entry.scheduler.setLimits(
      Object.fromEntries(
        Object.keys(defaults).map((k) => [
          k,
          Math.min(...active.map((limits) => limits[k as keyof Limits])),
        ]),
      ),
    );
  };
  entry.leases.set(id, limitsFor(config));
  update();
  return {
    scheduler: entry.scheduler,
    release: () => {
      if (!entry.leases.delete(id)) return;
      if (!entry.leases.size) {
        pool.delete(key);
        entry.scheduler.close();
      } else update();
    },
  };
}
