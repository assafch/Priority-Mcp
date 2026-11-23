import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { registerImpfileStepTools } from '../src/tools/impfile-steps.js';
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
 * bonded_line_costs runs Priority's "רישום עלויות יבוא לשורה" (IMPORTCOSTPERLINE) on a release
 * while it is still a draft, and reports the cost of every line from a re-read. Driven against a
 * scripted fake SDK whose activation writes the cost rows into the in-memory release.
 */
afterEach(() => vi.unstubAllGlobals());

const ACTIVATION = { background: 0, confirm: 0 };
const SDK: FakeSdkOptions = {
  rows: { '1': { DOCNO: 'BD1', IMPFNUM: 'IM1', STATDES: 'טיוטא' } },
  activations: { 'IMPORTCOSTPERLINE.P': ACTIVATION },
};
const costRow = (goods: number, imp: number, at = '2026-01-20T10:05:00Z'): Row => ({
  TRANSCOST: goods,
  CUSTOMSSUM: 0,
  DUTYCOST: 0,
  IMPFCOST: imp,
  TOTCOST: goods + imp,
  UDATE: at,
});

/** A closed file whose whole balance sits on the draft release BD1; no costs registered yet. */
function releaseWorld(): World {
  const world = openWorld();
  world.file.CLOSED = 'Y';
  world.file.STATDES = 'סופי';
  world.file.IMPFILEITEMS_SUBFORM = [
    { KLINE: 1, PARTNAME: 'P1', TQUANT: 10, TBALANCE: 10 },
    { KLINE: 2, PARTNAME: 'P2', TQUANT: 5, TBALANCE: 5 },
  ];
  world.receipts.push({
    DOCNO: 'GR1',
    STATDES: 'סופית',
    TOWARHSNAME: 'arov',
    IVNUM: 'GI1',
    TRANSORDER_P_SUBFORM: [],
  });
  world.releases.push({
    DOCNO: 'BD1',
    TYPE: 'J',
    IMPFNUM: 'IM1',
    STATDES: 'טיוטא',
    CURDATE: '2026-01-20T00:00:00Z',
    UDATE: '2026-01-20T10:00:00Z',
    DOCREF: 'D1',
    IVNUM: null,
    TRANSORDER_J_SUBFORM: [
      { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10 },
      { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 5 },
    ],
  });
  return world;
}
const releaseLines = (world: World) => world.releases[0].TRANSORDER_J_SUBFORM as Row[];
/** What the program does: one cost row per line; the file's cost invoice is 300 ₪. */
const registerCosts = (world: World, at?: string) => () => {
  releaseLines(world)[0].TRANSIMPFILE_SUBFORM = costRow(1000, 200, at);
  releaseLines(world)[1].TRANSIMPFILE_SUBFORM = costRow(500, 100, at);
};

function setup(world: World, sdk: FakeSdkOptions = SDK, config: Config = testConfig) {
  serve(world);
  const fake = fakeSdk(sdk);
  const ledgerPath = tempLedger();
  let sessions = 0;
  const session = () => {
    sessions++;
    return fake.session;
  };
  const h = toolHarness(
    (s, c, cfg) =>
      registerImpfileStepTools(s, c, cfg, {
        ledgerPath,
        session,
        stepTimeoutMs: 40,
        endTimeoutMs: 20,
      }),
    config,
  );
  const ledger = () =>
    readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Row);
  return { ...h, fake, ledger, sessions: () => sessions };
}
const COSTS = { impfnum: 'IM1', release: 'BD1' };
const RUN = { ...COSTS, dryRun: false };

describe('bonded_line_costs', () => {
  it('previews without the Web SDK; with probe it logs in and never activates', async () => {
    const world = releaseWorld();
    const t = setup(world);
    const preview = await t.call('bonded_line_costs', COSTS);
    expect(preview).toMatchObject({
      status: 'preview',
      program: 'IMPORTCOSTPERLINE',
      piloted: false,
    });
    expect(t.sessions()).toBe(0);
    const probed = await t.call('bonded_line_costs', { ...COSTS, probe: true });
    expect(probed.probe).toMatchObject({ rowFound: true, mismatch: null });
    expect(t.fake.count('activateStart')).toBe(0);
    expect(world.writes).toEqual([]);
  });

  it('runs the program on the draft and reports the cost of every line', async () => {
    const world = releaseWorld();
    const t = setup(world, { ...SDK, onActivate: registerCosts(world) });
    const r = await t.call('bonded_line_costs', RUN);
    expect(r).toMatchObject({
      status: 'done',
      verified: true,
      release: 'BD1',
      documentStatus: 'טיוטא',
    });
    expect(r.lines).toEqual([
      { part: 'P1', qty: 10, goodsILS: 1000, importILS: 200, totalILS: 1200 },
      { part: 'P2', qty: 5, goodsILS: 500, importILS: 100, totalILS: 600 },
    ]);
    expect(t.fake.calls.filter((c) => c.startsWith('activateStart'))).toEqual([
      'activateStart(IMPORTCOSTPERLINE,P)',
    ]);
    expect(t.fake.calls).toContain('setSearchFilter([{"field":"DOCNO","fromval":"BD1","op":"="}])');
    expect(r.nextStep).toMatch(/סופית/);
    expect(world.writes).toEqual([]);
    expect(t.ledger().map((l) => l.phase)).toEqual(['in_flight', 'done']);
  });

  it('adds the whole-file reconciliation when the release takes the whole balance', async () => {
    const world = releaseWorld();
    const t = setup(world, { ...SDK, onActivate: registerCosts(world) });
    const r = await t.call('bonded_line_costs', RUN);
    expect(r.reconciliation).toMatchObject({
      status: 'ties',
      importCostsOnReleases: 300,
      costInvoiceLinesTotal: 300,
    });
  });

  it('still reconciles when the draft release already lowered the balance in bond', async () => {
    const world = releaseWorld();
    // if Priority reduces the content balance as soon as the draft exists, the balance is 0 here
    for (const c of world.file.IMPFILEITEMS_SUBFORM as Row[]) c.TBALANCE = 0;
    const t = setup(world, { ...SDK, onActivate: registerCosts(world) });
    const r = await t.call('bonded_line_costs', RUN);
    expect(r.status).toBe('done');
    expect(r.reconciliation).toMatchObject({ status: 'ties', importCostsOnReleases: 300 });
  });

  it('gives no reconciliation for a partial release', async () => {
    const world = releaseWorld();
    releaseLines(world)[1].TQUANT = 2; // 3 of P2 stay in bond
    const t = setup(world, { ...SDK, onActivate: registerCosts(world) });
    const r = await t.call('bonded_line_costs', RUN);
    expect(r.status).toBe('done');
    expect(r.reconciliation).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/חלקי/);
  });

  it('reports unverified, naming the parts, when a line is left without costs', async () => {
    const world = releaseWorld();
    const t = setup(world, {
      ...SDK,
      onActivate: () => {
        releaseLines(world)[0].TRANSIMPFILE_SUBFORM = costRow(1000, 200);
      },
    });
    const r = await t.call('bonded_line_costs', RUN);
    expect(r.status).toBe('unverified');
    expect(r.verification.reason).toMatch(/P2/);
    expect(t.ledger().at(-1)?.phase).toBe('unverified');
  });

  it('refuses a final release unless the caller asks for the repair path', async () => {
    const world = releaseWorld();
    world.releases[0].STATDES = 'סופית';
    const sdk = { ...SDK, rows: { '1': { DOCNO: 'BD1', IMPFNUM: 'IM1', STATDES: 'סופית' } } };
    const t = setup(world, { ...sdk, onActivate: registerCosts(world) });
    const refused = await t.call('bonded_line_costs', RUN);
    expect(refused.status).toBe('refused');
    expect(refused.reasons.join(' ')).toMatch(/onFinalRelease/);
    expect(t.fake.calls).toEqual([]);
    const repaired = await t.call('bonded_line_costs', { ...RUN, onFinalRelease: true });
    expect(repaired).toMatchObject({ status: 'done', documentStatus: 'סופית' });
  });

  it('refuses a file that is not closed, and a release of another file', async () => {
    const open = releaseWorld();
    open.file.CLOSED = null;
    const t = setup(open);
    const r = await t.call('bonded_line_costs', RUN);
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/התיק אינו סגור/);
    const other = await setup(releaseWorld()).call('bonded_line_costs', { ...RUN, release: 'BD9' });
    expect(other.status).toBe('refused');
    expect(other.reasons.join(' ')).toMatch(/לא נמצאה/);
    expect(t.fake.calls).toEqual([]);
  });

  it('reports already-done without running when every line is costed', async () => {
    const world = releaseWorld();
    registerCosts(world)();
    const t = setup(world);
    const r = await t.call('bonded_line_costs', RUN);
    expect(r.status).toBe('already-done');
    expect(r.lines).toHaveLength(2);
    expect(t.fake.calls).toEqual([]);
  });

  it('runs again only with rerun=true, and says whether the rows changed', async () => {
    const world = releaseWorld();
    registerCosts(world)();
    const same = setup(world, { ...SDK, onActivate: registerCosts(world) });
    const unchanged = await same.call('bonded_line_costs', { ...RUN, rerun: true });
    // identical rows before and after: nothing shows that the rerun did anything
    expect(unchanged).toMatchObject({
      status: 'unverified',
      verified: false,
      rerunEffect: 'not-provable',
    });
    expect(same.fake.count('activateStart')).toBe(1);

    const later = setup(world, {
      ...SDK,
      onActivate: registerCosts(world, '2026-01-21T09:00:00Z'),
    });
    const changed = await later.call('bonded_line_costs', { ...RUN, rerun: true });
    expect(changed).toMatchObject({ status: 'done', rerunEffect: 'changed' });
  });

  it('matches lines before and after by line number, not by position', async () => {
    const world = releaseWorld();
    registerCosts(world)();
    const t = setup(world, {
      ...SDK,
      onActivate: () => {
        (world.releases[0].TRANSORDER_J_SUBFORM as Row[]).reverse(); // same rows, other order
      },
    });
    const r = await t.call('bonded_line_costs', { ...RUN, rerun: true });
    expect(r.rerunEffect).toBe('not-provable');
  });

  it('does not report done when the costs do not tie to the cost invoices', async () => {
    const world = releaseWorld();
    const t = setup(world, {
      ...SDK,
      onActivate: () => {
        releaseLines(world)[0].TRANSIMPFILE_SUBFORM = costRow(1000, 200);
        releaseLines(world)[1].TRANSIMPFILE_SUBFORM = costRow(500, 50); // 250 against invoices of 300
      },
    });
    const r = await t.call('bonded_line_costs', RUN);
    expect(r.status).toBe('unverified');
    expect(r.reconciliation.status).toBe('differs');
    expect(r.verification.reason).toMatch(/250.*300|300.*250/);
    // …and a later call does not present the same state as verified
    const again = await t.call('bonded_line_costs', RUN);
    expect(again).toMatchObject({ status: 'already-done', verified: false });
    expect(again.warnings.join(' ')).toMatch(/250.*300|300.*250/);
  });

  it('does not report done for a rerun whose program ended with an error', async () => {
    const world = releaseWorld();
    registerCosts(world)();
    const t = setup(world, {
      ...SDK,
      steps: [{ type: 'end', messagetype: 'error', message: 'התיק נעול' }],
      onActivate: registerCosts(world, '2026-01-21T09:00:00Z'),
    });
    const r = await t.call('bonded_line_costs', { ...RUN, rerun: true });
    expect(r.status).toBe('unverified');
    expect(r.verification.reason).toMatch(/התיק נעול/);
  });

  it('cancels and reports when the program opens an input dialog', async () => {
    const t = setup(releaseWorld(), { ...SDK, steps: [{ type: 'inputFields' }, { type: 'end' }] });
    const r = await t.call('bonded_line_costs', RUN);
    expect(r.status).toBe('cancelled');
    expect(r.procedure.steps[0].type).toBe('inputFields');
    expect(t.ledger().map((l) => l.phase)).toEqual(['in_flight', 'failed']);
  });

  it('does not run on an SDK row that is not the approved release', async () => {
    const sdk = { ...SDK, rows: { '1': { DOCNO: 'BD1', IMPFNUM: 'IM2', STATDES: 'טיוטא' } } };
    const t = setup(releaseWorld(), sdk);
    const r = await t.call('bonded_line_costs', RUN);
    expect(r.status).toBe('failed');
    expect(r.procedure.error).toMatch(/IMPFNUM IM2/);
    expect(t.fake.count('activateStart')).toBe(0);
  });

  it('runs no program in read-only mode', async () => {
    const t = setup(releaseWorld(), SDK, { ...testConfig, priorityReadOnly: true } as Config);
    const r = await t.call('bonded_line_costs', RUN);
    expect(r.status).toBe('blocked');
    expect(t.sessions()).toBe(0);
  });

  it('reads the cost rows back without a $select (computed columns come back null with one)', async () => {
    const world = releaseWorld();
    const t = setup(world, { ...SDK, onActivate: registerCosts(world) });
    await t.call('bonded_line_costs', RUN);
    const reads = world.gets.filter((g) => g.startsWith('DOCUMENTS_J'));
    expect(reads.length).toBeGreaterThanOrEqual(2); // before and after the program
    for (const read of reads) {
      expect(read).toContain('TRANSORDER_J_SUBFORM($expand=TRANSIMPFILE_SUBFORM)');
      expect(read).not.toContain('TRANSIMPFILE_SUBFORM($select');
    }
  });
});
