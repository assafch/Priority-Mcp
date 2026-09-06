import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { aliasHint } from '../lib/form-aliases.js';
import { FORM_SCHEMA, isCompositeKey } from '../lib/priority-schema.js';

/** What was requested, as parsed from the request URL — lets an error name the form it was about. */
export interface RequestedResource {
  /** The form / entity-set name, e.g. 'IMPFILES'. */
  form: string;
  /** True when the URL carried a key predicate, e.g. IMPFILES('IM25000012'). */
  keyed: boolean;
}

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
    /** The form (and whether a key was used) this request targeted. */
    public readonly resource?: RequestedResource,
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
    const form = err.resource?.form;
    return ` Hint: the form${form ? ` '${form}'` : ''} EXISTS on this Priority installation but is not enabled for the API (its "Available for API" flag is off) — note this is NOT a 404: the name is right, the permission is missing. Ask a Priority admin to tick it in the API/Limited-Access Forms screen, or use a form that is exposed (discover them with priority_list_forms).`;
  }

  // Wrong number of key values in the URL — the composite-key mistake, caught explicitly.
  // Priority answers either 400 "The number of keys specified in the URI does not match number of
  // key properties" or a bare 404 (see notFoundMessage) depending on the form; both mean the same
  // thing, so both get the same fix.
  if (/number of keys specified in the URI does not match/i.test(hay)) {
    const form = err.resource?.form;
    const keys = form ? FORM_SCHEMA[form]?.key : undefined;
    return ` Hint: ${form ?? 'this form'} has a COMPOSITE key${
      keys ? ` (${keys.join(', ')})` : ''
    } on this installation, so a single-value key predicate cannot address a record. Use priority_query with a $filter on every key field${
      keys ? ` (e.g. "${keys.map((k) => `${k} eq '…'`).join(' and ')}")` : ''
    }, or a full predicate like ${form ?? 'FORM'}(${(keys ?? ['KEY1', 'KEY2']).map((k) => `${k}='…'`).join(',')}).`;
  }

  // Opaque XML-generation failure. Priority answers 400 with
  // "היתה בעיה ביצירת ה-XML. כפי הנראה באחד השדות קיים ערך שאינו תקין" when a $select names
  // something it cannot project — an unknown column, or a column that exists for FILTERING but is
  // not selectable on that form. Verified live 2026-07-29 on company a051014:
  //   ACCOUNTS?$select=ZZZNOPE                → this message
  //   PINVOICES?$select=VATFLAG               → this message, while
  //   PINVOICES?$filter=VATFLAG eq 'Y'        → 200 OK (same field, filterable but not selectable)
  // The message never names the offending field, so spell out the isolation procedure.
  if (low.includes('ביצירת ה-xml') || /problem (creating|generating) the xml/i.test(low)) {
    const form = err.resource?.form;
    const describe = form
      ? `priority_get_entity_metadata({ entity: '${form}' })`
      : 'priority_get_entity_metadata';
    return ` Hint: this is Priority's generic "could not build the response" error, and on this installation it almost always means a $select field is not selectable on this form${form ? ` (${form})` : ''} — either the name is wrong or the column exists only for filtering (verified: PINVOICES.VATFLAG filters but does not select). Drop the $select entirely to confirm, then re-add fields (or bisect them) to isolate the culprit, and confirm exact names with ${describe}.`;
  }

  // Unknown field/property in $filter, $select, or $orderby.
  const prop = hay.match(/Could not find a property named '([^']+)'/i);
  if (prop) {
    const form = hay.match(/on type '(?:Priority\.OData\.)?([A-Za-z0-9_]+)'/i)?.[1];
    const onForm = form ? ` on form ${form}` : '';
    const describe = form
      ? `priority_describe_form({ form: '${form}' })`
      : 'priority_describe_form';
    return ` Hint: the field '${prop[1]}' does not exist${onForm}. Call ${describe} or priority_get_entity_metadata to get the exact (UPPERCASE) field names before retrying. If the field IS on the Priority screen, it may exist for FILTERING but not for $select on this install (verified: PINVOICES.VATFLAG filters fine but cannot be selected) — drop it from $select and keep it in $filter.`;
  }

  return '';
}

/**
 * Explain a 404 in Priority-OData terms. A bare "Not found:" reads like a transient failure, but
 * on this API a 404 is always one of three DIFFERENT, individually fixable things — and Priority
 * distinguishes them only by the response body (verified live 2026-07-29, company a051014):
 *
 *   GET NOSUCHFORM              → 404, EMPTY body   — no such entity set in the service document
 *   GET PINVOICES('GI25000029') → 404, EMPTY body   — composite-keyed form, single-value predicate
 *   GET IMPFILES('IM99999999')  → 404, body "The specified entity was not found" — bad key
 *
 * Note what a 404 is NOT: a form that exists but has its "Available for API" flag off answers
 * 400 "לא ניתן להפעיל API למסך זה". So a 404 means the NAME is unknown here, never a permission.
 */
export function notFoundMessage(err: PriorityError): string {
  const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body ?? '');
  const isBadKey = /specified entity was not found/i.test(`${err.message} ${body}`);
  const form = err.resource?.form;
  const named = form ? `'${form}'` : 'the requested entity';

  if (isBadKey && form) {
    return `Not found: no record with that key exists in ${named}${
      isCompositeKey(form)
        ? ` — and ${named} has a COMPOSITE key on this install, so a single-value key predicate can never match; query it with priority_query using a $filter on the key fields instead.`
        : '. The form itself is fine — check the key value (Priority keys are case- and format-sensitive, e.g. IMPFNUM "IM25000012").'
    }`;
  }

  const parts: string[] = [];
  if (err.resource?.keyed && form && isCompositeKey(form)) {
    // Empty-body 404 on a form we KNOW is composite-keyed: the arity is the problem, not the name.
    // (The same mistake sometimes surfaces as 400 "number of keys ... does not match" — see
    // hintForError. Both variants name the key fields so the fix is identical either way.)
    const keys = FORM_SCHEMA[form]?.key ?? [];
    parts.push(
      `Not found: ${named} has a COMPOSITE key (${keys.join(', ')}) on this installation, so the single-value key predicate used here can never match (Priority answers 404 with an empty body). Query it with priority_query using a $filter on every key field (e.g. "${keys
        .map((k) => `${k} eq '…'`)
        .join(' and ')}") instead.`,
    );
  } else {
    parts.push(
      `Not found: ${named} is not in this installation's OData service document — either the name is wrong, or that screen is not exposed as an entity set here. (A form that DOES exist but has its "Available for API" flag off answers 400 "לא ניתן להפעיל API למסך זה", not 404 — so a 404 means the name itself is unknown.)`,
    );
    if (err.resource?.keyed) {
      parts.push(
        'This request also used a key predicate: an empty-body 404 can equally mean the form has a COMPOSITE key, where a single-value predicate never matches.',
      );
    }
  }

  const alias = aliasHint(form);
  if (alias) parts.push(alias);
  parts.push(
    `Discover exposed forms with priority_list_forms({ contains: '${(form ?? 'XXX').slice(0, 6)}' }).`,
  );
  if (err.suggestion) parts.push(err.suggestion);
  return parts.join(' ') + renderBody(err.body);
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
      return new McpError(ErrorCode.InvalidRequest, notFoundMessage(err));
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
