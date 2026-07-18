import type { Config } from '../config.js';

/**
 * Check if write operations are allowed. Returns an error result if not.
 */
export function checkWriteAllowed(
  config: Config,
):
  | { blocked: true; result: { content: Array<{ type: 'text'; text: string }>; isError: true } }
  | { blocked: false } {
  if (config.priorityReadOnly) {
    return {
      blocked: true,
      result: {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error:
                'Server is in read-only mode (PRIORITY_READ_ONLY=true). Write operations are disabled.',
            }),
          },
        ],
        isError: true,
      },
    };
  }
  return { blocked: false };
}

/**
 * Gate a curated write tool consistently: a dryRun preview comes FIRST (it is non-mutating, so it
 * works even under read-only mode — matching the generic write tools and create_credit_memo), then
 * the read-only guard. Returns a result to return immediately, or null to proceed with the write.
 */
export function previewOrBlock(config: Config, dryRun: boolean, action: string, payload: unknown) {
  if (dryRun) return dryRunResult(action, payload);
  const guard = checkWriteAllowed(config);
  return guard.blocked ? guard.result : null;
}

export function dryRunResult(action: string, payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            dryRun: true,
            action,
            wouldSend: payload,
            note: 'No changes were made. Set dryRun=false to execute.',
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * Dry-run preview for the generic write tools: shows the EXACT HTTP request that WOULD be
 * sent (method + resolved endpoint URL + JSON body) without sending it. Triggered whenever
 * confirm=false (the default).
 */
export function dryRunRequest(method: string, endpoint: string, body: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            dryRun: true,
            wouldSend: { method, endpoint, body },
            note: 'No request was sent. Re-run with confirm=true to execute this write against Priority.',
          },
          null,
          2,
        ),
      },
    ],
  };
}

/**
 * Max characters for a tool result before we truncate. Kept well under the harness's
 * per-result token ceiling so a large list never spills to a temp file (which forces a
 * grep/read round-trip). When exceeded, the largest top-level array(s) are trimmed and a
 * sibling note explains how to narrow the query.
 */
const MAX_RESULT_CHARS = 24000;

/** Key of the array-valued property whose serialized form is largest, or null if none. */
function largestArrayKey(obj: Record<string, unknown>): string | null {
  let best: string | null = null;
  let bestSize = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length > 1) {
      const size = JSON.stringify(v).length;
      if (size > bestSize) {
        bestSize = size;
        best = k;
      }
    }
  }
  return best;
}

/**
 * Shrink an oversized result by halving its biggest array(s) until it fits the budget,
 * annotating what was omitted. Pure: returns a shallow-cloned object, never mutates input.
 */
function capLargeArrays(data: unknown): unknown {
  if (data === null || typeof data !== 'object') return data;
  const obj: Record<string, unknown> = Array.isArray(data) ? { value: [...data] } : { ...data };
  const originalLen: Record<string, number> = {};
  let guard = 0;
  while (JSON.stringify(obj, null, 2).length > MAX_RESULT_CHARS && guard++ < 200) {
    const key = largestArrayKey(obj);
    if (!key) break;
    const arr = obj[key] as unknown[];
    if (!(key in originalLen)) originalLen[key] = arr.length; // remember pre-truncation size
    const keep = Math.max(1, Math.floor(arr.length / 2));
    if (keep >= arr.length) break;
    obj[key] = arr.slice(0, keep);
    obj[`${key}_truncated`] = {
      note: `Result too large; showing first ${keep} of ${originalLen[key]}. Narrow with $filter / a smaller top / $select to see the rest.`,
      omitted: originalLen[key] - keep,
    };
  }
  return obj;
}

/**
 * Short-circuit result for a tool whose backing form is NOT exposed on this installation
 * (verified absent from the OData service document). Returns guidance instead of letting the
 * tool issue a request that would 404 (or hang on a slow miss) — and names the form/field to
 * use instead so the caller can pivot via the generic tools.
 */
export function unavailableHere(reason: string, suggestion: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ available: false, reason, suggestion }, null, 2),
      },
    ],
  };
}

export function textResult(data: unknown) {
  let text = JSON.stringify(data, null, 2);
  if (text.length > MAX_RESULT_CHARS) {
    text = JSON.stringify(capLargeArrays(data), null, 2);
    // capLargeArrays only trims top-level arrays of length > 1. A single huge object, a
    // single oversized element, or a one-element array can stay over budget — hard-clamp the
    // string so a result can NEVER spill to a temp file (the grep/read round-trip we're avoiding).
    if (text.length > MAX_RESULT_CHARS) {
      text = `${text.slice(0, MAX_RESULT_CHARS)}\n… [truncated: result exceeded the size limit; narrow with $filter / $select / a smaller top]`;
    }
  }
  return { content: [{ type: 'text' as const, text }] };
}
