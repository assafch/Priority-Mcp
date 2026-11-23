import { type WebSdkProcStep, type WebSdkSession, withTimeout } from '../client/web-sdk.js';
import type { ActivationTrace } from './form-activation.js';
import { describeError } from './invoice-close.js';

/**
 * Run Priority's costing program "תמחיר לתאריך נוכחי" (FNCCOSTINGPART) once, through the Web
 * SDK's procStart. It is a menu program, not a form activation, and it runs on every part of the
 * company. Observed once in the screen (2026-11-23): one question "להמשיך בפעולה?", about a minute
 * of work, an end "with warnings".
 *
 * Rules, as for the form activations:
 *  - started once, never retried;
 *  - the one expected question is answered OK only when its text is exactly COSTING_CONFIRM;
 *    information messages are confirmed; any other question, input dialog or choice is cancelled
 *    unanswered and reported — nothing is ever filled in;
 *  - the caller decides from COSTINGLOG whether the program ran.
 */
export const COSTING_PROGRAM = 'FNCCOSTINGPART';
export const COSTING_CONFIRM = 'להמשיך בפעולה?';

const MAX_STEPS = 10;

const normalize = (text: unknown): string =>
  String(text ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();

async function safeCancel(
  proc: WebSdkProcStep['proc'] | undefined,
  timeoutMs: number,
): Promise<boolean> {
  if (!proc) return false;
  return withTimeout(
    Promise.resolve().then(() => proc.cancel()),
    timeoutMs,
    'proc.cancel',
  ).then(
    () => true,
    () => false,
  );
}

export async function runCostingProgram(
  session: WebSdkSession,
  opts: { stepTimeoutMs?: number; runTimeoutMs?: number; endTimeoutMs?: number } = {},
): Promise<ActivationTrace> {
  const stepTimeoutMs = opts.stepTimeoutMs ?? 30_000;
  // The step after the OK is the program's whole run (about a minute live).
  const runTimeoutMs = opts.runTimeoutMs ?? 240_000;
  const endTimeoutMs = opts.endTimeoutMs ?? 15_000;
  const trace: ActivationTrace = {
    dispatched: false,
    outcome: 'failed',
    steps: [],
    formMessages: [],
  };
  let current: WebSdkProcStep | undefined;
  let confirmed = false;
  try {
    await session.ensureLogin().catch((err) => {
      session.reset();
      throw err;
    });
    const start = session.sdk.procStart;
    if (!start) throw new Error('priority-web-sdk has no procStart.');
    trace.dispatched = true; // from here Priority may run the program
    const started = start(COSTING_PROGRAM, 'P', () => {}, session.company);
    current = await withTimeout(started, stepTimeoutMs, `procStart(${COSTING_PROGRAM})`).catch(
      (err) => {
        started.then((late) => safeCancel(late?.proc, endTimeoutMs)).catch(() => undefined);
        throw err;
      },
    );
    for (let i = 0; i < MAX_STEPS && current && current.type !== 'end'; i++) {
      const step: WebSdkProcStep = current;
      const entry = {
        type: step.type,
        messagetype: step.messagetype,
        message: step.message,
        action: '',
      };
      trace.steps.push(entry);
      const kind = String(step.messagetype ?? '').toLowerCase();
      const isConfirm = !confirmed && normalize(step.message) === COSTING_CONFIRM;
      if (step.type === 'message' && step.proc && (isConfirm || kind === 'information')) {
        if (isConfirm) confirmed = true;
        entry.action = isConfirm ? 'message(1) — the expected question' : 'message(1)';
        current = await withTimeout(
          step.proc.message(1),
          isConfirm ? runTimeoutMs : stepTimeoutMs,
          'proc.message',
        );
        continue;
      }
      entry.action = `cancel (unexpected ${step.type === 'message' ? kind || 'message' : `step ${step.type}`})`;
      trace.cancelConfirmed = await safeCancel(step.proc, endTimeoutMs);
      trace.outcome = 'cancelled';
      throw new Error(
        step.type === 'message'
          ? `unexpected ${kind || 'message'} from Priority: ${step.message ?? ''}`.trim()
          : `unexpected procedure step: ${step.type}`,
      );
    }
    if (!current || current.type !== 'end') {
      trace.cancelConfirmed = await safeCancel(current?.proc, endTimeoutMs);
      trace.outcome = 'cancelled';
      throw new Error(`procedure did not finish within ${MAX_STEPS} steps`);
    }
    trace.steps.push({
      type: 'end',
      messagetype: current.messagetype,
      message: current.message,
      action: 'done',
    });
    const endKind = String(current.messagetype ?? '').toLowerCase();
    trace.outcome = endKind && endKind !== 'information' ? 'end-with-message' : 'end';
    if (trace.outcome === 'end-with-message') {
      trace.error = `end step carried a ${endKind}: ${current.message ?? ''}`.trim();
    }
    return trace;
  } catch (err) {
    trace.error = describeError(err);
    // Once the question was answered the program is running: a cancel then could stop it half
    // way, so a timeout after the OK leaves it alone (the caller reports unverified).
    if (trace.dispatched && !confirmed && current?.proc && /timed out/.test(trace.error)) {
      await safeCancel(current.proc, endTimeoutMs);
    }
    return trace;
  }
}
