#!/usr/bin/env node
/**
 * LIVE read-only smoke test. Spawns the built server with the real env (load via
 * `node --env-file=.env scripts/live-smoke.mjs`) and exercises only READ operations:
 * list_forms, entity metadata for the customer & invoice forms, and a bounded top=1 query.
 * Makes a handful of GETs — no writes. The server is started with PRIORITY_READ_ONLY=true.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const transport = new StdioClientTransport({
  command: 'node',
  args: [resolve(root, 'dist/index.js')],
  env: { ...process.env, PRIORITY_READ_ONLY: 'true', LOG_LEVEL: 'error' },
});
const client = new Client({ name: 'live-smoke', version: '0.0.0' });

const call = async (name, args = {}, timeout = 60000) => {
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
    const text = res.content?.[0]?.text ?? '';
    try {
      return { ok: !res.isError, data: JSON.parse(text) };
    } catch {
      return { ok: !res.isError, data: text };
    }
  } catch (err) {
    return { ok: false, data: null, error: err?.message ?? String(err) };
  }
};

await client.connect(transport);
console.log('✓ connected to live Priority\n');

// 1) Discovery: which forms are exposed to the API? (service doc is large/slow here → long timeout)
const forms = await call('priority_list_forms', {}, 120000);
if (forms.error) console.log(`list_forms → ${forms.error}`);
if (Array.isArray(forms.data?.forms)) {
  const names = forms.data.forms
    .map((f) => f.name ?? f.url)
    .filter(Boolean)
    .sort();
  console.log(`list_forms → ${names.length} forms exposed.`);
  const rx = /CUST|INVOIC|CINV|AINV|ORDER|LOGPART|PART/i;
  console.log('relevant forms:', names.filter((n) => rx.test(n)).join(', ') || '(none matched)');
} else {
  console.log('list_forms result:', JSON.stringify(forms.data).slice(0, 600));
}

// 2) Field discovery for the customer & invoice forms (metadata, fallback to describe).
for (const form of ['CUSTOMERS', 'AINVOICES', 'CINVOICES']) {
  console.log(`\n--- ${form} ---`);
  const md = await call('priority_get_entity_metadata', { entity: form });
  const d = md.data;
  if (md.ok && d?.fields) {
    const mandatory = d.fields.filter((f) => f.mandatory).map((f) => f.name);
    const lineSub = d.subforms?.find((s) => /ITEM/i.test(s));
    console.log(
      `  title: ${d.title ?? '(none)'} | key: [${(d.key ?? []).join(', ')}] | ${d.fieldCount} fields`,
    );
    console.log(`  mandatory: ${mandatory.join(', ') || '(none)'}`);
    console.log(
      `  line sub-form: ${lineSub ?? '(none found)'} | sub-forms: ${(d.subforms ?? []).length}`,
    );
  } else {
    console.log('  get_entity_metadata parse miss:', JSON.stringify(d).slice(0, 300));
  }
}

// 3) Bounded query (top=1) to prove reads work end-to-end.
console.log('\n--- bounded query CUSTOMERS top=1 ---');
const q = await call('priority_query', { form: 'CUSTOMERS', top: 1 });
console.log(
  `query OK=${q.ok}, count=${q.data?.count}; first row keys:`,
  q.data?.value?.[0] ? Object.keys(q.data.value[0]).slice(0, 25).join(', ') : '(none)',
);

await client.close();
console.log('\n✓ live read-only smoke complete (no writes performed).');
