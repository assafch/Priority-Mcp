import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityClient } from '../src/client/priority-client.js';
import { findStageViolation } from '../src/lib/import-stage-guard.js';
import { createLogger } from '../src/logger.js';
import { type FinalDeps, finalizeBondedRelease } from '../src/services/import-final-steps.js';
import { type Row, type World, openWorld, serve, tempLedger, testConfig } from './import-world.js';

/**
 * bonded_release_finalize (step 10): the draft release becomes final through the lock's one
 * narrow opening — only when every line carries its import costs, only with the approval code of
 * its own preview.
 */
afterEach(() => vi.unstubAllGlobals());

const cost = (goods: number, imp: number, at = '2026-01-20T10:05:00Z'): Row => ({
  TRANSCOST: goods,
  CUSTOMSSUM: 0,
  DUTYCOST: 0,
  IMPFCOST: imp,
  TOTCOST: goods + imp,
  UDATE: at,
});

/** A closed file whose whole balance is on the draft release BD1, costs registered. */
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
    TOWARHSNAME: 'BONDED',
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
    TOWARHSNAME: 'Main',
    TOLOCNAME: '0',
    IVNUM: null,
    TRANSORDER_J_SUBFORM: [
      { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10, TRANSIMPFILE_SUBFORM: cost(1000, 200) },
      { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 5, TRANSIMPFILE_SUBFORM: cost(500, 100) },
    ],
  });
  world.stock = { P1: { 'BONDED/0': 10, 'Main/0': 0 }, P2: { 'BONDED/0': 5 } };
  return world;
}
const lines = (world: World) => world.releases[0].TRANSORDER_J_SUBFORM as Row[];

function setup(world: World) {
  serve(world);
  const client = new PriorityClient(testConfig, createLogger(testConfig));
  const deps: FinalDeps = {
    ledgerPath: tempLedger(),
    approvalDir: mkdtempSync(join(tmpdir(), 'approvals-')),
  };
  const run = (p: Partial<Parameters<typeof finalizeBondedRelease>[2]> = {}) =>
    finalizeBondedRelease(
      client,
      testConfig,
      { impfnum: 'IM1', docno: 'BD1', dryRun: true, ...p },
      deps,
    );
  return { run };
}

describe('bonded_release_finalize', () => {
  it('previews with a code when every line is costed', async () => {
    const world = releaseWorld();
    const r = await setup(world).run();
    expect(r.status, JSON.stringify(r.reasons)).toBe('preview');
    expect(r.approvalCode).toBeTruthy();
    expect(r.stockBefore).toEqual({
      P1: { 'BONDED/0': 10, 'Main/0': 0 },
      P2: { 'BONDED/0': 5, 'Main/0': 0 },
    });
    expect(world.writes).toEqual([]);
  });

  it('runs through the lock opening and verifies status and stock', async () => {
    const world = releaseWorld();
    const { run } = setup(world);
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status, JSON.stringify(r)).toBe('done');
    expect(world.writes).toEqual([
      { method: 'PATCH', path: "DOCUMENTS_J(DOCNO='BD1',TYPE='J')", body: { STATDES: 'סופית' } },
    ]);
    expect(r.stockAfter).toEqual({
      P1: { 'BONDED/0': 0, 'Main/0': 10 },
      P2: { 'BONDED/0': 0, 'Main/0': 5 },
    });
  });

  it('the same write outside the tool stays blocked', () => {
    expect(
      findStageViolation('PATCH', "DOCUMENTS_J(DOCNO='BD1',TYPE='J')", { STATDES: 'סופית' })?.rule,
    ).toBe('bonded-release');
  });

  it('refuses a line without costs, naming the part and bonded_line_costs', async () => {
    const world = releaseWorld();
    lines(world)[1].TRANSIMPFILE_SUBFORM = null;
    const r = await setup(world).run();
    expect(r.status).toBe('refused');
    expect(r.reasons?.join(' ')).toContain('P2');
    expect(r.reasons?.join(' ')).toContain('bonded_line_costs');
  });

  it('a 0 import cost is refused when the file has cost invoices, allowed when it has none', async () => {
    const world = releaseWorld();
    lines(world)[0].TRANSIMPFILE_SUBFORM = cost(1000, 0);
    expect((await setup(world).run()).status).toBe('refused');
    const noCosts = releaseWorld();
    lines(noCosts)[0].TRANSIMPFILE_SUBFORM = cost(1000, 0);
    lines(noCosts)[1].TRANSIMPFILE_SUBFORM = cost(500, 0);
    noCosts.file.IMPFILEINV_SUBFORM = (noCosts.file.IMPFILEINV_SUBFORM as Row[]).slice(0, 1);
    expect((await setup(noCosts).run()).status).toBe('preview');
  });

  it('refuses on an open file, another file, a zero-quantity line', async () => {
    const open = releaseWorld();
    open.file.CLOSED = null;
    expect((await setup(open).run()).status).toBe('refused');
    const other = releaseWorld();
    other.releases[0].IMPFNUM = 'IM2';
    expect((await setup(other).run()).reasons?.[0]).toContain('IM2');
    const zero = releaseWorld();
    lines(zero)[1].TQUANT = 0;
    expect((await setup(zero).run()).reasons?.join(' ')).toContain('כמות 0');
  });

  it('a final release is already done', async () => {
    const world = releaseWorld();
    world.releases[0].STATDES = 'סופית';
    expect((await setup(world).run()).status).toBe('already-done');
  });

  it('refuses when the costs were registered again after the preview', async () => {
    const world = releaseWorld();
    const { run } = setup(world);
    const { approvalCode } = await run();
    lines(world)[0].TRANSIMPFILE_SUBFORM = cost(1000, 200, '2026-01-20T11:00:00Z');
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.reasons?.[0]).toContain('המסמך השתנה');
    expect(world.writes).toEqual([]);
  });

  it('refuses a VAT line even at quantity 0, and a release into BONDED/0 itself', async () => {
    const vat = releaseWorld();
    lines(vat).push({ KLINE: 3, PARTNAME: "מע'מ", PQUANT: 0, TQUANT: 0 });
    const r = await setup(vat).run();
    expect(r.status).toBe('refused');
    expect(r.reasons?.join(' ')).toContain("מע'מ");
    const same = releaseWorld();
    same.releases[0].TOWARHSNAME = 'BONDED';
    expect((await setup(same).run()).status).toBe('refused');
  });
});
