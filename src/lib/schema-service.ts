import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { ReadCoalescer } from '../client/read-coalescer.js';
import { recordMetric } from '../runtime/metrics.js';
import { createOperation, currentOperation, withOperation } from '../runtime/operation-context.js';
import type { EvidenceMeta, OperationContext } from '../runtime/types.js';
import { CapabilityStore } from './capability-store.js';
import { type CsdlEntity, parseCsdl } from './csdl.js';
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
  async get(
    form: string,
    options: { purpose: 'read' | 'write'; allowFullScan?: boolean; force?: boolean },
    ctx?: OperationContext,
  ): Promise<SchemaResult> {
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
    const entry = { schema, at: Date.now(), bytes: Buffer.byteLength(JSON.stringify(schema)) };
    const previous = this.entries.get(form);
    if (previous) {
      this.bytes -= previous.bytes;
      this.entries.delete(form);
    }
    if (entry.bytes <= 16 * 1024 * 1024) {
      while (this.entries.size >= 256 || this.bytes + entry.bytes > 16 * 1024 * 1024) {
        const key = this.entries.keys().next().value;
        if (key === undefined) break;
        const oldest = this.entries.get(key);
        this.bytes -= oldest?.bytes ?? 0;
        this.entries.delete(key);
      }
      this.entries.set(form, entry);
      this.bytes += entry.bytes;
    }
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
