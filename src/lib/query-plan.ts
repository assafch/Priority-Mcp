import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { EvidenceMeta, OperationContext, RecordIdentity } from '../runtime/types.js';
import type { CsdlEntity } from './csdl.js';
import { dateRange } from './dates.js';
import {
  QueryValidationError,
  type ReadQueryInput,
  mappedDateField,
  requireField,
  typedPredicate,
  validateReadQueryInput,
} from './query-validation.js';
import { knowledgeFor } from './schema-service.js';
export type { ReadQueryInput } from './query-validation.js';
export interface QueryPlanningContext extends OperationContext {
  client: PriorityClient;
}
export interface PreparedReadQuery {
  query: string;
  source: RecordIdentity['form'];
  costClass: 'small' | 'scan' | 'heavy';
  reasons: string[];
  meta: EvidenceMeta;
}
function assertBudget(ctx: OperationContext): void {
  ctx.signal.throwIfAborted();
  if (ctx.deadlineAt <= Date.now()) throw new Error('Query planning deadline exceeded.');
}
function build(input: ReadQueryInput, schema: CsdlEntity): ODataBuilder {
  if (schema.entity !== input.form || !schema.key.length)
    throw new QueryValidationError('Schema source/key evidence does not match the requested form.');
  const fields = [...new Set([...input.fields, ...schema.key])];
  for (const field of fields) requireField(schema, field);
  const builder = new ODataBuilder().select(...fields).top(input.top ?? 50);
  for (const filter of input.filters)
    builder.filter(typedPredicate(requireField(schema, filter.field), filter.op, filter.value));
  if (input.dates && (input.dates.from !== undefined || input.dates.to !== undefined)) {
    const field = mappedDateField(schema);
    const range = dateRange(input.dates.from, input.dates.to);
    const literal = (value: string) => (field.type === 'Edm.Date' ? value.slice(0, 10) : value);
    if (range.from) builder.filter(`${field.name} ge ${literal(range.from)}`);
    if (range.to) builder.filter(`${field.name} ${range.upperOperator} ${literal(range.to)}`);
  }
  for (const subform of new Set(input.expand ?? [])) {
    if (!schema.subforms.includes(subform))
      throw new QueryValidationError(
        `Unknown expansion ${subform}; choose a direct metadata-listed subform.`,
        'unknown-property',
      );
    builder.expand(`${subform}($top=${Math.min(input.top ?? 50, 50)})`);
  }
  for (const key of schema.key) builder.orderBy(key);
  return builder;
}
/** Preview only: metadata reads are permitted, backend data reads and mutations are never executed. */
export async function prepareReadQuery(
  input: ReadQueryInput,
  ctx: QueryPlanningContext,
): Promise<PreparedReadQuery> {
  validateReadQueryInput(input);
  assertBudget(ctx);
  const knowledge = knowledgeFor(ctx.client);
  const access = knowledge.capabilities.get(input.form, 'read');
  if (access && ['unsupported', 'denied', 'absent', 'api-disabled'].includes(access.status))
    throw new QueryValidationError(
      'Form-read capability is unavailable for this client. Check scoped capability evidence.',
    );
  let result = await knowledge.schemas.get(
    input.form,
    { purpose: 'read', allowFullScan: false },
    ctx,
  );
  assertBudget(ctx);
  let builder: ODataBuilder;
  let refreshed = false;
  try {
    builder = build(input, result.schema);
  } catch (error) {
    if (!(error instanceof QueryValidationError) || error.kind !== 'unknown-property') throw error;
    assertBudget(ctx);
    result = await knowledge.schemas.get(
      input.form,
      { purpose: 'read', force: true, allowFullScan: false },
      ctx,
    );
    assertBudget(ctx);
    refreshed = true;
    builder = build(input, result.schema);
  }
  const contains = input.filters.some((filter) => filter.op === 'contains');
  const containsSupport = contains ? knowledge.capabilities.get(input.form, 'contains') : undefined;
  if (
    containsSupport &&
    containsSupport.status !== 'supported' &&
    containsSupport.status !== 'unknown'
  )
    throw new QueryValidationError(
      'contains is unavailable for this form. Use priority_resolve_entity for customer/supplier/product lookup, or an exact typed eq filter; no hidden table scan was performed.',
    );
  const top = input.top ?? 50;
  const expanded = (input.expand?.length ?? 0) > 0;
  const exactKeys = result.schema.key.every((key) =>
    input.filters.some((filter) => filter.field === key && filter.op === 'eq'),
  );
  const costClass = expanded || top > 100 ? 'heavy' : exactKeys ? 'small' : 'scan';
  const reasons = [
    `Source ${input.form} and ${input.fields.length} requested projection fields validated against scoped metadata; full composite identity is included.`,
    `At most ${top} parent rows; ordered by every schema key: ${result.schema.key.join(', ')}.`,
    expanded
      ? `Direct subform expansions are bounded to ${Math.min(top, 50)} rows each, depth 1, maximum 2 subforms.`
      : 'No subform expansion requested.',
    `Cost class ${costClass} is a structural heuristic, not a latency or total scan-work estimate.`,
    'Read-only preview; use an existing authorized read tool to execute this query.',
    ...(input.dates && (input.dates.from !== undefined || input.dates.to !== undefined)
      ? [
          `Date range uses schema-listed ${mappedDateField(result.schema).name}; date-only boundaries are UTC days with an exclusive next-day upper bound.`,
        ]
      : []),
    ...(refreshed
      ? ['One targeted schema refresh rebuilt the preview after unknown-property drift.']
      : []),
  ];
  const warnings = [
    ...result.evidence.warnings,
    'Preview validates schema and query shape; backend execution, result completeness and performance have not been verified.',
  ];
  if (contains && containsSupport?.status !== 'supported')
    warnings.push('contains support is unknown for this form; execution may reject the function.');
  const query = builder.build();
  if (query.length > 8000)
    throw new QueryValidationError(
      'Prepared query exceeds 8000 characters. Narrow projection/filter values or split the read; no truncated query was returned.',
    );
  return {
    query,
    source: input.form,
    costClass,
    reasons,
    meta: {
      ...result.evidence,
      source: 'query-preview:scoped-metadata',
      complete: true,
      traceId: ctx.traceId,
      warnings,
      nextCursor: null,
    },
  };
}
