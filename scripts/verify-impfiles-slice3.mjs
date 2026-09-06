#!/usr/bin/env node
/**
 * LIVE verification of IMPFILES Slice 3 (match / preflight / landed-cost / close). Read tools run
 * against real data (PO25000003, IM25000009); write tools use their default dryRun=true (no writes).
 * Run:  node --env-file=.env scripts/verify-impfiles-slice3.mjs
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
const client = new Client({ name: 'impfiles-slice3-verify', version: '0.0.0' });

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
const approx = (a, b, tol = 0.1) => Math.abs(a - b) <= tol;

await client.connect(transport);
console.log('✓ connected (read-only; writes dry-run)\n');

// 1) po_match on a closed, fully-supplied PO.
console.log('--- 1) po_match PO25000003 (closed) ---');
const m = await call('po_match', { poNumber: 'PO25000003' });
check('po_match succeeds', m.ok && Array.isArray(m.data?.lines), m.error ?? '');
check('PO reported closed', m.data?.closed === true);
check(
  '5 parts, all matched',
  m.data?.summary?.parts === 5 && m.data?.summary?.matched === 5 && m.data?.summary?.issues === 0,
  JSON.stringify(m.data?.summary),
);
check(
  'a matched line carries ordered/received/invoiced + price',
  m.data?.lines?.[0]?.verdict === 'matched' && m.data.lines[0].unitPrice > 0,
);

// 2) po_match on an open PO → ordered-not-arrived.
console.log('\n--- 2) po_match PO26000008 (open) ---');
const mo = await call('po_match', { poNumber: 'PO26000008' });
check('open PO not closed', mo.ok && mo.data?.closed === false, mo.error ?? '');
check(
  'open PO line is ordered-not-arrived',
  (mo.data?.lines ?? []).some((l) => l.verdict === 'ordered-not-arrived'),
);

// 3) impfile_preflight on a real closed file.
console.log('\n--- 3) impfile_preflight IM25000009 ---');
const pf = await call('impfile_preflight', { impfnum: 'IM25000009' });
check('preflight succeeds', pf.ok && typeof pf.data?.ok === 'boolean', pf.error ?? '');
check(
  'preflight ok (no blocking) for a valid file',
  pf.data?.ok === true && (pf.data?.blocking ?? []).length === 0,
  JSON.stringify(pf.data?.blocking),
);
check('preflight reports duty-free info', (pf.data?.info ?? []).join(' ').includes('duty-free'));
check(
  'preflight has advisories (loading method / calc timing)',
  (pf.data?.advisory ?? []).length >= 2,
);

// 4) impfile_landed_cost — value-weighted estimate against real numbers.
console.log('\n--- 4) impfile_landed_cost IM25000009 ---');
const lc = await call('impfile_landed_cost', { impfnum: 'IM25000009' });
check('landed_cost succeeds', lc.ok && Array.isArray(lc.data?.lines), lc.error ?? '');
check('5 SKU lines', lc.data?.lines?.length === 5, `got ${lc.data?.lines?.length}`);
check(
  'ancillary = broker pre-VAT DISPRICE (5751.06)',
  approx(lc.data?.ancillaryCostsILS, 5751.06),
  `got ${lc.data?.ancillaryCostsILS}`,
);
check(
  'total goods value = Σ customs-estimate PRICE (53055.23)',
  approx(lc.data?.totalGoodsValueILS, 53055.23),
  `got ${lc.data?.totalGoodsValueILS}`,
);
const allocSum = (lc.data?.lines ?? []).reduce((s, l) => s + l.allocatedCostILS, 0);
check(
  'allocated costs sum ≈ ancillary (value-weighted)',
  approx(allocSum, 5751.06, 0.2),
  `Σalloc=${allocSum.toFixed(2)}`,
);
check(
  'each landed = goods + allocated',
  (lc.data?.lines ?? []).every((l) =>
    approx(l.landedCostILS, l.goodsValueILS + l.allocatedCostILS, 0.02),
  ),
);

// 5) impfile_run_calc — procedure guidance (not an OData action).
console.log('\n--- 5) impfile_run_calc IM25000009 ---');
const rc = await call('impfile_run_calc', { impfnum: 'IM25000009' });
check(
  'run_calc reports not-exposed + current state',
  rc.ok && rc.data?.exposedAsApi === false && rc.data?.currentCustomsEstimateLines === 5,
  rc.error ?? '',
);

// 6) po_close_lines — dry-run PATCH preview.
console.log('\n--- 6) po_close_lines (dry-run) ---');
const pcl = await call('po_close_lines', { poNumber: 'PO26000008' });
check(
  'po_close_lines previews CLOSEDBOOL PATCH',
  pcl.data?.dryRun === true &&
    pcl.data?.wouldSend?.method === 'PATCH' &&
    pcl.data?.wouldSend?.body?.CLOSEDBOOL === 'Y',
);

// 7) impfile_close — runs preflight first, then previews the close PATCH.
console.log('\n--- 7) impfile_close IM25000009 (dry-run) ---');
const cl = await call('impfile_close', { impfnum: 'IM25000009' });
check(
  'close is a dry-run gated by a clean preflight',
  cl.data?.dryRun === true && cl.data?.wouldSend?.preflight?.ok === true,
  cl.error ?? '',
);
check(
  'close body sets CLOSED=Y + STATDES=סופי',
  cl.data?.wouldSend?.body?.CLOSED === 'Y' && cl.data?.wouldSend?.body?.STATDES === 'סופי',
);

// 8) impfile_reopen — dry-run PATCH preview.
console.log('\n--- 8) impfile_reopen IM25000009 (dry-run) ---');
const ro = await call('impfile_reopen', { impfnum: 'IM25000009' });
check(
  'reopen previews CLOSED="" + STATDES=טיוטא',
  ro.data?.dryRun === true &&
    ro.data?.wouldSend?.body?.CLOSED === '' &&
    ro.data?.wouldSend?.body?.STATDES === 'טיוטא',
);

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail === 0 ? 0 : 1);
