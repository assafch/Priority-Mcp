import { ODataBuilder } from '../client/odata-builder.js';
import { withOperation } from '../runtime/operation-context.js';
import type { ReadBudget } from '../runtime/types.js';
import {
  type ReadWorkflowContext,
  WorkflowReadSession,
  type WorkflowSection,
  exactKey,
  finishWorkflow,
  headerFields,
  readSection,
  unavailableSection,
} from './read-policy.js';
export type CustomerSection = 'balance' | 'orders' | 'invoices';
export interface CustomerSnapshotInput {
  customerId: string;
  sections?: CustomerSection[];
  budget: ReadBudget;
}
const numeric = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() && Number.isFinite(Number(value))
      ? Number(value)
      : null;

export async function customerSnapshot(input: CustomerSnapshotInput, context: ReadWorkflowContext) {
  const key = exactKey(input.customerId, 'customer CUSTNAME');
  const requested = [...new Set(input.sections ?? ['balance', 'orders', 'invoices'])];
  if (requested.some((section) => !['balance', 'orders', 'invoices'].includes(section)))
    throw new Error('Unknown customer section.');
  const session = new WorkflowReadSession(context, input.budget);
  const ctx = { ...context, deadlineAt: session.deadlineAt };
  return withOperation(ctx, async () => {
    const sections: Record<string, WorkflowSection> = {};
    sections.identity = await readSection(
      ctx,
      'priority_get_customer',
      'Priority:CUSTOMERS',
      async () => {
        const record = await session.read(1, async () => ({
          data: await ctx.client.get<Record<string, unknown>>('CUSTOMERS', key, undefined, {
            cache: false,
            signal: ctx.signal,
          }),
          rows: 1,
        }));
        if (record.CUSTNAME !== key)
          throw new Error('Exact customer identity could not be verified.');
        return { data: headerFields(record), complete: true };
      },
    );
    if (sections.identity.status !== 'available') {
      for (const section of requested)
        sections[section] = unavailableSection(
          ctx,
          'Priority:customer-dependent-read',
          'Customer identity was not verified; no dependent read was attempted.',
        );
      return finishWorkflow(ctx, 'customer-snapshot', null, sections);
    }
    await Promise.all(
      requested.map(async (section) => {
        if (section === 'balance') {
          sections.balance = await readSection(
            ctx,
            'priority_get_customer_balance',
            'Priority:OBLIGO',
            async () => {
              const result = await session.read(1, async () => {
                const data = await ctx.client.list<Record<string, unknown>>(
                  'OBLIGO',
                  new ODataBuilder()
                    .eq('CUSTNAME', key)
                    .select('CUSTNAME', 'CREDIT', 'MAX_CREDIT', 'CREDIT_REST', 'CODE')
                    .top(1)
                    .build(),
                  { cache: false, signal: ctx.signal },
                );
                return { data, rows: Math.min(1, data.value.length) };
              });
              const row = result.value[0];
              const warning =
                'Priority ledger balance is not bank receipt, clearing or payment proof.';
              if (!row || row.CUSTNAME !== key)
                return {
                  complete: false,
                  warnings: ['No exact OBLIGO balance source was available.', warning],
                };
              const data = {
                customerId: key,
                balance: numeric(row.CREDIT),
                creditLimit: numeric(row.MAX_CREDIT),
                availableCredit: numeric(row.CREDIT_REST),
                currency: row.CODE ?? null,
              };
              return {
                data,
                complete:
                  data.balance !== null &&
                  data.creditLimit !== null &&
                  data.availableCredit !== null &&
                  data.currency !== null,
                warnings: [
                  warning,
                  ...([
                    data.balance,
                    data.creditLimit,
                    data.availableCredit,
                    data.currency,
                  ].includes(null)
                    ? ['Missing financial source fields remain unknown, not zero.']
                    : []),
                ],
              };
            },
          );
        } else {
          const form = section === 'orders' ? 'ORDERS' : 'AINVOICES';
          sections[section] = await readSection(
            ctx,
            section === 'orders' ? 'priority_list_orders' : 'priority_list_invoices',
            `Priority:${form}`,
            async () =>
              session.read(25, async (limit) => {
                const fields =
                  section === 'orders'
                    ? ['ORDNAME', 'CUSTNAME', 'CURDATE', 'ORDSTATUSDES', 'TOTPRICE']
                    : ['IVNUM', 'DEBIT', 'IVTYPE', 'CUSTNAME', 'IVDATE', 'TOTPRICE', 'CODE'];
                const qb = new ODataBuilder()
                  .eq('CUSTNAME', key)
                  .select(...fields)
                  .top(limit);
                for (const field of section === 'orders'
                  ? ['CURDATE', 'ORDNAME']
                  : ['IVDATE', 'IVNUM', 'DEBIT', 'IVTYPE'])
                  qb.orderBy(field, 'desc');
                const result = await ctx.client.list<Record<string, unknown>>(form, qb.build(), {
                  cache: false,
                  signal: ctx.signal,
                });
                const rows = result.value.slice(0, limit);
                if (rows.some((row) => row.CUSTNAME !== key))
                  throw new Error('Dependent rows do not match exact customer identity.');
                return {
                  rows: rows.length,
                  data: {
                    data: { rows, returned: rows.length },
                    complete: rows.length === 0 && !result['@odata.nextLink'],
                    warnings:
                      rows.length || result['@odata.nextLink']
                        ? [
                            'Bounded first-page window only; full customer history is incomplete. Narrow or page the legacy list tool for additional records.',
                          ]
                        : [],
                  },
                };
              }),
          );
        }
      }),
    );
    return finishWorkflow(
      ctx,
      'customer-snapshot',
      { form: 'CUSTOMERS', keys: { CUSTNAME: key } },
      sections,
    );
  });
}
