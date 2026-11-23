import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOOL_DEFINITIONS } from '../src/lib/capability-definitions.js';
import { registerImpfileFinalStepTools } from '../src/tools/impfile-final-steps.js';
import { type Row, openWorld, serve, tempLedger, toolHarness } from './import-world.js';

/**
 * The four irreversible-step tools are registered with the approval contract in their schema:
 * a code of the right shape only, no acceptPrompts, and the document names mapped through.
 */
afterEach(() => vi.unstubAllGlobals());

const TOOLS = [
  'bonded_receipt_finalize',
  'impfile_close_run',
  'bonded_release_finalize',
  'costing_run',
];

function harness() {
  const deps = {
    ledgerPath: tempLedger(),
    approvalDir: mkdtempSync(join(tmpdir(), 'approvals-')),
  };
  return toolHarness((s, c, cfg) => registerImpfileFinalStepTools(s, c, cfg, deps));
}

describe('final-step tool registration', () => {
  it('registers exactly the four tools, each with a capability row', () => {
    expect(harness().names().sort()).toEqual([...TOOLS].sort());
    const defined = new Set(TOOL_DEFINITIONS.map((d) => d.name));
    for (const tool of TOOLS) expect(defined.has(tool), tool).toBe(true);
  });

  it('rejects a malformed approval code and an acceptPrompts parameter', async () => {
    const h = harness();
    await expect(
      h.call('impfile_close_run', { impfnum: 'IM1', dryRun: false, approvalCode: 'abcd-1234' }),
    ).rejects.toThrow();
    // zod objects strip unknown keys: acceptPrompts never reaches the service.
    const world = openWorld();
    world.file.CLOSED = 'Y';
    serve(world);
    const r = await h.call('impfile_close_run', { impfnum: 'IM1', acceptPrompts: ['x'] });
    expect(r.status).toBe('already-done');
  });

  it('maps receipt → the receipt document and previews it', async () => {
    const world = openWorld();
    world.receipts.push({
      DOCNO: 'GR1',
      TYPE: 'P',
      STATDES: 'טיוטא',
      TOWARHSNAME: 'arov',
      TOLOCNAME: '0',
      IVNUM: 'GI1',
      UDATE: '2026-01-10T10:00:00Z',
      TRANSORDER_P_SUBFORM: [
        { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10 },
        { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 5 },
      ] as Row[],
    });
    world.stock = { P1: { 'arov/0': 0 }, P2: { 'arov/0': 0 } };
    serve(world);
    const r = await harness().call('bonded_receipt_finalize', { impfnum: 'IM1', receipt: 'GR1' });
    expect(r.status, JSON.stringify(r.reasons)).toBe('preview');
    expect(r.approvalCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});
