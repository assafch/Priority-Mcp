import type { MetricsCollector } from './metrics.js';

export type WorkClass = 'interactive' | 'report' | 'discovery' | 'verification';
export interface ReadObservations {
  oldestAt: number | null;
  newestAt: number | null;
  liveReads: number;
  cachedReads: number;
  sensitiveReads: number;
}
export interface OperationContext {
  traceId: string;
  toolName: string;
  workClass: WorkClass;
  deadlineAt: number;
  signal: AbortSignal;
  /** Local collector only; never serialized as request evidence. */
  metrics?: MetricsCollector;
  /** Authorization policy identity for scoped handles; discovery profile is not authority. */
  policyScope?: string;
  /** Bounded aggregate timestamps/counts only; no request identifiers. */
  readObservations?: ReadObservations;
}
export interface EvidenceMeta {
  source: string;
  observedAt: string | null;
  freshness: 'live' | 'cached' | 'stale' | 'unknown';
  complete: boolean | null;
  warnings: string[];
  traceId: string;
  nextCursor: string | null;
  ageMs?: number;
  liveReads?: number;
  cachedReads?: number;
}
export interface ReadBudget {
  maxRows: number;
  maxPages: number;
  deadlineAt: number;
}
export type RecordIdentity = { form: string; keys: Record<string, string | number> };
export type MetricPhase =
  | 'tool'
  | 'queue'
  | 'network'
  | 'retry'
  | 'cache'
  | 'parse'
  | 'serialization'
  | 'rows'
  | 'pages';
export interface MetricEvent {
  tool?: string;
  form?: string;
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  phase: MetricPhase;
  durationMs?: number;
  bytes?: number;
  /** Numeric counter amount, e.g. rows/pages; never business values. */
  value?: number;
  outcome?: 'ok' | 'error' | 'cancelled' | 'incomplete';
  cache?: 'hit' | 'miss' | 'bypass' | 'coalesced';
}
export interface MetricBucket {
  tool: string;
  form: string;
  method: string;
  phase: string;
  outcome: string;
  cache: string;
  count: number;
  durationMs: number;
  maxDurationMs: number;
  bytes: number;
  value: number;
  /** Noncumulative counts for <=1, <=5, <=20, <=100, <=500, <=2000, >2000ms. */
  durationHistogram: number[];
}
export interface MetricsSnapshot {
  schemaVersion: 1;
  buckets: MetricBucket[];
  overflowed: boolean;
}
