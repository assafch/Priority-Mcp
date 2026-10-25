import type { OperationContext } from '../runtime/types.js';

interface Subscriber {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}
interface SharedRead {
  controller: AbortController;
  subscribers: Set<Subscriber>;
}

/** Sharing is explicitly keyed by data scope, cache generation and the exact request URL. */
export class ReadCoalescer {
  private readonly reads = new Map<string, SharedRead>();
  has(key: string): boolean {
    return this.reads.has(key);
  }

  run<T>(
    key: string,
    ctx: OperationContext,
    fetcher: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (ctx.signal?.aborted)
      return Promise.reject(ctx.signal.reason ?? new Error('Read cancelled'));
    if (ctx.deadlineAt <= Date.now()) return Promise.reject(new Error('Read deadline exceeded'));
    let read = this.reads.get(key);
    const fresh = !read;
    if (!read) {
      read = { controller: new AbortController(), subscribers: new Set() };
      this.reads.set(key, read);
    }
    const shared = read;
    const promise = new Promise<T>((resolve, reject) => {
      const cancel = () => {
        subscriber.cleanup();
        shared.subscribers.delete(subscriber);
        reject(ctx.signal?.aborted ? ctx.signal.reason : new Error('Read deadline exceeded'));
        if (!shared.subscribers.size) {
          if (this.reads.get(key) === shared) this.reads.delete(key);
          shared.controller.abort(new Error('All read subscribers cancelled'));
        }
      };
      const timer = setTimeout(cancel, Math.max(0, ctx.deadlineAt - Date.now()));
      timer.unref?.();
      const subscriber: Subscriber = {
        resolve: (value) => resolve(value as T),
        reject,
        cleanup: () => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', cancel);
        },
      };
      shared.subscribers.add(subscriber);
      ctx.signal?.addEventListener('abort', cancel, { once: true });
    });
    if (fresh) {
      const settle = (value: unknown, error: boolean) => {
        if (this.reads.get(key) === shared) this.reads.delete(key);
        for (const subscriber of shared.subscribers) {
          subscriber.cleanup();
          if (error) subscriber.reject(value);
          else subscriber.resolve(value);
        }
        shared.subscribers.clear();
      };
      try {
        void fetcher(shared.controller.signal).then(
          (value) => settle(value, false),
          (error) => settle(error, true),
        );
      } catch (error) {
        settle(error, true);
      }
    }
    return promise;
  }
}
