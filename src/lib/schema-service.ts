import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { ReadCoalescer } from '../client/read-coalescer.js';
import { recordMetric } from '../runtime/metrics.js';
import { createOperation, currentOperation, withOperation } from '../runtime/operation-context.js';
import type { EvidenceMeta, OperationContext } from '../runtime/types.js';
import { CapabilityStore } from './capability-store.js';
import { type CsdlEntity, csdlEntityNames, parseCsdl } from './csdl.js';
const MAX_SCHEMA_BYTES = 16 * 1024 * 1024;
type SchemaOptions = { purpose: 'read' | 'write'; allowFullScan?: boolean; force?: boolean };
interface SchemaEntry {
  schema: CsdlEntity;
  at: number;
  bytes: number;
}
export interface SchemaResult {
  schema: CsdlEntity;
  evidence: EvidenceMeta;
}
export class SchemaService {
  private entries = new Map<string, SchemaEntry>();
  private pending = new ReadCoalescer();
  private bytes = 0;
  private fullDocument?: { raw: unknown; at: number; bytes: number };
  constructor(private client: PriorityClient) {}
  private result(entry: SchemaEntry, freshness: EvidenceMeta['freshness']): SchemaResult {
    return {
      schema: structuredClone(entry.schema),
      evidence: {
        source: 'Priority metadata',
        observedAt: new Date(entry.at).toISOString(),
        freshness,
        complete: true,
        warnings:
          freshness === 'stale'
            ? ['Schema is stale read-discovery guidance; refresh before schema-dependent writes.']
            : [],
        traceId: currentOperation()?.traceId ?? 'local',
        nextCursor: null,
      },
    };
  }
  async get(form: string, options: SchemaOptions, ctx?: OperationContext): Promise<SchemaResult> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(form))
      throw new PriorityError('Invalid metadata form name.', 400);
    const operation = async () => {
      const subscriber =
        ctx ?? currentOperation() ?? createOperation('schema', { workClass: 'discovery' });
      subscriber.signal.throwIfAborted();
      if (subscriber.deadlineAt <= Date.now())
        throw new PriorityError('Schema deadline exceeded.', 408);
      const entry = this.entries.get(form);
      const age = entry ? Date.now() - entry.at : Number.POSITIVE_INFINITY;
      if (entry && !options.force && age < 3600000) {
        this.entries.delete(form);
        this.entries.set(form, entry);
        return this.result(entry, 'cached');
      }
      if (entry && !options.force && options.purpose === 'read' && age < 86400000)
        return this.result(entry, 'stale');
      // Different fallback policies must not share a promise that performs an unapproved full scan.
      const pendingKey = JSON.stringify([form, Boolean(options.allowFullScan)]);
      const result = await this.pending.run(pendingKey, subscriber, (signal) => {
        const shared = {
          ...subscriber,
          signal,
          workClass: 'discovery' as const,
          deadlineAt: Date.now() + 120000,
        };
        return withOperation(shared, () => this.load(form, Boolean(options.allowFullScan), shared));
      });
      return {
        schema: structuredClone(result.schema),
        evidence: { ...result.evidence, traceId: subscriber.traceId },
      };
    };
    return ctx ? withOperation(ctx, operation) : operation();
  }
  /** Priority GetMetadataFor supports top-level entities only. Resolve children by declared type. */
  async getSubform(
    parent: string,
    subform: string,
    options: SchemaOptions,
    ctx?: OperationContext,
  ): Promise<SchemaResult> {
    if (![parent, subform].every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)))
      throw new PriorityError('Invalid navigation schema name.', 400);
    const subscriber =
      ctx ?? currentOperation() ?? createOperation('schema', { workClass: 'discovery' });
    return withOperation(subscriber, async () => {
      subscriber.signal.throwIfAborted();
      if (subscriber.deadlineAt <= Date.now())
        throw new PriorityError('Schema deadline exceeded.', 408);
      const owner = await this.get(
        parent,
        { purpose: options.purpose, force: options.force },
        subscriber,
      );
      const target = owner.schema.subformTypes?.[subform];
      if (
        !owner.schema.subforms.includes(subform) ||
        !target ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)
      )
        throw new PriorityError('The parent has no verified declared navigation target.', 422);
      if (!options.allowFullScan)
        throw new PriorityError('Subform schema requires explicit opt-in to full metadata.', 400);
      const cacheKey = JSON.stringify(['navigation', parent, subform, target]);
      const cached = this.entries.get(cacheKey);
      const age = cached ? Date.now() - cached.at : Number.POSITIVE_INFINITY;
      if (
        cached &&
        !options.force &&
        (age < 3600000 || (options.purpose === 'read' && age < 86400000))
      ) {
        this.entries.delete(cacheKey);
        this.entries.set(cacheKey, cached);
        return this.result(cached, age < 3600000 ? 'cached' : 'stale');
      }
      let document = this.fullDocument;
      let fetched = false;
      if (!document || options.force || Date.now() - document.at >= 3600000) {
        fetched = true;
        document = await this.pending.run(
          'full-navigation-metadata',
          subscriber,
          async (signal) => {
            const shared = {
              ...subscriber,
              signal,
              workClass: 'discovery' as const,
              deadlineAt: Date.now() + 120000,
            };
            return withOperation(shared, async () => {
              const raw = await this.client.request('$metadata', undefined, undefined, {
                cache: false,
                signal,
              });
              signal.throwIfAborted();
              if (!csdlEntityNames(raw)?.length)
                throw new PriorityError(
                  'Full metadata did not contain an authoritative schema.',
                  422,
                );
              const result = {
                raw,
                at: Date.now(),
                bytes: Buffer.byteLength(typeof raw === 'string' ? raw : JSON.stringify(raw)),
              };
              this.fullDocument = undefined;
              if (result.bytes <= MAX_SCHEMA_BYTES) {
                this.evictFor(result.bytes);
                this.fullDocument = result;
              }
              return result;
            });
          },
        );
      }
      subscriber.signal.throwIfAborted();
      if (subscriber.deadlineAt <= Date.now())
        throw new PriorityError('Schema deadline exceeded.', 408);
      const start = performance.now();
      const fullParent = parseCsdl(document.raw, parent);
      const schema = parseCsdl(document.raw, target);
      recordMetric({ phase: 'parse', durationMs: performance.now() - start, form: parent });
      if (
        fullParent?.subformTypes?.[subform] !== target ||
        !schema?.key.length ||
        !schema.fields.length ||
        schema.key.some((key) => !schema.fields.some((field) => field.name === key))
      )
        throw new PriorityError(
          'Full schema did not verify the parent navigation and complete child key.',
          422,
        );
      const entry = this.remember(
        cacheKey,
        schema,
        Math.min(document.at, Date.parse(owner.evidence.observedAt ?? '') || document.at),
      );
      return this.result(
        entry,
        owner.evidence.freshness === 'stale' ? 'stale' : fetched ? 'live' : 'cached',
      );
    });
  }
  private evictFor(bytes: number): void {
    while (
      this.entries.size &&
      (this.entries.size >= 256 ||
        this.bytes + (this.fullDocument?.bytes ?? 0) + bytes > MAX_SCHEMA_BYTES)
    ) {
      const key = this.entries.keys().next().value;
      if (key === undefined) break;
      this.bytes -= this.entries.get(key)?.bytes ?? 0;
      this.entries.delete(key);
    }
    if (this.bytes + (this.fullDocument?.bytes ?? 0) + bytes > MAX_SCHEMA_BYTES)
      this.fullDocument = undefined;
  }
  private remember(key: string, schema: CsdlEntity, at: number): SchemaEntry {
    const entry = { schema, at, bytes: Buffer.byteLength(JSON.stringify(schema)) };
    const previous = this.entries.get(key);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(key);
    }
    if (entry.bytes <= MAX_SCHEMA_BYTES) {
      this.evictFor(entry.bytes);
      this.entries.set(key, entry);
      this.bytes += entry.bytes;
    }
    return entry;
  }
  private async load(
    form: string,
    allowFullScan: boolean,
    ctx?: OperationContext,
  ): Promise<SchemaResult> {
    ctx?.signal.throwIfAborted();
    let raw: unknown;
    try {
      raw = await this.client.request(`GetMetadataFor(entity='${form}')`, undefined, undefined, {
        cache: false,
        signal: ctx?.signal,
      });
    } catch (error) {
      const unsupported =
        error instanceof PriorityError &&
        (error.statusCode === 501 ||
          (error.statusCode === 404 && /GetMetadataFor|function.*not found/i.test(error.message)));
      if (!allowFullScan || !unsupported) throw error;
      raw = await this.client.request('$metadata', undefined, undefined, {
        cache: false,
        signal: ctx?.signal,
      });
    }
    ctx?.signal.throwIfAborted();
    const started = performance.now();
    const schema = parseCsdl(raw, form);
    recordMetric({ phase: 'parse', durationMs: performance.now() - started, form });
    if (!schema || schema.fields.length === 0 || schema.key.length === 0)
      throw new PriorityError(`A complete keyed schema for ${form} could not be established.`, 422);
    const entry = this.remember(form, schema, Date.now());
    return this.result(entry, 'live');
  }
}
const knowledge = new WeakMap<
  PriorityClient,
  { schemas: SchemaService; capabilities: CapabilityStore }
>();
export function knowledgeFor(client: PriorityClient) {
  let value = knowledge.get(client);
  if (!value) {
    value = { schemas: new SchemaService(client), capabilities: new CapabilityStore() };
    knowledge.set(client, value);
  }
  return value;
}
