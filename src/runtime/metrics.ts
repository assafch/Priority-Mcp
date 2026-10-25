import { createHash } from 'node:crypto';
import { TOOL_DEFINITIONS } from '../lib/capability-definitions.js';
import { currentOperation } from './operation-context.js';
import type { MetricBucket, MetricEvent, MetricsSnapshot } from './types.js';
export type { MetricEvent, MetricsSnapshot } from './types.js';

const tools = new Set(TOOL_DEFINITIONS.map((definition) => definition.name));
const forms = new Set(TOOL_DEFINITIONS.flatMap((definition) => definition.requiredForms));
const phases = new Set([
  'tool',
  'queue',
  'network',
  'retry',
  'cache',
  'parse',
  'serialization',
  'rows',
  'pages',
]);
const methods = new Set(['GET', 'POST', 'PATCH', 'DELETE']);
const outcomes = new Set(['ok', 'error', 'cancelled', 'incomplete']);
const caches = new Set(['hit', 'miss', 'bypass', 'coalesced']);
const bounds = [1, 5, 20, 100, 500, 2000];
const safeNumber = (value: number | undefined) =>
  Number.isFinite(value) && (value ?? 0) > 0 ? (value as number) : 0;

/** Safe for logs as well as aggregate labels; never returns unknown raw names. */
export function metricFormLabel(form?: string): string {
  if (!form) return 'none';
  return forms.has(form)
    ? form
    : `custom:${createHash('sha256').update(form).digest('hex').slice(0, 16)}`;
}

/** Per-client bounded aggregates, never a request history or arbitrary label store. */
export class MetricsCollector {
  private readonly formLabels = new Set<string>();
  private readonly aggregates = new Map<string, MetricBucket>();
  private overflowed = false;

  record(event: MetricEvent): void {
    // Unknown form names are opaque, so identifiers that look like form names cannot leak.
    let form = metricFormLabel(event.form);
    if (!this.formLabels.has(form) && this.formLabels.size >= 256) {
      form = 'overflow';
      this.overflowed = true;
    }
    this.formLabels.add(form);
    const tool = event.tool ?? currentOperation()?.toolName ?? '';
    const labels = {
      tool: tools.has(tool) ? tool : 'other',
      form,
      method: methods.has(event.method ?? '') ? (event.method as string) : 'none',
      phase: phases.has(event.phase) ? event.phase : 'other',
      outcome: outcomes.has(event.outcome ?? '') ? (event.outcome as string) : 'ok',
      cache: caches.has(event.cache ?? '') ? (event.cache as string) : 'none',
    };
    let key = JSON.stringify(labels);
    if (!this.aggregates.has(key) && this.aggregates.size >= 2048) {
      key = 'overflow';
      this.overflowed = true;
      Object.assign(labels, {
        tool: 'other',
        form: 'overflow',
        method: 'none',
        phase: 'other',
        outcome: 'ok',
        cache: 'none',
      });
    }
    let bucket = this.aggregates.get(key);
    if (!bucket) {
      bucket = {
        ...labels,
        count: 0,
        durationMs: 0,
        maxDurationMs: 0,
        bytes: 0,
        value: 0,
        durationHistogram: Array(7).fill(0),
      };
      this.aggregates.set(key, bucket);
    }
    const duration = safeNumber(event.durationMs);
    bucket.count++;
    bucket.durationMs += duration;
    bucket.maxDurationMs = Math.max(bucket.maxDurationMs, duration);
    bucket.bytes += safeNumber(event.bytes);
    bucket.value += safeNumber(event.value);
    const index = bounds.findIndex((bound) => duration <= bound);
    bucket.durationHistogram[index < 0 ? 6 : index]++;
  }
  snapshot(): MetricsSnapshot {
    return {
      schemaVersion: 1,
      buckets: Array.from(this.aggregates.values(), (bucket) => ({
        ...bucket,
        durationHistogram: [...bucket.durationHistogram],
      })),
      overflowed: this.overflowed,
    };
  }
}
/** With no operation collector, intentionally drop metrics rather than expose process-wide activity. */
export function recordMetric(event: MetricEvent): void {
  currentOperation()?.metrics?.record(event);
}
export function metricsSnapshot(): MetricsSnapshot {
  return (
    currentOperation()?.metrics?.snapshot() ?? { schemaVersion: 1, buckets: [], overflowed: false }
  );
}
