import type { Config } from '../config.js';

/**
 * Check if write operations are allowed. Returns an error result if not.
 */
export function checkWriteAllowed(config: Config): { blocked: true; result: { content: Array<{ type: 'text'; text: string }>; isError: true } } | { blocked: false } {
  if (config.priorityReadOnly) {
    return {
      blocked: true,
      result: {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Server is in read-only mode (PRIORITY_READ_ONLY=true). Write operations are disabled.' }) }],
        isError: true,
      },
    };
  }
  return { blocked: false };
}

export function dryRunResult(action: string, payload: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ dryRun: true, action, wouldSend: payload, note: 'No changes were made. Set dryRun=false to execute.' }, null, 2),
    }],
  };
}

export function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}
