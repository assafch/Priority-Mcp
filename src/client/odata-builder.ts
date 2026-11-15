/**
 * Type-safe OData query builder for Priority ERP.
 *
 * Encoding contract (matches Priority's OData v4 expectations):
 *  - System option KEYS ($filter, $select, $expand, $orderby, $top, $skip) are LITERAL.
 *  - All option VALUES are percent-encoded so spaces, single quotes, Hebrew, and other
 *    reserved characters transmit correctly. encodeURIComponent leaves `' ( ) * ! - _ . ~`
 *    untouched, so OData string literals ('value'), the doubled-quote escape (''), and
 *    function syntax like contains(FIELD,'value') survive intact.
 *  - String literals are wrapped in single quotes with embedded quotes doubled ('').
 *  - Numbers are emitted with a '.' decimal separator (JS String() is locale-independent).
 *  - Dates are emitted as UNQUOTED ISO 8601 datetimeoffset literals (OData v4).
 */

export type ODataScalar = string | number | boolean | Date;

// A FULL ISO 8601 datetimeoffset — date + time + explicit zone (Z or ±hh:mm), e.g.
// 2026-05-01T00:00:00Z or 2026-05-01T10:30:00+02:00. ONLY this shape is emitted as an unquoted
// OData date literal. A bare date ('2026-05-01') or an offset-less datetime is NOT: on this
// install those are invalid as date literals anyway (date filters must go through dates.ts,
// which produces the full form), and treating a date-SHAPED string value — e.g. a date-coded
// part/lot number — as an unquoted literal produced `PARTNAME eq 2026-05-01`, a 400. Quoting it
// as a string is the correct, unambiguous default.
const ISO_DATETIMEOFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** Format a single value as an OData literal (pre-URL-encoding). */
export function odataLiteral(value: ODataScalar): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return String(value); // always uses '.'
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  // Only a full datetimeoffset is an UNQUOTED date literal; everything else is a quoted string.
  if (ISO_DATETIMEOFFSET.test(value)) return value;
  return `'${value.replace(/'/g, "''")}'`; // string: quote + double embedded quotes
}

const enc = encodeURIComponent;

export class ODataBuilder {
  private filters: string[] = [];
  private selects: string[] = [];
  private expands: string[] = [];
  private orderBys: string[] = [];
  private topValue?: number;
  private skipValue?: number;

  filter(expr: string): this {
    if (expr) this.filters.push(expr);
    return this;
  }

  /** Convenience: field eq value with proper literal formatting. */
  eq(field: string, value: ODataScalar): this {
    return this.filter(`${field} eq ${odataLiteral(value)}`);
  }

  gt(field: string, value: ODataScalar): this {
    return this.filter(`${field} gt ${odataLiteral(value)}`);
  }

  lt(field: string, value: ODataScalar): this {
    return this.filter(`${field} lt ${odataLiteral(value)}`);
  }

  ge(field: string, value: ODataScalar): this {
    return this.filter(`${field} ge ${odataLiteral(value)}`);
  }

  le(field: string, value: ODataScalar): this {
    return this.filter(`${field} le ${odataLiteral(value)}`);
  }

  contains(field: string, value: string): this {
    return this.filter(`contains(${field},${odataLiteral(value)})`);
  }

  startsWith(field: string, value: string): this {
    return this.filter(`startswith(${field},${odataLiteral(value)})`);
  }

  /**
   * Push a parenthesized OR of pre-built condition strings as a SINGLE and-composable term,
   * e.g. orGroup("SUPNAME eq 'X'", "SUPDES eq 'X'") → "(SUPNAME eq 'X' or SUPDES eq 'X')".
   * Callers must format each condition's value themselves (e.g. via escapeODataString).
   * The wrapping parentheses are essential: build() AND-joins every filter term, and OData binds
   * `and` tighter than `or`, so an un-parenthesized OR would let a disjunct escape the AND group
   * and silently merge with unrelated filters. A single condition is pushed as-is (no parens).
   */
  orGroup(...conditions: string[]): this {
    const parts = conditions.filter(Boolean);
    if (parts.length === 1) return this.filter(parts[0]);
    if (parts.length > 1) this.filter(`(${parts.join(' or ')})`);
    return this;
  }

  select(...fields: string[]): this {
    this.selects.push(...fields);
    return this;
  }

  expand(...subforms: string[]): this {
    this.expands.push(...subforms);
    return this;
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.orderBys.push(`${field} ${direction}`);
    return this;
  }

  top(n: number): this {
    this.topValue = n;
    return this;
  }

  skip(n: number): this {
    this.skipValue = n;
    return this;
  }

  build(): string {
    const params: string[] = [];
    // $filter is one expression: percent-encode the whole value.
    if (this.filters.length) params.push(`$filter=${enc(this.filters.join(' and '))}`);
    // For list-valued options, keep the structural commas literal and encode each member.
    if (this.selects.length) params.push(`$select=${this.selects.map(enc).join(',')}`);
    if (this.expands.length) params.push(`$expand=${this.expands.map(enc).join(',')}`);
    if (this.orderBys.length) params.push(`$orderby=${this.orderBys.map(enc).join(',')}`);
    if (this.topValue !== undefined) params.push(`$top=${this.topValue}`);
    if (this.skipValue !== undefined) params.push(`$skip=${this.skipValue}`);
    return params.length ? `?${params.join('&')}` : '';
  }
}
