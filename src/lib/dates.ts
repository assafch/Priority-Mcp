/**
 * Date-literal normalization for Priority OData filters.
 *
 * Priority date columns are Edm.DateTimeOffset and (on at least some installations) REJECT a
 * bare date literal: `IVDATE ge 2026-05-01` →
 *   400 "Invalid DateTimeOffset format '2026-05-01', expected 'yyyy-mm-ddThh:mm:ss+hh:mm'".
 * A full datetimeoffset works. So we expand a date-only input to a full instant before it
 * reaches a $filter: the start of the day for range starts, the end of the day for range ends.
 * Inputs that already carry a time component are passed through unchanged.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// A datetime WITHOUT a timezone offset, e.g. '2026-05-01T10:30' or '2026-05-01 10:30:00'.
const NAIVE_DATETIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * Normalize a date/datetime input into a full OData datetimeoffset literal — the only shape this
 * installation accepts (it 400s on bare dates AND on offset-less datetimes).
 *  - 'YYYY-MM-DD'                → start (or end) of that day, in UTC.
 *  - 'YYYY-MM-DD[ T]HH:MM[:SS]'  → that instant, tagged UTC ('Z') since no offset was given.
 *  - anything already carrying an offset (Z or ±hh:mm) is passed through unchanged.
 */
export function toODataDateTime(value: string, opts?: { endOfDay?: boolean }): string {
  const v = value.trim();
  validateDate(v);
  if (DATE_ONLY.test(v)) {
    return opts?.endOfDay ? `${v}T23:59:59Z` : `${v}T00:00:00Z`;
  }
  const naive = v.match(NAIVE_DATETIME);
  if (naive) return `${naive[1]}T${naive[2]}Z`;
  return v;
}

/** Range start: 'YYYY-MM-DD' → start of that day. */
export function dateFrom(value: string): string {
  return toODataDateTime(value);
}

/** Range end: 'YYYY-MM-DD' → end of that day (inclusive). */
export function dateTo(value: string): string {
  return toODataDateTime(value, { endOfDay: true });
}

/** Reject rollover dates (Date.parse accepts February 30) and malformed/timezone values. */
function validateDate(value: string): void {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|([+-])(\d{2}):?(\d{2}))?)?$/.exec(
      value,
    );
  if (!match) throw new Error(`Invalid ISO date: ${value}`);
  const [, yy, mm, dd, hh, mi, ss, , oh, om] = match;
  const year = Number(yy);
  const month = Number(mm);
  const day = Number(dd);
  const calendar = new Date(`${yy}-${mm}-${dd}T00:00:00Z`);
  if (
    !Number.isFinite(calendar.getTime()) ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() + 1 !== month ||
    calendar.getUTCDate() !== day ||
    Number(hh ?? 0) > 23 ||
    Number(mi ?? 0) > 59 ||
    Number(ss ?? 0) > 59 ||
    Number(oh ?? 0) > 23 ||
    Number(om ?? 0) > 59
  )
    throw new Error(`Invalid calendar date: ${value}`);
}

/** Date-only ranges are UTC calendar days; explicit offsets retain their instant meaning. */
export function dateRange(
  fromValue?: string,
  toValue?: string,
): { from?: string; to?: string; upperOperator: 'lt' | 'le' } {
  const from = fromValue === undefined ? undefined : dateFrom(fromValue);
  let to = toValue === undefined ? undefined : toODataDateTime(toValue);
  const dayEnd = toValue !== undefined && DATE_ONLY.test(toValue.trim());
  if (dayEnd && to) to = new Date(Date.parse(to) + 86_400_000).toISOString().replace('.000Z', 'Z');
  if (
    from &&
    to &&
    (dayEnd ? Date.parse(from) >= Date.parse(to) : Date.parse(from) > Date.parse(to))
  )
    throw new Error('dateFrom must not be after dateTo');
  return { ...(from ? { from } : {}), ...(to ? { to } : {}), upperOperator: dayEnd ? 'lt' : 'le' };
}

/** Validated OData range expression, safe to use before any backend request. */
export function dateRangeFilter(field: string, from?: string, to?: string): string {
  const range = dateRange(from, to);
  return [
    range.from && `${field} ge ${range.from}`,
    range.to && `${field} ${range.upperOperator} ${range.to}`,
  ]
    .filter(Boolean)
    .join(' and ');
}
