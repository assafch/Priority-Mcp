import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

export class PriorityError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly priorityCode?: string,
    public readonly suggestion?: string,
    /** Raw response body from Priority, surfaced verbatim so the model can self-correct. */
    public readonly body?: unknown,
    /** Parsed Retry-After delay in ms, when the server sent one (429 responses). */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'PriorityError';
  }
}

/**
 * Parse an HTTP Retry-After header (delta-seconds or an HTTP-date) into milliseconds.
 * Returns undefined when absent or unparseable.
 */
export function parseRetryAfterMs(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const when = Date.parse(trimmed);
  if (!Number.isNaN(when)) return Math.max(0, when - now);
  return undefined;
}

/** Render a raw body for inclusion in an error message, truncated to stay readable. */
function renderBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (!text || text === '{}') return '';
  const trimmed = text.length > 1500 ? `${text.slice(0, 1500)}… [truncated]` : text;
  return ` | response body: ${trimmed}`;
}

/**
 * Turn a Priority error into a one-line, actionable hint so the model can self-correct in a
 * single follow-up call instead of guessing. Returns '' when no specific hint applies.
 */
export function hintForError(err: PriorityError): string {
  const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body ?? '');
  const hay = `${err.message} ${body}`;
  const low = hay.toLowerCase();

  // Unsupported OData function (this install rejects contains/startswith/etc. with 501).
  // Only treat a message-text match as a string-function error when it actually names one —
  // otherwise "$expand/$apply is not supported" would wrongly get string-function advice.
  const namesStringFn = /\b(contains|startswith|endswith|substringof|tolower|toupper)\b/.test(low);
  if (err.statusCode === 501 || (low.includes('is not supported') && namesStringFn)) {
    const fn = hay.match(/Function\s+['"]?(\w+)['"]?\s+is not supported/i)?.[1];
    const which = fn ? `'${fn}' function` : 'function used';
    return ` Hint: this Priority installation does not support the OData ${which}. Use eq/ne/gt/ge/lt/le filters and date ranges instead of string functions, or use the search tools (priority_search_customers / priority_search_products), which fall back to server-side matching when string functions are unavailable.`;
  }

  // Form not enabled for the API on this installation. Priority returns HTTP 400 with
  // "לא ניתן להפעיל API למסך זה" (≈ "cannot enable API for this form"). This is a per-form
  // Priority setting ("Available for API"), not something this server can change — so name the
  // condition clearly. If an admin re-enables the form, the same tool starts working again.
  if (
    err.statusCode === 400 &&
    (low.includes('להפעיל api') || /cannot (enable|activate) (the )?api/i.test(low))
  ) {
    return ' Hint: this form is not enabled for the API on this Priority installation (its "Available for API" flag is off). Ask a Priority admin to enable it in the API/Limited-Access Forms screen, or use a form that is exposed (discover them with priority_list_forms).';
  }

  // Unknown field/property in $filter, $select, or $orderby.
  const prop = hay.match(/Could not find a property named '([^']+)'/i);
  if (prop) {
    const form = hay.match(/on type '(?:Priority\.OData\.)?([A-Za-z0-9_]+)'/i)?.[1];
    const onForm = form ? ` on form ${form}` : '';
    const describe = form
      ? `priority_describe_form({ form: '${form}' })`
      : 'priority_describe_form';
    return ` Hint: the field '${prop[1]}' does not exist${onForm}. Call ${describe} or priority_get_entity_metadata to get the exact (UPPERCASE) field names before retrying.`;
  }

  return '';
}

export function toMcpError(err: unknown): McpError {
  if (err instanceof PriorityError) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      return new McpError(
        ErrorCode.InvalidRequest,
        `Authentication failed: ${err.message}. Check PRIORITY_USERNAME and PRIORITY_PASSWORD.`,
      );
    }
    if (err.statusCode === 404) {
      return new McpError(
        ErrorCode.InvalidRequest,
        `Not found: ${err.message}${err.suggestion ? `. ${err.suggestion}` : ''}${renderBody(err.body)}`,
      );
    }
    if (err.statusCode === 429) {
      return new McpError(
        ErrorCode.InvalidRequest,
        'Rate limited by Priority server. Try again shortly.',
      );
    }
    return new McpError(
      ErrorCode.InternalError,
      `Priority API error (${err.statusCode}): ${err.message}${err.suggestion ? `. ${err.suggestion}` : ''}${hintForError(err)}${renderBody(err.body)}`,
    );
  }
  if (err instanceof Error) {
    return new McpError(ErrorCode.InternalError, err.message);
  }
  return new McpError(ErrorCode.InternalError, String(err));
}

/**
 * Parse Priority's sometimes-cryptic error responses into a readable message.
 */
export function parsePriorityErrorBody(body: unknown): { message: string; code?: string } {
  if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;
    // Priority wraps errors in odata.error or error
    const odataErr = (obj['odata.error'] ?? obj.error) as Record<string, unknown> | undefined;
    if (odataErr) {
      const msg =
        typeof odataErr.message === 'object'
          ? (odataErr.message as Record<string, unknown>).value
          : odataErr.message;
      return {
        message: String(msg ?? 'Unknown Priority error'),
        code: odataErr.code as string | undefined,
      };
    }
    if (obj.message) return { message: String(obj.message) };
  }
  return { message: typeof body === 'string' ? body : 'Unknown error' };
}
