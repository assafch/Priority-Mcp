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
              status: 'blocked',
              acknowledged: false,
              verified: false,
              verification: { reason: 'Server read-only policy blocks execution.' },
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
            status: 'preview',
            acknowledged: false,
            verified: false,
            verification: { reason: 'Preview only; no write was attempted.' },
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
            status: 'preview',
            acknowledged: false,
            verified: false,
            verification: { reason: 'Preview only; no write was attempted.' },
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

export { textResult } from './tool-result.js';
