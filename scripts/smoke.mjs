#!/usr/bin/env node
/** Offline validation through the actual MCP stdio protocol. No .env or real credentials. */
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['--import', resolve(root, 'scripts/offline-network.mjs'), resolve(root, 'dist/index.js')],
  env: {
    PRIORITY_SERVICE_ROOT: 'https://example.invalid/odata/Priority/offline/demo',
    PRIORITY_PAT: 'offline-placeholder',
    PRIORITY_READ_ONLY: 'true',
    MCP_TRANSPORT: 'stdio',
    LOG_LEVEL: 'error',
  },
});
const client = new Client({ name: 'offline-smoke-test', version: '0.0.0' });
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((tool) => tool.name));
  for (const name of [
    'priority_list_forms',
    'priority_get_entity_metadata',
    'priority_describe_form',
    'priority_query',
    'priority_get_record',
    'priority_create_record',
    'priority_update_record',
    'priority_add_line',
    'priority_create_invoice',
    'priority_create_purchase_order',
    'priority_search_suppliers',
  ])
    assert(names.has(name), `Missing MCP tool: ${name}`);

  function content(result) {
    const block = result.content?.find((item) => item.type === 'text');
    assert(block, 'Expected a structured tool response');
    return JSON.parse(block.text);
  }
  // Explicitly synthetic generic form: this does not assert any tenant mapping.
  const generic = await client.callTool({
    name: 'priority_create_record',
    arguments: {
      form: 'OFFLINE_DEMO_FORM',
      data: { NOTE: 'offline only' },
      confirm: false,
    },
  });
  assert.equal(generic.isError, undefined);
  assert.equal(content(generic).dryRun, true);
  assert.equal(content(generic).wouldSend.method, 'POST');

  for (const [name, arguments_] of [
    [
      'priority_create_invoice',
      { customerId: 'offline-customer', items: [{ productId: 'offline-product', quantity: 1 }] },
    ],
    [
      'priority_create_purchase_order',
      { supplierId: 'offline-supplier', items: [{ productId: 'offline-product', quantity: 1 }] },
    ],
  ]) {
    const preview = await client.callTool({ name, arguments: arguments_ });
    assert.equal(content(preview).dryRun, true, `${name} must default to preview`);
    const blocked = await client.callTool({ name, arguments: { ...arguments_, dryRun: false } });
    assert.equal(blocked.isError, true, `${name} must reject live writes`);
    assert.match(content(blocked).error, /read-only/i);
  }
  const blocked = await client.callTool({
    name: 'priority_create_record',
    arguments: {
      form: 'OFFLINE_DEMO_FORM',
      data: {},
      confirm: true,
    },
  });
  assert.equal(blocked.isError, true);
  assert.match(content(blocked).error, /read-only/i);
  console.info(
    `Offline MCP smoke passed: ${tools.length} tools registered; previews and write guards verified. No Priority connection used.`,
  );
} finally {
  await client.close();
}
