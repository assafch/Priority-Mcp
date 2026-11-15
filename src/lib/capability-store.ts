import { ReadCoalescer } from '../client/read-coalescer.js';
import { createOperation, currentOperation, withOperation } from '../runtime/operation-context.js';
/** Evidence belongs to one authenticated client, not to a global tenant name. */
export type CapabilityStatus =
  | 'supported'
  | 'unsupported'
  | 'denied'
  | 'absent'
  | 'api-disabled'
  | 'unknown';
export interface CapabilityEvidence {
  status: CapabilityStatus;
  checkedAt: string;
  expiresAt: number;
}
export class CapabilityStore {
  private entries = new Map<string, CapabilityEvidence>();
  private pending = new ReadCoalescer();
  private active = 0;
  private queue: Array<{ start: () => void; abort: () => void; signal: AbortSignal }> = [];
  private key(form: string, operation: string) {
    return JSON.stringify([form, operation]);
  }
  get(form: string, operation: string): CapabilityEvidence | undefined {
    const key = this.key(form, operation);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { ...entry };
  }
  put(form: string, operation: string, status: CapabilityStatus): CapabilityEvidence {
    const key = this.key(form, operation);
    const ttl = status === 'unknown' || status === 'denied' ? 30000 : 300000;
    const value = { status, checkedAt: new Date().toISOString(), expiresAt: Date.now() + ttl };
    this.entries.delete(key);
    while (this.entries.size >= 1024) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.entries.delete(first);
    }
    this.entries.set(key, value);
    return { ...value };
  }
  private async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.active >= 4) {
      if (this.queue.length >= 100) throw new Error('Capability probe queue full');
      await new Promise<void>((resolve, reject) => {
        const item = {
          signal,
          start: () => {
            signal.removeEventListener('abort', item.abort);
            resolve();
          },
          abort: () => {
            const i = this.queue.indexOf(item);
            if (i >= 0) this.queue.splice(i, 1);
            reject(signal.reason);
          },
        };
        this.queue.push(item);
        signal.addEventListener('abort', item.abort, { once: true });
      });
    } else this.active++;
    return () => {
      const next = this.queue.shift();
      if (next) next.start();
      else this.active--;
    };
  }
  async probe(
    form: string,
    operation: string,
    run: () => Promise<CapabilityStatus>,
    force = false,
  ): Promise<CapabilityEvidence> {
    const subscriber =
      currentOperation() ?? createOperation('capabilities', { workClass: 'discovery' });
    subscriber.signal.throwIfAborted();
    if (subscriber.deadlineAt <= Date.now()) throw new Error('Capability deadline exceeded');
    const key = this.key(form, operation);
    const existing = this.get(form, operation);
    if (existing && !force) return existing;
    const result = await this.pending.run(key, subscriber, (signal) =>
      withOperation({ ...subscriber, signal, deadlineAt: Number.POSITIVE_INFINITY }, async () => {
        const release = await this.acquire(signal);
        try {
          signal.throwIfAborted();
          const verdict = await run();
          signal.throwIfAborted();
          return this.put(form, operation, verdict);
        } finally {
          release();
        }
      }),
    );
    return { ...result };
  }
}
