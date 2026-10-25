import { currentOperation, readObservationSnapshot } from '../runtime/operation-context.js';

/** Bounded, valid JSON for legacy text clients and structured MCP consumers. */
export const MAX_RESULT_CHARS = 24_000;

type JsonObject = Record<string, unknown>;

function objectPayload(data: unknown): JsonObject {
  const normalized = JSON.parse(JSON.stringify(data ?? null));
  return normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized
    : { value: normalized };
}

/** Keep small results identical; trim payloads, never the serialized JSON text. */
export function boundedPayload(
  data: unknown,
  maxChars = MAX_RESULT_CHARS,
  preserveSourceCompleteness = false,
): JsonObject {
  const obj = objectPayload(data);
  if (JSON.stringify(obj, null, 2).length <= maxChars) return obj;
  if (obj.meta && typeof obj.meta === 'object' && !Array.isArray(obj.meta)) {
    const meta = obj.meta as JsonObject;
    if ('complete' in meta) {
      if (!preserveSourceCompleteness) meta.complete = false;
      meta.outputTruncated = true;
    }
  }
  const originalLengths = new Map<string, number>();
  for (let attempt = 0; attempt < 200; attempt++) {
    if (JSON.stringify(obj, null, 2).length <= maxChars) return obj;
    let candidate:
      | { parent: JsonObject; key: string; value: unknown; size: number; path: string }
      | undefined;
    const visit = (parent: JsonObject, prefix: string, depth = 0) => {
      if (depth > 30) return;
      for (const [key, value] of Object.entries(parent)) {
        if (key.endsWith('_truncated')) continue;
        const path = `${prefix}/${key}`;
        const trimmable =
          (Array.isArray(value) && value.length > 1) ||
          (typeof value === 'string' && value.length > 200);
        if (trimmable) {
          const size = JSON.stringify(value).length;
          if (!candidate || size > candidate.size) candidate = { parent, key, value, size, path };
        }
        if (value && typeof value === 'object') visit(value as JsonObject, path, depth + 1);
      }
    };
    visit(obj, '');
    if (!candidate) break;
    const { parent, key, value, path } = candidate;
    if (Array.isArray(value)) {
      if (!originalLengths.has(path)) originalLengths.set(path, value.length);
      const keep = Math.max(1, Math.floor(value.length / 2));
      parent[key] = value.slice(0, keep);
      if (parent === obj && typeof obj.returned === 'number') {
        obj.returned = keep;
        if (typeof obj.skip === 'number' && 'nextSkip' in obj) obj.nextSkip = obj.skip + keep;
      }
      // Array elements cannot hold JSON sibling metadata, so use the containing result if needed.
      if (Array.isArray(parent)) {
        const detail = (obj._truncated ?? {}) as JsonObject;
        const arrays = (detail.arrays ?? {}) as JsonObject;
        arrays[path] = { omitted: (originalLengths.get(path) ?? value.length) - keep, kept: keep };
        obj._truncated = { ...detail, arrays };
      }
      if (!Array.isArray(parent))
        parent[`${key}_truncated`] = {
          omitted: (originalLengths.get(path) ?? value.length) - keep,
          note: 'Result truncated; narrow with filter/select/top to retrieve omitted rows.',
        };
    } else if (typeof value === 'string') {
      const keep = Math.max(100, Math.floor(value.length / 2));
      parent[key] = `${value.slice(0, keep)}… [truncated]`;
    }
  }
  // Very wide/deep objects of small scalar fields cannot be shortened by the loop above.
  // Replace their largest subtrees with an explicit omission marker until they fit.
  while (JSON.stringify(obj, null, 2).length > maxChars) {
    const entries = Object.entries(obj).filter(
      ([k]) => k !== '_truncated' && !(preserveSourceCompleteness && k === 'meta'),
    );
    if (!entries.length) return { _truncated: { note: 'Result omitted: exceeds output budget.' } };
    entries.sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length);
    const [key] = entries[0];
    delete obj[key];
    const previous = obj._truncated as { omittedFields?: number } | undefined;
    obj._truncated = {
      omittedFields: (previous?.omittedFields ?? 0) + 1,
      note: 'Large fields omitted. Narrow with select/filter/top.',
    };
  }
  return obj;
}

export function textResult(data: unknown, maxChars = MAX_RESULT_CHARS) {
  const observation = readObservationSnapshot();
  let payload = data;
  if (observation.sensitiveReads > 0) {
    const object =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as JsonObject)
        : { value: data };
    const previous =
      object.meta && typeof object.meta === 'object' ? (object.meta as JsonObject) : {};
    const ownsObservation = ['observedAt', 'firstObservedAt', 'lastObservedAt', 'freshness'].some(
      (key) => Object.hasOwn(previous, key),
    );
    const sourceStart = previous.firstObservedAt ?? previous.observedAt;
    const sourceTime = typeof sourceStart === 'string' ? Date.parse(sourceStart) : Number.NaN;
    payload = {
      ...object,
      meta: {
        ...previous,
        source: previous.source ?? 'Priority read observations',
        complete: previous.complete ?? null,
        traceId: previous.traceId ?? currentOperation()?.traceId ?? 'local',
        nextCursor: previous.nextCursor ?? null,
        warnings: previous.warnings ?? [],
        ...(ownsObservation
          ? {
              requestObservations: observation,
              ...(Number.isFinite(sourceTime)
                ? { ageMs: Math.max(0, Date.now() - sourceTime) }
                : {}),
            }
          : observation),
      },
    };
  }
  const structuredContent = boundedPayload(payload, maxChars);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}
