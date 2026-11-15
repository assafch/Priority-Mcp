#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
/**
 * LIVE verification of every fix in PRIORITY_MCP_ISSUES.md, against the real tenant
 * (tabula-style .ini, company a051014). Read-only: it performs GETs and dry-run previews only —
 * no tool is called with dryRun=false / confirm=true.
 *
 * Run:  node --env-file=.env scripts/live-verify-issues.mjs [--json evidence.json]
 *
 * Every check prints the actual request/response evidence it was decided on, because several of
 * these defects are installation-specific and only reproduce against this tenant.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const jsonFlag = process.argv.indexOf('--json');
const jsonOut = jsonFlag > -1 ? process.argv[jsonFlag + 1] : null;

const transport = new StdioClientTransport({
  command: 'node',
  args: [resolve(root, 'dist/index.js')],
  env: { ...process.env, PRIORITY_READ_ONLY: 'true', LOG_LEVEL: 'error' },
});
const client = new Client({ name: 'issues-verify', version: '0.0.0' });

let pass = 0;
let fail = 0;
const evidence = [];
let current = null;

const section = (title) => {
  current = { section: title, checks: [] };
  evidence.push(current);
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
};
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  cond ? pass++ : fail++;
  current?.checks.push({ name, pass: Boolean(cond), detail: String(detail).slice(0, 400) });
};
const show = (label, value, max = 600) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  console.log(`    ${label}: ${text.length > max ? `${text.slice(0, max)}…` : text}`);
  current?.checks.push({ evidence: label, value: String(text).slice(0, 2000) });
};

const call = async (name, args = {}, timeout = 180000) => {
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout });
    const text = res.content?.[0]?.text ?? '';
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ok: !res.isError, data, raw: text, chars: text.length };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err), raw: '', chars: 0 };
  }
};

await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`connected — ${tools.length} tools registered (read-only)`);

// ───────────────────────────────────────────────────────── P0-1 attachments
section('P0-1  priority_upload_attachment is implemented against EXTFILES_SUBFORM');
{
  const list = await call('priority_list_attachments', {
    entityType: 'IMPFILES',
    entityKey: 'IM25000012',
  });
  check(
    'list_attachments resolves the sub-form at runtime',
    list.ok && !!list.data?.subform,
    list.error ?? '',
  );
  show('GET IMPFILES(IM25000012)/EXTFILES_SUBFORM', list.data);

  const preview = await call('priority_upload_attachment', {
    entityType: 'IMPFILES',
    entityKey: 'IM25000012',
    filePath: '\\\\priority-files\\import\\IM25000012-bl.pdf',
    description: 'שטר מטען',
  });
  const would = preview.data?.wouldSend;
  check(
    'upload_attachment is no longer hard-disabled',
    preview.data?.available !== false,
    JSON.stringify(preview.data)?.slice(0, 160),
  );
  check(
    'dry-run previews a real POST to the sub-form',
    would?.method === 'POST' || would?.body?.method === 'POST',
  );
  check(
    'body carries the mandatory EXTFILES columns',
    Boolean(would?.body?.EXTFILENAME && would?.body?.EXTFILEDES),
    JSON.stringify(would?.body ?? {}),
  );
  show('DRY-RUN POST', preview.data);

  // Runtime detection beats a hardcoded name: CUSTOMERS spells its attachments sub-form
  // CUSTEXTFILE_SUBFORM, which no static table in this repo knew about.
  const other = await call('priority_upload_attachment', {
    entityType: 'CUSTOMERS',
    entityKey: '11005',
    filePath: '/tmp/x.pdf',
  });
  const otherSub = other.data?.wouldSend?.subform;
  check(
    'discovers a non-standard sub-form name from live metadata (CUSTOMERS)',
    otherSub === 'CUSTEXTFILE_SUBFORM' &&
      other.data?.wouldSend?.subformResolvedBy?.includes('GetMetadataFor'),
    `subform=${otherSub}`,
  );
  show('CUSTOMERS runtime detection', other.data?.wouldSend);

  const noSubform = await call('priority_upload_attachment', {
    entityType: 'PARTSTATS',
    entityKey: 'X',
    filePath: '/tmp/x.pdf',
  });
  check(
    'a form with NO attachments sub-form degrades with the sub-forms it does have',
    noSubform.data?.available === false,
    String(noSubform.data?.reason ?? '').slice(0, 140),
  );

  const bytes = await call('priority_upload_attachment', {
    entityType: 'IMPFILES',
    entityKey: 'IM25000012',
    filePath: '/tmp/x.pdf',
    fileContent: 'YmFzZTY0',
  });
  check(
    'base64 content is refused with the reason, not silently dropped',
    bytes.data?.available === false && /path/i.test(String(bytes.data?.reason)),
  );
}

// ───────────────────────────────────────────────────────── P0-2 link routes
section('P0-2  impfile_link_invoice line/final routes are mapped to real entities');
{
  const lines = await call('impfile_link_invoice', {
    route: 'line',
    invoiceNumber: 'GI25000029',
    impfnum: 'IM25000012',
    ivtype: 'P',
  });
  check(
    "route='line' no longer says 'not yet mapped'",
    lines.ok && Array.isArray(lines.data?.lines),
    lines.data?.reason ?? lines.error ?? '',
  );
  check(
    'lists the invoice lines with their KLINE + per-line IMPFNUM',
    (lines.data?.lines?.length ?? 0) > 0,
    `lines=${lines.data?.lines?.length}`,
  );
  show('IMPFILEIV + IMPFILEIVS_SUBFORM', {
    invoice: lines.data?.invoice,
    firstLines: lines.data?.lines?.slice(0, 3),
  });

  const linePreview = await call('impfile_link_invoice', {
    route: 'line',
    invoiceNumber: 'GI25000029',
    impfnum: 'IM25000012',
    ivtype: 'P',
    line: 1,
  });
  const ep = linePreview.data?.wouldSend?.endpoint ?? '';
  check(
    'dry-run targets the sub-form ROW url',
    /IMPFILEIVS_SUBFORM\(KLINE=1\)/.test(ep),
    ep.slice(-90),
  );
  check('PATCH body sets IMPFNUM', linePreview.data?.wouldSend?.body?.IMPFNUM === 'IM25000012');
  show('DRY-RUN PATCH (line)', linePreview.data?.wouldSend);

  const fin = await call('impfile_link_invoice', {
    route: 'final',
    invoiceNumber: 'GI25000029',
    impfnum: 'IM25000012',
  });
  const finText = JSON.stringify(fin.data);
  check("route='final' names the form it needs (PIVDETAILS)", finText.includes('PIVDETAILS'));
  check(
    "route='final' distinguishes API-flag-off from missing",
    /Available for API|api-flag-off/i.test(finText),
  );
  show('final route verdict', fin.data);
}

// ───────────────────────────────────────────────────────── P0-3 bank balances
section('P0-3  priority_get_bank_balances returns real balances');
{
  const bank = await call('priority_get_bank_balances', {});
  check('no bare "Not found"', bank.ok, bank.error ?? '');
  check(
    'returns bank/cash accounts with balances',
    (bank.data?.bankAccounts?.length ?? 0) > 0,
    `accounts=${bank.data?.bankAccounts?.length}`,
  );
  check(
    'names its source form',
    bank.data?.source?.form === 'ACCOUNTS',
    JSON.stringify(bank.data?.source),
  );
  show("GET ACCOUNTS?$filter=CASHNAME ne ''", bank.data?.bankAccounts);

  const cash = await call('priority_get_cash_position', {});
  check(
    'cash position totals per currency',
    cash.ok && !!cash.data?.totalByCurrency,
    cash.error ?? '',
  );
  show('cash position', {
    totalByCurrency: cash.data?.totalByCurrency,
    totalLocalCurrency: cash.data?.totalLocalCurrency,
  });
}

// ───────────────────────────────────────────────────────── P1-1 / P1-2 discovery
section('P1-1/P1-2  list_entities and list_forms are bounded and filterable');
{
  const ents = await call('priority_list_entities', {});
  check(
    'unfiltered list_entities stays inside the 24000-char result budget',
    ents.chars <= 24000,
    `chars=${ents.chars} (was 59834)`,
  );
  check(
    'reports the full entity-type count',
    (ents.data?.totalEntityTypes ?? 0) > 1000,
    `total=${ents.data?.totalEntityTypes}`,
  );

  const entsFiltered = await call('priority_list_entities', { contains: 'EXTFILE' });
  check(
    'list_entities accepts contains',
    entsFiltered.ok && (entsFiltered.data?.entities?.length ?? 0) > 0,
  );
  show('entities contains=EXTFILE', entsFiltered.data?.entities);

  const forms = await call('priority_list_forms', { contains: 'BANK' });
  check(
    'list_forms accepts contains',
    forms.ok && Array.isArray(forms.data?.forms),
    forms.error ?? '',
  );
  check(
    'answers "is form X exposed?" with counts',
    typeof forms.data?.matched === 'number' &&
      typeof forms.data?.totalFormsOnInstallation === 'number',
    `matched=${forms.data?.matched}/${forms.data?.totalFormsOnInstallation}`,
  );
  show(
    'forms contains=BANK',
    forms.data?.forms?.map((f) => f.name),
  );

  const prefixed = await call('priority_list_forms', { prefix: 'IMPF' });
  check(
    'list_forms accepts prefix',
    (prefixed.data?.forms?.length ?? 0) > 0,
    JSON.stringify(prefixed.data?.forms?.map((f) => f.name)),
  );

  const limited = await call('priority_list_forms', { limit: 5 });
  check(
    'list_forms honors limit and says what it dropped',
    limited.data?.forms?.length === 5 && !!limited.data?.truncated,
    limited.data?.truncated ?? '',
  );
  check(
    'unfiltered list_forms stays inside the result budget',
    limited.chars <= 24000,
    `chars=${limited.chars}`,
  );
}

// ───────────────────────────────────────────────────────── P1-3 404 text
section('P1-3  a 404 explains itself');
{
  for (const [entity, expect1] of [
    ['GLPERIODS', 'ACCDATES'],
    ['LOGCOUNTERS', 'LASTCOUNT'],
    ['WARHSBAL', 'WARHSBALREP'],
    ['IMPFILEITEMS', 'IMPFILEITEMS_SUBFORM'],
    ['CASHACC', 'ACCOUNTS'],
  ]) {
    const r = await call('priority_query', { form: entity, top: 1 });
    const msg = r.error ?? JSON.stringify(r.data);
    check(
      `${entity}: 404 names the entity and the fix (${expect1})`,
      msg.includes(entity) && msg.includes(expect1) && msg.includes('service document'),
      msg.slice(0, 150),
    );
  }
  const composite = await call('priority_get_record', { form: 'PINVOICES', key: 'GI25000029' });
  const cmsg = composite.error ?? JSON.stringify(composite.data);
  check(
    'single-value key on a composite-keyed form is diagnosed as a key-arity problem',
    /COMPOSITE/i.test(cmsg) && /IVNUM/.test(cmsg),
    cmsg.slice(0, 220),
  );
  const badKey = await call('impfile_get', { impfnum: 'IM99999999' });
  const kmsg = badKey.error ?? JSON.stringify(badKey.data);
  check(
    'bad key on a valid form does not blame the form name',
    /no record with that key/i.test(kmsg),
    kmsg.slice(0, 160),
  );
}

// ───────────────────────────────────────────────────────── P1-4 XML error
section('P1-4  the opaque $select XML error gets a hint');
{
  // Priority returns ONE OF two messages for an unselectable field, depending on whether its
  // model cache is warm: the opaque XML error, or the precise "Could not find a property named".
  // Both are handled; assert the hint is actionable for whichever came back this run.
  const r = await call('priority_query', { form: 'PINVOICES', select: ['VATFLAG'], top: 1 });
  const msg = r.error ?? JSON.stringify(r.data);
  const opaque = /ביצירת ה-XML/.test(msg);
  check(
    'the failing $select is reported (not silently empty)',
    !r.ok,
    `variant=${opaque ? 'opaque-XML' : 'named-property'}`,
  );
  check(
    opaque
      ? 'opaque XML error gets the $select isolation hint'
      : 'named-property error explains selectable-vs-filterable',
    opaque
      ? msg.includes('$select') && /isolate|bisect|Drop/i.test(msg)
      : /\$select/.test(msg) && /filter/i.test(msg),
    msg.slice(0, 300),
  );
  show('PINVOICES?$select=VATFLAG', msg.slice(0, 500));
  const ok = await call('priority_query', { form: 'PINVOICES', filter: "VATFLAG eq 'Y'", top: 1 });
  check(
    'control: the same field is usable in $filter without $select',
    ok.ok,
    ok.error?.slice(0, 160) ?? '',
  );
}

// ───────────────────────────────────────────────────────── P1-5 current user
section('P1-5  get_current_user separates server config from Priority identity');
{
  const u = await call('priority_get_current_user', {});
  check('no bare "readOnly" key', !Object.hasOwn(u.data ?? {}, 'readOnly'));
  check(
    'exposes serverReadOnly instead',
    typeof u.data?.serverConfig?.serverReadOnly === 'boolean',
  );
  check(
    'explains the .env + restart remediation inline',
    /restart/i.test(String(u.data?.serverConfig?.serverReadOnlyMeans)),
  );
  check(
    'reports the real Priority user',
    Boolean(u.data?.priorityUser?.userName),
    JSON.stringify(u.data?.priorityUser),
  );
  show('current user', u.data);
}

// ───────────────────────────────────────────────────────── P2-1 guidance tools
section('P2-1  screen-procedure tools are obviously non-mutating');
{
  const renamed = [
    'bonded_receipt_guide',
    'bonded_release_guide',
    'bonded_fill_detail_guide',
    'bonded_line_costs_guide',
    'impfile_run_calc_guide',
  ];
  check(
    'renamed to *_guide',
    renamed.every((t) => tools.includes(t)),
    renamed.filter((t) => !tools.includes(t)).join(',') || 'all present',
  );
  check(
    'old misleading *_create names are gone',
    !tools.includes('bonded_receipt_create') && !tools.includes('bonded_release_create'),
  );
  const g = await call('bonded_receipt_guide', { impfnum: 'IM25000012' });
  check(
    'results carry mutates:false',
    g.data?.mutates === false,
    JSON.stringify(g.data)?.slice(0, 100),
  );
  const calc = await call('impfile_run_calc_guide', { impfnum: 'IM25000012' });
  check('impfile_run_calc_guide carries mutates:false', calc.data?.mutates === false);
}

// ───────────────────────────────────────────────────────── P2-2 close verifies
section('P2-2  impfile_close verifies instead of assuming');
{
  const preview = await call('impfile_close', { impfnum: 'IM25000012', override: true });
  const text = JSON.stringify(preview.data);
  check('close still previews by default', preview.data?.dryRun === true, text.slice(0, 120));
  check(
    'description/preview promise a post-write re-read',
    /verify|re-read/i.test(text) ||
      /verify/i.test(
        (await client.listTools()).tools.find((t) => t.name === 'impfile_close')?.description ?? '',
      ),
  );
  show('close dry-run', preview.data?.wouldSend ?? preview.data);
}

// ───────────────────────────────────────────────────────── P2-3 supplier search
section('P2-3  priority_search_suppliers exists and falls back like the others');
{
  check('tool is registered', tools.includes('priority_search_suppliers'));
  const s = await call('priority_search_suppliers', { query: 'שני' });
  check(
    'search succeeds despite contains() being unsupported (501)',
    s.ok && Array.isArray(s.data?.results),
    s.error ?? '',
  );
  check(
    'reports the strategy it used',
    Boolean(s.data?.search?.strategy),
    `strategy=${s.data?.search?.strategy}`,
  );
  show('search suppliers "שני"', s.data?.results?.slice(0, 3));
}

// ───────────────────────────────────────────────────────── P2-4 companies
section('P2-4  list_companies names the form it needs');
{
  const c = await call('priority_list_companies', {});
  const text = JSON.stringify(c.data);
  check('reports availability rather than failing opaquely', c.ok, c.error ?? '');
  check(
    'names COMPANIES and the API flag',
    text.includes('COMPANIES') && /Available for API|api-flag-off/i.test(text),
  );
  show('list_companies', c.data);
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ pass, fail, evidence }, null, 2));
  console.log(`evidence → ${jsonOut}`);
}
await client.close();
process.exit(fail === 0 ? 0 : 1);
