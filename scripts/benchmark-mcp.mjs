#!/usr/bin/env node
/** Maintained synthetic benchmark. No .env, network, tenant data or real credentials. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PriorityClient } from '../dist/client/priority-client.js';
import { searchForm } from '../dist/lib/search.js';
import { textResult } from '../dist/lib/tool-result.js';
import { createLogger } from '../dist/logger.js';
import { createServer } from '../dist/server.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return (
    args
      .find((arg) => arg.startsWith(`--${name}=`))
      ?.split('=')
      .slice(1)
      .join('=') ?? (index >= 0 ? args[index + 1] : fallback)
  );
};
assert.equal(
  option('mode', 'offline'),
  'offline',
  'Only offline mode is implemented; live measurement requires a separate approved replay.',
);
const outputPath = resolve(option('output', resolve(root, 'artifacts/performance/offline.json')));
const fixture = JSON.parse(
  await readFile(resolve(root, 'tests/fixtures/performance/workloads.json'), 'utf8'),
);
const samples = fixture.samples;
assert.equal(samples, 50);
const config = {
  priorityServiceRoot: 'https://fixture.invalid/odata/Priority/offline/demo',
  priorityPat: 'synthetic-offline-only',
  priorityReadOnly: true,
  priorityCompany: 'demo',
  priorityEnvironment: 'offline',
  priorityLanguage: 'EN',
  priorityCustomEntities: [],
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 1000000,
  requestTimeoutMs: 1000,
  logLevel: 'silent',
  mcpTransport: 'stdio',
  mcpHttpPort: 3000,
  mcpHttpHost: '127.0.0.1',
};
const logger = createLogger(config);
let backendCalls = 0;
let fixtureFetch;
// No fallback to real fetch is retained. All in-memory requests must use this fixture origin.
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin, 'https://fixture.invalid', 'Non-fixture request forbidden');
  assert.equal(init?.method ?? 'GET', 'GET', 'Benchmark cannot mutate');
  backendCalls++;
  return fixtureFetch
    ? fixtureFetch(url)
    : Response.json({ value: [{ CUSTNAME: 'SYNTHETIC', CUSTDES: 'fixture' }] });
};
const results = [];
const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
function summarize(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    samples: ordered.length,
    min: ordered[0],
    p50: ordered[Math.ceil(ordered.length * 0.5) - 1],
    p95: ordered[Math.ceil(ordered.length * 0.95) - 1],
    max: ordered.at(-1),
    mean: ordered.reduce((a, b) => a + b, 0) / ordered.length,
  };
}
async function measure(name, mode, state, run, inputBytes) {
  const durations = [];
  const payloadBytes = [];
  const calls = [];
  for (let i = 0; i < samples; i++) {
    const beforeCalls = backendCalls;
    const started = performance.now();
    const result = await run(i);
    durations.push(performance.now() - started);
    payloadBytes.push(result?.serializedResultBytes ?? bytes(result));
    calls.push(backendCalls - beforeCalls);
  }
  results.push({
    name,
    mode,
    state,
    inputBytes,
    latencyMs: summarize(durations),
    payloadBytes: summarize(payloadBytes),
    backendCalls: summarize(calls),
  });
}
async function memorySession(profile = 'full') {
  const server = createServer({ ...config, priorityToolProfile: profile }, logger);
  const client = new Client({ name: 'offline-benchmark', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
await measure('startup-and-list-tools', 'in-memory', 'cold-server-warm-imports', async () => {
  const session = await memorySession();
  try {
    return await session.client.listTools();
  } finally {
    await session.close();
  }
});
await measure('startup-and-list-tools', 'process-stdio', 'cold-process', async () => {
  const client = new Client({ name: 'offline-process-benchmark', version: '1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      '--import',
      resolve(root, 'scripts/offline-network.mjs'),
      resolve(root, 'dist/index.js'),
    ],
    stderr: 'pipe',
    env: {
      PRIORITY_SERVICE_ROOT: 'https://fixture.invalid/odata/Priority/offline/demo',
      PRIORITY_PAT: 'synthetic-offline-only',
      PRIORITY_READ_ONLY: 'true',
      MCP_TRANSPORT: 'stdio',
      LOG_LEVEL: 'error',
    },
  });
  try {
    await client.connect(transport);
    return await client.listTools();
  } finally {
    await client.close();
  }
});
const session = await memorySession();
try {
  await measure('list-tools', 'in-memory', 'warm-server', () => session.client.listTools());
  await measure('capabilities-all-pages', 'in-memory', 'warm-server', async () => {
    let skip = 0;
    let totalBytes = 0;
    let calls = 0;
    let entries = 0;
    do {
      const result = await session.client.callTool({
        name: 'priority_get_capabilities',
        arguments: { top: 100, skip },
      });
      assert.notEqual(result.isError, true);
      totalBytes += bytes(result);
      calls++;
      entries += result.structuredContent.returned;
      skip = result.structuredContent.nextSkip;
      assert.ok(calls < 20, 'Catalog pagination must advance');
    } while (skip !== null);
    return { calls, entries, serializedResultBytes: totalBytes };
  });
} finally {
  await session.close();
}
const compactSession = await memorySession('operations');
try {
  await measure('list-tools-operations', 'in-memory', 'warm-server', async () => {
    const result = await compactSession.client.listTools();
    assert(result.tools.length <= 25);
    assert(bytes(result) <= 40000);
    return result;
  });
} finally {
  await compactSession.close();
}
const backend = new PriorityClient(config, logger);
await backend.list('CUSTOMERS');
await measure('cached-lookup', 'in-memory-client', 'warm-response-cache', () =>
  backend.list('CUSTOMERS'),
);
await measure(
  'concurrent-identical-reads-20',
  'in-memory-client',
  'cold-response-cache',
  async () => {
    backend.invalidateCache('CUSTOMERS');
    return Promise.all(Array.from({ length: 20 }, () => backend.list('CUSTOMERS')));
  },
);
backend.close();
const spec = fixture.shortPageSearch;
const rows = Array.from({ length: spec.rows }, (_, i) => ({
  CUSTNAME: `SYNTHETIC_${i}`,
  CUSTDES: i === spec.matchIndex ? 'needle-fixture' : 'other-fixture',
}));
fixtureFetch = (url) => {
  if (url.searchParams.get('$filter')?.includes('contains'))
    return Response.json({ error: { message: 'contains is not supported' } }, { status: 501 });
  const skip = Number(url.searchParams.get('$skip') ?? 0);
  const top = Number(url.searchParams.get('$top') ?? spec.pageSize);
  const end = Math.min(skip + spec.pageSize, skip + top);
  return Response.json({
    value: rows.slice(skip, end),
    ...(end < rows.length ? { '@odata.nextLink': `CUSTOMERS?$skip=${end}&$top=${top}` } : {}),
  });
};
await measure('short-page-search-row-250', 'in-memory-client', 'cold-response-cache', async () => {
  const client = new PriorityClient(config, logger);
  try {
    const result = await searchForm(client, {
      form: 'CUSTOMERS',
      query: 'needle-fixture',
      fields: ['CUSTNAME', 'CUSTDES'],
      top: 20,
    });
    assert.equal(result.value[0]?.CUSTNAME, `SYNTHETIC_${spec.matchIndex}`);
    return result;
  } finally {
    client.close();
  }
});
fixtureFetch = undefined;
const formatInput = {
  value: Array.from({ length: fixture.formatter.rows }, (_, i) => ({
    id: i,
    description: 'x'.repeat(fixture.formatter.descriptionChars),
  })),
};
const formatInputBytes = bytes(formatInput);
assert.ok(formatInputBytes >= fixture.formatter.minimumInputBytes);
await measure(
  'formatter-1MiB',
  'in-memory-formatter',
  'warm-imports',
  () => textResult(formatInput),
  formatInputBytes,
);
const total = fixture.report.amounts.reduce((a, b) => a + b, 0);
assert.equal(total, fixture.report.expectedTotal);
assert.equal(textResult({ total }).structuredContent.total, fixture.report.expectedTotal);
const artifact = {
  schemaVersion: 1,
  observedAt: new Date().toISOString(),
  kind: 'synthetic-offline-maintained-benchmark',
  livePriority: false,
  revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dirty: Boolean(
    execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  ),
  node: process.version,
  platform: platform(),
  release: release(),
  arch: arch(),
  cpu: cpus()[0]?.model,
  fixture: fixture.name,
  fixtureVersion: fixture.schemaVersion,
  results,
  correctness: { shortPageMatchIndex: spec.matchIndex, reportTotal: total },
  exclusions: [
    'ERP/network latency',
    'host/model turns and token usage',
    'disk-cold module/OS caches',
    'live rate-limit behavior',
  ],
  notes: [
    '50 measured samples per workload; no discarded warmup samples.',
    'Process timings include stdio initialization and shutdown; in-memory imports are already warm.',
    'Payload bytes are serialized JSON bytes, not tokens. Catalog serializedResultBytes measures every tool response.',
    'Historical planning baseline is separate: docs/audits/2026-10-25/performance/baseline.json.',
  ],
};
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.info(
  `Offline benchmark complete: ${results.length} workloads, ${samples} samples each. ${outputPath}`,
);
