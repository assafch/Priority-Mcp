import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { type FinalDeps, finalizeBondedReceipt } from '../src/services/import-final-steps.js';
import {
  type Row,
  type World,
  openWorld,
  priorityError,
  serve,
  tempLedger,
  testConfig,
} from './import-world.js';

/**
 * bonded_receipt_finalize (step 4b): the draft receipt into BONDED becomes final, only with the
 * approval code of its own preview, and only while it still is exactly what the preview showed.
 */
afterEach(() => vi.unstubAllGlobals());

function receiptWorld(over: Partial<Row> = {}, lines?: Row[]): World {
  const world = openWorld();
  world.receipts.push({
    DOCNO: 'GR1',
    TYPE: 'P',
    STATDES: 'טיוטא',
    TOWARHSNAME: 'BONDED',
    TOLOCNAME: '0',
    IVNUM: 'GI1',
    UDATE: '2026-01-10T10:00:00Z',
    TRANSORDER_P_SUBFORM: lines ?? [
      { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10 },
      { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 5 },
    ],
    ...over,
  });
  world.stock = { P1: { 'BONDED/0': 0, 'Main/0': 3 }, P2: { 'BONDED/0': 0 } };
  return world;
}

function setup(world: World, config: Config = testConfig) {
  serve(world);
  const client = new PriorityClient(config, createLogger(config));
  const deps: FinalDeps = {
    ledgerPath: tempLedger(),
    approvalDir: mkdtempSync(join(tmpdir(), 'approvals-')),
  };
  const run = (p: Partial<Parameters<typeof finalizeBondedReceipt>[2]> = {}) =>
    finalizeBondedReceipt(
      client,
      config,
      { impfnum: 'IM1', docno: 'GR1', dryRun: true, ...p },
      deps,
    );
  return { run, deps };
}
const statusWrites = (world: World) =>
  world.writes.filter((w) => w.method === 'PATCH' && w.path.startsWith('DOCUMENTS_P('));

describe('bonded_receipt_finalize', () => {
  it('previews with a code and sends nothing', async () => {
    const world = receiptWorld();
    const { run } = setup(world);
    const r = await run();
    expect(r.status).toBe('preview');
    expect(r.approvalCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(r.approvalRule).toContain('אישר');
    expect(r.wouldSend?.[0]).toMatchObject({ method: 'PATCH', body: { STATDES: 'סופית' } });
    expect(r.piloted).toBe(false);
    expect(world.writes).toEqual([]);
  });

  it('runs with the code: exactly the status, verified by status and stock', async () => {
    const world = receiptWorld();
    const { run, deps } = setup(world);
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('done');
    expect(statusWrites(world)).toEqual([
      { method: 'PATCH', path: "DOCUMENTS_P(DOCNO='GR1',TYPE='P')", body: { STATDES: 'סופית' } },
    ]);
    expect(r.stockAfter).toEqual({ P1: { 'BONDED/0': 10 }, P2: { 'BONDED/0': 5 } });
    const ledger = readFileSync(deps.ledgerPath as string, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(ledger.map((l) => `${l.step}:${l.phase}`)).toEqual([
      'receiptFinal:in_flight',
      'receiptFinal:done',
    ]);
  });

  it('refuses a real run without a code, with an unknown code, and a code used twice', async () => {
    const world = receiptWorld();
    const { run } = setup(world);
    expect((await run({ dryRun: false })).status).toBe('refused');
    const unknown = await run({ dryRun: false, approvalCode: 'ABCD-EFGH' });
    expect(unknown.reasons?.[0]).toContain('אינו מוכר');
    expect(world.writes).toEqual([]);
    const { approvalCode } = await run();
    await run({ dryRun: false, approvalCode: approvalCode as string });
    const again = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(again.status).toBe('already-done');
    expect(statusWrites(world)).toHaveLength(1);
  });

  it('refuses an expired code', async () => {
    const world = receiptWorld();
    const { run, deps } = setup(world);
    let now = Date.parse('2026-01-10T10:00:00Z');
    deps.now = () => now;
    const { approvalCode } = await run();
    now += 600_001;
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.reasons?.[0]).toContain('פג');
    expect(world.writes).toEqual([]);
  });

  it('refuses when the receipt changed after the preview; a new preview works', async () => {
    const world = receiptWorld();
    const { run } = setup(world);
    const { approvalCode } = await run();
    world.receipts[0].UDATE = '2026-01-10T10:07:00Z';
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('refused');
    expect(r.reasons?.[0]).toContain('המסמך השתנה מאז התצוגה המקדימה');
    expect(world.writes).toEqual([]);
    const fresh = await run();
    expect((await run({ dryRun: false, approvalCode: fresh.approvalCode as string })).status).toBe(
      'done',
    );
  });

  it('refuses a code issued by another tool', async () => {
    const world = receiptWorld();
    const { run, deps } = setup(world);
    const { issueApproval } = await import('../src/lib/approval-codes.js');
    const { approvalCode } = issueApproval(
      deps.approvalDir as string,
      { tool: 'bonded_release_finalize', subject: 'IM1/GR1', state: {} },
      Date.now(),
    );
    const r = await run({ dryRun: false, approvalCode });
    expect(r.reasons?.[0]).toContain('אינו שייך');
  });

  it('refuses a receipt that still carries the 000 or the VAT line', async () => {
    for (const part of ['000', "מע'מ"]) {
      const world = receiptWorld({}, [
        { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10 },
        { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 5 },
        { KLINE: 3, PARTNAME: part, PQUANT: 1, TQUANT: 1 },
      ]);
      const r = await setup(world).run();
      expect(r.status).toBe('refused');
      expect(r.reasons?.join(' ')).toContain(part);
    }
  });

  it('accepts the pilot shape: a 000 line on the invoice, none on the receipt', async () => {
    const world = receiptWorld();
    (world.pinvoices[0].PINVOICEITEMS_SUBFORM as Row[]).push({
      KLINE: 3,
      PARTNAME: '000',
      TQUANT: 1,
    });
    const r = await setup(world).run();
    expect(r.status).toBe('preview');
  });

  it('refuses a receipt into another warehouse, a line short of the invoice, a temporary invoice', async () => {
    expect((await setup(receiptWorld({ TOWARHSNAME: 'Main' })).run()).status).toBe('refused');
    const short = receiptWorld({}, [
      { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 8 },
      { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 5 },
    ]);
    expect((await setup(short).run()).status).toBe('refused');
    const temp = receiptWorld({ IVNUM: 'T9' });
    (temp.file.IMPFILEINV_SUBFORM as Row[])[0].IVNUM = 'T9';
    temp.pinvoices[0].IVNUM = 'T9';
    expect((await setup(temp).run()).status).toBe('refused');
  });

  it('a final receipt is already done', async () => {
    const r = await setup(receiptWorld({ STATDES: 'סופית' })).run();
    expect(r.status).toBe('already-done');
  });

  it('blocked when DOCUMENTS_P reads come back empty, and in read-only mode', async () => {
    const blind = receiptWorld();
    blind.blind = ['DOCUMENTS_P'];
    expect((await setup(blind).run()).status).toBe('blocked');
    const world = receiptWorld();
    const ro = setup(world, { ...testConfig, priorityReadOnly: true } as Config);
    const { approvalCode } = await ro.run();
    const r = await ro.run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('blocked');
    expect(world.writes).toEqual([]);
  });

  it('an unclear answer to the PATCH is unverified and the step then cools down', async () => {
    const world = receiptWorld();
    const { run } = setup(world);
    world.intercept = (method, path) =>
      method === 'PATCH' && path.startsWith('DOCUMENTS_P(')
        ? priorityError(500, 'boom')
        : undefined;
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('unverified');
    world.intercept = undefined;
    const next = await run();
    const again = await run({ dryRun: false, approvalCode: next.approvalCode as string });
    expect(again.status).toBe('refused');
    expect(again.reasons?.[0]).toContain('receiptFinal');
  });

  it('a stock change that does not match is unverified, not done', async () => {
    const world = receiptWorld();
    world.frozenStock = true;
    const { run } = setup(world);
    const { approvalCode } = await run();
    const r = await run({ dryRun: false, approvalCode: approvalCode as string });
    expect(r.status).toBe('unverified');
    expect(r.verification.reason).toContain('המלאי');
  });

  it('a final receipt of another invoice is refused, not already-done', async () => {
    const r = await setup(receiptWorld({ STATDES: 'סופית', IVNUM: 'GI9' })).run();
    expect(r.status).toBe('refused');
    expect(r.reasons?.[0]).toContain('GI9');
  });
});
