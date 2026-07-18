#!/usr/bin/env node
/**
 * LIVE read-only verification of the P0–P2 fixes, replaying the original failing flow:
 *   "search יעד כימיה → its May 2026 invoices".
 * Run:  node --env-file=.env scripts/live-verify-p0p2.mjs
 * Forces PRIORITY_READ_ONLY=true — performs only GETs.
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
const client = new Client({ name: 'p0p2-verify', version: '0.0.0' });

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

// 1) search_customers — the call that used to 501 on contains().
console.log('--- 1) priority_search_customers("יעד כימיה") ---');
const s = await call('priority_search_customers', { query: 'יעד כימיה' });
const hit = Array.isArray(s.data?.results)
  ? s.data.results.find((r) => String(r.CUSTNAME) === '11005')
  : null;
check('search succeeds (no 501)', s.ok && Array.isArray(s.data?.results), s.error ?? '');
check('finds יעד כימיה as CUSTNAME 11005', Boolean(hit), hit ? `CUSTDES="${hit.CUSTDES}"` : 'not found');
check('reports fallback strategy', Boolean(s.data?.search?.strategy), `strategy=${s.data?.search?.strategy}`);

// 2) list_invoices by customerName + May date range (IVDATE) — the exact original task.
console.log('\n--- 2) priority_list_invoices(customerName, May 2026) ---');
const inv = await call('priority_list_invoices', {
  customerName: 'יעד כימיה',
  dateFrom: '2026-05-01',
  dateTo: '2026-05-31',
  top: 500,
});
const invoices = inv.data?.invoices ?? [];
check('invoice list succeeds (IVDATE filter, no 400)', inv.ok && Array.isArray(invoices), inv.error ?? '');
check('resolved customerName → 11005', inv.data?.resolvedCustomer?.CUSTNAME === '11005');
check('returns 6 May invoices', invoices.length === 6, `got ${invoices.length}`);
const allMay = invoices.every((i) => String(i.IVDATE ?? '').startsWith('2026-05'));
check('every invoice is dated May 2026 (IVDATE present)', invoices.length > 0 && allMay);
const total = invoices.reduce((s, i) => s + (Number(i.TOTPRICE) || 0), 0);
check('total matches expected 66,888', total === 66888, `sum=${total}`);

// 3) Control: same query by explicit customerId.
console.log('\n--- 3) priority_list_invoices(customerId=11005, May 2026) ---');
const inv2 = await call('priority_list_invoices', {
  customerId: '11005',
  dateFrom: '2026-05-01',
  dateTo: '2026-05-31',
  top: 500,
});
check('by-id matches by-name count', (inv2.data?.invoices?.length ?? -1) === invoices.length);

// 4) get_invoice — composite-key path (used to 404 on single-key .get()).
console.log('\n--- 4) priority_get_invoice("IN264000144") ---');
const one = await call('priority_get_invoice', { invoiceNumber: 'IN264000144' });
check('fetches invoice by IVNUM (composite key handled)', one.ok && one.data?.IVNUM === 'IN264000144', one.error ?? `IVNUM=${one.data?.IVNUM}`);
check('expands line items', Array.isArray(one.data?.AINVOICEITEMS_SUBFORM));

// 5) list_customers(search) fallback path.
console.log('\n--- 5) priority_list_customers(search="יעד") ---');
const lc = await call('priority_list_customers', { search: 'יעד', top: 50 });
const lcHit = (lc.data?.customers ?? []).some((c) => String(c.id) === '11005');
check('list_customers search works + finds 11005', lc.ok && lcHit, lc.error ?? '');

// ===== Follow-up: repointed drift tools =====

// 6) customer balance via OBLIGO.
console.log('\n--- 6) priority_get_customer_balance(11005) → OBLIGO ---');
const bal = await call('priority_get_customer_balance', { customerId: '11005' });
check('balance succeeds (OBLIGO, no 400)', bal.ok, bal.error ?? '');
check('returns a numeric balance', typeof bal.data?.balance === 'number', `balance=${bal.data?.balance}`);

// 7) top debtors via OBLIGO.
console.log('\n--- 7) priority_get_top_debtors → OBLIGO ---');
const td = await call('priority_get_top_debtors', { top: 5 });
check('top_debtors succeeds + has rows', td.ok && Array.isArray(td.data?.topDebtors) && td.data.topDebtors.length > 0, td.error ?? '');

// 8) open debts + unpaid-for-customer via OPENINVOICES.
console.log('\n--- 8) priority_get_open_debts / unpaid_invoices_for_customer → OPENINVOICES ---');
const od = await call('priority_get_open_debts', { top: 10 });
check('open_debts succeeds (OPENINVOICES, no 404)', od.ok && Array.isArray(od.data?.debts), od.error ?? '');
const unpaid = await call('priority_get_unpaid_invoices_for_customer', { customerId: '11005', top: 50 });
check('unpaid_invoices_for_customer succeeds', unpaid.ok && Array.isArray(unpaid.data?.unpaidInvoices), unpaid.error ?? '');

// 9) product sales history (SALESINVOICEITEMS) + stock levels (PARTBAL).
console.log('\n--- 9) sales history (SALESINVOICEITEMS) + stock (PARTBAL) ---');
const sh = await call('priority_get_product_sales_history', { productId: 'PO0002', top: 10 });
check('sales_history succeeds (SALESINVOICEITEMS, no 404)', sh.ok && Array.isArray(sh.data?.salesHistory), sh.error ?? '');
const stock = await call('priority_get_stock_levels', { productId: '030095' });
check('stock_levels succeeds (PARTBAL, no 404)', stock.ok && Array.isArray(stock.data?.stockLevels), stock.error ?? '');

// 10) ORDERS field drift (status field / pending) + products active filter.
console.log('\n--- 10) orders (ORDSTATUSDES/BOOLCLOSED) + products active ---');
const pend = await call('priority_get_pending_orders', { top: 5 });
check('pending_orders succeeds (BOOLCLOSED ne Y)', pend.ok && Array.isArray(pend.data?.pendingOrders), pend.error ?? '');
const lp = await call('priority_list_products', { active: true, top: 5 });
check('list_products(active) succeeds (STATDES filter)', lp.ok && Array.isArray(lp.data?.products), lp.error ?? '');

// 11) graceful degradation (non-exposed forms return available:false, not a 404 throw).
console.log('\n--- 11) graceful degrade: aging / supplier balance / activities ---');
const ag = await call('priority_get_aging_report', {});
check('aging_report degrades cleanly (available:false)', ag.ok && ag.data?.available === false, JSON.stringify(ag.data)?.slice(0, 80));
const sb = await call('priority_get_supplier_balance', { supplierId: '10164' });
check('supplier_balance degrades cleanly', sb.ok && sb.data?.available === false);
const la = await call('priority_list_activities', { top: 5 });
check('list_activities degrades cleanly', la.ok && la.data?.available === false);

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail === 0 ? 0 : 1);
