// Historical baseline script for commit 4fc5577; not the post-fix regression suite.
// Offline audit: fake credentials, mocked fetch, no Priority access or writes.
// Run after: npx tsc --outDir node_modules/.cache/priority-audit-2026-10-25
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import ts from 'typescript';
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const build = resolve(root, 'node_modules/.cache/priority-audit-2026-10-25');
const compiled = (p) => import(pathToFileURL(resolve(build, p)).href);
const { createServer } = await compiled('server.js');
const { textResult } = await compiled('lib/write-guard.js');
const { fetchAllPages } = await compiled('lib/paginate.js');
const { registerGenericTools } = await compiled('tools/generic.js');
const { registerOrderTools } = await compiled('tools/orders.js');
const { registerInvoiceTools } = await compiled('tools/invoices.js');
const config = {
  priorityServiceRoot: 'https://example.invalid/odata/Priority/offline/demo',
  priorityEnvironment: 'offline',
  priorityCompany: 'demo',
  priorityLanguage: 'EN',
  priorityUsername: 'SYNTHETIC_PAT_DO_NOT_USE',
  priorityPassword: 'PAT',
  priorityCustomEntities: [],
  priorityReadOnly: true,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 120,
  requestTimeoutMs: 1000,
  logLevel: 'error',
  mcpTransport: 'stdio',
  mcpHttpPort: 3000,
  mcpHttpHost: '127.0.0.1',
};
const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((k) => [k, () => {}]));
globalThis.fetch = async () => {
  throw new Error('OFFLINE audit: network forbidden');
};
const server = createServer(config, logger);
const client = new Client({ name: 'offline-capability-audit', version: '1' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await server.connect(st);
await client.connect(ct);
const findings = {};
const sourceTools = [];
for (const file of (await readdir(resolve(root, 'src/tools'))).filter((f) => f.endsWith('.ts'))) {
  const code = await readFile(resolve(root, 'src/tools', file), 'utf8');
  const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'tool' &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const name = node.arguments[0].text;
      const body = node.arguments.at(-1).getText(sf);
      const schema = node.arguments[2].getText(sf);
      const unavailable = body.includes('unavailableHere(') && !/client[.,]/.test(body);
      const status = unavailable
        ? 'unavailable-in-code'
        : name.endsWith('_guide')
          ? 'guide-only'
          : /dryRun:|confirm:/.test(schema)
            ? 'write-path'
            : 'read-path';
      sourceTools.push({
        name,
        module: file.replace('.ts', ''),
        status,
        source: `src/tools/${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}
let tools;
let resources;
let templates;
let prompts;
try {
  tools = (await client.listTools()).tools;
  resources = (await client.listResources()).resources;
  templates = (await client.listResourceTemplates()).resourceTemplates;
  prompts = (await client.listPrompts()).prompts;
  const profile = await client.readResource({ uri: 'priority://user/profile' });
  findings.legacyPatReturnedByResource = JSON.stringify(profile).includes(config.priorityUsername);
  findings.toolsWithAnnotations = tools.filter((t) => t.annotations).length;
  findings.toolsWithOutputSchema = tools.filter((t) => t.outputSchema).length;
} finally {
  await client.close();
  await server.close();
}
const result = textResult({ invoice: { DETAILS: 'x'.repeat(40000) } }).content[0].text;
findings.largeResultLength = result.length;
try {
  JSON.parse(result);
  findings.largeResultValidJson = true;
} catch {
  findings.largeResultValidJson = false;
}
const capped = await fetchAllPages(
  async (_skip, top) => Array.from({ length: top }, (_, id) => ({ id })),
  { pageSize: 500, maxRows: 600 },
);
findings.maxRows600ActualRows = capped.rows.length;
const short = await fetchAllPages(async () => Array.from({ length: 100 }, (_, id) => ({ id })), {
  pageSize: 500,
  maxRows: 1000,
});
findings.shortPageAssumedExhausted = { rows: short.rows.length, capped: short.capped };
// Direct handler fixtures: all backend calls are intercepted here, never sent.
const handlers = new Map();
const capture = { tool: (name, description, schema, handler) => handlers.set(name, handler) };
const fake = {
  resolveEntityUrl: () => 'https://example.invalid/record',
  update: async () => ({ BOOLCLOSED: '', PHONE: 'old' }),
};
registerGenericTools(capture, fake, { ...config, priorityReadOnly: false });
registerOrderTools(capture, fake, { ...config, priorityReadOnly: false });
const parse = (r) => JSON.parse(r.content[0].text);
findings.updateNoOp = parse(
  await handlers.get('priority_update_record')({
    form: 'CUSTOMERS',
    key: 'synthetic',
    data: { PHONE: 'new' },
    confirm: true,
  }),
);
findings.cancelNoOp = parse(
  await handlers.get('priority_cancel_order')({
    orderNumber: 'synthetic',
    reason: 'fixture',
    dryRun: false,
  }),
);
registerInvoiceTools(
  capture,
  {
    list: async () => ({
      value: Array.from({ length: 200 }, (_, i) => ({
        IVNUM: `IV${i}`,
        IVRECONDATE: '2026-01-01',
        IVDATE: '2025-01-01',
      })),
    }),
  },
  config,
);
findings.unpaidScanCap = parse(
  await handlers.get('priority_get_unpaid_invoices_for_customer')({
    customerId: 'synthetic',
    top: 100,
  }),
);
assert.equal(tools.length, sourceTools.length);
assert.deepEqual(tools.map((t) => t.name).sort(), sourceTools.map((t) => t.name).sort());
const inventory = sourceTools
  .map((t) => ({
    ...t,
    hasAnnotations: !!tools.find((x) => x.name === t.name).annotations,
    hasOutputSchema: !!tools.find((x) => x.name === t.name).outputSchema,
  }))
  .sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
const summary = {
  generatedAt: new Date().toISOString(),
  sourceCommit: '4fc5577',
  node: process.version,
  backend: 'synthetic/offline; fetch disabled',
  counts: {
    tools: tools.length,
    resources: resources.length,
    templates: templates.length,
    prompts: prompts.length,
    byStatus: Object.fromEntries(
      [...new Set(inventory.map((t) => t.status))].map((s) => [
        s,
        inventory.filter((t) => t.status === s).length,
      ]),
    ),
  },
  findings,
  inventory,
};
await writeFile(resolve(here, 'offline-evidence.json'), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(
  resolve(here, 'capabilities.md'),
  [
    '# Priority MCP capability inventory — 2026-10-25',
    '',
    'Source-derived status, verified against offline MCP tools/list. This is not proof of tenant availability.',
    '',
    '`read-path` = implemented read; `write-path` = guarded write implementation; `guide-only` = instructions without execution; `unavailable-in-code` = unconditional refusal. Per-form and procedure limitations still apply to implemented paths.',
    '',
    `Counts: ${JSON.stringify(summary.counts)}`,
    '',
    '| Tool | Code status | Source |',
    '| --- | --- | --- |',
    ...inventory.map((t) => `| \`${t.name}\` | ${t.status} | ${t.source} |`),
    '',
    '## Resources and prompts',
    '',
    ...resources.map((r) => `- Resource: \`${r.uri}\``),
    ...templates.map((r) => `- Template: \`${r.uriTemplate}\``),
    ...prompts.map((p) => `- Prompt: \`${p.name}\``),
    '',
  ].join('\n'),
);
console.log(JSON.stringify({ counts: summary.counts, findings }, null, 2));
