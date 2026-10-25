/** Offline planning measurements against 29f8959; no env or Priority network access. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { PriorityError } from '../../../../dist/client/errors.js';
import { PriorityClient } from '../../../../dist/client/priority-client.js';
import { loadConfig } from '../../../../dist/config.js';
import { CapabilityCatalog } from '../../../../dist/lib/capabilities.js';
import { searchForm } from '../../../../dist/lib/search.js';
import { textResult } from '../../../../dist/lib/tool-result.js';
import { createServer } from '../../../../dist/server.js';
import { registerMetaTools } from '../../../../dist/tools/meta.js';

const config = loadConfig({
  PRIORITY_SERVICE_ROOT: 'https://example.invalid/odata/Priority/offline/demo',
  PRIORITY_PAT: 'synthetic-offline',
  PRIORITY_READ_ONLY: 'true',
  MCP_TRANSPORT: 'stdio',
  LOG_LEVEL: 'error',
  RATE_LIMIT_PER_MINUTE: '10000',
});
const logger = pino({ level: 'silent' });
const outputFlag = process.argv.indexOf('--output');
if (outputFlag < 0 || !process.argv[outputFlag + 1]) {
  throw new Error(
    'Pass --output /tmp/priority-performance-replay.json; existing evidence is never overwritten.',
  );
}
const outputPath = process.argv[outputFlag + 1];
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('Real network forbidden in this benchmark');
};
const output = {
  date: new Date().toISOString(),
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version,
  kind: 'synthetic-offline-planning-baseline',
  livePriority: false,
};
const bytes = (x) => Buffer.byteLength(JSON.stringify(x));
const stats = (values) => {
  const a = values.slice().sort((a, b) => a - b);
  return {
    samples: a.length,
    medianMs: +a[Math.floor(a.length / 2)].toFixed(3),
    p95Ms: +a[Math.min(a.length - 1, Math.ceil(a.length * 0.95) - 1)].toFixed(3),
  };
};
try {
  const server = createServer(config, logger);
  const client = new Client({ name: 'planning-benchmark', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const begin = performance.now();
  await server.connect(st);
  await client.connect(ct);
  const list = await client.listTools();
  const elapsed = performance.now() - begin;
  output.discovery = {
    count: list.tools.length,
    serializedBytes: bytes(list),
    descriptionsBytes: list.tools.reduce((n, t) => n + Buffer.byteLength(t.description ?? ''), 0),
    schemaBytes: list.tools.reduce((n, t) => n + bytes(t.inputSchema) + bytes(t.outputSchema), 0),
    startupAndListInMemoryMs: +elapsed.toFixed(3),
    unavailableCount: list.tools.filter((t) => t.description?.startsWith('[UNAVAILABLE')).length,
    protocol: '2025-11-25',
    note: 'One in-process sample; excludes process startup, host/LLM cost, and ERP latency. Wire bytes are not token counts.',
  };
  let skip = 0;
  let calls = 0;
  let total = 0;
  let catalogBytes = 0;
  do {
    const result = await client.callTool({
      name: 'priority_get_capabilities',
      arguments: { top: 100, skip },
    });
    calls++;
    total += result.structuredContent.returned;
    catalogBytes += bytes(result);
    skip = result.structuredContent.nextSkip;
  } while (skip !== null);
  output.catalog = { topRequested: 100, calls, entries: total, serializedBytes: catalogBytes };
  await client.close();
  await server.close();
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ value: [{ CUSTNAME: 'SYNTHETIC-1' }] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const backend = new PriorityClient(config, logger);
  const start = performance.now();
  await Promise.all(Array.from({ length: 20 }, () => backend.list('CUSTOMERS', '?$top=1')));
  const cold = requests;
  await backend.list('CUSTOMERS', '?$top=1');
  output.coalescing = {
    concurrentIdenticalReads: 20,
    backendCalls: cold,
    warmAdditionalCalls: requests - cold,
    simulatedNetworkDelayMs: 20,
    elapsedMs: +(performance.now() - start).toFixed(3),
  };
  globalThis.fetch = async () => {
    throw new Error('Real network forbidden');
  };
  const searchCalls = [];
  const fakeSearch = {
    list: async (form, query) => {
      searchCalls.push(query);
      if (decodeURIComponent(query).includes('contains('))
        throw new PriorityError('contains not supported', 501);
      const q = new URLSearchParams(query.slice(1));
      const from = Number(q.get('$skip') ?? 0);
      return {
        value: Array.from({ length: Math.min(100, 300 - from) }, (_, i) => ({
          CUSTNAME: String(from + i),
          CUSTDES: from + i === 250 ? 'needle' : 'unrelated',
        })),
        ...(from < 200 ? { '@odata.nextLink': `CUSTOMERS?$skip=${from + 100}` } : {}),
      };
    },
  };
  const search = await searchForm(fakeSearch, {
    form: 'CUSTOMERS',
    query: 'needle',
    fields: ['CUSTDES'],
    select: ['CUSTNAME', 'CUSTDES'],
    top: 20,
    scanCap: 2000,
  });
  output.searchShortPage = {
    datasetRows: 300,
    serverPageCap: 100,
    matchingRowIndex: 250,
    calls: searchCalls.length,
    found: search.value.length,
    meta: search.meta,
    expectedMatches: 1,
  };
  const handlers = new Map();
  const metadataRequests = [];
  const fakeMetadata = {
    request: async (entity) => {
      metadataRequests.push(entity);
      return '<Schema><EntityType Name="CUSTOMERS"><Key><PropertyRef Name="CUSTNAME" /></Key><Property Name="CUSTNAME" Type="Edm.String" /></EntityType></Schema>';
    },
  };
  registerMetaTools(
    { tool: (name, desc, schema, callback) => handlers.set(name, callback) },
    fakeMetadata,
    config,
  );
  await handlers.get('priority_get_entity_schema')({ entity: 'CUSTOMERS' });
  output.singleEntitySchema = {
    requestedEntity: 'CUSTOMERS',
    backendEndpoints: metadataRequests,
    usesFullMetadata: metadataRequests.includes('$metadata'),
  };
  let probes = 0;
  const probeClient = {
    request: async () => {
      probes++;
      return { value: [] };
    },
  };
  const catalog = new CapabilityCatalog(probeClient, config);
  const entries = catalog.list().filter((x) => x.name === 'priority_list_customers');
  await catalog.refresh(entries);
  await catalog.refresh(entries);
  const otherCatalog = new CapabilityCatalog(probeClient, config);
  output.capabilityEvidence = {
    explicitRefreshes: 2,
    backendCalls: probes,
    firstCatalogEvidence: catalog
      .list('customers')
      .find((x) => x.name === 'priority_list_customers').evidence,
    secondSessionEvidence: otherCatalog
      .list('customers')
      .find((x) => x.name === 'priority_list_customers').evidence,
    note: 'Explicit refresh forces reads by design; evidence cache is per catalog/server, unlike shared backend cache.',
  };
  const large = {
    rows: Array.from({ length: 20000 }, (_, i) => ({
      id: i,
      label: 'synthetic label',
      amount: 123.45,
    })),
    meta: { complete: true },
  };
  const times = [];
  let result;
  for (let i = 0; i < 11; i++) {
    const t = performance.now();
    result = textResult(large);
    if (i) times.push(performance.now() - t);
  }
  assert(JSON.parse(result.content[0].text));
  assert(result.content[0].text.length <= 24000);
  output.serialization = {
    ...stats(times),
    inputRows: large.rows.length,
    inputJsonBytes: bytes(large),
    outputTextChars: result.content[0].text.length,
    returnedRows: result.structuredContent.rows.length,
    note: 'Direct textResult CPU sample only; tool registry can normalize the already-bounded result again.',
  };
  writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(output, null, 2));
} finally {
  globalThis.fetch = nativeFetch;
}
