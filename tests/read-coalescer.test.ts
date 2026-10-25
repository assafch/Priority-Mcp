import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadCoalescer } from '../src/client/read-coalescer.js';
const ctx = (signal?: AbortSignal) => ({
  traceId: 'test',
  toolName: 'test',
  workClass: 'interactive' as const,
  deadlineAt: Date.now() + 10000,
  signal,
});
afterEach(() => vi.useRealTimers());
describe('read subscriber isolation', () => {
  it('runs twenty identical reads once and removes rejected work', async () => {
    const coalescer = new ReadCoalescer();
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return { value: 3 };
    };
    const results = await Promise.all(
      Array.from({ length: 20 }, () => coalescer.run('scope:generation:url', ctx(), fetcher)),
    );
    expect(calls).toBe(1);
    expect(results).toEqual(Array.from({ length: 20 }, () => ({ value: 3 })));
    await expect(
      coalescer.run('bad', ctx(), async () => {
        throw new Error('broken');
      }),
    ).rejects.toThrow('broken');
    expect(await coalescer.run('bad', ctx(), fetcher)).toEqual({ value: 3 });
  });
  it('aborting one subscriber leaves another read successful', async () => {
    const coalescer = new ReadCoalescer();
    const a = new AbortController();
    let finish!: (v: number) => void;
    let sharedSignal!: AbortSignal;
    const fetcher = (signal: AbortSignal) => {
      sharedSignal = signal;
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    };
    const first = coalescer.run('same', ctx(a.signal), fetcher);
    const second = coalescer.run('same', ctx(), fetcher);
    a.abort();
    await expect(first).rejects.toThrow();
    expect(sharedSignal.aborted).toBe(false);
    finish(4);
    expect(await second).toBe(4);
  });
  it('all subscribers cancelling aborts underlying work and allows fresh work immediately', async () => {
    const coalescer = new ReadCoalescer();
    const a = new AbortController();
    let sharedSignal!: AbortSignal;
    const request = coalescer.run('same', ctx(a.signal), (signal) => {
      sharedSignal = signal;
      return new Promise(() => {});
    });
    a.abort();
    await expect(request).rejects.toThrow();
    expect(sharedSignal.aborted).toBe(true);
    expect(await coalescer.run('same', ctx(), async () => 5)).toBe(5);
  });
  it('expires each subscriber independently without cancelling a later deadline', async () => {
    vi.useFakeTimers();
    const coalescer = new ReadCoalescer();
    let finish!: (v: number) => void;
    const fetcher = () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      });
    const first = coalescer.run('same', { ...ctx(), deadlineAt: Date.now() + 10 }, fetcher);
    const rejected = expect(first).rejects.toThrow(/deadline/i);
    const second = coalescer.run('same', ctx(), fetcher);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    finish(6);
    expect(await second).toBe(6);
  });
});
