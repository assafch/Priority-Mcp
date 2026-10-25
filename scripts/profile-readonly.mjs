#!/usr/bin/env node
/** Explicit read-only pilot. No dotenv, automatic tenant discovery or business-data artifacts. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
export function validateScenarios(value) {
  assert(
    Array.isArray(value) && value.length > 0 && value.length <= 4,
    'Provide 1–4 explicit workloads.',
  );
  let requested = 0;
  for (const s of value) {
    assert(s && /^[A-Z_][A-Z0-9_]{0,127}$/.test(s.form), 'Each workload needs a literal form.');
    assert(s.kind === 'record' || s.kind === 'list', 'kind must be record or list.');
    assert(
      Array.isArray(s.fields) &&
        s.fields.length > 0 &&
        s.fields.length <= 25 &&
        s.fields.every((f) => /^[A-Z_][A-Z0-9_]{0,127}$/.test(f)),
      'Explicit bounded projection required.',
    );
    assert(s.cache === 'cold' || s.cache === 'warm', 'cache must be cold or warm.');
    assert(
      Number.isSafeInteger(s.samples) && s.samples >= 1 && s.samples <= 50,
      'Samples must be 1–50.',
    );
    if (s.kind === 'record')
      assert(
        s.keys &&
          Object.keys(s.keys).length > 0 &&
          Object.keys(s.keys).length <= 5 &&
          Object.entries(s.keys).every(
            ([k, v]) =>
              /^[A-Z_][A-Z0-9_]*$/.test(k) &&
              ((typeof v === 'string' && v.length > 0 && v.length <= 128) ||
                (typeof v === 'number' && Number.isFinite(v))),
          ),
        'Explicit record keys required.',
      );
    else
      assert(
        Number.isSafeInteger(s.top) && s.top >= 1 && s.top <= 100,
        'List top must be 1–100; no pagination.',
      );
    requested += s.samples + (s.cache === 'warm' ? 1 : 0);
  }
  assert(
    requested <= 200,
    'Including warm-up, planned calls must not exceed200; actual retries count too.',
  );
  return value;
}
export function summarizeSamples(values) {
  const a = [...values].sort((x, y) => x - y);
  return {
    samples: a.length,
    sufficient: a.length >= 50,
    p50Ms: a.length ? a[Math.ceil(a.length * 0.5) - 1] : null,
    p95Ms: a.length >= 50 ? a[Math.ceil(a.length * 0.95) - 1] : null,
  };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(
      'Explicit authorized pilot: node scripts/profile-readonly.mjs --live --scenario-file PRIVATE.json --output PRIVATE-result.json\nNo .env is loaded. Requests <=200/run and <=30/minute. Without --live no network is possible.\n',
    );
    return;
  }
  assert(
    args.includes('--live'),
    'Live reads require explicit --live and prior activation authorization.',
  );
  const arg = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args[i + 1];
  };
  const path = arg('--scenario-file');
  assert(path, '--scenario-file required.');
  const output = arg('--output');
  assert(output, '--output required.');
  const scenarios = validateScenarios(JSON.parse(await readFile(resolve(path), 'utf8')));
  const [{ PriorityClient }, { loadConfig }, { createLogger }, { ODataBuilder }] =
    await Promise.all([
      import('../dist/client/priority-client.js'),
      import('../dist/config.js'),
      import('../dist/logger.js'),
      import('../dist/client/odata-builder.js'),
    ]);
  const config = loadConfig({
    ...process.env,
    PRIORITY_READ_ONLY: 'true',
    RATE_LIMIT_PER_MINUTE: String(Math.min(30, Number(process.env.RATE_LIMIT_PER_MINUTE) || 30)),
    LOG_LEVEL: 'error',
  });
  const client = new PriorityClient(config, createLogger(config));
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  let lastStart = 0;
  const results = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.method ?? 'GET', 'GET', 'Pilot cannot mutate.');
    assert(attempts < 200, 'Pilot total request budget exhausted.');
    const wait = Math.max(0, lastStart + 2001 - Date.now());
    if (wait) await delay(wait, undefined, { signal: init?.signal });
    init?.signal?.throwIfAborted();
    lastStart = Date.now();
    attempts++;
    return originalFetch(input, init);
  };
  try {
    for (const [index, s] of scenarios.entries()) {
      const query = new ODataBuilder().select(...s.fields);
      if (s.kind === 'list') query.top(s.top);
      const read = () =>
        s.kind === 'record'
          ? client.getComposite(s.form, s.keys, query.build())
          : client.list(s.form, query.build());
      const times = [];
      const before = attempts;
      let failures = 0;
      if (s.cache === 'warm') {
        try {
          await read();
        } catch {
          failures++;
        }
      }
      for (let i = 0; i < s.samples && attempts < 200; i++) {
        if (s.cache === 'cold') client.invalidateCache(s.form);
        const started = performance.now();
        try {
          await read();
          times.push(performance.now() - started);
        } catch {
          failures++;
        }
      }
      results.push({
        workload: index + 1,
        cacheState: s.cache,
        ...summarizeSamples(times),
        backendAttempts: attempts - before,
        failures,
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
    client.close();
  }
  const fingerprint = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const report = {
    mode: 'authorized-live-readonly',
    scenarioFingerprint: fingerprint(scenarios),
    effectiveRuntime: {
      rateLimitPerMinute: config.rateLimitPerMinute,
      maxConcurrency: config.priorityMaxConcurrency,
      reportConcurrency: config.priorityReportConcurrency,
      coalesceReads: config.priorityCoalesceReads,
      toolProfile: config.priorityToolProfile,
      readOnly: true,
    },
    observedAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    limits: { totalRequests: 200, perMinute: 30 },
    backendAttempts: attempts,
    results: results.map((result, index) => ({
      ...result,
      workloadFingerprint: fingerprint(scenarios[index]),
    })),
    hostModelTrials: { status: 'not-run', tokens: null },
    notes: [
      'Timing includes local queue and retry latency. Warm cache samples are not independent ERP observations. No business values, identifiers, credentials or source URLs are retained.',
    ],
  };
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(
    `${JSON.stringify({
      output: resolve(output),
      backendAttempts: attempts,
      complete: results.every((r) => r.sufficient && !r.failures),
    })}\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    process.stderr.write(
      'Read-only profiler stopped: invalid input, request budget, configuration or backend failure. No mutation attempted.\n',
    );
    process.exitCode = 1;
  });
