import { z } from 'zod';
import type { EvidenceMeta } from '../runtime/types.js';
import { boundedPayload } from './tool-result.js';
export const evidenceSchema = z.looseObject({
  source: z.string(),
  observedAt: z.string().nullable(),
  freshness: z.enum(['live', 'cached', 'stale', 'unknown']),
  complete: z.boolean().nullable(),
  warnings: z.array(z.string()),
  traceId: z.string(),
  nextCursor: z.string().nullable(),
});
export function formatResult(
  data: Record<string, unknown>,
  options: { mode: 'summary' | 'detail'; rowLimit: number; meta: EvidenceMeta },
) {
  const value = structuredClone(data);
  let trimmed = false;
  if (options.mode === 'summary') {
    const visit = (object: Record<string, unknown>, depth = 0) => {
      if (depth > 20) return;
      for (const [key, item] of Object.entries(object)) {
        if (Array.isArray(item)) {
          if (item.length > options.rowLimit) {
            object[key] = item.slice(0, options.rowLimit);
            trimmed = true;
          }
        } else if (item && typeof item === 'object')
          visit(item as Record<string, unknown>, depth + 1);
      }
    };
    visit(value);
  }
  const budget = options.mode === 'summary' ? 8000 : 24000;
  // Preserve the typed envelope even when a very wide section cannot fit. Calculations
  // were already completed; omission is a display fact, separate from source coverage.
  if (value.sections && typeof value.sections === 'object' && !Array.isArray(value.sections)) {
    const sections = Object.values(value.sections as Record<string, Record<string, unknown>>)
      .filter((section) => section && typeof section === 'object' && 'data' in section)
      .sort((a, b) => JSON.stringify(b.data).length - JSON.stringify(a.data).length);
    for (const section of sections) {
      if (
        JSON.stringify({ ...value, meta: { ...options.meta, outputTruncated: true } }, null, 2)
          .length <= budget
      )
        break;
      section.data = {
        omitted: true,
        note: 'Section display exceeds output budget; use the corresponding detail read tool.',
      };
      trimmed = true;
    }
  }
  const structuredContent = boundedPayload(
    { ...value, meta: { ...options.meta, ...(trimmed ? { outputTruncated: true } : {}) } },
    budget,
    true,
  );
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}
export function outputSchemaFor(name: string) {
  if (name === 'priority_resolve_entity')
    return z.looseObject({
      status: z.enum(['resolved', 'ambiguous', 'not-found-in-scan']),
      candidates: z.array(
        z.looseObject({
          identity: z.object({
            form: z.string(),
            keys: z.record(z.string(), z.union([z.string(), z.number()])),
          }),
          displayName: z.string(),
          rank: z.number(),
          matchReasons: z.array(z.string()),
        }),
      ),
      meta: evidenceSchema,
    });
  if (name === 'priority_prepare_query')
    return z.looseObject({
      query: z.string(),
      source: z.string(),
      costClass: z.enum(['small', 'scan', 'heavy']),
      reasons: z.array(z.string()),
      meta: evidenceSchema,
    });
  if (
    [
      'priority_customer_snapshot',
      'priority_order_diagnosis',
      'priority_import_diagnosis',
    ].includes(name)
  )
    return z.looseObject({
      identity: z
        .object({ form: z.string(), keys: z.record(z.string(), z.union([z.string(), z.number()])) })
        .nullable(),
      sections: z.record(
        z.string(),
        z.object({
          status: z.enum(['available', 'blocked', 'failed', 'incomplete']),
          data: z.unknown().optional(),
          meta: evidenceSchema,
        }),
      ),
      meta: evidenceSchema,
    });
  return z.looseObject({});
}
