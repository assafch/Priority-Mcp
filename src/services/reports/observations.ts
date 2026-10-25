import { currentOperation, readObservationSnapshot } from '../../runtime/operation-context.js';
export function scanOperationOptions() {
  return { signal: currentOperation()?.signal, deadlineAt: currentOperation()?.deadlineAt };
}
export function scanObservation(
  scan: { complete: boolean; pages: number; stopReason: string },
  _firstObservedAt: string,
) {
  const observation = readObservationSnapshot();
  const known = observation.liveReads + observation.cachedReads > 0;
  const last = known ? observation.lastObservedAt : null;
  return {
    source: 'Priority paged read',
    ...observation,
    observedAt: known ? observation.observedAt : null,
    freshness: known ? observation.freshness : 'unknown',
    complete: scan.complete,
    coverageComplete: scan.complete,
    consistency: 'multi-observation',
    snapshotConsistent: false,
    firstObservedAt: known ? observation.firstObservedAt : null,
    lastObservedAt: last,
    traceId: currentOperation()?.traceId ?? 'local',
    nextCursor: null,
    warnings: [
      ...(scan.complete ? [] : [`Source scan incomplete: ${scan.stopReason}.`]),
      ...(known
        ? []
        : [
            'Source observation timestamps are unavailable; formatting time is not a read observation.',
          ]),
    ],
  };
}
