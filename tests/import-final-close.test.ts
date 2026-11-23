import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityClient } from '../src/client/priority-client.js';
import type { WebSdkProcStep } from '../src/client/web-sdk.js';
import { recordStep } from '../src/lib/step-ledger.js';
import { createLogger } from '../src/logger.js';
import { type FinalDeps, closeImportFile } from '../src/services/import-final-steps.js';
import { type FakeSdkOptions, fakeSdk } from './fake-web-sdk.js';
import { type Row, type World, openWorld, serve, tempLedger, testConfig } from './import-world.js';

/**
 * impfile_close_run (step 7): "סגירת התיק" (IMPFILE1) on a file whose earlier steps are proven
 * and whose loading calc ran through the tool after the last change — only with the approval code
 * of its own preview.
 */
afterEach(() => vi.unstubAllGlobals());

/** Received, detail filled, customs estimate complete: ready to close. */
function readyWorld(): World {
  const world = openWorld();
  world.receipts.push({
    DOCNO: 'GR1',
    TYPE: 'P',
    STATDES: 'סופית',
    TOWARHSNAME: 'arov',
    IVNUM: 'GI1',
    TOTPRICE: 150,
    TRANSORDER_P_SUBFORM: [],
  });
  world.file.IMPFILEITEMS_SUBFORM = [
    { KLINE: 1, PARTNAME: 'P1', TQUANT: 10, TBALANCE: 10 },
    { KLINE: 2, PARTNAME: 'P2', TQUANT: 5, TBALANCE: 5 },
  ];
  world.file.IMPFILECUSTOMS_SUBFORM = [
    { PARTNAME: 'P1', COUNTRYNAME: 'DE' },
    { PARTNAME: 'P2', COUNTRYNAME: 'DE' },
  ];
  return world;
}

const CLOSED_OK: WebSdkProcStep[] = [
  { type: 'message', messagetype: 'information', message: 'תיק היבוא נסגר בהצלחה' },
  { type: 'end' },
];

function setup(world: World, steps: WebSdkProcStep[] = CLOSED_OK, closes = true) {
  serve(world);
  const sdk: FakeSdkOptions = {
    rows: { '1': { IMPFNUM: 'IM1', CLOSED: null, STATDES: 'טיוטא' } },
    activations: { 'IMPFILE1.P': { background: 0, confirm: 0 } },
    steps,
    onActivate: () => {
      if (closes) {
        world.file.CLOSED = 'Y';
        world.file.STATDES = 'סופי';
      }
    },
  };
  const fake = fakeSdk(sdk);
  const client = new PriorityClient(testConfig, createLogger(testConfig));
  const ledgerPath = tempLedger();
  recordStep(ledgerPath, { impfnum: 'IM1', step: 'calc', phase: 'done' });
  const deps: FinalDeps = {
    ledgerPath,
    approvalDir: mkdtempSync(join(tmpdir(), 'approvals-')),
    session: () => fake.session,
    stepTimeoutMs: 40,
    endTimeoutMs: 40,
  };
  const run = (p: Partial<Parameters<typeof closeImportFile>[2]> = {}) =>
    closeImportFile(client, testConfig, { impfnum: 'IM1', dryRun: true, ...p }, deps);
  return { run, fake, deps };
}

describe('impfile_close_run', () => {
  it('previews with a code and does not touch the Web SDK', async () => {
    const world = readyWorld();
    const { run, fake } = setup(world);
    const r = await run();
    expect(r.status, JSON.stringify(r.reasons)).toBe('preview');
    expect(r.approvalCode).toBeTruthy();
    expect(r.limits).toHaveLength(2);
    expect(fake.calls).toEqual([]);
  });

  it('runs IMPFILE1 once with the code and verifies CLOSED = Y', async () => {
    const world = readyWorld();
    const { run, fake } = setup(world);
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('done');
    expect(fake.count('activateStart(IMPFILE1,P)')).toBe(1);
    expect(r.programMessages).toEqual(['תיק היבוא נסגר בהצלחה']);
    const again = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(again.status).toBe('already-done');
    expect(fake.count('activateStart')).toBe(1);
  });

  it('cancels an unexpected warning; the code is spent', async () => {
    const world = readyWorld();
    const { run, fake } = setup(
      world,
      [{ type: 'message', messagetype: 'warning', message: 'האם לסגור?' }, { type: 'end' }],
      false,
    );
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('cancelled');
    expect(fake.calls).toContain('cancel');
    expect(world.file.CLOSED).toBeNull();
    const reuse = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(reuse.reasons?.[0]).toContain('כבר נוצל');
  });

  it('refuses without a calc through the tool, or after a later change', async () => {
    const world = readyWorld();
    serve(world);
    const { run, deps } = setup(world);
    deps.ledgerPath = tempLedger();
    const none = await run();
    expect(none.status).toBe('refused');
    expect(none.reasons?.join(' ')).toContain('impfile_run_calc');
    recordStep(deps.ledgerPath, { impfnum: 'IM1', step: 'calc', phase: 'done' });
    await new Promise((r) => setTimeout(r, 2));
    recordStep(deps.ledgerPath, { impfnum: 'IM1', step: 'fillDetail', phase: 'done' });
    const later = await run();
    expect(later.status).toBe('refused');
    expect(later.reasons?.join(' ')).toContain('fillDetail');
  });

  it('already closed → already-done, no SDK', async () => {
    const world = readyWorld();
    world.file.CLOSED = 'Y';
    const { run, fake } = setup(world);
    expect((await run()).status).toBe('already-done');
    expect(fake.calls).toEqual([]);
  });

  it('refuses while a VAT line with a quantity is left in the content', async () => {
    const world = readyWorld();
    (world.file.IMPFILEITEMS_SUBFORM as Row[]).push({
      KLINE: 3,
      PARTNAME: "מע'מ",
      TQUANT: 1,
      TBALANCE: 0,
    });
    const r = await setup(world).run();
    expect(r.status).toBe('refused');
    expect(r.reasons?.join(' ')).toContain("מע'מ");
  });

  it('a program that ran but left the file open is unverified', async () => {
    const world = readyWorld();
    const { run } = setup(world, CLOSED_OK, false);
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('unverified');
  });

  it('refuses when the file changed after the preview', async () => {
    const world = readyWorld();
    const { run, fake } = setup(world);
    const { approvalCode } = await run();
    (world.file.IMPFILEITEMS_SUBFORM as Row[])[0].TQUANT = 9;
    (world.file.IMPFILEITEMS_SUBFORM as Row[])[0].TBALANCE = 9;
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('refused');
    expect(fake.count('activateStart')).toBe(0);
  });

  it('refuses after an impfile_* write to the file, or when the newest calc is not confirmed', async () => {
    const world = readyWorld();
    const { run, deps } = setup(world);
    await new Promise((r) => setTimeout(r, 2));
    recordStep(deps.ledgerPath as string, { impfnum: 'IM1', step: 'fileChange', phase: 'done' });
    const changed = await run();
    expect(changed.status).toBe('refused');
    expect(changed.reasons?.join(' ')).toContain('fileChange');
    deps.ledgerPath = tempLedger();
    recordStep(deps.ledgerPath, { impfnum: 'IM1', step: 'calc', phase: 'done' });
    await new Promise((r) => setTimeout(r, 2));
    recordStep(deps.ledgerPath, { impfnum: 'IM1', step: 'calc', phase: 'unverified' });
    const stale = await run();
    expect(stale.status).toBe('refused');
    expect(stale.reasons?.join(' ')).toContain('unverified');
  });
});
