import { randomUUID } from 'node:crypto';
import { PriorityError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import { withOperation } from '../runtime/operation-context.js';
import type { EvidenceMeta, OperationContext, RecordIdentity } from '../runtime/types.js';
import type { CsdlEntity } from './csdl.js';
import { type EntityKind, ReviewedAliasStore } from './entity-aliases.js';
import { lexicalNameMatch } from './name-normalization.js';
import { type PageScan, fetchAllPages } from './paginate.js';
import { knowledgeFor } from './schema-service.js';

export interface ResolveEntityRequest {
  kind: EntityKind;
  query: string;
  limit?: number;
}
export interface ResolvedCandidate {
  identity: RecordIdentity;
  displayName: string;
  rank: number;
  matchReasons: string[];
}
export interface ResolveEntityResult {
  query: string;
  status: 'resolved' | 'ambiguous' | 'not-found-in-scan';
  candidates: ResolvedCandidate[];
  meta: EvidenceMeta & {
    stopReason: string;
    scanned?: number;
    verification: 'verified' | 'unavailable' | 'denied';
  };
}
export interface ResolverOptions {
  aliases?: ReviewedAliasStore;
  /** Re-evaluated before every source/verification read and again before emitting results. */
  authorize?: (kind: EntityKind) => boolean;
  scanCap?: number;
}
const definitions = {
  customer: { form: 'CUSTOMERS', id: 'CUSTNAME', name: 'CUSTDES' },
  supplier: { form: 'SUPPLIERS', id: 'SUPNAME', name: 'SUPDES' },
  product: { form: 'LOGPART', id: 'PARTNAME', name: 'PARTDES' },
} as const;
type Row = Record<string, unknown>;
type Hint = { identity: RecordIdentity; reason: string; weight: number };
const localScopes = new WeakMap<PriorityClient, string>();
function scopeFor(client: PriorityClient): string {
  if (client.scopeId) return client.scopeId;
  let scope = localScopes.get(client);
  if (!scope) {
    scope = `client:${randomUUID()}`;
    localScopes.set(client, scope);
  }
  return scope;
}
function identityFor(schema: CsdlEntity, row: Row): RecordIdentity | undefined {
  const keys: Record<string, string | number> = {};
  for (const key of schema.key) {
    const value = row[key];
    if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value)))
      return undefined;
    keys[key] = value;
  }
  return { form: schema.entity, keys };
}
function identityKey(identity: RecordIdentity): string {
  return JSON.stringify([
    identity.form,
    Object.entries(identity.keys).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

/** Read-only resolver. Every emitted candidate comes from an uncached current exact read. */
export class EntityResolver {
  private aliases: ReviewedAliasStore;
  private scanCap: number;
  constructor(
    private client: PriorityClient,
    private options: ResolverOptions = {},
  ) {
    this.aliases = options.aliases ?? new ReviewedAliasStore();
    this.scanCap = options.scanCap ?? 2000;
    if (!Number.isSafeInteger(this.scanCap) || this.scanCap < 1 || this.scanCap > 10000)
      throw new Error('Resolver scanCap must be between 1 and 10000.');
  }
  async resolveEntity(
    request: ResolveEntityRequest,
    ctx: OperationContext,
  ): Promise<ResolveEntityResult> {
    if (
      !definitions[request.kind] ||
      typeof request.query !== 'string' ||
      !request.query.trim() ||
      request.query.length > 500
    )
      throw new Error(
        'A supported kind and nonempty query of at most 500 characters are required.',
      );
    const limit = request.limit ?? 3;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5)
      throw new Error('Resolver limit must be between 1 and 5.');
    const definition = definitions[request.kind];
    let observedAt: string | null = null;
    const result = (
      candidates: ResolvedCandidate[],
      complete: boolean,
      stopReason: string,
      status: ResolveEntityResult['status'],
      scanned?: number,
    ): ResolveEntityResult => ({
      query: request.query,
      status,
      candidates,
      meta: {
        source: `Priority ${definition.form}`,
        observedAt,
        freshness: observedAt ? 'live' : 'unknown',
        complete,
        warnings: complete
          ? [
              'Resolution never authorizes a write; write consumers must re-read the exact record uncached.',
            ]
          : [
              'Coverage or verification is incomplete; absence does not establish that a record does not exist.',
              'Resolution never authorizes a write.',
            ],
        traceId: ctx.traceId,
        nextCursor: null,
        stopReason,
        verification:
          stopReason === 'verification-unavailable'
            ? 'unavailable'
            : stopReason === 'policy-denied'
              ? 'denied'
              : 'verified',
        ...(scanned !== undefined ? { scanned } : {}),
      },
    });
    const check = () => {
      if (this.options.authorize && !this.options.authorize(request.kind))
        throw new PriorityError('Resolver policy denied.', 403);
      ctx.signal.throwIfAborted();
      if (Date.now() >= ctx.deadlineAt) throw new PriorityError('Resolver deadline exceeded.', 408);
    };
    let phase = 'schema';
    try {
      return await withOperation(ctx, async () => {
        check();
        const { schema } = await knowledgeFor(this.client).schemas.get(
          definition.form,
          { purpose: 'read' },
          ctx,
        );
        const fields = new Map(schema.fields.map((field) => [field.name, field]));
        if (
          schema.entity !== definition.form ||
          !schema.key.length ||
          !fields.has(definition.name) ||
          fields.get(definition.id)?.type !== 'Edm.String' ||
          schema.key.some((key) => !fields.has(key))
        )
          return result([], false, 'schema-unavailable', 'ambiguous');
        const barcode = request.kind === 'product' && fields.get('BARCODE')?.type === 'Edm.String';
        const projection = [
          ...new Set([
            ...schema.key,
            definition.id,
            definition.name,
            ...(barcode ? ['BARCODE'] : []),
          ]),
        ];
        const select = new ODataBuilder().select(...projection).build();
        const read = async (identity: RecordIdentity): Promise<Row | undefined> => {
          check();
          if (
            identity.form !== definition.form ||
            Object.keys(identity.keys).length !== schema.key.length ||
            schema.key.some((key) => !(key in identity.keys))
          )
            return undefined;
          try {
            const row = await this.client.getComposite<Row>(identity.form, identity.keys, select, {
              cache: false,
              signal: ctx.signal,
            });
            check();
            observedAt = new Date().toISOString();
            const current = identityFor(schema, row);
            return current &&
              identityKey(current) === identityKey(identity) &&
              typeof row[definition.name] === 'string'
              ? row
              : undefined;
          } catch (error) {
            if (
              error instanceof PriorityError &&
              (error.statusCode === 403 || error.statusCode === 404)
            )
              return undefined;
            throw error;
          }
        };
        const scan = async (filter?: string, maxRows = this.scanCap): Promise<PageScan<Row>> =>
          fetchAllPages(
            async (skip, top) => {
              check();
              const qb = new ODataBuilder().select(...projection).top(top);
              if (skip) qb.skip(skip);
              if (filter) qb.filter(filter);
              for (const key of schema.key) qb.orderBy(key);
              const response = await this.client.list<Row>(definition.form, qb.build(), {
                cache: false,
                signal: ctx.signal,
              });
              observedAt = new Date().toISOString();
              return response;
            },
            {
              pageSize: 500,
              maxRows,
              signal: ctx.signal,
              deadlineAt: ctx.deadlineAt,
              ...(typeof this.client.listNext === 'function'
                ? {
                    fetchNext: async (link: string) => {
                      check();
                      const response = await this.client.listNext<Row>(link, {
                        signal: ctx.signal,
                      });
                      observedAt = new Date().toISOString();
                      return response;
                    },
                  }
                : {}),
            },
          );
        phase = 'verification';
        // This is a literal identifier lookup: do not trim, NFKC-fold or parse it as a number.
        if (schema.key.length === 1 && schema.key[0] === definition.id) {
          const identity = { form: definition.form, keys: { [definition.id]: request.query } };
          const row = await read(identity);
          if (row) {
            check();
            return result(
              [
                {
                  identity,
                  displayName: String(row[definition.name]),
                  rank: 1,
                  matchReasons: ['exact-identifier'],
                },
              ],
              true,
              'exact-identifier',
              'resolved',
            );
          }
        }
        let hints: Hint[] = [];
        let complete = true;
        let stopReason = 'exhausted';
        let scanned = 0;
        let exact = false;
        if (schema.key.length !== 1 || schema.key[0] !== definition.id) {
          phase = 'scan';
          const page = await scan(`${definition.id} eq '${request.query.replace(/'/g, "''")}'`, 6);
          hints = page.rows.flatMap((row) => {
            const identity = identityFor(schema, row);
            return identity ? [{ identity, reason: 'exact-identifier', weight: 1 }] : [];
          });
          complete = page.complete;
          stopReason = page.stopReason;
          scanned += page.rows.length;
          exact = hints.length > 0;
        }
        if (!hints.length && barcode) {
          phase = 'scan';
          const filter = `BARCODE eq '${request.query.replace(/'/g, "''")}'`;
          const page = await scan(filter, 6);
          hints = page.rows.flatMap((row) => {
            const identity = identityFor(schema, row);
            return identity ? [{ identity, reason: 'exact-barcode', weight: 1 }] : [];
          });
          complete = page.complete;
          stopReason = page.stopReason;
          scanned += page.rows.length;
          exact = hints.length > 0;
        }
        if (!hints.length) {
          const mappings = this.aliases.lookup(scopeFor(this.client), request.kind, request.query);
          hints = mappings.map((mapping) => ({
            identity: mapping.identity,
            reason: 'reviewed-alias',
            weight: 1,
          }));
          exact = hints.length > 0;
        }
        if (!hints.length) {
          phase = 'scan';
          const page = await scan();
          complete = page.complete;
          stopReason = page.stopReason;
          scanned += page.rows.length;
          hints = page.rows.flatMap((row) => {
            const identity = identityFor(schema, row);
            const match =
              typeof row[definition.name] === 'string'
                ? lexicalNameMatch(request.query, row[definition.name] as string)
                : undefined;
            return identity && match
              ? [{ identity, reason: match.reason, weight: match.weight }]
              : [];
          });
        }
        const unique = new Map<string, Hint>();
        for (const hint of hints) {
          const key = identityKey(hint.identity);
          const prior = unique.get(key);
          if (!prior || hint.weight > prior.weight) unique.set(key, hint);
        }
        const ranked = [...unique.values()].sort(
          (a, b) =>
            b.weight - a.weight || identityKey(a.identity).localeCompare(identityKey(b.identity)),
        );
        const candidates: ResolvedCandidate[] = [];
        let suppressed = false;
        phase = 'verification';
        for (const hint of ranked.slice(0, 5)) {
          const row = await read(hint.identity);
          if (!row) {
            suppressed = true;
            continue;
          }
          if (hint.reason === 'exact-barcode' && row.BARCODE !== request.query) {
            suppressed = true;
            continue;
          }
          if (!exact && !lexicalNameMatch(request.query, String(row[definition.name]))) {
            suppressed = true;
            continue;
          }
          candidates.push({
            identity: identityFor(schema, row) as RecordIdentity,
            displayName: String(row[definition.name]),
            rank: candidates.length + 1,
            matchReasons: [hint.reason],
          });
        }
        check();
        if (suppressed) complete = false;
        if (ranked.length > limit) {
          complete = false;
          if (stopReason === 'exhausted') stopReason = 'maxCandidates';
        }
        const status =
          exact && ranked.length === 1 && candidates.length === 1 && complete
            ? 'resolved'
            : candidates.length
              ? 'ambiguous'
              : 'not-found-in-scan';
        return result(candidates.slice(0, limit), complete, stopReason, status, scanned);
      });
    } catch (error) {
      const denied =
        error instanceof PriorityError &&
        error.statusCode === 403 &&
        this.options.authorize &&
        !this.options.authorize(request.kind);
      return result(
        [],
        false,
        denied
          ? 'policy-denied'
          : phase === 'schema'
            ? 'schema-unavailable'
            : 'verification-unavailable',
        'ambiguous',
      );
    }
  }
}
