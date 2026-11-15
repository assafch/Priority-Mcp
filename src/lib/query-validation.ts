import type { CsdlEntity, CsdlField } from './csdl.js';
import { dateFrom, dateRange } from './dates.js';
import { getSchema } from './priority-schema.js';

export interface ReadQueryInput {
  form: string;
  fields: string[];
  filters: Array<{
    field: string;
    op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'contains';
    value: string | number | boolean;
  }>;
  dates?: { from?: string; to?: string };
  expand?: string[];
  top?: number;
}
export class QueryValidationError extends Error {
  constructor(
    message: string,
    readonly kind: 'unknown-property' | 'invalid-query' = 'invalid-query',
  ) {
    super(message);
    this.name = 'QueryValidationError';
  }
}
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const operators = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains']);
const isDate = (field: CsdlField) =>
  ['Edm.Date', 'Edm.DateTimeOffset', 'Edm.DateTime'].includes(field.type);
export const quotedString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Validate source/grammar/budgets before even requesting schema metadata. */
export function validateReadQueryInput(input: ReadQueryInput): void {
  if (!identifier.test(input.form))
    throw new QueryValidationError('Use one plain form name; source expressions are not accepted.');
  if (
    !Array.isArray(input.fields) ||
    input.fields.length < 1 ||
    input.fields.length > 100 ||
    input.fields.some((field) => !identifier.test(field))
  )
    throw new QueryValidationError('Specify 1–100 plain field names.');
  if (
    !Array.isArray(input.filters) ||
    input.filters.length > 50 ||
    input.filters.some(
      (filter) =>
        !identifier.test(filter.field) ||
        !operators.has(filter.op) ||
        !['string', 'number', 'boolean'].includes(typeof filter.value),
    )
  )
    throw new QueryValidationError('Use at most 50 typed field/operator/value filters.');
  const top = input.top ?? 50;
  if (!Number.isSafeInteger(top) || top < 1 || top > 500)
    throw new QueryValidationError('top must be an integer from 1 to 500; default is 50.');
  if (
    input.expand &&
    (!Array.isArray(input.expand) ||
      input.expand.length > 2 ||
      input.expand.some((name) => !identifier.test(name)))
  )
    throw new QueryValidationError(
      'Expand at most two named direct subforms; remove wildcard/nested expansion and query a specific subform separately.',
    );
  if (input.dates) dateRange(input.dates.from, input.dates.to);
}
export function requireField(schema: CsdlEntity, name: string): CsdlField {
  const field = schema.fields.find((candidate) => candidate.name === name);
  if (!field)
    throw new QueryValidationError(
      `Unknown field ${name} in the current form schema. Choose a metadata-listed field.`,
      'unknown-property',
    );
  return field;
}
/** A string-typed date-shaped identifier stays a quoted string; schema determines the literal. */
export function typedPredicate(
  field: CsdlField,
  op: ReadQueryInput['filters'][number]['op'],
  value: string | number | boolean,
): string {
  if (op === 'contains' && (field.type !== 'Edm.String' || typeof value !== 'string'))
    throw new QueryValidationError('contains requires a string field and string value.');
  let literal: string;
  if (field.type === 'Edm.String') {
    if (typeof value !== 'string')
      throw new QueryValidationError(`Field ${field.name} requires a string value.`);
    literal = quotedString(value);
  } else if (/^Edm\.(Byte|SByte|Int16|Int32|Int64|Decimal|Double|Single)$/.test(field.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value))
      throw new QueryValidationError(`Field ${field.name} requires a finite number.`);
    if (/Int|Byte/.test(field.type) && !Number.isSafeInteger(value))
      throw new QueryValidationError(`Field ${field.name} requires a safe integer number.`);
    literal = String(value);
  } else if (field.type === 'Edm.Boolean') {
    if (typeof value !== 'boolean')
      throw new QueryValidationError(`Field ${field.name} requires a boolean value.`);
    if (op !== 'eq' && op !== 'ne')
      throw new QueryValidationError('Boolean fields support only eq/ne operators.');
    literal = String(value);
  } else if (isDate(field)) {
    if (typeof value !== 'string')
      throw new QueryValidationError(`Field ${field.name} requires an ISO date string.`);
    literal = dateFrom(value);
    if (field.type === 'Edm.Date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new QueryValidationError('Edm.Date requires YYYY-MM-DD.');
      literal = value;
    }
  } else if (field.type === 'Edm.Guid') {
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    )
      throw new QueryValidationError('Guid fields require a canonical GUID string.');
    if (op !== 'eq' && op !== 'ne')
      throw new QueryValidationError('Guid fields support only eq/ne operators.');
    literal = value;
  } else
    throw new QueryValidationError(
      `Field ${field.name} has an unsupported typed-query type; use an explicit reviewed raw read query.`,
    );
  return op === 'contains'
    ? `contains(${field.name},${literal})`
    : `${field.name} ${op} ${literal}`;
}
export function mappedDateField(schema: CsdlEntity): CsdlField {
  const dates = schema.fields.filter(isDate);
  const hinted = getSchema(schema.entity)?.dateField;
  const known = dates.find((field) => field.name === hinted);
  if (known) return known;
  if (dates.length === 1) return dates[0];
  throw new QueryValidationError(
    'Date-field mapping is ambiguous or absent. Use an explicit typed filter on a metadata-listed date field.',
  );
}
