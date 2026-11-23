import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { recordStep } from '../src/lib/step-ledger.js';
import { registerImpfileStepTools } from '../src/tools/impfile-steps.js';
import { registerImpfileTools } from '../src/tools/impfiles.js';
import { type FakeSdkOptions, fakeSdk } from './fake-web-sdk.js';
import {
  type Row,
  type World,
  openWorld,
  serve,
  tempLedger,
  testConfig,
  toolHarness,
} from './import-world.js';

/**
 * bonded_fill_detail and impfile_run_calc run Priority's own programs ("מילוי פירוט למחסן ערובה",
 * "חישוב העמסה") through the Web SDK, once, and judge the result by re-reading the file. Driven
 * against a scripted fake SDK whose activation changes the in-memory file.
 */
afterEach(() => vi.unstubAllGlobals());

const ACTIVATION = { background: 0, confirm: 0 };
const SDK: FakeSdkOptions = {
  rows: { '1': { IMPFNUM: 'IM1', CLOSED: null, STATDES: 'טיוטא' } },
  activations: { 'FILL_IMPFILES.P': ACTIVATION, 'IMPFILE2.P': ACTIVATION },
};
const CONTENT: Row[] = [
  { KLINE: 1, PARTNAME: 'P1', TQUANT: 10, TBALANCE: 10 },
  { KLINE: 2, PARTNAME: 'P2', TQUANT: 5, TBALANCE: 5 },
];
const VAT_LINE = (qty: number): Row => ({ KLINE: 3, PARTNAME: "מע'מ", TQUANT: qty, TBALANCE: 0 });
const ESTIMATE: Row[] = [
  { PARTNAME: 'P1', COUNTRYNAME: 'DE' },
  { PARTNAME: 'P2', COUNTRYNAME: 'DE' },
];
const copy = (rows: Row[]) => rows.map((r) => ({ ...r }));

/** The goods were received into arov (final receipt); the file content is still empty. */
function receivedWorld(): World {
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
  return world;
}
/** …and the detail was filled. */
function filledWorld(): World {
  const world = receivedWorld();
  world.file.IMPFILEITEMS_SUBFORM = copy(CONTENT);
  return world;
}

function setup(world: World, sdk: FakeSdkOptions = SDK, config: Config = testConfig) {
  serve(world);
  const fake = fakeSdk(sdk);
  const ledgerPath = tempLedger();
  let sessions = 0;
  const session = () => {
    sessions++;
    return fake.session;
  };
  const h = toolHarness((s, c, cfg) => {
    registerImpfileStepTools(s, c, cfg, {
      ledgerPath,
      session,
      stepTimeoutMs: 40,
      endTimeoutMs: 20,
    });
    registerImpfileTools(s, c, cfg, { stepLedgerPath: ledgerPath });
  }, config);
  const ledger = () =>
    readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Row);
  return { ...h, fake, ledgerPath, ledger, sessions: () => sessions };
}
const readOnly = { ...testConfig, priorityReadOnly: true } as Config;
const RUN = { impfnum: 'IM1', dryRun: false };

describe.each([
  ['bonded_fill_detail', 'fillDetail', 'FILL_IMPFILES', receivedWorld],
  ['impfile_run_calc', 'calc', 'IMPFILE2', filledWorld],
] as const)('%s — common contract', (tool, step, program, ready) => {
  it('previews without logging into the Web SDK', async () => {
    const t = setup(ready());
    const r = await t.call(tool, { impfnum: 'IM1' });
    expect(r).toMatchObject({ status: 'preview', piloted: true, program });
    expect(t.sessions()).toBe(0);
    expect(t.fake.calls).toEqual([]);
  });

  it('with probe: logs in, finds the row, and never activates', async () => {
    const t = setup(ready());
    const r = await t.call(tool, { impfnum: 'IM1', probe: true });
    expect(r.status).toBe('preview');
    expect(r.probe).toMatchObject({ rowFound: true, mismatch: null, activation: ACTIVATION });
    expect(t.fake.calls).toContain('login');
    expect(t.fake.count('activateStart')).toBe(0);
    expect(t.fake.count('setActiveRow')).toBe(0);
  });

  it('dispatches nothing when the gate refuses', async () => {
    const t = setup(openWorld()); // nothing received yet
    const r = await t.call(tool, RUN);
    expect(r.status).toBe('refused');
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(t.fake.calls).toEqual([]);
  });

  it('waits after a run whose result was not confirmed', async () => {
    const t = setup(ready());
    recordStep(t.ledgerPath, { impfnum: 'IM1', step, phase: 'unverified' });
    const r = await t.call(tool, RUN);
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/לא שולחים שוב/);
    expect(t.fake.count('activateStart')).toBe(0);
  });

  it('runs no program in read-only mode', async () => {
    const t = setup(ready(), SDK, readOnly);
    const r = await t.call(tool, RUN);
    expect(r.status).toBe('blocked');
    expect(t.sessions()).toBe(0);
  });

  it('cancels and reports when the program opens an input dialog', async () => {
    const t = setup(ready(), { ...SDK, steps: [{ type: 'inputFields' }, { type: 'end' }] });
    const r = await t.call(tool, RUN);
    expect(r.status).toBe('cancelled');
    expect(r.procedure.steps[0]).toMatchObject({
      type: 'inputFields',
      action: 'cancel (unexpected step inputFields)',
    });
    expect(t.fake.proc.cancel).toHaveBeenCalledTimes(1);
    expect(t.ledger().map((l) => l.phase)).toEqual(['in_flight', 'failed']);
  });

  it('reports unverified when the program does not answer in time', async () => {
    const t = setup(ready(), { ...SDK, hangActivate: true });
    const r = await t.call(tool, RUN);
    expect(r.status).toBe('unverified');
    expect(r.procedure.dispatched).toBe(true);
    expect(t.ledger().at(-1)?.phase).toBe('unverified');
  });

  it('reports failed when the program is not available on the form', async () => {
    const t = setup(ready(), { ...SDK, activations: {} });
    const r = await t.call(tool, RUN);
    expect(r.status).toBe('failed');
    expect(r.procedure.dispatched).toBe(false);
    expect(t.ledger().at(-1)?.phase).toBe('failed');
  });

  it('waits, instead of running again, when the cancel was not confirmed', async () => {
    const t = setup(ready(), {
      ...SDK,
      steps: [{ type: 'inputFields' }, { type: 'end' }],
      hangCancel: true,
    });
    const r = await t.call(tool, RUN);
    expect(r.status).toBe('unverified');
    expect(t.ledger().at(-1)?.phase).toBe('unverified');
    const again = await t.call(tool, RUN);
    expect(again.status).toBe('refused');
    expect(t.fake.count('activateStart')).toBe(1);
  });

  it('leaves no false "sent" record when the Web SDK cannot be started', async () => {
    serve(ready());
    const ledgerPath = tempLedger();
    const h = toolHarness((s, c, cfg) =>
      registerImpfileStepTools(s, c, cfg, {
        ledgerPath,
        session: () => {
          throw new Error('priority-web-sdk is not installed');
        },
      }),
    );
    const r = await h.call(tool, RUN);
    expect(r.status).toBe('failed');
    expect(r.verification.reason).toMatch(/priority-web-sdk/);
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it('answers a warning only when the caller passed its exact text', async () => {
    const steps = [
      { type: 'message', messagetype: 'warning', message: 'להמשיך?' },
      { type: 'end' },
    ];
    const unlisted = setup(ready(), { ...SDK, steps });
    expect((await unlisted.call(tool, RUN)).status).toBe('cancelled');
    expect(unlisted.fake.proc.message).not.toHaveBeenCalled();
    const listed = setup(ready(), { ...SDK, steps });
    const r = await listed.call(tool, { ...RUN, acceptPrompts: ['להמשיך?'] });
    expect(r.status).not.toBe('cancelled');
    expect(listed.fake.calls).toContain('message(1)');
  });

  it('refuses when the SDK row is a closed file', async () => {
    const t = setup(ready(), { ...SDK, rows: { '1': { IMPFNUM: 'IM1', CLOSED: 'Y' } } });
    const r = await t.call(tool, RUN);
    expect(r.status).toBe('failed');
    expect(r.procedure.error).toMatch(/CLOSED/);
    expect(t.fake.count('activateStart')).toBe(0);
  });
});

describe('bonded_fill_detail', () => {
  it('reports already-done when the content already equals the invoice', async () => {
    const t = setup(filledWorld());
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r.status).toBe('already-done');
    expect(t.fake.calls).toEqual([]);
  });

  it('runs the program, deletes the VAT line it copied, and verifies the content', async () => {
    const world = receivedWorld();
    const t = setup(world, {
      ...SDK,
      onActivate: () => {
        world.file.IMPFILEITEMS_SUBFORM = [...copy(CONTENT), VAT_LINE(1)];
      },
    });
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r).toMatchObject({ status: 'done', verified: true, program: 'FILL_IMPFILES' });
    expect(t.fake.calls.filter((c) => c.startsWith('activateStart'))).toEqual([
      'activateStart(FILL_IMPFILES,P)',
    ]);
    expect(world.writes).toEqual([
      { method: 'DELETE', path: "IMPFILES('IM1')/IMPFILEITEMS_SUBFORM(KLINE=3)", body: {} },
    ]);
    expect(world.file.IMPFILEITEMS_SUBFORM).toEqual(CONTENT);
    expect(r.warnings).toEqual([]);
    expect(t.ledger().map((l) => l.phase)).toEqual(['in_flight', 'done']);
  });

  it('reports unverified, with the difference, when a product is missing afterwards', async () => {
    const world = receivedWorld();
    const t = setup(world, {
      ...SDK,
      onActivate: () => {
        world.file.IMPFILEITEMS_SUBFORM = copy(CONTENT).slice(0, 1);
      },
    });
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r.status).toBe('unverified');
    expect(r.verification.reason).toMatch(/P2/);
    expect(t.ledger().at(-1)?.phase).toBe('unverified');
  });

  it('deletes every VAT line, also one already at 0 (a release would pull it in)', async () => {
    const world = receivedWorld();
    world.file.IMPFILEITEMS_SUBFORM = [
      ...copy(CONTENT),
      VAT_LINE(0),
      { KLINE: 4, PARTNAME: "מע'מ", TQUANT: 1, TBALANCE: 0 },
    ];
    const t = setup(world);
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r.status).toBe('done');
    expect(world.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "DELETE IMPFILES('IM1')/IMPFILEITEMS_SUBFORM(KLINE=3)",
      "DELETE IMPFILES('IM1')/IMPFILEITEMS_SUBFORM(KLINE=4)",
    ]);
    expect(world.file.IMPFILEITEMS_SUBFORM).toEqual(CONTENT);
  });

  it('passes on what the program said at its end when the content is right', async () => {
    const world = receivedWorld();
    const t = setup(world, {
      ...SDK,
      steps: [{ type: 'end', messagetype: 'warning', message: 'חלק מהשורות דולגו' }],
      onActivate: () => {
        world.file.IMPFILEITEMS_SUBFORM = copy(CONTENT);
      },
    });
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r.status).toBe('done');
    expect(r.warnings.join(' ')).toMatch(/חלק מהשורות דולגו/);
  });

  it('only deletes the VAT line when the products are already in place', async () => {
    const world = receivedWorld();
    world.file.IMPFILEITEMS_SUBFORM = [...copy(CONTENT), VAT_LINE(1)];
    const t = setup(world);
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r.status).toBe('done');
    expect(t.fake.count('activateStart')).toBe(0);
    expect(world.writes.map((w) => w.method)).toEqual(['DELETE']);
  });

  it('removes a VAT line left at 0 by the old zeroing (first pilot)', async () => {
    const world = receivedWorld();
    world.file.IMPFILEITEMS_SUBFORM = [...copy(CONTENT), VAT_LINE(0)];
    const t = setup(world);
    const preview = await t.call('bonded_fill_detail', { ...RUN, dryRun: true });
    expect(preview.status).toBe('preview');
    expect(preview.wouldSend).toEqual([
      expect.objectContaining({ method: 'DELETE', endpoint: expect.stringContaining('KLINE=3') }),
    ]);
    expect(world.writes).toEqual([]);
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r.status).toBe('done');
    expect(world.writes.map((w) => w.method)).toEqual(['DELETE']);
    expect(world.file.IMPFILEITEMS_SUBFORM).toEqual(CONTENT);
  });

  it('zeroes the VAT line instead when Priority refuses the delete, and says so', async () => {
    const world = receivedWorld();
    world.file.IMPFILEITEMS_SUBFORM = [...copy(CONTENT), VAT_LINE(1)];
    world.intercept = (method) =>
      method === 'DELETE'
        ? new Response(JSON.stringify({ error: { message: 'אין הרשאה למחוק' } }), { status: 403 })
        : undefined;
    const t = setup(world);
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r.status).toBe('done');
    expect(r.sent.map((w: { method: string }) => w.method)).toEqual(['PATCH']);
    expect(world.writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      "PATCH IMPFILES('IM1')/IMPFILEITEMS_SUBFORM(KLINE=3)",
    ]);
    expect(world.file.IMPFILEITEMS_SUBFORM).toEqual([...CONTENT, VAT_LINE(0)]);
    expect(r.warnings.join(' ')).toMatch(/דחה את מחיקת שורת מע'מ/);
  });

  it('leaves a refused delete of a 0 VAT line as it is, with a warning', async () => {
    const world = receivedWorld();
    world.file.IMPFILEITEMS_SUBFORM = [...copy(CONTENT), VAT_LINE(0)];
    world.intercept = (method) =>
      method === 'DELETE' ? new Response('{}', { status: 403 }) : undefined;
    const t = setup(world);
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r.status).toBe('done');
    expect(r.sent).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/bonded_release_draft מתעלם ממנה/);
  });

  it('on a closed file a VAT line at 0 is left alone: already-done with a warning', async () => {
    const world = receivedWorld();
    world.file.CLOSED = 'Y';
    world.file.IMPFILEITEMS_SUBFORM = [...copy(CONTENT), VAT_LINE(0)];
    const t = setup(world);
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r.status).toBe('already-done');
    expect(r.warnings.join(' ')).toMatch(/התיק סגור/);
    expect(world.writes).toEqual([]);
  });

  it('refuses content that differs from the invoice instead of running again', async () => {
    const world = receivedWorld();
    world.file.IMPFILEITEMS_SUBFORM = [{ KLINE: 1, PARTNAME: 'P1', TQUANT: 4, TBALANCE: 4 }];
    const t = setup(world);
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/כבר יש שורות/);
    expect(t.fake.calls).toEqual([]);
  });

  it('compares product lines only: carriage and a zeroed duplicate are not products', async () => {
    const world = receivedWorld();
    const goodsLines = (world.file.IMPFILEINV_SUBFORM as Row[])[0].IMPFILEIVS_SUBFORM as Row[];
    goodsLines.push(
      { KLINE: 3, PARTNAME: '000', TQUANT: 1, QPRICE: 30, CODE: 'EUR' },
      { KLINE: 4, PARTNAME: 'P1', TQUANT: 0, QPRICE: 0, CODE: 'EUR' },
    );
    const t = setup(world, {
      ...SDK,
      onActivate: () => {
        world.file.IMPFILEITEMS_SUBFORM = copy(CONTENT);
      },
    });
    const r = await t.call('bonded_fill_detail', RUN);
    expect(r.status).toBe('done');
  });
});

describe('impfile_run_calc', () => {
  it('runs the program and verifies that the customs estimate covers the content', async () => {
    const world = filledWorld();
    const t = setup(world, {
      ...SDK,
      onActivate: () => {
        world.file.IMPFILECUSTOMS_SUBFORM = copy(ESTIMATE);
      },
    });
    const r = await t.call('impfile_run_calc', RUN);
    expect(r).toMatchObject({
      status: 'done',
      verified: true,
      program: 'IMPFILE2',
      customsEstimateLines: 2,
    });
    expect(r.stage.currentStep).toBe(7);
    expect(typeof r.ranAt).toBe('string');
    expect(world.writes).toEqual([]);
    expect(t.ledger().map((l) => l.phase)).toEqual(['in_flight', 'done']);
  });

  it('reports unverified when the estimate still misses a product', async () => {
    const world = filledWorld();
    const t = setup(world, {
      ...SDK,
      onActivate: () => {
        world.file.IMPFILECUSTOMS_SUBFORM = copy(ESTIMATE).slice(0, 1);
      },
    });
    const r = await t.call('impfile_run_calc', RUN);
    expect(r.status).toBe('unverified');
    expect(r.verification.reason).toMatch(/1\/2/);
  });

  it('reports unverified when an estimate row has no country of origin', async () => {
    const world = filledWorld();
    const t = setup(world, {
      ...SDK,
      onActivate: () => {
        world.file.IMPFILECUSTOMS_SUBFORM = [ESTIMATE[0], { PARTNAME: 'P2', COUNTRYNAME: null }];
      },
    });
    const r = await t.call('impfile_run_calc', RUN);
    expect(r.status).toBe('unverified');
    expect(r.verification.reason).toMatch(/ארץ מוצא/);
  });

  it('does not report done when the program ended with an error', async () => {
    const world = filledWorld();
    world.file.IMPFILECUSTOMS_SUBFORM = copy(ESTIMATE); // complete before the run: no proof
    const t = setup(world, {
      ...SDK,
      steps: [{ type: 'end', messagetype: 'error', message: 'חסר שער מטבע' }],
    });
    const r = await t.call('impfile_run_calc', RUN);
    expect(r.status).toBe('unverified');
    expect(r.verification.reason).toMatch(/חסר שער מטבע/);
    expect((await t.call('impfile_close', { impfnum: 'IM1' })).lastCalcViaTool).toBeNull();
  });

  it('may be run again after it was done (the SOP repeats it after every change)', async () => {
    const world = filledWorld();
    world.file.IMPFILECUSTOMS_SUBFORM = copy(ESTIMATE);
    const t = setup(world);
    expect((await t.call('impfile_run_calc', RUN)).status).toBe('done');
    expect((await t.call('impfile_run_calc', RUN)).status).toBe('done');
    expect(t.fake.count('activateStart')).toBe(2);
  });

  it('the calc guide and the close check point to impfile_run_calc', async () => {
    const world = filledWorld();
    world.file.IMPFILECUSTOMS_SUBFORM = copy(ESTIMATE);
    const t = setup(world);
    const guide = await t.call('impfile_run_calc_guide', { impfnum: 'IM1' });
    expect(guide).toMatchObject({ mutates: false, tool: 'impfile_run_calc' });
    expect(guide.instruction).toContain('impfile_run_calc');
    const close = await t.call('impfile_close', { impfnum: 'IM1' });
    expect(close.readyToClose).toBe(true);
    expect(close.nextStep).toMatch(/impfile_run_calc.*אסף.*סגירת התיק/);
  });

  it('is shown by impfile_close and impfile_preflight as lastCalcViaTool', async () => {
    const world = filledWorld();
    world.file.IMPFILECUSTOMS_SUBFORM = copy(ESTIMATE);
    const t = setup(world);
    expect((await t.call('impfile_close', { impfnum: 'IM1' })).lastCalcViaTool).toBeNull();
    const ran = await t.call('impfile_run_calc', RUN);
    const close = await t.call('impfile_close', { impfnum: 'IM1' });
    expect(close.lastCalcViaTool).toBe(ran.ranAt);
    expect(close.mutates).toBe(false);
    const preflight = await t.call('impfile_preflight', { impfnum: 'IM1' });
    expect(preflight.lastCalcViaTool).toBe(ran.ranAt);
  });
});
