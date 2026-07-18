#!/usr/bin/env node
/**
 * Offline smoke test (NO live Priority calls).
 *
 * Spawns the built server over the real MCP stdio protocol with placeholder, READ-ONLY env,
 * lists the tools, asserts the 8 generic target tools are registered, and exercises the
 * credit-document write path in DRY-RUN mode (confirm=false) so the exact POST endpoint +
 * JSON body is printed without anything being sent to Priority.
 *
 * Run:  node scripts/smoke.mjs   (after `npm run build`)
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const transport = new StdioClientTransport({
  command: 'node',
  args: [resolve(root, 'dist/index.js')],
  env: {
    ...process.env,
    // Placeholder, syntactically-valid config. No network is used by this test.
    PRIORITY_SERVICE_ROOT: 'https://example.invalid/odata/Priority/tabula.ini/demo',
    PRIORITY_USERNAME: 'placeholder-token',
    PRIORITY_PASSWORD: 'PAT',
    PRIORITY_READ_ONLY: 'true',
    LOG_LEVEL: 'error',
  },
});

const client = new Client({ name: 'smoke-test', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`\n✓ Server connected. ${tools.length} tools registered.`);

const TARGET = [
  'priority_list_forms',
  'priority_get_entity_metadata',
  'priority_describe_form',
  'priority_query',
  'priority_get_record',
  'priority_create_record',
  'priority_update_record',
  'priority_add_line',
];
const missing = TARGET.filter((n) => !names.includes(n));
console.log(
  missing.length
    ? `✗ MISSING generic tools: ${missing.join(', ')}`
    : `✓ All 8 generic target tools present: ${TARGET.join(', ')}`,
);

// --- DRY-RUN: build a credit document (negative quantities) and preview it. ---
// NOTE: 'CINVOICES' / the sub-form name are PLACEHOLDERS. The credit-invoice form name
// varies by installation — in real use, discover it first with priority_list_forms /
// priority_get_entity_metadata. We use confirm=false, so NOTHING is sent regardless.
const creditDoc = {
  form: 'CINVOICES',
  data: {
    CUSTNAME: 'C1001',
    IVNUM: '12345',
    AINVOICEITEMS_SUBFORM: [
      { PARTNAME: 'P-100', TQUANT: -2 },
      { PARTNAME: 'P-200', TQUANT: -1 },
    ],
  },
  confirm: false,
};

const res = await client.callTool({ name: 'priority_create_record', arguments: creditDoc });
console.log('\n--- priority_create_record DRY-RUN (credit document) ---');
console.log(res.content[0].text);

await client.close();
console.log('\n✓ Smoke test complete (no live API calls were made).');
