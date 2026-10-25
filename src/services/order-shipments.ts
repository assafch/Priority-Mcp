import { PriorityError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { CsdlEntity } from '../lib/csdl.js';
import { escapeODataString } from '../lib/sanitize.js';
import { knowledgeFor } from '../lib/schema-service.js';
import type { RecordIdentity } from '../runtime/types.js';
import {
  ReadBudgetExceeded,
  ReadDependencyBlocked,
  type ReadWorkflowContext,
  type SectionData,
  type WorkflowReadSession,
  assertReadDependencyAllowed,
  headerFields,
} from './read-policy.js';

type Row = Record<string, unknown>;
const carrierWarning =
  'ERP document headers, tracking labels and airway bills are not carrier delivery proof; customer delivery remains unverified.';
const scopeWarning =
  'Coverage is limited to DOCUMENTS_D headers linked by exact ORDNAME. Multi-order or mixed ORDERSDOCS links have not been checked; this is not a complete shipment-link history.';
const source = { form: 'DOCUMENTS_D', relation: 'ORDNAME exact' } as const;

/** Caller supplies an identity already read uncached within this workflow's shared session. */
export async function readOrderShipmentSources(
  orderIdentity: RecordIdentity,
  context: ReadWorkflowContext,
  session: WorkflowReadSession,
): Promise<SectionData> {
  const orderNumber = orderIdentity.keys.ORDNAME;
  if (orderIdentity.form !== 'ORDERS' || typeof orderNumber !== 'string' || !orderNumber)
    throw new Error('An exact verified order identity is required before reading document links.');
  const check = () => {
    assertReadDependencyAllowed(context.config, 'priority_get_order_shipment_status');
    assertReadDependencyAllowed(context.config, 'priority_get_order');
    context.signal.throwIfAborted();
    if (Date.now() >= session.deadlineAt) throw new ReadBudgetExceeded();
  };
  const base = {
    orderNumber,
    deliveryVerified: false,
    coverageScope: 'DOCUMENTS_D headers with exact ORDNAME only; multi-order links unverified',
    source,
    directLinkCoverageComplete: false,
  };
  const unknown = (warning: string): SectionData => ({
    data: { ...base, sourceAvailability: 'unknown' },
    complete: false,
    warnings: [carrierWarning, scopeWarning, warning],
  });
  check();
  let schema: CsdlEntity;
  let schemaWarnings: string[];
  try {
    const result = await knowledgeFor(context.client).schemas.get(
      'DOCUMENTS_D',
      { purpose: 'read' },
      context,
    );
    schema = result.schema;
    schemaWarnings = result.evidence.warnings;
  } catch (error) {
    if (error instanceof ReadDependencyBlocked || context.signal.aborted) throw error;
    return unknown(
      'The direct-order document source metadata could not be verified; no guessed shipment expansion was attempted.',
    );
  }
  check();
  const fields = new Map(schema.fields.map((field) => [field.name, field]));
  if (
    schema.entity !== 'DOCUMENTS_D' ||
    fields.get('ORDNAME')?.type !== 'Edm.String' ||
    !schema.key.includes('DOCNO') ||
    !schema.key.includes('TYPE') ||
    schema.key.some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !fields.has(key))
  )
    return unknown(
      'Metadata did not establish the exact ORDNAME relation and full DOCUMENTS_D identity; document/shipment links remain unknown.',
    );
  const projection = [
    ...new Set([
      ...schema.key,
      'ORDNAME',
      ...['CURDATE', 'STATDES', 'SHIPPERNAME', 'SHIPPERDES', 'AIRWAYBILL', 'DISTRDATE'].filter(
        (field) => fields.has(field),
      ),
    ]),
  ];
  const maxRows = Math.min(25, session.availableRows());
  if (maxRows < 1)
    return unknown(
      'The shared read-row budget was exhausted before direct-order document coverage could be checked.',
    );
  const rows = new Map<string, Row>();
  const warnings = [carrierWarning, scopeWarning, ...schemaWarnings];
  const seen = new Set<string>();
  let skip = 0;
  let observedRows = 0;
  let next: string | undefined;
  let directLinkCoverageComplete = false;
  let invalidRows = false;
  let stopReason = 'maxRows';
  while (observedRows < maxRows) {
    check();
    if (next && seen.has(next)) {
      stopReason = 'continuationLoop';
      break;
    }
    if (next) {
      let continuationForm: string | undefined;
      try {
        continuationForm = decodeURIComponent(
          new URL(next, 'https://continuation.invalid/').pathname.split('/').at(-1) ?? '',
        );
      } catch {
        /* A malformed continuation cannot establish the declared source. */
      }
      if (continuationForm !== source.form) {
        stopReason = 'continuationSourceMismatch';
        break;
      }
      seen.add(next);
    }
    let page: { value: Row[]; '@odata.nextLink'?: string };
    try {
      page = await session.read(maxRows - observedRows, async (limit) => {
        check();
        const qb = new ODataBuilder()
          .filter(`ORDNAME eq '${escapeODataString(orderNumber)}'`)
          .select(...projection)
          .top(limit);
        if (skip) qb.skip(skip);
        for (const key of schema.key) qb.orderBy(key);
        const data = next
          ? await context.client.listNext<Row>(next, { signal: context.signal })
          : await context.client.list<Row>('DOCUMENTS_D', qb.build(), {
              cache: false,
              signal: context.signal,
            });
        check();
        if (!Array.isArray(data.value))
          throw new Error('The direct-order document source did not return a collection.');
        return { data, rows: Math.min(limit, data.value.length) };
      });
    } catch (error) {
      if (error instanceof ReadDependencyBlocked || context.signal.aborted) throw error;
      stopReason = error instanceof ReadBudgetExceeded ? 'budget' : 'sourceUnavailable';
      warnings.push(
        error instanceof PriorityError
          ? `Direct-order document read failed with HTTP ${error.statusCode}; source coverage remains unknown.`
          : 'A source read or the shared row/page/deadline budget prevented complete direct-link coverage.',
      );
      if (!rows.size && stopReason === 'sourceUnavailable')
        return unknown(warnings.at(-1) ?? 'Direct-order document source unavailable.');
      break;
    }
    const remaining = maxRows - observedRows;
    const accepted = page.value.slice(0, remaining);
    observedRows += accepted.length;
    skip += accepted.length;
    for (const row of accepted) {
      if (
        !row ||
        typeof row !== 'object' ||
        Array.isArray(row) ||
        row.ORDNAME !== orderNumber ||
        schema.key.some(
          (key) =>
            !(
              (typeof row[key] === 'string' && row[key] !== '') ||
              (typeof row[key] === 'number' && Number.isFinite(row[key]))
            ),
        )
      ) {
        invalidRows = true;
        continue;
      }
      rows.set(
        JSON.stringify(schema.key.map((key) => row[key])),
        headerFields(
          Object.fromEntries(
            projection.filter((field) => field in row).map((field) => [field, row[field]]),
          ),
        ),
      );
    }
    if (page.value.length > remaining) {
      stopReason = 'maxRows';
      break;
    }
    next = page['@odata.nextLink'];
    if (!next && page.value.length === 0) {
      directLinkCoverageComplete = !invalidRows;
      stopReason = invalidRows ? 'unverifiedDocumentIdentity' : 'exhausted';
      break;
    }
  }
  check();
  if (invalidRows)
    warnings.push(
      'Rows without the exact order relation or complete source key were suppressed; direct-link coverage is incomplete.',
    );
  if (!directLinkCoverageComplete)
    warnings.push(
      `Direct-order document coverage is incomplete (${stopReason}); no absence or full shipment-history claim is supported.`,
    );
  const erpDocuments = [...rows.values()];
  return {
    data: {
      ...base,
      sourceAvailability: 'verified',
      directLinkCoverageComplete,
      erpDocuments,
      // Retained legacy shape; these are the same ERP headers, never carrier-verified shipments.
      shipments: erpDocuments,
      shipmentsInterpretation:
        'Compatibility alias of erpDocuments; ERP document headers only, not carrier shipment/delivery verification.',
      returned: erpDocuments.length,
      scanned: observedRows,
      stopReason,
    },
    // The selected direct relation can be exhausted while multi-order links remain unverified.
    complete: false,
    warnings,
  };
}
