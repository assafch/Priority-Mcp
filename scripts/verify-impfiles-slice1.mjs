#!/usr/bin/env node
/**
 * LIVE read-only verification of the IMPFILES Slice 1 read tools (impfile_search, impfile_get),
 * asserting against real values captured from closed file IM25000009 (Polymeric).
 * Run:  node --env-file=.env scripts/verify-impfiles-slice1.mjs
 * Spawns the built server with PRIORITY_READ_ONLY=true — performs only GETs.
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
const client = new Client({ name: 'impfiles-slice1-verify', version: '0.0.0' });

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  cond ? pass++ : fail++;
};
const call = async (name, args = {}, timeout = 60000) => {
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
    const text = res.content?.[0]?.text ?? '';
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ok: !res.isError, data, raw: text };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
};

await client.connect(transport);
console.log('✓ connected (read-only)\n');

// 1) impfile_search — closed files.
console.log('--- 1) impfile_search { closed:true } ---');
const closed = await call('impfile_search', { closed: true, top: 10 });
const closedRows = closed.data?.importFiles ?? [];
check('search closed succeeds', closed.ok && Array.isArray(closedRows), closed.error ?? '');
check('returns closed files', closedRows.length > 0, `got ${closedRows.length}`);
check(
  'every result is CLOSED=Y',
  closedRows.length > 0 && closedRows.every((r) => r.CLOSED === 'Y'),
);
check(
  'all in bonded warehouse arov',
  closedRows.length > 0 && closedRows.every((r) => r.WARHSNAME === 'arov'),
);

// 2) impfile_search — by supplier, expect Polymeric files.
console.log('\n--- 2) impfile_search { supplier:"Polymeric Systems, INC." } ---');
const bySup = await call('impfile_search', { supplier: 'Polymeric Systems, INC.', top: 20 });
const supRows = bySup.data?.importFiles ?? [];
check('search by supplier succeeds', bySup.ok && Array.isArray(supRows), bySup.error ?? '');
check(
  'finds IM25000009 among Polymeric files',
  supRows.some((r) => r.IMPFNUM === 'IM25000009'),
);

// 3) impfile_search — drafts.
console.log('\n--- 3) impfile_search { status:"טיוטא" } ---');
const drafts = await call('impfile_search', { status: 'טיוטא', top: 20 });
const draftRows = drafts.data?.importFiles ?? [];
check('search drafts succeeds', drafts.ok && Array.isArray(draftRows), drafts.error ?? '');
check(
  'drafts include IM25000012',
  draftRows.some((r) => r.IMPFNUM === 'IM25000012'),
  `got ${draftRows.length}`,
);

// 4) impfile_get — normalized snapshot of IM25000009 vs known values.
console.log('\n--- 4) impfile_get { impfnum:"IM25000009" } ---');
const g = await call('impfile_get', { impfnum: 'IM25000009' });
const d = g.data ?? {};
check('impfile_get succeeds', g.ok && d.header?.IMPFNUM === 'IM25000009', g.error ?? '');
check('status is סופי (final)', d.header?.STATDES === 'סופי', `STATDES=${d.header?.STATDES}`);
check('2 linked invoices', (d.invoices?.length ?? 0) === 2, `got ${d.invoices?.length}`);
check(
  '1 goods invoice (file supplier)',
  d.derived?.goodsInvoices === 1,
  `got ${d.derived?.goodsInvoices}`,
);
check('1 cost/broker invoice', d.derived?.costInvoices === 1, `got ${d.derived?.costInvoices}`);
check('5 goods-content lines', d.derived?.goodsLineCount === 5, `got ${d.derived?.goodsLineCount}`);
check(
  '5 customs-estimate lines',
  d.derived?.customsEstimate?.lineCount === 5,
  `got ${d.derived?.customsEstimate?.lineCount}`,
);
check(
  'all 5 parts duty-free (no customs item)',
  d.derived?.customsEstimate?.partsWithoutCustomsItem === 5,
);
check('total duty is 0', d.derived?.customsEstimate?.totalDuty === 0);
check('5 linked PO lines', (d.linkedPoLines?.length ?? 0) === 5, `got ${d.linkedPoLines?.length}`);
check('no manual cost allocations', d.derived?.hasManualCostAllocations === false);
check(
  'invoice totals split by currency ($ + ILS)',
  d.derived?.invoiceTotalsByCurrency && Object.keys(d.derived.invoiceTotalsByCurrency).length >= 2,
  JSON.stringify(d.derived?.invoiceTotalsByCurrency),
);

// 5) impfile_get raw passthrough.
console.log('\n--- 5) impfile_get { raw:true } ---');
const graw = await call('impfile_get', { impfnum: 'IM25000009', raw: true });
check(
  'raw returns Priority record with IMPFILEINV_SUBFORM',
  graw.ok && Array.isArray(graw.data?.IMPFILEINV_SUBFORM),
);

// 6) multi-filter scoping — regression for the OR-precedence bug (supplier + status must BOTH hold).
console.log('\n--- 6) impfile_search { supplier + status } (OR-precedence regression) ---');
const scoped = await call('impfile_search', {
  supplier: 'Polymeric Systems, INC.',
  status: 'סופי',
  top: 50,
});
const scopedRows = scoped.data?.importFiles ?? [];
check(
  'supplier+status scoping succeeds',
  scoped.ok && Array.isArray(scopedRows),
  scoped.error ?? '',
);
check(
  'every result honors BOTH filters (would fail pre-fix)',
  scopedRows.length > 0 &&
    scopedRows.every((r) => r.STATDES === 'סופי' && r.SUPDES === 'Polymeric Systems, INC.'),
  `${scopedRows.length} rows`,
);

// 7) closed:false — regression for the eq-null 500 + precedence; combine with status.
console.log('\n--- 7) impfile_search { closed:false [+ status] } ---');
const open = await call('impfile_search', { closed: false, top: 20 });
const openRows = open.data?.importFiles ?? [];
check('closed:false succeeds (no HTTP 500)', open.ok && Array.isArray(openRows), open.error ?? '');
check(
  'closed:false returns only open files',
  openRows.length > 0 && openRows.every((r) => r.CLOSED !== 'Y'),
);
const openDrafts = await call('impfile_search', { closed: false, status: 'טיוטא', top: 20 });
const odRows = openDrafts.data?.importFiles ?? [];
check(
  'closed:false + status honors both filters',
  odRows.length > 0 && odRows.every((r) => r.CLOSED !== 'Y' && r.STATDES === 'טיוטא'),
  `${odRows.length} rows`,
);

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail === 0 ? 0 : 1);
