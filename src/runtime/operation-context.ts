import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { OperationContext, ReadObservations } from './types.js';

const operations = new AsyncLocalStorage<OperationContext>();
export function withOperation<T>(ctx: OperationContext, run: () => Promise<T>): Promise<T> {
  ctx.readObservations ??= emptyReadObservations();
  return operations.run(ctx, run);
}
export function currentOperation(): OperationContext | undefined {
  return operations.getStore();
}
/** No timer: the scheduler enforces deadlineAt and composes cancellation. */
export function createOperation(
  toolName: string,
  options: Partial<OperationContext> = {},
): OperationContext {
  const workClass = options.workClass ?? 'interactive';
  return {
    traceId: randomUUID(),
    toolName,
    workClass,
    deadlineAt:
      Date.now() + (workClass === 'report' || workClass === 'discovery' ? 120_000 : 20_000),
    signal: new AbortController().signal,
    readObservations: emptyReadObservations(),
    ...options,
  };
}

export function emptyReadObservations(): ReadObservations {
  return { oldestAt: null, newestAt: null, liveReads: 0, cachedReads: 0, sensitiveReads: 0 };
}
export function recordReadObservation(
  ctx: OperationContext,
  observedAt: number,
  cached: boolean,
  sensitive = false,
): void {
  if (!Number.isFinite(observedAt)) return;
  ctx.readObservations ??= emptyReadObservations();
  const aggregate = ctx.readObservations;
  aggregate.oldestAt =
    aggregate.oldestAt === null ? observedAt : Math.min(aggregate.oldestAt, observedAt);
  aggregate.newestAt =
    aggregate.newestAt === null ? observedAt : Math.max(aggregate.newestAt, observedAt);
  if (cached) aggregate.cachedReads++;
  else aggregate.liveReads++;
  if (sensitive) aggregate.sensitiveReads++;
}
export function readObservationSnapshot(ctx: OperationContext | undefined = currentOperation()) {
  const observations = ctx?.readObservations;
  const observedAt = observations?.oldestAt ?? null;
  const last = observations?.newestAt ?? null;
  return {
    observedAt: observedAt === null ? null : new Date(observedAt).toISOString(),
    firstObservedAt: observedAt === null ? null : new Date(observedAt).toISOString(),
    lastObservedAt: last === null ? null : new Date(last).toISOString(),
    freshness: observations?.cachedReads
      ? ('cached' as const)
      : observations?.liveReads
        ? ('live' as const)
        : ('unknown' as const),
    ageMs: observedAt === null ? null : Math.max(0, Date.now() - observedAt),
    liveReads: observations?.liveReads ?? 0,
    cachedReads: observations?.cachedReads ?? 0,
    sensitiveReads: observations?.sensitiveReads ?? 0,
  };
}
