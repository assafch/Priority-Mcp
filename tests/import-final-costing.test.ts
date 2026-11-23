import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityClient } from '../src/client/priority-client.js';
import type { WebSdkProcStep } from '../src/client/web-sdk.js';
import { COSTING_CONFIRM } from '../src/lib/costing-program.js';
import { createLogger } from '../src/logger.js';
import { type FinalDeps, runCosting } from '../src/services/import-final-steps.js';
import { type FakeSdkOptions, fakeSdk } from './fake-web-sdk.js';
import { type Row, type World, openWorld, serve, tempLedger, testConfig } from './import-world.js';

/**
 * costing_run (step 11): "תמחיר לתאריך נוכחי" (FNCCOSTINGPART), company-wide, only when every
 * final release is costed on a closed file, only with the approval code of its own preview.
 * Done only when COSTINGLOG moved and no file is still pending.
 */
afterEach(() => vi.unstubAllGlobals());

const cost = (goods: number, imp: number): Row => ({
  TRANSCOST: goods,
  CUSTOMSSUM: 0,
  DUTYCOST: 0,
  IMPFCOST: imp,
  TOTCOST: goods + imp,
  UDATE: '2026-01-20T10:05:00Z',
});
const BEFORE = '2026-01-19T08:00:00Z';
const AFTER = '2026-01-21T08:00:00Z';

/** One closed file, its release final and costed after the last costing run. */
function costingWorld(): World {
  const world = openWorld();
  world.file.CLOSED = 'Y';
  world.file.STATDES = 'סופי';
  world.releases.push({
    DOCNO: 'BD1',
    TYPE: 'J',
    IMPFNUM: 'IM1',
    STATDES: 'סופית',
    CURDATE: '2026-01-20T00:00:00Z',
    UDATE: '2026-01-20T10:00:00Z',
    TRANSORDER_J_SUBFORM: [
      { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10, TRANSIMPFILE_SUBFORM: cost(1000, 200) },
    ],
  });
  world.costingLog = [{ TITLE: 'תמחיר', UDATE: BEFORE }];
  return world;
}

const RUN_OK: WebSdkProcStep[] = [
  { type: 'message', messagetype: 'warning', message: COSTING_CONFIRM },
  { type: 'message', messagetype: 'information', message: 'התוכנית הסתיימה עם אזהרות' },
  { type: 'end' },
];

function setup(world: World, sdkOpts: FakeSdkOptions = {}) {
  serve(world);
  const fake = fakeSdk({
    procSteps: RUN_OK,
    onProcMessage: (ok) => {
      if (ok === 1) world.costingLog = [{ TITLE: 'תמחיר', UDATE: AFTER }];
    },
    ...sdkOpts,
  });
  const client = new PriorityClient(testConfig, createLogger(testConfig));
  const deps: FinalDeps = {
    ledgerPath: tempLedger(),
    approvalDir: mkdtempSync(join(tmpdir(), 'approvals-')),
    session: () => fake.session,
    stepTimeoutMs: 40,
    endTimeoutMs: 40,
  };
  const run = (p: Partial<Parameters<typeof runCosting>[2]> = {}) =>
    runCosting(client, testConfig, { dryRun: true, ...p }, deps);
  return { run, fake };
}

describe('costing_run', () => {
  it('previews with a code and does not touch the Web SDK', async () => {
    const world = costingWorld();
    const { run, fake } = setup(world);
    const r = await run();
    expect(r.status, JSON.stringify(r.reasons)).toBe('preview');
    expect(r.approvalCode).toBeTruthy();
    expect(r.pendingFiles).toEqual(['IM1']);
    expect(fake.calls).toEqual([]);
  });

  it('runs once with the code: confirm, information, end; the log moved → done', async () => {
    const world = costingWorld();
    const { run, fake } = setup(world);
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status, JSON.stringify(r)).toBe('done');
    expect(fake.calls).toEqual([
      'login',
      'procStart(FNCCOSTINGPART,P)',
      'message(1)',
      'message(1)',
    ]);
    expect(r.lastCostingAt).toBe(AFTER);
    const again = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(again.status).toBe('already-done');
    expect(fake.count('procStart')).toBe(1);
  });

  it('cancels an input screen without answering it; the code is spent', async () => {
    const world = costingWorld();
    const { run, fake } = setup(world, { procSteps: [{ type: 'inputFields' }, { type: 'end' }] });
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('cancelled');
    expect(fake.calls).toContain('cancel');
    expect(fake.calls).not.toContain('message(1)');
    const reuse = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(reuse.reasons?.[0]).toContain('כבר נוצל');
  });

  it('cancels a question with a different text', async () => {
    const world = costingWorld();
    const { run, fake } = setup(world, {
      procSteps: [{ type: 'message', messagetype: 'warning', message: 'למחוק את כל התמחירים?' }],
    });
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('cancelled');
    expect(fake.calls).toEqual(['login', 'procStart(FNCCOSTINGPART,P)', 'cancel']);
  });

  it('nothing pending → already-done; rerun=true still previews', async () => {
    const world = costingWorld();
    world.costingLog = [{ TITLE: 'תמחיר', UDATE: AFTER }];
    const { run } = setup(world);
    expect((await run()).status).toBe('already-done');
    expect((await run({ rerun: true })).status).toBe('preview');
  });

  it('refuses while a final release has no costs, or its file is open', async () => {
    const uncosted = costingWorld();
    (uncosted.releases[0].TRANSORDER_J_SUBFORM as Row[])[0].TRANSIMPFILE_SUBFORM = null;
    const r = await setup(uncosted).run();
    expect(r.status).toBe('refused');
    expect(r.reasons?.join(' ')).toContain('BD1');
    const open = costingWorld();
    open.file.CLOSED = null;
    expect((await setup(open).run()).status).toBe('refused');
  });

  it('a program that ended but left the log where it was is unverified', async () => {
    const world = costingWorld();
    const { run } = setup(world, { onProcMessage: () => {} });
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('unverified');
  });

  it('probe logs in only', async () => {
    const world = costingWorld();
    const { run, fake } = setup(world);
    const r = await run({ probe: true });
    expect(r.status).toBe('preview');
    expect(fake.calls).toEqual(['login']);
  });

  it('blocked when DOCUMENTS_J reads come back empty', async () => {
    const world = costingWorld();
    world.blind = ['DOCUMENTS_J'];
    const { run, fake } = setup(world);
    expect((await run()).status).toBe('blocked');
    expect(fake.calls).toEqual([]);
  });

  it('an end step that carries an error is unverified even when the log moved', async () => {
    const world = costingWorld();
    const { run } = setup(world, {
      procSteps: [
        { type: 'message', messagetype: 'warning', message: COSTING_CONFIRM },
        { type: 'end', messagetype: 'error', message: 'שגיאה' },
      ],
    });
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('unverified');
    expect(world.costingLog?.[0].UDATE).toBe(AFTER);
  });

  it('blocked when the costing log reads come back empty', async () => {
    const world = costingWorld();
    world.costingLog = [];
    const { run, fake } = setup(world);
    expect((await run()).status).toBe('blocked');
    expect(fake.calls).toEqual([]);
  });

  it('a timeout after the OK does not cancel the running program', async () => {
    const world = costingWorld();
    const fake = fakeSdk({
      procSteps: [{ type: 'message', messagetype: 'warning', message: COSTING_CONFIRM }],
    });
    fake.proc.message.mockImplementation(() => new Promise(() => {}));
    const { runCostingProgram } = await import('../src/lib/costing-program.js');
    serve(world);
    const trace = await runCostingProgram(fake.session, {
      stepTimeoutMs: 40,
      runTimeoutMs: 40,
      endTimeoutMs: 40,
    });
    expect(trace.error).toMatch(/timed out/);
    expect(fake.calls).not.toContain('cancel');
  });
});
