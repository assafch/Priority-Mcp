#!/usr/bin/env node
/**
 * LIVE verification of the bonded-warehouse module (read + guidance + read-back). Reads WAREHOUSES
 * (arov) and real files (IM25000009 closed, IM25000012 open draft). No writes.
 * Run:  node --env-file=.env scripts/verify-impfiles-bonded.mjs
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
const client = new Client({ name: 'impfiles-bonded-verify', version: '0.0.0' });

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

// 1) bonded_status — arov config, plus a non-bonded control and a not-found case.
console.log('--- 1) bonded_status ---');
const st = await call('bonded_status', {});
check('bonded_status succeeds', st.ok && Array.isArray(st.data?.locations), st.error ?? '');
check('arov reported as bonded', st.data?.isBonded === true);
// The holding location is the one NOT in inventory value (COSTFLAG); the costed one holds released goods.
const holding = (st.data?.locations ?? []).find((l) => l.inInventoryValue === false);
const costed = (st.data?.locations ?? []).find((l) => l.inInventoryValue === true);
check('has a bonded holding location (type D, not in inventory value)', holding && holding.bonded === true && holding.type === 'D');
check('holding location described as ערובה', String(holding?.description ?? '').includes('ערובה'));
check('has a costed/released location (in inventory value)', Boolean(costed));
// Control: a TYPE='D' warehouse that is NOT bonded must report isBonded=false (BONDED flag, not TYPE).
const main = await call('bonded_status', { warehouse: 'Main' });
check('Main (type-D, not bonded) → isBonded false', main.data?.found === true && main.data?.isBonded === false);
const none = await call('bonded_status', { warehouse: '__no_such_wh__' });
check('unknown warehouse → found false, isBonded false', none.data?.found === false && none.data?.isBonded === false);

// 2) bonded_receipt_create — guidance + read-back on a closed file.
console.log('\n--- 2) bonded_receipt_create IM25000009 ---');
const rc = await call('bonded_receipt_create', { impfnum: 'IM25000009' });
check('receipt guidance + warehouse read-back', rc.ok && rc.data?.warehouse === 'arov' && Array.isArray(rc.data?.instructions), rc.error ?? '');
check('read-back: 5 goods lines, fully released (unreleased 0)', rc.data?.readback?.goodsLines === 5 && rc.data?.readback?.unreleasedQty === 0);

// 3) bonded_fill_detail.
console.log('\n--- 3) bonded_fill_detail IM25000009 ---');
const fd = await call('bonded_fill_detail', { impfnum: 'IM25000009' });
check('fill_detail returns guidance + read-back', fd.ok && fd.data?.readback?.goodsLines === 5);

// 4) bonded_release_create — closed file: no warning; open file: warning.
console.log('\n--- 4) bonded_release_create (closed vs open) ---');
const relClosed = await call('bonded_release_create', { impfnum: 'IM25000009' });
check('release on closed file: fileClosed true, no warning', relClosed.data?.fileClosed === true && (relClosed.data?.warnings ?? []).length === 0);
const relOpen = await call('bonded_release_create', { impfnum: 'IM25000012' });
check('release on OPEN draft: fileClosed false + warning', relOpen.data?.fileClosed === false && (relOpen.data?.warnings ?? []).join(' ').includes('close'));

// 5) bonded_line_costs — requires a closed file.
console.log('\n--- 5) bonded_line_costs (closed vs open) ---');
const lcClosed = await call('bonded_line_costs', { impfnum: 'IM25000009' });
check('line_costs on closed file: no warning', lcClosed.data?.fileClosed === true && (lcClosed.data?.warnings ?? []).length === 0);
const lcOpen = await call('bonded_line_costs', { impfnum: 'IM25000012' });
check('line_costs on OPEN file: warns file must be closed', lcOpen.data?.fileClosed === false && (lcOpen.data?.warnings ?? []).join(' ').toLowerCase().includes('closed'));

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail === 0 ? 0 : 1);
