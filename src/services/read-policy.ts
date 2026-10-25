import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { toolAllowed } from '../lib/capabilities.js';
import { readObservationSnapshot } from '../runtime/operation-context.js';
import type {
  EvidenceMeta,
  OperationContext,
  ReadBudget,
  RecordIdentity,
} from '../runtime/types.js';

export interface ReadWorkflowContext extends OperationContext {
  client: PriorityClient;
  config: Config;
}
export interface WorkflowSection {
  status: 'available' | 'blocked' | 'failed' | 'incomplete';
  data?: unknown;
  meta: EvidenceMeta;
}
export interface ReadWorkflowResult {
  identity: RecordIdentity | null;
  sections: Record<string, WorkflowSection>;
  meta: EvidenceMeta;
}
export interface SectionData {
  data?: unknown;
  complete: boolean;
  warnings?: string[];
}
export class ReadDependencyBlocked extends Error {
  constructor(readonly toolName: string) {
    super(`Read dependency ${toolName} is blocked by policy.`);
  }
}
export class ReadBudgetExceeded extends Error {
  constructor() {
    super('Shared read budget or deadline exhausted.');
  }
}
export function assertReadDependencyAllowed(config: Config, legacyToolName: string): void {
  if (!toolAllowed(config, legacyToolName)) throw new ReadDependencyBlocked(legacyToolName);
}
export function evidence(
  ctx: OperationContext,
  source: string,
  complete: boolean,
  warnings: string[] = [],
  observed = true,
): EvidenceMeta {
  const observation = readObservationSnapshot(ctx);
  const known = observed && observation.liveReads + observation.cachedReads > 0;
  return {
    source,
    observedAt: known ? observation.observedAt : observed ? new Date().toISOString() : null,
    freshness: known ? observation.freshness : observed ? 'live' : 'unknown',
    ...(known
      ? {
          ageMs: observation.ageMs ?? 0,
          liveReads: observation.liveReads,
          cachedReads: observation.cachedReads,
        }
      : {}),
    complete,
    warnings,
    traceId: ctx.traceId,
    nextCursor: null,
  };
}
export function unavailableSection(
  ctx: OperationContext,
  source: string,
  warning: string,
  status: WorkflowSection['status'] = 'incomplete',
): WorkflowSection {
  return { status, meta: evidence(ctx, source, false, [warning], false) };
}
export async function readSection(
  ctx: ReadWorkflowContext,
  dependency: string,
  source: string,
  run: () => Promise<SectionData> | SectionData,
): Promise<WorkflowSection> {
  try {
    assertReadDependencyAllowed(ctx.config, dependency);
    ctx.signal.throwIfAborted();
    if (Date.now() >= ctx.deadlineAt) throw new ReadBudgetExceeded();
    const result = await run();
    if (Date.now() >= ctx.deadlineAt) throw new ReadBudgetExceeded();
    return {
      status: result.complete ? 'available' : 'incomplete',
      ...(result.data === undefined ? {} : { data: result.data }),
      meta: evidence(ctx, source, result.complete, result.warnings ?? []),
    };
  } catch (error) {
    if (error instanceof ReadDependencyBlocked)
      return unavailableSection(ctx, source, error.message, 'blocked');
    if (error instanceof ReadBudgetExceeded || ctx.signal.aborted)
      return unavailableSection(
        ctx,
        source,
        'Shared read budget, cancellation or deadline prevented a complete read.',
      );
    const status = error instanceof PriorityError ? error.statusCode : undefined;
    return unavailableSection(
      ctx,
      source,
      status
        ? `Source read failed with HTTP ${status}; no business conclusion is available.`
        : 'Source read failed; no business conclusion is available.',
      'failed',
    );
  }
}
/** Shared synchronous reservations prevent parallel sections overspending the same row/page budget. */
export class WorkflowReadSession {
  private rows = 0;
  private pages = 0;
  readonly deadlineAt: number;
  constructor(
    readonly ctx: ReadWorkflowContext,
    readonly budget: ReadBudget,
  ) {
    if (
      !Number.isSafeInteger(budget.maxRows) ||
      budget.maxRows < 1 ||
      budget.maxRows > 500 ||
      !Number.isSafeInteger(budget.maxPages) ||
      budget.maxPages < 1 ||
      budget.maxPages > 20 ||
      !Number.isFinite(budget.deadlineAt)
    )
      throw new Error('Workflow budget requires 1–500 rows, 1–20 pages and a finite deadline.');
    this.deadlineAt = Math.min(ctx.deadlineAt, budget.deadlineAt);
  }
  availableRows(): number {
    return Math.max(0, this.budget.maxRows - this.rows);
  }
  async read<T>(
    wantedRows: number,
    run: (limit: number) => Promise<{ data: T; rows: number }>,
  ): Promise<T> {
    this.ctx.signal.throwIfAborted();
    if (
      Date.now() >= this.deadlineAt ||
      this.pages >= this.budget.maxPages ||
      this.availableRows() < 1
    )
      throw new ReadBudgetExceeded();
    const reserved = Math.min(Math.max(1, wantedRows), this.availableRows());
    this.pages++;
    this.rows += reserved;
    // Pages count attempted reads. Keep the row reservation after failure conservatively.
    const result = await run(reserved);
    this.rows -= reserved - Math.min(reserved, Math.max(0, result.rows));
    if (Date.now() >= this.deadlineAt || this.ctx.signal.aborted) throw new ReadBudgetExceeded();
    return result.data;
  }
}
export function finishWorkflow(
  ctx: OperationContext,
  source: string,
  identity: RecordIdentity | null,
  sections: Record<string, WorkflowSection>,
): ReadWorkflowResult {
  const values = Object.values(sections);
  const complete =
    Boolean(identity) &&
    values.every((section) => section.status === 'available' && section.meta.complete === true);
  const observed = values.some((section) => section.meta.observedAt !== null);
  return {
    identity,
    sections,
    meta: evidence(
      ctx,
      source,
      complete,
      [...new Set(values.flatMap((section) => section.meta.warnings))],
      observed,
    ),
  };
}
export function exactKey(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256)
    throw new Error(
      `An exact ${label} key is required; resolve/select similar-name candidates first.`,
    );
  return value;
}
export function headerFields(record: Record<string, unknown>): Record<string, unknown> {
  const entries = Object.entries(record).filter(
    ([key, value]) =>
      !key.includes('@') &&
      (value === null || ['string', 'number', 'boolean'].includes(typeof value)),
  );
  return {
    ...Object.fromEntries(entries.slice(0, 100)),
    ...(entries.length > 100 ? { summaryFieldsOmitted: entries.length - 100 } : {}),
  };
}
