import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RequestScheduler,
  acquireScheduler,
  rateScopeFor,
} from '../src/client/request-scheduler.js';
import type { Config } from '../src/config.js';
const ctx = (workClass = 'interactive', signal?: AbortSignal) => ({
  traceId: 'test',
  toolName: 'test',
  workClass,
  deadlineAt: Date.now() + 120000,
  signal,
});
afterEach(() => vi.useRealTimers());
describe('bounded fair scheduling', () => {
  it('caps attempts globally and heavy attempts separately', async () => {
    const scheduler = new RequestScheduler({
      maxConcurrency: 4,
      maxHeavy: 2,
      maxPending: 100,
      rateLimitPerMinute: 1000,
    });
    const releases = await Promise.all([
      scheduler.acquire(ctx('report')),
      scheduler.acquire(ctx('report')),
      scheduler.acquire(ctx()),
      scheduler.acquire(ctx()),
    ]);
    let admitted = false;
    const pending = scheduler.acquire(ctx('report')).then((release) => {
      admitted = true;
      return release;
    });
    releases[2]();
    await Promise.resolve();
    expect(admitted).toBe(false);
    releases[0]();
    (await pending)();
    for (const release of releases) release();
    scheduler.close();
  });
  it('rejects the 101st pending attempt and cancellation removes queue entries immediately', async () => {
    vi.useFakeTimers();
    const scheduler = new RequestScheduler({
      maxConcurrency: 1,
      maxPending: 100,
      rateLimitPerMinute: 1000,
    });
    const release = await scheduler.acquire(ctx());
    const controllers = Array.from({ length: 100 }, () => new AbortController());
    const waiting = controllers.map((c) =>
      scheduler.acquire(ctx('interactive', c.signal)).catch((e) => e),
    );
    await expect(scheduler.acquire(ctx())).rejects.toMatchObject({ code: 'queue_full' });
    for (const controller of controllers) controller.abort();
    await Promise.all(waiting);
    release();
    expect(scheduler.pendingCount).toBe(0);
    (await scheduler.acquire(ctx()))();
    scheduler.close();
  });
  it('counts attempts and shared pauses within deadlines without occupying concurrency', async () => {
    vi.useFakeTimers();
    const scheduler = new RequestScheduler({ maxConcurrency: 4, rateLimitPerMinute: 1 });
    (await scheduler.acquire(ctx()))();
    const controller = new AbortController();
    let admitted = false;
    const pending = scheduler
      .acquire(ctx('interactive', controller.signal))
      .then((r) => {
        admitted = true;
        r();
      })
      .catch((e) => e);
    await vi.advanceTimersByTimeAsync(59999);
    expect(admitted).toBe(false);
    controller.abort();
    await pending;
    await vi.advanceTimersByTimeAsync(1);
    scheduler.pause(2000);
    const expired = scheduler.acquire({ ...ctx(), deadlineAt: Date.now() + 100 });
    const rejected = expect(expired).rejects.toThrow(/deadline/i);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(scheduler.pendingCount).toBe(0);
    scheduler.close();
  });
  it('serves both queues within the report and interactive admission bounds', async () => {
    const scheduler = new RequestScheduler({
      maxConcurrency: 1,
      maxHeavy: 1,
      rateLimitPerMinute: 1000,
    });
    const release = await scheduler.acquire(ctx());
    const order: string[] = [];
    const all = Array.from({ length: 12 }, (_, i) =>
      scheduler.acquire(ctx(i < 6 ? 'report' : 'interactive')).then((r) => {
        order.push(i < 6 ? 'r' : 'i');
        r();
      }),
    );
    release();
    await Promise.all(all);
    expect(order.slice(0, 3)).toContain('i');
    expect(order.slice(0, 4)).toContain('r');
    expect(order.join('')).not.toContain('rrr');
    scheduler.close();
  });
});
describe('account-scoped scheduler leases', () => {
  const config = {
    priorityBaseUrl: 'https://P.TEST/odata/Priority/tabula.ini,1/',
    priorityCompany: 'a',
    priorityPat: 'token',
    priorityLanguage: 'HE',
    rateLimitPerMinute: 1000,
  } as Config;
  it('groups company/profile/language while isolating credentials and deployment', () => {
    expect(rateScopeFor(config)).toBe(
      rateScopeFor({
        ...config,
        priorityCompany: 'b',
        priorityBaseUrl: 'https://p.test/odata/Priority/tabula.ini,3',
        priorityReadOnly: false,
      }),
    );
    expect(rateScopeFor(config)).not.toBe(rateScopeFor({ ...config, priorityPat: 'different' }));
    expect(rateScopeFor({ ...config, priorityRateScope: 'account' })).toBe(
      rateScopeFor({ ...config, priorityPat: 'different', priorityRateScope: 'account' }),
    );
    expect(rateScopeFor({ ...config, priorityRateScope: 'account' })).not.toBe(
      rateScopeFor({
        ...config,
        priorityBaseUrl: 'https://other.test/odata/Priority/tabula.ini',
        priorityRateScope: 'account',
      }),
    );
  });
  it('uses the minimum active limits and removes a lease idempotently', async () => {
    const a = acquireScheduler({ ...config, priorityMaxConcurrency: 4 });
    const b = acquireScheduler({ ...config, priorityMaxConcurrency: 1, priorityCompany: 'b' });
    expect(a.scheduler).toBe(b.scheduler);
    const release = await a.scheduler.acquire(ctx());
    let entered = false;
    const next = b.scheduler.acquire(ctx()).then((r) => {
      entered = true;
      return r;
    });
    await Promise.resolve();
    expect(entered).toBe(false);
    b.release();
    b.release();
    (await next)();
    release();
    a.release();
    const c = acquireScheduler(config);
    expect(c.scheduler).not.toBe(a.scheduler);
    c.release();
  });
});
