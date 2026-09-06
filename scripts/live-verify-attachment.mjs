#!/usr/bin/env node
/**
 * LIVE WRITE round-trip for priority_upload_attachment (PRIORITY_MCP_ISSUES.md P0-1), which is
 * the one fix a read-only run cannot prove.
 *
 *   POST   IMPFILES('<file>')/EXTFILES_SUBFORM   ← via the MCP tool, dryRun=false
 *   GET    the sub-form                          ← confirm the row and its assigned EXTFILENUM
 *   DELETE the row                               ← leave the document exactly as found
 *
 * Safety:
 *   - the target document is REQUIRED as an argument (no default), and must be an OPEN file;
 *   - the server is spawned with PRIORITY_READ_ONLY=false for THIS PROCESS ONLY — the .env file
 *     and the MCP host stay read-only;
 *   - the cleanup DELETE runs even if a later step throws;
 *   - --keep skips the cleanup.
 *
 * Run:  node --env-file=.env scripts/live-verify-attachment.mjs IM25000011 [--keep]
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const impfnum = process.argv[2];
const keep = process.argv.includes('--keep');
if (!impfnum || impfnum.startsWith('-')) {
  console.error(
    'usage: node --env-file=.env scripts/live-verify-attachment.mjs <IMPFNUM> [--keep]',
  );
  process.exit(2);
}

const FILE_PATH = 'C:\\PriorityFiles\\mcp-attach-test.txt';
const DESCRIPTION = 'MCP attach test';

const transport = new StdioClientTransport({
  command: 'node',
  args: [resolve(root, 'dist/index.js')],
  // Writes enabled for this child process only.
  env: { ...process.env, PRIORITY_READ_ONLY: 'false', LOG_LEVEL: 'error' },
});
const client = new Client({ name: 'attachment-roundtrip', version: '0.0.0' });

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  cond ? pass++ : fail++;
  return cond;
};
const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = res.content?.[0]?.text ?? '';
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { ok: !res.isError, data, raw: text };
};

await client.connect(transport);
console.log(`connected (writes ENABLED for this process only) — target ${impfnum}\n`);

// Guard: never touch a closed file.
const file = await call('impfile_get', { impfnum });
const closed = file.data?.header?.CLOSED === 'Y';
if (closed) {
  console.error(`refusing: ${impfnum} is CLOSED (${file.data?.header?.STATDES}).`);
  await client.close();
  process.exit(2);
}
console.log(
  `file ${impfnum}: status=${file.data?.header?.STATDES} closed=${file.data?.header?.CLOSED ?? 'null'} supplier=${file.data?.header?.SUPDES}\n`,
);

const before = await call('priority_list_attachments', {
  entityType: 'IMPFILES',
  entityKey: impfnum,
});
const beforeCount = before.data?.count ?? 0;
console.log(`attachments before: ${beforeCount}\n`);

let created;
try {
  console.log('--- 1) POST the attachment row (dryRun=false) ---');
  const res = await call('priority_upload_attachment', {
    entityType: 'IMPFILES',
    entityKey: impfnum,
    filePath: FILE_PATH,
    description: DESCRIPTION,
    dryRun: false,
  });
  console.log(`${JSON.stringify(res.data, null, 2).slice(0, 1200)}\n`);
  check('POST accepted by Priority', res.ok, res.ok ? '' : res.raw.slice(0, 300));
  check(
    'tool reports the attachment as stored (verified by its own re-read)',
    res.data?.attached === true,
  );
  created = res.data?.storedRow;
  check(
    'Priority assigned an EXTFILENUM',
    Number.isFinite(Number(created?.EXTFILENUM)),
    `EXTFILENUM=${created?.EXTFILENUM}`,
  );
  check(
    'EXTFILENAME round-tripped',
    created?.EXTFILENAME === FILE_PATH,
    String(created?.EXTFILENAME),
  );
  check(
    'EXTFILEDES round-tripped',
    created?.EXTFILEDES === DESCRIPTION,
    String(created?.EXTFILEDES),
  );

  console.log('\n--- 2) independent re-read of the sub-form ---');
  const after = await call('priority_list_attachments', {
    entityType: 'IMPFILES',
    entityKey: impfnum,
  });
  console.log(`${JSON.stringify(after.data?.attachments, null, 2).slice(0, 900)}\n`);
  check(
    'attachment count increased by exactly 1',
    (after.data?.count ?? 0) === beforeCount + 1,
    `${beforeCount} → ${after.data?.count}`,
  );

  console.log('--- 3) it is visible through the generic tools too ---');
  const viaQuery = await call('priority_get_record', {
    form: 'IMPFILES',
    key: impfnum,
    expand: ['EXTFILES_SUBFORM'],
  });
  const rows = viaQuery.data?.EXTFILES_SUBFORM ?? [];
  check(
    'appears in IMPFILES $expand=EXTFILES_SUBFORM',
    rows.some((r) => String(r.EXTFILENUM) === String(created?.EXTFILENUM)),
    `rows=${rows.length}`,
  );
} finally {
  if (created?.EXTFILENUM !== undefined && !keep) {
    console.log('\n--- 4) cleanup: DELETE the test row ---');
    // No delete tool exists (by design — this server exposes no destructive tool), so the cleanup
    // goes straight to the OData endpoint.
    const gone = await deleteRow(impfnum, created.EXTFILENUM);
    check('test attachment removed — document left as found', gone.ok, gone.detail);
    // Read the sub-form directly, NOT through the tool: the DELETE above went straight to OData,
    // so the MCP server's 60s GET cache still holds the pre-delete response and would report the
    // row as present. (Writes made THROUGH the tools do invalidate that cache.)
    const final = await readSubform(impfnum);
    check(
      'sub-form is back to its original contents',
      final.count === beforeCount,
      `${final.count} vs ${beforeCount} (direct read, cache bypassed)`,
    );
  } else if (keep) {
    console.log('\n--- 4) cleanup SKIPPED (--keep) ---');
  }
}

console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'} — ${pass} passed, ${fail} failed`);
await client.close();
process.exit(fail === 0 ? 0 : 1);

function odataAuth() {
  return process.env.PRIORITY_PAT
    ? Buffer.from(`${process.env.PRIORITY_PAT}:PAT`).toString('base64')
    : Buffer.from(`${process.env.PRIORITY_USERNAME}:${process.env.PRIORITY_PASSWORD}`).toString(
        'base64',
      );
}

/** DELETE the attachment row directly (this server deliberately exposes no delete tool). */
async function deleteRow(file, extfilenum) {
  const base = `${process.env.PRIORITY_BASE_URL}/${process.env.PRIORITY_COMPANY}`;
  const url = `${base}/IMPFILES('${file}')/EXTFILES_SUBFORM(EXTFILENUM=${extfilenum})`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Basic ${odataAuth()}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  const body = await res.text();
  return { ok: res.ok || res.status === 204, detail: `HTTP ${res.status} ${body.slice(0, 200)}` };
}

/** Read the attachments sub-form straight from OData, bypassing the MCP server's GET cache. */
async function readSubform(file) {
  const base = `${process.env.PRIORITY_BASE_URL}/${process.env.PRIORITY_COMPANY}`;
  const res = await fetch(`${base}/IMPFILES('${file}')/EXTFILES_SUBFORM`, {
    headers: { Authorization: `Basic ${odataAuth()}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60000),
  });
  const rows = res.ok ? ((await res.json()).value ?? []) : [];
  return { count: rows.length, rows };
}
