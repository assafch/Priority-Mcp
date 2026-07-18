#!/usr/bin/env node
/**
 * LIVE dry-run verification of the IMPFILES Slice 2 WRITE tools. Every write tool is called with its
 * default (dryRun=true), so NOTHING is written — we only assert the exact bodies the tools would send.
 * impfile_link_invoice does a real READ to resolve an invoice's composite key (safe).
 * Run:  node --env-file=.env scripts/verify-impfiles-slice2.mjs   (server also runs PRIORITY_READ_ONLY).
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
const client = new Client({ name: 'impfiles-slice2-verify', version: '0.0.0' });

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
console.log('✓ connected (read-only; all writes dry-run)\n');

// 1) impfile_open — default dryRun.
console.log('--- 1) impfile_open (dry-run) ---');
const open = await call('impfile_open', {
  date: '2026-07-18',
  currency: 'EUR',
  owner: 'Assaf',
  supplier: '200017',
  po: 'PO26000010',
  warehouse: 'arov',
});
const ob = open.data?.wouldSend ?? {};
check('open is a dry-run (default safe)', open.ok && open.data?.dryRun === true, open.error ?? '');
check('open body: CURDATE/CODE/STATDES draft', ob.CURDATE === '2026-07-18' && ob.CODE === 'EUR' && ob.STATDES === 'טיוטא');
check('open body maps owner/supplier/po/warehouse', ob.OWNERLOGIN === 'Assaf' && ob.SUPNAME === '200017' && ob.ORDNAME === 'PO26000010' && ob.WARHSNAME === 'arov');

// 2) impfile_update — only provided fields; empty errors.
console.log('\n--- 2) impfile_update (dry-run) ---');
const upd = await call('impfile_update', { impfnum: 'IM25000012', status: 'סופי', details: 'test' });
const ub = upd.data?.wouldSend ?? {};
check('update is a dry-run', upd.ok && upd.data?.dryRun === true, upd.error ?? '');
check('update body has ONLY the provided fields', ub.STATDES === 'סופי' && ub.DETAILS === 'test' && Object.keys(ub).length === 2);
const updEmpty = await call('impfile_update', { impfnum: 'IM25000012' });
check('update with no fields returns an error', Boolean(updEmpty.data?.error));

// 3) pinvoice_create goods.
console.log('\n--- 3) pinvoice_create goods (dry-run) ---');
const goods = await call('pinvoice_create', {
  mode: 'goods',
  supplier: '200001',
  invoiceNumber: 'P999',
  invoiceDate: '2026-07-18',
  currency: '$',
  impfnum: 'IM25000012',
  po: 'PO25000003',
  goodsLines: [
    { part: 'POL0001', qty: 400, price: 7.3 },
    { part: 'POL0002', qty: 216 },
  ],
});
const gb = goods.data?.wouldSend ?? {};
const gItems = gb.PINVOICEITEMS_SUBFORM ?? [];
check('goods is a dry-run', goods.ok && goods.data?.dryRun === true, goods.error ?? '');
check('goods header: DEBIT=D, OTYPE=P, IMPFNUM, ORDNAME', gb.DEBIT === 'D' && gb.OTYPE === 'P' && gb.IMPFNUM === 'IM25000012' && gb.ORDNAME === 'PO25000003');
check('goods lines built; PRICE optional', gItems.length === 2 && gItems[0].PRICE === 7.3 && !('PRICE' in gItems[1]));
const goodsEmpty = await call('pinvoice_create', { mode: 'goods', supplier: 'x', invoiceNumber: 'y', invoiceDate: '2026-07-18', currency: '$', impfnum: 'IM25000012' });
check('goods with no lines returns an error', Boolean(goodsEmpty.data?.error));

// 4) pinvoice_create broker — the §3.1 template.
console.log('\n--- 4) pinvoice_create broker (dry-run) ---');
const broker = await call('pinvoice_create', {
  mode: 'broker',
  supplier: '200026',
  invoiceNumber: 'B123',
  invoiceDate: '2026-07-18',
  currency: 'ש"ח',
  impfnum: 'IM25000012',
  costLines: [
    { part: 'AVI001', amount: 3518.39 },
    { part: 'AVI007', amount: 300, vat: true },
  ],
  declarationVat: [{ amount: 11147, declaration: 'IL-1', declarationDate: '2026-07-10' }],
});
const bItems = broker.data?.wouldSend?.PINVOICEITEMS_SUBFORM ?? [];
const vatLine = bItems.find((i) => i.PARTNAME === "מע'מ");
const avi001 = bItems.find((i) => i.PARTNAME === 'AVI001');
const avi007 = bItems.find((i) => i.PARTNAME === 'AVI007');
check('broker is a dry-run', broker.ok && broker.data?.dryRun === true, broker.error ?? '');
check("broker VAT line on מע'מ part: VATFLAG=Y + amount + declaration", Boolean(vatLine) && vatLine.VATFLAG === 'Y' && vatLine.PRICE === 11147 && vatLine.CUSTOMSNUM === 'IL-1');
check('broker cost VAT flags correct (freight none, brokerage Y)', Boolean(avi001) && !avi001.VATFLAG && Boolean(avi007) && avi007.VATFLAG === 'Y');
check('broker header currency ILS + linked', broker.data?.wouldSend?.CODE === 'ש"ח' && broker.data?.wouldSend?.IMPFNUM === 'IM25000012');
const brokerEmpty = await call('pinvoice_create', { mode: 'broker', supplier: 'x', invoiceNumber: 'y', invoiceDate: '2026-07-18', currency: 'ש"ח', impfnum: 'IM25000012' });
check('broker with no lines returns an error', Boolean(brokerEmpty.data?.error));

// 5) impfile_link_invoice header — resolves a REAL invoice's composite key (read), previews PATCH.
console.log('\n--- 5) impfile_link_invoice header (dry-run, real resolve) ---');
const link = await call('impfile_link_invoice', { invoiceNumber: 'GI25000025', impfnum: 'IM25000009' });
const lw = link.data?.wouldSend ?? {};
check('link header is a dry-run', link.ok && link.data?.dryRun === true, link.error ?? '');
check('link resolved composite key (IVNUM/DEBIT/IVTYPE)', lw.keys?.IVNUM === 'GI25000025' && Boolean(lw.keys?.DEBIT) && Boolean(lw.keys?.IVTYPE));
check('link body sets IMPFNUM + OTYPE=P', lw.body?.IMPFNUM === 'IM25000009' && lw.body?.OTYPE === 'P');
check('link endpoint is a composite URL', typeof lw.endpoint === 'string' && lw.endpoint.includes("PINVOICES(IVNUM='GI25000025'"));
const linkLine = await call('impfile_link_invoice', { route: 'line', invoiceNumber: 'GI25000025', impfnum: 'IM25000009' });
check('link route=line returns guidance (not a guess)', linkLine.data?.available === false);

// 6) impfile_manual_alloc — subform routing; preview shows the exact endpoint + body (fix #12).
console.log('\n--- 6) impfile_manual_alloc (dry-run) ---');
const allocCost = await call('impfile_manual_alloc', { impfnum: 'IM25000012', target: 'cost', fields: { PARTNAME: 'AVI001', PRICE: 100 } });
const acw = allocCost.data?.wouldSend ?? {};
check('manual_alloc cost → MANIVDUTIES endpoint + exact body', allocCost.data?.dryRun === true && acw.endpoint?.includes("IMPFILES('IM25000012')/MANIVDUTIES_SUBFORM") && acw.body?.PARTNAME === 'AVI001');
const allocItem = await call('impfile_manual_alloc', { impfnum: 'IM25000012', target: 'item', fields: { PARTNAME: 'X' } });
check('manual_alloc item → MANIVPARTS2 endpoint', allocItem.data?.wouldSend?.endpoint?.includes('MANIVPARTS2_SUBFORM'));

// 7) impfile_expected_costs — endpoint + body preview.
console.log('\n--- 7) impfile_expected_costs (dry-run) ---');
const exp = await call('impfile_expected_costs', { impfnum: 'IM25000012', fields: { PARTNAME: 'AVI001', PRICE: 50 } });
check('expected_costs → EXPIVDUTIES endpoint + body', exp.ok && exp.data?.dryRun === true && exp.data?.wouldSend?.endpoint?.includes('EXPIVDUTIES_SUBFORM') && exp.data?.wouldSend?.body?.PRICE === 50);

// 8) pinvoice_create cross-mode + pricing validation (fixes #4, #5).
console.log('\n--- 8) pinvoice_create validation regressions ---');
const brokerWithGoods = await call('pinvoice_create', { mode: 'broker', supplier: 'x', invoiceNumber: 'y', invoiceDate: '2026-07-18', currency: 'ש"ח', impfnum: 'IM25000012', goodsLines: [{ part: 'POL0001', qty: 1 }], declarationVat: [{ amount: 1 }] });
check('broker mode rejects goodsLines (no silent drop)', Boolean(brokerWithGoods.data?.error));
const goodsWithCost = await call('pinvoice_create', { mode: 'goods', supplier: 'x', invoiceNumber: 'y', invoiceDate: '2026-07-18', currency: '$', impfnum: 'IM25000012', goodsLines: [{ part: 'POL0001', qty: 1, price: 5 }], costLines: [{ part: 'AVI001', amount: 10 }] });
check('goods mode rejects costLines (no silent drop)', Boolean(goodsWithCost.data?.error));
const goodsNoPrice = await call('pinvoice_create', { mode: 'goods', supplier: 'x', invoiceNumber: 'y', invoiceDate: '2026-07-18', currency: '$', impfnum: 'IM25000012', goodsLines: [{ part: 'POL0001', qty: 1 }] });
check('goods priceless line with no PO is rejected', Boolean(goodsNoPrice.data?.error));

// 9) impfile_link_invoice composite-key + guards (fixes #1, #2).
console.log('\n--- 9) impfile_link_invoice guards ---');
const linkCredit = await call('impfile_link_invoice', { invoiceNumber: 'GI25000025', impfnum: 'IM25000009', debit: 'C' });
check('link with debit=C (no such row) → not found (debit param is live)', Boolean(linkCredit.data?.error));
const relinkBlocked = await call('impfile_link_invoice', { invoiceNumber: 'GI25000025', impfnum: 'IM25000010' });
check('relink to a different file without allowRelink is refused', Boolean(relinkBlocked.data?.error) && String(relinkBlocked.data.error).includes('already linked'));
const relinkAllowed = await call('impfile_link_invoice', { invoiceNumber: 'GI25000025', impfnum: 'IM25000010', allowRelink: true });
check('relink with allowRelink=true proceeds to dry-run', relinkAllowed.data?.dryRun === true && relinkAllowed.data?.wouldSend?.relink === true);

// 10) impfile_update honors an explicit empty string (fix #7).
console.log('\n--- 10) impfile_update empty-string clear ---');
const clr = await call('impfile_update', { impfnum: 'IM25000012', details: '' });
check('details="" is included in the PATCH body (not dropped)', clr.data?.dryRun === true && clr.data?.wouldSend?.DETAILS === '' && Object.keys(clr.data.wouldSend).length === 1);

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail === 0 ? 0 : 1);
