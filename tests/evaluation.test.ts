import { describe, expect, it } from 'vitest';
import { loadEvaluationCases, runEvaluation } from '../scripts/evaluate-mcp.mjs';

import * as errors from '../src/client/errors.js';
import * as client from '../src/client/priority-client.js';
import * as aliases from '../src/lib/entity-aliases.js';
import * as resolver from '../src/lib/entity-resolver.js';
import * as query from '../src/lib/query-plan.js';
import * as knowledge from '../src/lib/schema-service.js';
import * as results from '../src/lib/tool-result.js';
import * as writes from '../src/lib/write-guard.js';
import * as logger from '../src/logger.js';
import * as context from '../src/runtime/operation-context.js';
import * as customer from '../src/services/customer-snapshot.js';
import * as imports from '../src/services/import-diagnosis.js';
import * as order from '../src/services/order-diagnosis.js';
import * as finance from '../src/tools/finance.js';
import * as sales from '../src/tools/sales-report.js';
const engines = {
  ...resolver,
  ...aliases,
  ...query,
  ...knowledge,
  ...context,
  ...errors,
  ...client,
  ...logger,
  ...results,
  ...writes,
  ...customer,
  ...order,
  ...imports,
  ...sales,
  ...finance,
};

describe('frozen offline evaluation', () => {
  it('keeps 120 independent factual cases split 80 development/40 held-out in the required categories', async () => {
    const dataset = await loadEvaluationCases();
    expect(dataset.cases).toHaveLength(120);
    expect(dataset.cases.filter((c) => c.split === 'development')).toHaveLength(80);
    expect(dataset.cases.filter((c) => c.split === 'held-out')).toHaveLength(40);
    const categories: Record<string, number> = {};
    for (const entry of dataset.cases)
      categories[entry.category] = (categories[entry.category] ?? 0) + 1;
    expect(categories).toEqual({ entity: 40, query: 30, 'workflow-report': 30, guard: 20 });
    expect(new Set(dataset.cases.map((c) => c.id)).size).toBe(120);
    expect(
      dataset.cases.every(
        (c) =>
          c.prompt &&
          Array.isArray(c.authorizedTools) &&
          c.ambiguityAction &&
          c.claimConstraints.length &&
          Object.keys(c.expected).length,
      ),
    ).toBe(true);
    expect(dataset.verifiedFrozenHashes).toBe(true);
  });
  it('passes deterministic engine facts without claiming a host/model trial or live ERP measurement', async () => {
    const report = await runEvaluation({ engines });
    expect(report.kind).toBe('synthetic-deterministic-offline-evaluation');
    expect(report.deterministic.failed).toBe(0);
    expect(report.deterministic.executed).toBe(120);
    expect(report.hostModel.status).toBe('not-run');
    expect(report.livePriority).toBe(false);
    expect(report.deterministic.bySplit['held-out'].executed).toBe(40);
    expect(report.hostModel.targetChoiceAccuracy).toBeNull();
    expect(report.hostModel.assistantCallReduction).toBeNull();
  });
  it('actually detects a wrong independent expectation', async () => {
    const dataset = await loadEvaluationCases();
    const entity = dataset.cases.find(
      (c) => c.engine === 'resolver' && c.expected.status === 'resolved',
    );
    if (!entity) throw new Error('Missing resolved fixture');
    const wrong = { ...entity, expected: { ...entity.expected, status: 'ambiguous' } };
    const report = await runEvaluation({ cases: [wrong], engines });
    expect(report.deterministic.failed).toBe(1);
    expect(report.results[0].failures.join(' ')).toContain('status');
  });
});

it('declares the separately versioned source-identity enrichment and preserves frozen economic facts', async () => {
  const dataset = await loadEvaluationCases();
  expect(dataset.sourceIdentities.version).toBe('synthetic-source-identities-v1');
  expect(dataset.sourceIdentityHash).toMatch(/^[a-f0-9]{64}$/);
  const selected = dataset.cases.filter((entry) =>
    ['workflow-report-001', 'workflow-report-004', 'workflow-report-010'].includes(entry.id),
  );
  const before = JSON.stringify(selected);
  const report = await runEvaluation({ cases: selected, engines });
  expect(report.deterministic.failed).toBe(0);
  expect(report.config.sourceIdentityAdapter).toMatchObject({
    enabled: true,
    effectiveInputsChanged: true,
    version: 'synthetic-source-identities-v1',
  });
  expect(JSON.stringify(selected)).toBe(before);
  expect(report.results.map((entry) => entry.facts.grandTotal)).toEqual([10, 4, 10]);
});
it('raw missing source identities and metadata remain incomplete even with a declared sidecar available', async () => {
  const dataset = await loadEvaluationCases();
  const base = dataset.cases.find((entry) => entry.id === 'workflow-report-001');
  if (!base) throw new Error('Missing sales source fixture');
  const raw = await runEvaluation({
    cases: [{ ...base, expected: { grandTotal: 0, complete: false } }],
    engines,
    sourceIdentities: false,
  });
  expect(raw.deterministic.failed).toBe(0);
  expect(raw.results[0].facts.missingWindowReasons).toContain('unverifiedLineIdentity');
  for (const [fault, reason] of [
    ['line-key', 'missingLineIdentity'],
    ['parent-key', 'missingParentIdentity'],
    ['line-schema', 'unverifiedLineIdentity'],
  ]) {
    const control = {
      ...base,
      backend: { ...base.backend, rawIdentityFault: fault },
      expected: { grandTotal: 0, complete: false },
    };
    const report = await runEvaluation({ cases: [control], engines });
    expect(report.deterministic.failed).toBe(0);
    expect(report.results[0].facts.missingWindowReasons).toContain(reason);
  }
});
