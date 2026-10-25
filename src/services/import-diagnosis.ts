import { type ImpfileSnapshot, computeLandedCost, preflight } from '../lib/impfiles-logic.js';
import { withOperation } from '../runtime/operation-context.js';
import type { ReadBudget } from '../runtime/types.js';
import { IMPFILE_SUBFORMS, loadImportRecord, normalizeSnapshot } from './import-read.js';
import {
  type ReadWorkflowContext,
  WorkflowReadSession,
  type WorkflowSection,
  assertReadDependencyAllowed,
  exactKey,
  finishWorkflow,
  readSection,
  unavailableSection,
} from './read-policy.js';
export type ImportSection = 'snapshot' | 'preflight' | 'landedCost';
export interface ImportDiagnosisInput {
  impfnum: string;
  sections?: ImportSection[];
  budget: ReadBudget;
}
const knownNumber = (value: unknown): boolean =>
  (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
  Number.isFinite(Number(value));
function calculationSourcesKnown(snapshot: ImpfileSnapshot, section: ImportSection): boolean {
  const invoices = snapshot.invoices ?? [];
  if (section === 'preflight')
    return invoices.every(
      (invoice) =>
        typeof invoice.DEBIT === 'string' &&
        ['D', 'C'].includes(invoice.DEBIT) &&
        typeof invoice.STORNOFLAG === 'string' &&
        ['', 'N', 'Y'].includes(invoice.STORNOFLAG),
    );
  const supplier = snapshot.header?.SUPNAME;
  if (invoices.length && (typeof supplier !== 'string' || !supplier.trim())) return false;
  if (
    invoices.some(
      (invoice) =>
        typeof invoice.SUPNAME !== 'string' ||
        !invoice.SUPNAME ||
        (invoice.SUPNAME !== supplier && !knownNumber(invoice.DISPRICE)),
    )
  )
    return false;
  const goods = snapshot.goodsContent ?? [];
  const customs = snapshot.customsEstimate ?? [];
  return (
    goods.every(
      (row) =>
        typeof row.PARTNAME === 'string' && row.PARTNAME.trim() !== '' && knownNumber(row.TQUANT),
    ) &&
    customs.length > 0 &&
    customs.every(
      (row) =>
        typeof row.PARTNAME === 'string' &&
        row.PARTNAME &&
        knownNumber(row.PRICE) &&
        goods
          .filter((good) => good.PARTNAME === row.PARTNAME)
          .reduce((sum, good) => sum + Number(good.TQUANT), 0) > 0,
    )
  );
}
export async function importDiagnosis(input: ImportDiagnosisInput, context: ReadWorkflowContext) {
  const key = exactKey(input.impfnum, 'import IMPFNUM');
  const requested = [
    ...new Set<ImportSection>(input.sections ?? ['snapshot', 'preflight', 'landedCost']),
  ];
  if (requested.some((section) => !['snapshot', 'preflight', 'landedCost'].includes(section)))
    throw new Error('Unknown import section.');
  const session = new WorkflowReadSession(context, input.budget);
  const ctx = { ...context, deadlineAt: session.deadlineAt };
  return withOperation(ctx, async () => {
    const sections: Record<string, WorkflowSection> = {};
    let normalized: ReturnType<typeof normalizeSnapshot> | undefined;
    let verified = false;
    let complete = false;
    const snapshot = await readSection(
      ctx,
      'impfile_get',
      'Priority:IMPFILES+import-subforms',
      async () =>
        session.read(session.availableRows(), async (limit) => {
          const subformTop = Math.floor((limit - 1) / IMPFILE_SUBFORMS.length);
          const raw = await loadImportRecord(ctx.client, key, {
            cache: false,
            signal: ctx.signal,
            subformTop,
          });
          if (raw.IMPFNUM !== key) throw new Error('Exact import identity could not be verified.');
          verified = true;
          let consumed = 1;
          const missing: string[] = [];
          const bounded: Record<string, unknown> = { ...raw };
          for (const { subform } of IMPFILE_SUBFORMS) {
            const value = raw[subform];
            if (!Array.isArray(value)) {
              missing.push(subform);
              delete bounded[subform];
              continue;
            }
            const capacity = Math.max(0, Math.min(subformTop, limit - consumed));
            bounded[subform] = value.slice(0, capacity);
            consumed += Math.min(value.length, capacity);
            if (value.length >= subformTop || raw[`${subform}@odata.nextLink`])
              missing.push(subform);
          }
          normalized = normalizeSnapshot(bounded, { strict: true });
          if (normalized.derived === null)
            missing.push('invoice value/currency or customs duty fields');
          complete = missing.length === 0;
          if (!complete) normalized.derived = null;
          return {
            rows: consumed,
            data: {
              data: normalized,
              complete,
              warnings: complete
                ? [
                    'Import/ledger documents do not establish bank clearing, receipt or carrier delivery.',
                  ]
                : [
                    `Missing, unknown or bounded import sources prevent financial diagnosis: ${missing.join(', ')}.`,
                    'No preflight or landed-cost calculation is asserted from incomplete source rows.',
                  ],
            },
          };
        }),
    );
    // Snapshot is also the mandatory identity source even when omitted from the requested sections.
    if (requested.includes('snapshot')) sections.snapshot = snapshot;
    else sections.identity = { ...snapshot, ...(verified ? { data: { IMPFNUM: key } } : {}) };
    for (const section of requested) {
      if (section === 'snapshot') continue;
      const dependency = section === 'preflight' ? 'impfile_preflight' : 'impfile_landed_cost';
      sections[section] = await readSection(ctx, dependency, `Priority:IMPFILES/${section}`, () => {
        assertReadDependencyAllowed(ctx.config, 'impfile_get');
        if (!verified || !complete || !normalized)
          return {
            complete: false,
            warnings: [
              'A complete policy-allowed import snapshot is required; no financial calculation was performed.',
            ],
          };
        if (!calculationSourcesKnown(normalized, section))
          return {
            complete: false,
            warnings: [
              'Required status/valuation/quantity source fields are unknown; no financial calculation was performed.',
            ],
          };
        if (
          section === 'preflight' &&
          (normalized.customsEstimate ?? []).some(
            (row) => typeof row.CUSTOMSITEMNAME !== 'string' || !row.CUSTOMSITEMNAME.trim(),
          )
        )
          return {
            complete: false,
            warnings: [
              'Customs classification is unknown. Missing mapping is not proof of duty exemption; a scoped reviewed rule or customs source is required.',
            ],
          };
        return {
          data: section === 'preflight' ? preflight(normalized) : computeLandedCost(normalized),
          complete: true,
          warnings: [
            'Calculated from one observed import snapshot; ledger documents do not prove bank clearing. Landed cost remains the existing estimate, not authoritative product costing.',
          ],
        };
      });
      if (snapshot.status === 'blocked' && sections[section].status !== 'blocked')
        sections[section] = unavailableSection(
          ctx,
          `Priority:IMPFILES/${section}`,
          'impfile_get dependency is blocked.',
          'blocked',
        );
    }
    return finishWorkflow(
      ctx,
      'import-diagnosis',
      verified ? { form: 'IMPFILES', keys: { IMPFNUM: key } } : null,
      sections,
    );
  });
}
