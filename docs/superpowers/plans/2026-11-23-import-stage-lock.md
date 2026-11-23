# Import-File Stage Lock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** No write path of this server can close or reopen an import file, or create/change a bonded release, and the close/reopen tools become stage checks that say exactly what is missing.

**Architecture:** A client-level guard next to the existing `FINAL` guard refuses the dangerous requests for every caller (curated tools, generic tools, scripts that import `PriorityClient`). A pure stage function computes, from a file snapshot plus its receipts and releases, which steps of the mandatory order are proven. `impfile_close` and `impfile_reopen` stop writing and return that stage result with the screen step for the owner.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, zod, vitest (stubbed `fetch`), biome.

**Spec:** `/path/to/priority-mcp/reports/impfiles-mcp-audit-2026-11-20/report.md` (sections "ארבעה תיקונים", "שדות שמוכיחים כל שלב", the hardening paragraph of section 2).

## Global Constraints

- No request to the live Priority tenant from any test, script or verification step. Tests stub `fetch`. Do not run `scripts/verify-impfiles-*.mjs`, `scripts/composite-write.mjs` or `scripts/finalize-docs.mjs`.
- Work ONLY in a new git worktree `/path/to/priority-mcp/.worktrees/import-stage-lock-20261123` on a new branch `fix/import-stage-lock` cut from `cursor/priority-print-document-c63d` (run `npm ci --ignore-scripts` there). Every command in this plan, `npm run build` included, runs in that worktree. Never build in the main checkout `priority-mcp-server/`: the registered MCP server loads `priority-mcp-server/dist/index.js`, so a build there is a deploy.
- No push, merge, deploy or MCP-server restart without the owner's separate approval. Delivery is one squashed commit.
- Test fixtures use invented values only (`IM1`, `GI1`, `T1`, `BD1`, part `P1`, supplier `S1`). No real customer or supplier names, no real account numbers.
- No secrets in output, fixtures or commit messages.
- Tool names stay unchanged (`impfile_close`, `impfile_reopen`, `impfile_update`, `impfile_open`): the import bot calls them by name.
- Mandatory order (owner, 26.10.2026): receipt into `BONDED` → fill detail → loading calc → close file → release → per-line import costs → costing.
- Exact Priority values: draft status `טיוטא`, final file status `סופי`, final document status `סופית`, cancelled document status `מבוטלת`, bonded warehouse `BONDED`, closed flag `CLOSED='Y'`.
- Screen procedure titles to quote in refusals: close = `סגירת התיק` (IMPFILE1), reopen = `ביטול סגירה של התיק` (OPENIMPFILE), calc = `חישוב העמסה` (IMPFILE2), per-line costs = `רישום עלויות יבוא לשורה` (IMPORTCOSTPERLINE).

## Review Focus

1. A lower-case or padded field name (`closed`, `Statdes `) in a write to IMPFILES: must be blocked like the exact spelling. Test in Task 1.
2. A write that addresses the property in the URL (`IMPFILES('IM1')/CLOSED`, `…/STATDES/$value`): must be blocked. Test in Task 1.
3. A write to an IMPFILES sub-form (`IMPFILES('IM1')/IMPFILEITEMS_SUBFORM`) whose line happens to carry a `STATDES`-named field: must NOT be blocked; only the header is guarded. Test in Task 1.
4. A file whose only release is cancelled (`מבוטלת`): must not count as released. Test in Task 2.
5. The receipt or release read fails (timeout, API flag turned off): the stage result must say "unknown" for that step and block, never report the step as satisfied. Test in Task 3.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/import-stage-guard.ts` (new) | Decide whether one mutating request breaks the stage lock; throw or return a blocked tool result |
| `src/lib/impfile-stage.ts` (new) | Pure: snapshot + receipts + releases → proven steps and blocking list |
| `src/services/import-stage.ts` (new) | Read the receipts and releases of one file over OData |
| `src/client/priority-client.ts` | Call the guard in `send` |
| `src/tools/generic.ts`, `src/tools/impfiles.ts` | Tool-level block so previews say "blocked"; close/reopen become checks; `status` params removed |
| `src/tools/impfiles-bonded.ts` | Correct the wrong "not OData-writable" texts; add per-line-cost read-back |
| `src/lib/capability-definitions.ts` | `impfile_close`, `impfile_reopen` → mode `guide` |

---

### Task 1: Client-level stage guard

**Files:**
- Create: `src/lib/import-stage-guard.ts`
- Modify: `src/client/priority-client.ts:351-352`, `src/tools/generic.ts` (the four `blockProcedureOnlyField` call sites at 296, 336, 384, 432 and the delete-line tool)
- Test: `tests/import-stage-guard.test.ts`

**Interfaces:**
- Produces:
  - `export const IMPORT_STAGE_GUARD_CODE = 'IMPORT_STAGE_GUARD'`
  - `export type StageViolation = { rule: 'impfile-status' | 'bonded-release'; field?: string; message: string }`
  - `export function findStageViolation(method: string, target: string | undefined, body: unknown): StageViolation | null`
  - `export function assertNoStageViolation(method: string, body: unknown, target?: string): void` — throws `PriorityError(message, 400, IMPORT_STAGE_GUARD_CODE, hint)`
  - `export function blockStageViolation(method: string, target: string, body: unknown)` — same result shape as `blockProcedureOnlyField` (`status: 'blocked'`, `isError: true`) or `null`
- Consumes: `canonicalFieldName`, `wireBody` from `src/lib/procedure-only-fields.ts`; `PriorityError` from `src/client/errors.ts`.

Rules `findStageViolation` implements (mutating methods are POST, PATCH, PUT, MERGE, DELETE; GET never matches):

| Request | Result |
|---|---|
| Any path segment whose name (text before `(`) is `DOCUMENTS_J` | `bonded-release` |
| Last path segment is `IMPFILES` or `IMPFILES(<key>)` and the body has a top-level key that canonicalises to `CLOSED` | `impfile-status`, field `CLOSED` |
| Same target, body has top-level `STATDES` | `impfile-status`, field `STATDES` — except POST to `IMPFILES` with no key predicate and value exactly `טיוטא` |
| Path is `IMPFILES(<key>)/CLOSED` or `/STATDES` (with or without `/$value`) | `impfile-status` |
| Anything else, including `IMPFILES(<key>)/<ANY>_SUBFORM…` | `null` |

Messages (exact copy):
- `impfile-status`: `Blocked: ${method} ${target} would change an import file's status. Closing and reopening an import file are screen procedures ("סגירת התיק" / "ביטול סגירה של התיק"); a field write skips the checks of the mandatory order (receipt → detail → calc → close → release → line costs → costing). Nothing was sent.`
- `bonded-release`: `Blocked: ${method} ${target} writes a bonded release (קבלות סחורה ממחסן ערובה). Some early releases got their per-line import costs only later, so a release must be followed by "רישום עלויות יבוא לשורה" and a check. Releases are done in the screen until a dedicated tool does both. Nothing was sent.`

- [ ] **Step 1: Write the failing tests**

```ts
const R = 'https://p.test/odata/Priority/tabula.ini/demo';
describe('findStageViolation', () => {
  it('blocks closing an import file by PATCH', () => {
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { CLOSED: 'Y', STATDES: 'סופי' }))
      .toMatchObject({ rule: 'impfile-status', field: 'CLOSED' });
  });
  it('blocks reopening and a bare status change', () => {
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { CLOSED: '' })?.rule).toBe('impfile-status');
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { STATDES: 'טיוטא' })?.rule).toBe('impfile-status');
  });
  it('matches field names in any case or padding', () => {
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { closed: 'Y' })?.rule).toBe('impfile-status');
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { 'Statdes ': 'סופי' })?.rule).toBe('impfile-status');
  });
  it('blocks the property addressed in the URL', () => {
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')/CLOSED`, { value: 'Y' })?.rule).toBe('impfile-status');
    expect(findStageViolation('PUT', `${R}/IMPFILES('IM1')/STATDES/$value`, 'סופי')?.rule).toBe('impfile-status');
  });
  it('allows opening a draft file and ordinary header edits', () => {
    expect(findStageViolation('POST', `${R}/IMPFILES`, { CURDATE: '2026-01-01', STATDES: 'טיוטא' })).toBeNull();
    expect(findStageViolation('PATCH', `${R}/IMPFILES('IM1')`, { DETAILS: 'x', CUSTOMSNUM: '1' })).toBeNull();
  });
  it('refuses to open a file already final', () => {
    expect(findStageViolation('POST', `${R}/IMPFILES`, { STATDES: 'סופי' })?.rule).toBe('impfile-status');
  });
  it('does not guard import-file sub-forms', () => {
    expect(findStageViolation('POST', `${R}/IMPFILES('IM1')/IMPFILEITEMS_SUBFORM`, { PARTNAME: 'P1', STATDES: 'x' })).toBeNull();
  });
  it('blocks every write to a bonded release, header or line', () => {
    expect(findStageViolation('POST', `${R}/DOCUMENTS_J`, { IMPFNUM: 'IM1' })?.rule).toBe('bonded-release');
    expect(findStageViolation('PATCH', `${R}/DOCUMENTS_J(DOCNO='BD1',TYPE='J')`, { STATDES: 'סופית' })?.rule).toBe('bonded-release');
    expect(findStageViolation('PATCH', `${R}/DOCUMENTS_J(DOCNO='BD1',TYPE='J')/TRANSORDER_J_SUBFORM(KLINE=1,TYPE='J')`, { TQUANT: 5 })?.rule).toBe('bonded-release');
    expect(findStageViolation('DELETE', `${R}/DOCUMENTS_J(DOCNO='BD1',TYPE='J')`, undefined)?.rule).toBe('bonded-release');
  });
  it('never matches a read, or other receipt forms', () => {
    expect(findStageViolation('GET', `${R}/DOCUMENTS_J`, undefined)).toBeNull();
    expect(findStageViolation('POST', `${R}/DOCUMENTS_P`, { TOWARHSNAME: 'BONDED' })).toBeNull();
  });
});

describe('PriorityClient', () => {
  it('sends nothing when a write breaks the stage lock', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new PriorityClient(config, logger); // same config/logger fixture as tests/final-flag-guard.test.ts
    await expect(client.update('IMPFILES', 'IM1', { CLOSED: 'Y' })).rejects.toMatchObject({ code: 'IMPORT_STAGE_GUARD' });
    await expect(client.create('DOCUMENTS_J', { IMPFNUM: 'IM1' })).rejects.toMatchObject({ code: 'IMPORT_STAGE_GUARD' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('generic tools', () => {
  it('report blocked even in a preview', async () => {
    // harness as in tests/final-flag-guard.test.ts
    expect(await h.call('priority_update_record', { form: 'IMPFILES', key: 'IM1', data: { CLOSED: 'Y' }, confirm: false }))
      .toMatchObject({ status: 'blocked' });
    expect(await h.call('priority_create_record', { form: 'DOCUMENTS_J', data: { IMPFNUM: 'IM1' }, confirm: false }))
      .toMatchObject({ status: 'blocked' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/import-stage-guard.test.ts`
Expected: FAIL, module `../src/lib/import-stage-guard.js` not found.

- [ ] **Step 3: Implement `src/lib/import-stage-guard.ts`** with the three exports and the rule table above. Decode the path once (`decodeURIComponent` in try/catch, as `findProcedureOnlyPath` does), drop the query string, split on `/`.

- [ ] **Step 4: Wire the guard.** In `src/client/priority-client.ts` add `assertNoStageViolation(method, wire, url);` on the line after `assertNoProcedureOnlyField(method, wire, url);`. In `src/tools/generic.ts`, after each `blockProcedureOnlyField(...)` check add the matching `blockStageViolation(...)` check with the same method, endpoint and data, and add one to the delete-line tool with method `DELETE`.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/import-stage-guard.test.ts tests/final-flag-guard.test.ts`
Expected: PASS, no test in `final-flag-guard.test.ts` changed.

- [ ] **Step 6: Commit**

```bash
git add src/lib/import-stage-guard.ts src/client/priority-client.ts src/tools/generic.ts tests/import-stage-guard.test.ts
git commit -m "fix(import): block status writes to import files and writes to bonded releases"
```

---

### Task 2: Pure stage computation

**Files:**
- Create: `src/lib/impfile-stage.ts`
- Test: `tests/impfile-stage.test.ts`

**Interfaces:**
- Consumes: `ImpfileSnapshot` from `src/lib/impfiles-logic.ts`.
- Produces:

```ts
export type StepState = 'done' | 'missing' | 'unknown';
export interface StageInput {
  snapshot: ImpfileSnapshot;
  /** DOCUMENTS_P rows for the file's goods invoices; null = the read failed. */
  receipts: Array<{ DOCNO: string; STATDES: string; TOWARHSNAME: string; IVNUM: string | null }> | null;
  /** DOCUMENTS_J rows of the file; null = the read failed. */
  releases: Array<{ DOCNO: string; STATDES: string }> | null;
}
export interface StageResult {
  closed: boolean;
  steps: {
    invoicesFinal: StepState;   // every linked invoice IVNUM does not start with 'T'
    bondedReceipt: StepState;   // a receipt with STATDES 'סופית' and TOWARHSNAME 'BONDED'
    detailFilled: StepState;    // goodsContent has at least one row
    calcEvidence: StepState;    // goodsContent is non-empty AND customsEstimate has a row for every distinct PARTNAME in it; empty content = 'missing' (reported as 0/0)
    released: StepState;        // a release whose STATDES is not 'מבוטלת' and not 'טיוטא'
  };
  /** Reasons the file must not be closed now, in order of the mandatory sequence. */
  closeBlocking: string[];
  /** Things that cannot be proven from Priority data. */
  advisory: string[];
}
export function computeStage(input: StageInput): StageResult;
```

`closeBlocking` entries (exact copy, one per failed condition, in this order):
1. `יש חשבונית זמנית מקושרת (${ivnums.join(', ')}) — יש לסגור T ל-GI לפני סגירת התיק.`
2. `לא נמצאה קבלה סופית למחסן BONDED מול חשבונית הסחורה.` (state `missing`) / `לא ניתן היה לקרוא את קבלות הסחורה — לא ניתן לאשר קבלה לערובה.` (state `unknown`)
3. `פירוט התיק (תכולה במחסני ערובה) ריק — יש להריץ "מילוי פירוט למחסן ערובה".`
4. `אומדן המכס ריק או חלקי (${have}/${need} מק"טים) — "חישוב העמסה" לא רץ על התכולה הנוכחית.`
5. `קיים שחרור מערובה (${docnos.join(', ')}) לפני סגירת התיק.` (only when the file is not closed) / `לא ניתן היה לקרוא את השחרורים מערובה.` (state `unknown`)

`advisory` always contains: `אין בפריוריטי שדה שמוכיח ש"חישוב העמסה" רץ אחרי השינוי האחרון — יש להריץ אותו שוב לפני הסגירה.`

A file with no linked invoices at all gets `invoicesFinal: 'missing'` and blocking line `אין חשבונית מקושרת לתיק.` in position 1.

- [ ] **Step 1: Write the failing tests**

```ts
const ready: StageInput = {
  snapshot: {
    header: { IMPFNUM: 'IM1', CLOSED: null, STATDES: 'טיוטא' },
    invoices: [{ IVNUM: 'GI1' }, { IVNUM: 'GI2' }],
    goodsContent: [{ PARTNAME: 'P1' }, { PARTNAME: 'P2' }],
    customsEstimate: [{ PARTNAME: 'P1' }, { PARTNAME: 'P2' }],
  },
  receipts: [{ DOCNO: 'GR1', STATDES: 'סופית', TOWARHSNAME: 'BONDED', IVNUM: 'GI1' }],
  releases: [],
};
it('a file with every step proven has nothing blocking', () => {
  const r = computeStage(ready);
  expect(r.closeBlocking).toEqual([]);
  expect(r.steps).toEqual({ invoicesFinal: 'done', bondedReceipt: 'done', detailFilled: 'done', calcEvidence: 'done', released: 'missing' });
  expect(r.advisory).toHaveLength(1);
});
it('blocks on a temporary invoice and names it', () => {
  const r = computeStage({ ...ready, snapshot: { ...ready.snapshot, invoices: [{ IVNUM: 'GI1' }, { IVNUM: 'T7' }] } });
  expect(r.steps.invoicesFinal).toBe('missing');
  expect(r.closeBlocking[0]).toContain('T7');
});
it('blocks when the receipt is a draft or went to another warehouse', () => {
  expect(computeStage({ ...ready, receipts: [{ DOCNO: 'GR1', STATDES: 'טיוטא', TOWARHSNAME: 'BONDED', IVNUM: 'GI1' }] }).steps.bondedReceipt).toBe('missing');
  expect(computeStage({ ...ready, receipts: [{ DOCNO: 'GR1', STATDES: 'סופית', TOWARHSNAME: 'Main', IVNUM: 'GI1' }] }).steps.bondedReceipt).toBe('missing');
});
it('blocks when the customs estimate covers only part of the content', () => {
  const r = computeStage({ ...ready, snapshot: { ...ready.snapshot, customsEstimate: [{ PARTNAME: 'P1' }] } });
  expect(r.steps.calcEvidence).toBe('missing');
  expect(r.closeBlocking.join(' ')).toContain('1/2');
});
it('an empty draft lists every missing step in sequence order', () => {
  const r = computeStage({ snapshot: { header: { IMPFNUM: 'IM1' } }, receipts: [], releases: [] });
  expect(r.closeBlocking).toHaveLength(4);
  expect(r.closeBlocking[0]).toContain('אין חשבונית');
});
it('a release on an open file blocks; a cancelled one does not count', () => {
  expect(computeStage({ ...ready, releases: [{ DOCNO: 'BD1', STATDES: 'סופית' }] }).closeBlocking.join(' ')).toContain('BD1');
  const cancelled = computeStage({ ...ready, releases: [{ DOCNO: 'BD1', STATDES: 'מבוטלת' }] });
  expect(cancelled.steps.released).toBe('missing');
  expect(cancelled.closeBlocking).toEqual([]);
});
it('a failed read is unknown and blocks', () => {
  const r = computeStage({ ...ready, receipts: null, releases: null });
  expect(r.steps.bondedReceipt).toBe('unknown');
  expect(r.steps.released).toBe('unknown');
  expect(r.closeBlocking).toHaveLength(2);
});
it('reports a closed file as closed', () => {
  expect(computeStage({ ...ready, snapshot: { ...ready.snapshot, header: { CLOSED: 'Y', STATDES: 'סופי' } } }).closed).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/impfile-stage.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `computeStage`** in `src/lib/impfile-stage.ts`. No I/O.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run tests/impfile-stage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/impfile-stage.ts tests/impfile-stage.test.ts
git commit -m "feat(import): compute which steps of the mandatory order are proven"
```

---

### Task 3: Close and reopen become stage checks; status params removed

**Files:**
- Create: `src/services/import-stage.ts`
- Modify: `src/tools/impfiles.ts` (`impfile_open` ~601, `impfile_update` ~644, `impfile_preflight` ~1091, `impfile_close` ~1196, `impfile_reopen` ~1245), `src/lib/capability-definitions.ts:59,73`
- Test: `tests/import-stage-tools.test.ts`; modify `tests/verified-writes.test.ts` (the two cases that expect `impfile_reopen` / import-file close to PATCH, lines ~119-145)

**Interfaces:**
- Consumes: `computeStage`, `StageInput`, `StageResult` (Task 2); `loadSnapshot` from `src/services/import-read.ts`.
- Produces: `export async function loadStage(client: PriorityClient, impfnum: string): Promise<StageResult & { impfnum: string }>` in `src/services/import-stage.ts`.

`loadStage` reads:
- snapshot via `loadSnapshot(client, impfnum)`;
- receipts: `DOCUMENTS_P`, `$filter` = `IVNUM eq '<n>'` joined with ` or ` over the snapshot's invoice IVNUMs that do not start with `T`, `$select=DOCNO,STATDES,TOWARHSNAME,IVNUM`; skip the request and use `[]` when there is no such IVNUM;
- releases: `DOCUMENTS_J`, `$filter=IMPFNUM eq '<impfnum>'`, `$select=DOCNO,STATDES`.
Each of the two document reads is wrapped separately: on any error pass `null` for that input. Values go through `sanitizeODataValue`.

Tool behaviour after this task:

| Tool | Behaviour |
|---|---|
| `impfile_close` | Parameters `impfnum`, plus `dryRun` and `override` kept as optional booleans that are accepted and ignored (described as `ignored — this tool never writes`), so an existing caller is not rejected. Never writes. Returns `{ mutates: false, impfnum, closed, readyToClose: closeBlocking.length === 0, stage, preflight, nextStep }`. `nextStep` = `'התיק כבר סגור.'` when closed; `'הבעלים: להריץ "חישוב העמסה" ואז "סגירת התיק" במסך תיקי יבוא.'` when ready; otherwise `closeBlocking[0]`. |
| `impfile_reopen` | Parameters `impfnum`, plus `dryRun` accepted and ignored. Never writes. Returns `{ mutates: false, impfnum, closed, stage, nextStep }` with `nextStep` = `'הבעלים: "ביטול סגירה של התיק" במסך. אחרי התיקון: חישוב העמסה → סגירת התיק → רישום עלויות יבוא לשורה → תמחיר.'` when closed, `'התיק פתוח — אין מה לבטל.'` otherwise. |
| `impfile_update` | `status` parameter removed. |
| `impfile_open` | `status` parameter removed; body always sends `STATDES: 'טיוטא'`. |
| `impfile_preflight` | Result gains `stage` (from `loadStage`); `ok` becomes `preflight.ok && stage.closeBlocking.length === 0`; `blocking` = existing blocking followed by `stage.closeBlocking`. |

Tool descriptions: replace "PROCEDURE-GATED … WRITE" in `impfile_close` / `impfile_reopen` with one line: `CHECK ONLY — never changes the file. Closing/reopening is done by the owner in the screen; this tool reports which steps of the mandatory order are proven and what is missing.` In `capability-definitions.ts` set both tools' mode to `'guide'`.

- [ ] **Step 1: Write the failing tests** (`harness`, `respond` as in `tests/verified-writes.test.ts`)

```ts
function stubFile(file: object, receipts: object[] | Error, releases: object[] | Error) {
  const fetchMock = vi.fn(async (url: string, init: { method: string }) => {
    if (init.method !== 'GET') throw new Error(`unexpected ${init.method}`);
    const u = decodeURIComponent(String(url));
    if (u.includes('/DOCUMENTS_P')) { if (receipts instanceof Error) throw receipts; return respond({ value: receipts }); }
    if (u.includes('/DOCUMENTS_J')) { if (releases instanceof Error) throw releases; return respond({ value: releases }); }
    return respond(file);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const readyFile = {
  IMPFNUM: 'IM1', STATDES: 'טיוטא', CLOSED: null, SUPNAME: 'S1',
  IMPFILEINV_SUBFORM: [{ IVNUM: 'GI1', SUPNAME: 'S1', DEBIT: 'D' }],
  IMPFILEITEMS_SUBFORM: [{ PARTNAME: 'P1', TQUANT: 1 }],
  IMPFILECUSTOMS_SUBFORM: [{ PARTNAME: 'P1', COUNTRYNAME: 'X' }],
};
const finalReceipt = [{ DOCNO: 'GR1', STATDES: 'סופית', TOWARHSNAME: 'BONDED', IVNUM: 'GI1' }];

it('impfile_close never writes, even when the file is ready', async () => {
  const fetchMock = stubFile(readyFile, finalReceipt, []);
  const r = await harness(registerImpfileTools).call('impfile_close', { impfnum: 'IM1', dryRun: false, override: true });
  expect(r).toMatchObject({ mutates: false, readyToClose: true, closed: false });
  expect(r.nextStep).toContain('סגירת התיק');
  expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
});
it('impfile_close names the first missing step', async () => {
  stubFile({ ...readyFile, IMPFILEINV_SUBFORM: [{ IVNUM: 'T7', SUPNAME: 'S1', DEBIT: 'D' }] }, [], []);
  const r = await harness(registerImpfileTools).call('impfile_close', { impfnum: 'IM1' });
  expect(r.readyToClose).toBe(false);
  expect(r.nextStep).toContain('T7');
});
it('a failed receipt read blocks instead of passing', async () => {
  stubFile(readyFile, new DOMException('timeout', 'TimeoutError'), []);
  const r = await harness(registerImpfileTools).call('impfile_close', { impfnum: 'IM1' });
  expect(r.readyToClose).toBe(false);
  expect(r.stage.steps.bondedReceipt).toBe('unknown');
});
it('impfile_reopen never writes', async () => {
  const fetchMock = stubFile({ ...readyFile, CLOSED: 'Y', STATDES: 'סופי' }, finalReceipt, []);
  const r = await harness(registerImpfileTools).call('impfile_reopen', { impfnum: 'IM1', dryRun: false });
  expect(r).toMatchObject({ mutates: false, closed: true });
  expect(r.nextStep).toContain('ביטול סגירה של התיק');
  expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
});
it('impfile_update cannot carry a status', async () => {
  stubFile(readyFile, [], []);
  const r = await harness(registerImpfileTools).call('impfile_update', { impfnum: 'IM1', status: 'סופי', dryRun: true });
  expect(JSON.stringify(r)).not.toContain('STATDES');
});
it('impfile_preflight is not ok while a stage step is missing', async () => {
  stubFile({ ...readyFile, IMPFILECUSTOMS_SUBFORM: [] }, finalReceipt, []);
  const r = await harness(registerImpfileTools).call('impfile_preflight', { impfnum: 'IM1' });
  expect(r.ok).toBe(false);
  expect(r.blocking.join(' ')).toContain('חישוב העמסה');
});
```

In `tests/verified-writes.test.ts`: delete the case `retains acknowledgment on import-file reopen read failure` (reopen no longer writes; its replacement is the `impfile_reopen never writes` test above). In the case `does not claim import-file header or PO close success after a no-op`, change the `impfile_update` call to `{ impfnum: 'I1', details: 'new', dryRun: false }` and the stubbed read to `respond({ DETAILS: 'old', CLOSEDBOOL: '' })`; the expectations and the `po_close_lines` half stay as they are.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/import-stage-tools.test.ts`
Expected: FAIL (`mutates` undefined; PATCH issued by `impfile_reopen`).

- [ ] **Step 3: Implement `loadStage`** in `src/services/import-stage.ts`.

- [ ] **Step 4: Change the five tools and the two capability rows** as the behaviour table states.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run tests/import-stage-tools.test.ts tests/verified-writes.test.ts tests/capabilities.test.ts tests/tool-gating.test.ts tests/impfiles-logic.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/import-stage.ts src/tools/impfiles.ts src/lib/capability-definitions.ts tests/import-stage-tools.test.ts tests/verified-writes.test.ts
git commit -m "fix(import): close and reopen report the file's stage instead of writing"
```

---

### Task 4: Bonded guides tell the truth; docs; full verification

**Files:**
- Modify: `src/tools/impfiles-bonded.ts`, `docs/impfiles-runbook.md` (§2 steps 9, §3, §6 item 1), `kb/impfiles_mapping.md` (§8, §9), `CHANGELOG.md`, `docs/tools.md` (regenerate with `node scripts/generate-tool-docs.mjs`; this script is offline)
- Test: `tests/bonded-guides.test.ts`

**Interfaces:**
- Consumes: `loadStage` (Task 3).
- Produces: nothing used elsewhere.

Changes in `src/tools/impfiles-bonded.ts`:
- Remove every "not OData-writable" / "UI-only" statement. Each guide's result replaces `procedure: 'UI-only'` with `doneBy: 'the owner, in the screen'` and adds `screenAction` with the exact title: receipt `קבלות סחורה מספק (מחסן BONDED, איתור 0)`, fill detail `מילוי פירוט למחסן ערובה`, release `קבלות סחורה ממחסן ערובה`, line costs `רישום עלויות יבוא לשורה`.
- `bonded_release_guide`: add `stage` from `loadStage`; `warnings` lists `stage.closeBlocking` plus the existing not-closed message; add instruction line `אחרי סגירת השחרור לסופית: להריץ "רישום עלויות יבוא לשורה" על אותה תעודה, ואז תמחיר.`
- `bonded_line_costs_guide`: read the file's releases with `DOCUMENTS_J?$filter=IMPFNUM eq '<n>'&$select=DOCNO,STATDES&$expand=TRANSORDER_J_SUBFORM($select=PARTNAME,TQUANT,KLINE;$expand=TRANSIMPFILE_SUBFORM($select=IMPFCOST,TOTCOST,UDATE))` and return `lineCosts: [{ docno, status, lines, linesWithoutCost }]`, where a line is without cost when `TRANSIMPFILE_SUBFORM` is absent or its `IMPFCOST` is null or 0. Add a warning `בשחרור ${docno} יש ${n} שורות בלי עלויות יבוא.` for each final release with `linesWithoutCost > 0`.

- [ ] **Step 1: Write the failing tests**

```ts
it('line-costs guide counts released lines that carry no import cost', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = decodeURIComponent(String(url));
    if (u.includes('/DOCUMENTS_J')) return respond({ value: [{ DOCNO: 'BD1', STATDES: 'סופית', TRANSORDER_J_SUBFORM: [
      { PARTNAME: 'P1', TQUANT: 5, KLINE: 1, TRANSIMPFILE_SUBFORM: { IMPFCOST: 12.5, TOTCOST: 50, UDATE: '2026-01-01T00:00:00Z' } },
      { PARTNAME: 'P2', TQUANT: 3, KLINE: 2, TRANSIMPFILE_SUBFORM: { IMPFCOST: null, TOTCOST: null, UDATE: null } },
    ] }] });
    return respond({ IMPFNUM: 'IM1', STATDES: 'סופי', CLOSED: 'Y' });
  }));
  const r = await harness(registerBondedTools).call('bonded_line_costs_guide', { impfnum: 'IM1' });
  expect(r.lineCosts).toEqual([{ docno: 'BD1', status: 'סופית', lines: 2, linesWithoutCost: 1 }]);
  expect(r.warnings.join(' ')).toContain('BD1');
  expect(r.mutates).toBe(false);
});
it('no guide claims the step is impossible over the API', async () => {
  const tools = await listTools(registerBondedTools); // as tests/capabilities.test.ts lists tools
  for (const t of tools) expect(t.description).not.toMatch(/not OData-writable|UI-only/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/bonded-guides.test.ts`
Expected: FAIL (`lineCosts` undefined; description matches `not OData-writable`).

- [ ] **Step 3: Implement the changes** in `src/tools/impfiles-bonded.ts`.

- [ ] **Step 4: Update the docs.** Runbook and mapping: state that close, reopen and bonded release are blocked for writing by the server, name the guard file, and replace "run `impfile_close`" with "the owner runs סגירת התיק in the screen; `impfile_close` reports readiness". CHANGELOG entry under Unreleased: three bullets (guard, check-only close/reopen with `status` params removed, bonded guides). Regenerate `docs/tools.md`.

- [ ] **Step 5: Full verification**

Run: `npm test`
Expected: all test files pass, 0 failed.

Run: `npm run lint`
Expected: no errors.

Run: `npm run build`
Expected: exit code 0.

Run: `git grep -n "CLOSED: 'Y'" src/`
Expected: no match in `src/tools/` (the only matches are read comparisons such as `file.CLOSED === 'Y'`).

- [ ] **Step 6: Commit**

```bash
git add src/tools/impfiles-bonded.ts tests/bonded-guides.test.ts docs/impfiles-runbook.md kb/impfiles_mapping.md CHANGELOG.md docs/tools.md
git commit -m "fix(import): bonded guides state who does each step and read back per-line costs"
```

---

## After the last task (needs the owner's approval, not part of execution)

1. Squash the four commits into one on `fix/import-stage-lock`.
2. The owner approves: merge, then restart of the local MCP server (`dist` is what the running server loads, so the lock takes effect only after build + restart).
3. The owner updates the instructions document: the technical note should read "`impfile_close` / `impfile_reopen` הם כלי בדיקה בלבד; סגירה, ביטול סגירה ושחרור חסומים לכתיבה בשרת".

## Known limits of this plan

- `bondedReceipt` is matched through the receipt header's `IVNUM`. Both filters were checked live read-only on 23.11.2026 (`DOCUMENTS_P` by `IVNUM`, `DOCUMENTS_J` by `IMPFNUM`). A receipt entered against PO lines carries no header `IVNUM` (seen on GR99194377) and will show as missing. The tool no longer writes, so the cost is a wrong warning, not a wrong close.
- The guard cannot stop a write made outside this server (the Priority screen, another integration).
- Until a dedicated release tool exists, the bot cannot create a release draft at all. That is intended.
