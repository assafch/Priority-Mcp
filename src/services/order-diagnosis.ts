import { ODataBuilder } from '../client/odata-builder.js';
import { withOperation } from '../runtime/operation-context.js';
import type { ReadBudget } from '../runtime/types.js';
import { readOrderShipmentSources } from './order-shipments.js';
import {
  type ReadWorkflowContext,
  type SectionData,
  WorkflowReadSession,
  type WorkflowSection,
  exactKey,
  finishWorkflow,
  headerFields,
  readSection,
  unavailableSection,
} from './read-policy.js';
export type OrderSection = 'lines' | 'shipments';
export interface OrderDiagnosisInput {
  orderNumber: string;
  sections?: OrderSection[];
  budget: ReadBudget;
}
export async function orderDiagnosis(input: OrderDiagnosisInput, context: ReadWorkflowContext) {
  const key = exactKey(input.orderNumber, 'order ORDNAME');
  const requested = [...new Set<OrderSection>(input.sections ?? ['shipments'])];
  if (requested.some((section) => !['lines', 'shipments'].includes(section)))
    throw new Error('Unknown order section.');
  const session = new WorkflowReadSession(context, input.budget);
  const ctx = { ...context, deadlineAt: session.deadlineAt };
  return withOperation(ctx, async () => {
    const sections: Record<string, WorkflowSection> = {};
    sections.identity = await readSection(
      ctx,
      'priority_get_order',
      'Priority:ORDERS',
      async () => {
        const record = await session.read(1, async () => ({
          data: await ctx.client.get<Record<string, unknown>>('ORDERS', key, undefined, {
            cache: false,
            signal: ctx.signal,
          }),
          rows: 1,
        }));
        if (record.ORDNAME !== key) throw new Error('Exact order identity could not be verified.');
        return { data: headerFields(record), complete: true };
      },
    );
    if (sections.identity.status !== 'available') {
      for (const section of requested)
        sections[section] = unavailableSection(
          ctx,
          section === 'lines'
            ? 'Priority:ORDERS/ORDERITEMS_SUBFORM'
            : 'Priority:DOCUMENTS_D/exact-ORDNAME',
          'Order identity was not verified; no dependent read was attempted.',
        );
      return finishWorkflow(ctx, 'order-diagnosis', null, sections);
    }
    await Promise.all(
      requested.map(async (section) => {
        if (section === 'shipments') {
          sections.shipments = await readSection(
            ctx,
            'priority_get_order_shipment_status',
            'Priority:DOCUMENTS_D/exact-ORDNAME',
            () =>
              readOrderShipmentSources({ form: 'ORDERS', keys: { ORDNAME: key } }, ctx, session),
          );
          return;
        }
        const subform = 'ORDERITEMS_SUBFORM';
        sections[section] = await readSection(
          ctx,
          'priority_get_order',
          `Priority:ORDERS/${subform}`,
          async () =>
            session.read<SectionData>(25, async (limit) => {
              const record = await ctx.client.get<Record<string, unknown>>(
                'ORDERS',
                key,
                new ODataBuilder().select('ORDNAME').expand(`${subform}($top=${limit})`).build(),
                { cache: false, signal: ctx.signal },
              );
              if (record.ORDNAME !== key)
                throw new Error('Order subform source identity mismatch.');
              const source = record[subform];
              if (
                !Array.isArray(source) ||
                source.some((row) => !row || typeof row !== 'object' || Array.isArray(row))
              )
                return {
                  rows: Array.isArray(source) ? Math.min(source.length, limit) : 0,
                  data: {
                    complete: false,
                    warnings: [
                      'Order-line subform was absent or malformed; no verified empty list is available.',
                    ],
                  },
                };
              const rows = source.slice(0, limit).map((row) => headerFields(row));
              const complete = source.length < limit && !record[`${subform}@odata.nextLink`];
              return {
                rows: rows.length,
                data: {
                  data: { orderNumber: key, rows, returned: rows.length },
                  complete,
                  warnings: [
                    ...(complete
                      ? []
                      : [
                          'Nested rows are bounded or continuation remains; source coverage is incomplete.',
                        ]),
                  ],
                },
              };
            }),
        );
      }),
    );
    return finishWorkflow(
      ctx,
      'order-diagnosis',
      { form: 'ORDERS', keys: { ORDNAME: key } },
      sections,
    );
  });
}
