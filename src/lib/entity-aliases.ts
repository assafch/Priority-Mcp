import type { RecordIdentity } from '../runtime/types.js';
import { normalizeEntityName } from './name-normalization.js';
export type EntityKind = 'customer' | 'supplier' | 'product';
export interface EntityAlias {
  scope: string;
  kind: EntityKind;
  alias: string;
  identity: RecordIdentity;
  source: string;
  reviewedAt: string;
}
const forms: Record<EntityKind, string> = {
  customer: 'CUSTOMERS',
  supplier: 'SUPPLIERS',
  product: 'LOGPART',
};
/** Private reviewed configuration only. No model-facing learning or mutation interface. */
export class ReviewedAliasStore {
  private records: EntityAlias[];
  constructor(records: EntityAlias[] = []) {
    if (records.length > 1000 || Buffer.byteLength(JSON.stringify(records)) > 1024 * 1024)
      throw new Error('Reviewed alias configuration exceeds its bounded storage budget.');
    for (const row of records) {
      if (
        !row.scope ||
        !row.alias.trim() ||
        !row.source.trim() ||
        !Number.isFinite(Date.parse(row.reviewedAt)) ||
        row.identity.form !== forms[row.kind] ||
        !Object.keys(row.identity.keys).length ||
        Object.entries(row.identity.keys).some(
          ([key, value]) =>
            !/^\w+$/.test(key) ||
            !(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))),
        )
      )
        throw new Error(
          'Aliases require scope, kind, canonical keys, source and a valid review date.',
        );
    }
    this.records = structuredClone(records);
  }
  lookup(scope: string, kind: EntityKind, query: string): EntityAlias[] {
    const normalized = normalizeEntityName(query);
    return structuredClone(
      this.records.filter(
        (row) =>
          row.scope === scope && row.kind === kind && normalizeEntityName(row.alias) === normalized,
      ),
    );
  }
}
