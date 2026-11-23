import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportStep } from './import-step-gates.js';
import { appendLedger } from './invoice-close.js';

/**
 * Append-only record of every attempt to run an executing import step: intent before the write
 * or the program, result after. It answers one question for the next call: was this step
 * dispatched moments ago with a result that is not visible yet? If so the next call waits
 * instead of dispatching a second time.
 *
 * Whether a step is DONE is always decided from Priority, never from this file.
 */
export const DEFAULT_STEP_LEDGER_PATH = fileURLToPath(
  new URL('../../output/import-step-attempts.jsonl', import.meta.url),
);

/** After a dispatch whose result is not confirmed, the same step of the same file waits this long. */
export const STEP_COOLDOWN_MS = 180_000;

export type StepPhase =
  /** written just before a write or a program is dispatched */
  | 'in_flight'
  /** read back from Priority and confirmed */
  | 'done'
  /** dispatched; Priority does not show the result (yet) */
  | 'unverified'
  /** nothing was dispatched, or the program was cancelled at a prompt */
  | 'failed'
  /** a document was created but not completed; the next call continues it */
  | 'incomplete';

/**
 * A ledger step: one of the official steps, or 'fileChange' — a header, invoice-link or allocation
 * write by the impfile_* tools, recorded so the close sees that the loading calc is stale.
 */
export type LedgerStep = ImportStep | 'fileChange';

export interface StepRecord {
  impfnum: string;
  step: LedgerStep;
  phase: StepPhase;
  docno?: string;
  detail?: unknown;
}

/** Phases after which a second dispatch has to wait. */
const COOLING: ReadonlySet<string> = new Set(['in_flight', 'unverified']);

/** Append one record. Throws when the ledger cannot be written. */
export function recordStep(path: string, record: StepRecord): void {
  appendLedger(path, { t: Date.now(), at: new Date().toISOString(), ...record });
}

/** The newest record of this file and step, or null. A damaged line is skipped. */
export function lastRecord(
  path: string,
  impfnum: string,
  step: ImportStep,
): { t: number; phase: string; docno?: string } | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as Partial<StepRecord> & { t?: unknown };
      if (rec.impfnum !== impfnum || rec.step !== step) continue;
      if (typeof rec.t !== 'number' || typeof rec.phase !== 'string') continue;
      return { t: rec.t, phase: rec.phase, ...(rec.docno ? { docno: rec.docno } : {}) };
    } catch {
      // a line cut short by a crash; older records still count
    }
  }
  return null;
}

/** Time (ms) of the newest confirmed run of this step on this file, or null. */
export function lastDoneTime(path: string, impfnum: string, step: ImportStep): number | null {
  const at = lastDoneAt(path, impfnum, step);
  return at ? Date.parse(at) : null;
}

/** Every record of this file written after `afterT` (ms), oldest first. A damaged line is skipped. */
export function recordsAfter(
  path: string,
  impfnum: string,
  afterT: number,
): Array<{ t: number; step: string; phase: string }> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const found: Array<{ t: number; step: string; phase: string }> = [];
  for (const line of text.split('\n')) {
    try {
      const rec = JSON.parse(line) as Partial<StepRecord> & { t?: unknown };
      if (rec.impfnum !== impfnum || typeof rec.t !== 'number' || rec.t <= afterT) continue;
      if (typeof rec.step !== 'string' || typeof rec.phase !== 'string') continue;
      found.push({ t: rec.t, step: rec.step, phase: rec.phase });
    } catch {
      // blank or damaged line
    }
  }
  return found;
}

/** Time (ISO) of the newest confirmed run of this step on this file, or null. */
export function lastDoneAt(path: string, impfnum: string, step: ImportStep): string | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const rec = JSON.parse(lines[i]) as Partial<StepRecord> & { t?: unknown };
      if (rec.impfnum === impfnum && rec.step === step && rec.phase === 'done') {
        return typeof rec.t === 'number' ? new Date(rec.t).toISOString() : null;
      }
    } catch {
      // blank or damaged line
    }
  }
  return null;
}

/** Why this step must not be dispatched right now, or null. */
export function cooldownReason(
  path: string,
  impfnum: string,
  step: ImportStep,
  now: number = Date.now(),
  windowMs: number = STEP_COOLDOWN_MS,
): string | null {
  const last = lastRecord(path, impfnum, step);
  if (!last || !COOLING.has(last.phase)) return null;
  const until = last.t + windowMs;
  if (now >= until) return null;
  return `הצעד ${step} בתיק ${impfnum} נשלח ב-${new Date(last.t).toISOString()} והתוצאה שלו עדיין לא אומתה (${last.phase}). לא שולחים שוב לפני ${new Date(until).toISOString()}; קוראים את התיק מחדש ובודקים מה נרשם.`;
}

/**
 * An exclusive claim on one step of one file, held while that step's non-repeatable write is in
 * progress. The ledger check alone is safe inside one process (nothing awaits between the check
 * and the record) but not between processes on the same machine: two could both read "nothing
 * sent" and both append. Creating the claim file with O_EXCL is atomic, so only one proceeds.
 *
 * A claim older than the window (default: the cooldown) belongs to a caller that died and is taken
 * over. A step whose run can last longer than the cooldown passes a longer window. Servers on
 * different machines do not share this file; between them only the re-read of what already
 * exists in Priority, right before the write, protects.
 */
export type StepClaim = { ok: true; release: () => void } | { ok: false; reason: string };

export function claimStep(
  ledgerPath: string,
  impfnum: string,
  step: ImportStep,
  now: number = Date.now(),
  windowMs: number = STEP_COOLDOWN_MS,
): StepClaim {
  const dir = join(dirname(ledgerPath), 'import-step-claims');
  const file = join(dir, `${impfnum.replace(/[^A-Za-z0-9_-]/g, '_')}.${step}.claim`);
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify({ t: now, pid: process.pid }));
      } finally {
        closeSync(fd);
      }
      return { ok: true, release: () => rmSync(file, { force: true }) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err;
    }
    let heldSince: number | undefined;
    try {
      heldSince = (JSON.parse(readFileSync(file, 'utf8')) as { t?: number }).t;
    } catch {
      heldSince = undefined; // unreadable or just removed: treat as stale and try once more
    }
    if (typeof heldSince === 'number' && now - heldSince < windowMs) {
      return {
        ok: false,
        reason: `הצעד ${step} בתיק ${impfnum} מבוצע כרגע על ידי קריאה אחרת (מאז ${new Date(heldSince).toISOString()}). לא שולחים במקביל; קוראים את התיק מחדש בעוד כמה דקות.`,
      };
    }
    rmSync(file, { force: true });
  }
  return { ok: false, reason: `לא ניתן היה לתפוס את הצעד ${step} בתיק ${impfnum}.` };
}
