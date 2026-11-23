import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STEP_LEDGER_PATH,
  STEP_COOLDOWN_MS,
  claimStep,
  cooldownReason,
  lastDoneTime,
  lastRecord,
  recordStep,
  recordsAfter,
} from '../src/lib/step-ledger.js';

/**
 * The step ledger is an append-only file of every attempt to run an import step. It is how a
 * second call learns that a program was dispatched moments ago and its result is not visible yet.
 */
const ledger = () => join(mkdtempSync(join(tmpdir(), 'step-ledger-')), 'steps.jsonl');

describe('step ledger', () => {
  it('lives under output/ by default', () => {
    expect(DEFAULT_STEP_LEDGER_PATH).toMatch(/output\/import-step-attempts\.jsonl$/);
  });

  it('appends one JSON line per record, with a numeric time', () => {
    const path = ledger();
    recordStep(path, { impfnum: 'IM1', step: 'calc', phase: 'in_flight' });
    recordStep(path, { impfnum: 'IM1', step: 'calc', phase: 'done', detail: { lines: 2 } });
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first).toMatchObject({ impfnum: 'IM1', step: 'calc', phase: 'in_flight' });
    expect(typeof first.t).toBe('number');
    expect(JSON.parse(lines[1]).detail).toEqual({ lines: 2 });
  });

  it('returns the newest record of the same file and step', () => {
    const path = ledger();
    expect(lastRecord(path, 'IM1', 'receipt')).toBeNull();
    recordStep(path, { impfnum: 'IM1', step: 'receipt', phase: 'in_flight' });
    recordStep(path, { impfnum: 'IM2', step: 'receipt', phase: 'done', docno: 'GR2' });
    recordStep(path, { impfnum: 'IM1', step: 'calc', phase: 'done' });
    recordStep(path, { impfnum: 'IM1', step: 'receipt', phase: 'incomplete', docno: 'GR1' });
    expect(lastRecord(path, 'IM1', 'receipt')).toMatchObject({ phase: 'incomplete', docno: 'GR1' });
    expect(lastRecord(path, 'IM2', 'receipt')).toMatchObject({ phase: 'done', docno: 'GR2' });
  });

  it('skips a damaged line instead of failing', () => {
    const path = ledger();
    recordStep(path, { impfnum: 'IM1', step: 'calc', phase: 'done' });
    writeFileSync(path, `${readFileSync(path, 'utf8')}not json\n`);
    expect(lastRecord(path, 'IM1', 'calc')).toMatchObject({ phase: 'done' });
  });

  it.each(['in_flight', 'unverified'] as const)('cools down after a %s record', (phase) => {
    const path = ledger();
    recordStep(path, { impfnum: 'IM1', step: 'calc', phase });
    const t = lastRecord(path, 'IM1', 'calc')?.t ?? 0;
    expect(cooldownReason(path, 'IM1', 'calc', t + 1_000)).toMatch(/calc/);
    expect(cooldownReason(path, 'IM1', 'calc', t + STEP_COOLDOWN_MS - 1)).not.toBeNull();
    expect(cooldownReason(path, 'IM1', 'calc', t + STEP_COOLDOWN_MS + 1)).toBeNull();
    expect(cooldownReason(path, 'IM2', 'calc', t + 1_000)).toBeNull();
    expect(cooldownReason(path, 'IM1', 'receipt', t + 1_000)).toBeNull();
  });

  it.each(['done', 'failed', 'incomplete'] as const)('does not cool down after %s', (phase) => {
    const path = ledger();
    recordStep(path, { impfnum: 'IM1', step: 'calc', phase: 'in_flight' });
    recordStep(path, { impfnum: 'IM1', step: 'calc', phase });
    const t = lastRecord(path, 'IM1', 'calc')?.t ?? 0;
    expect(cooldownReason(path, 'IM1', 'calc', t + 1_000)).toBeNull();
  });

  it('lets only one caller hold the claim for a step of a file', () => {
    const path = ledger();
    const first = claimStep(path, 'IM1', 'receipt');
    expect(first.ok).toBe(true);
    const second = claimStep(path, 'IM1', 'receipt');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toMatch(/receipt.*IM1/);
    expect(claimStep(path, 'IM1', 'calc').ok).toBe(true); // another step
    expect(claimStep(path, 'IM2', 'receipt').ok).toBe(true); // another file
    if (first.ok) first.release();
    expect(claimStep(path, 'IM1', 'receipt').ok).toBe(true);
  });

  it('takes over a claim left by a caller that died', () => {
    const path = ledger();
    const t0 = 1_000_000;
    expect(claimStep(path, 'IM1', 'receipt', t0).ok).toBe(true);
    expect(claimStep(path, 'IM1', 'receipt', t0 + STEP_COOLDOWN_MS - 1).ok).toBe(false);
    expect(claimStep(path, 'IM1', 'receipt', t0 + STEP_COOLDOWN_MS + 1).ok).toBe(true);
  });

  it('throws when the ledger cannot be written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'step-ledger-'));
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    // A path below a regular file can never be created.
    expect(() =>
      recordStep(join(file, 'steps.jsonl'), { impfnum: 'IM1', step: 'calc', phase: 'in_flight' }),
    ).toThrow();
  });
});

describe('step ledger: phase C helpers', () => {
  const ledger = () => join(mkdtempSync(join(tmpdir(), 'ledger-')), 'steps.jsonl');

  it('recordsAfter lists only the later records of that file', () => {
    const path = ledger();
    writeFileSync(
      path,
      [
        { t: 100, impfnum: 'IM1', step: 'calc', phase: 'done' },
        { t: 200, impfnum: 'IM2', step: 'fillDetail', phase: 'done' },
        'not json',
        { t: 300, impfnum: 'IM1', step: 'fillDetail', phase: 'done' },
      ]
        .map((r) => (typeof r === 'string' ? r : JSON.stringify(r)))
        .join('\n'),
    );
    expect(recordsAfter(path, 'IM1', 100)).toEqual([{ t: 300, step: 'fillDetail', phase: 'done' }]);
    expect(lastDoneTime(path, 'IM1', 'calc')).toBe(100);
    expect(lastDoneTime(path, 'IM1', 'close')).toBeNull();
  });

  it('a longer window keeps a claim and a cooldown alive past the default', () => {
    const path = ledger();
    const t0 = 1_000_000;
    const first = claimStep(path, 'COMPANY', 'costing', t0, 600_000);
    expect(first.ok).toBe(true);
    const late = t0 + STEP_COOLDOWN_MS + 60_000;
    expect(claimStep(path, 'COMPANY', 'costing', late, 600_000).ok).toBe(false);
    recordStep(path, { impfnum: 'COMPANY', step: 'costing', phase: 'in_flight' });
    const t = Date.now();
    expect(cooldownReason(path, 'COMPANY', 'costing', t + STEP_COOLDOWN_MS + 1)).toBeNull();
    expect(cooldownReason(path, 'COMPANY', 'costing', t + STEP_COOLDOWN_MS + 1, 600_000)).toContain(
      'costing',
    );
  });
});
