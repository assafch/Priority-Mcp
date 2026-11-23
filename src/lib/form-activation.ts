import {
  type WebSdkForm,
  type WebSdkProcStep,
  type WebSdkRow,
  type WebSdkServerMessage,
  type WebSdkSession,
  withTimeout,
} from '../client/web-sdk.js';
import { describeError, normalizeFormMessage } from './invoice-close.js';

/**
 * Run ONE direct activation (a program attached to a form: "הפעלות ישירות") on ONE located row,
 * through the Priority Web SDK. Generalised from the invoice-close runner (runCloseActivation) and
 * bound by the same rules:
 *
 *  - nothing is dispatched unless the activation is listed for this user, runs in the foreground,
 *    the filter returns exactly one row, and the caller's checkRow accepts that row;
 *  - once dispatched it is never repeated, whatever happens next;
 *  - an information message is confirmed; a warning is answered OK only when its exact text was
 *    listed by the caller; every other step (input dialog, choice list, unlisted message) is
 *    cancelled and reported — the runner never invents an answer;
 *  - the form is always closed.
 *
 * The runner does not decide whether the program did its job: the caller re-reads over OData.
 */
export interface ActivationSpec {
  /** Form the activation belongs to, e.g. 'IMPFILES'. */
  form: string;
  /** Internal name of the program (type 'P'), e.g. 'IMPFILE2'. */
  activation: string;
  /** Locates exactly one row of the form. */
  filter: { field: string; value: string };
  /** Mismatch reason, or null when the SDK row is the row the caller approved. */
  checkRow: (row: Record<string, unknown>) => string | null;
  /** Exact warning texts that may be answered OK; default none. */
  acceptPrompts?: string[];
}

export interface ActivationTrace {
  /** True once activateStart was called: from then on Priority may have changed data. */
  dispatched: boolean;
  outcome: 'end' | 'end-with-message' | 'cancelled' | 'failed';
  activation?: { background?: number; confirm?: number };
  steps: Array<{ type?: string; messagetype?: string; message?: string; action: string }>;
  formMessages: Array<{ type?: string; message?: string }>;
  /**
   * Set when a step was cancelled: true = Priority answered the cancel; false = the cancel got no
   * answer, so the program may still be running or waiting at its prompt.
   */
  cancelConfirmed?: boolean;
  error?: string;
}

export interface ActivationProbe {
  /** The activation's metadata, 'MISSING', or a note that the SDK exposes no list. */
  activation: unknown;
  rowFound: boolean;
  /** Rows the filter returned (1 is the only acceptable number). */
  rowCount: number;
  sdkRow?: Record<string, unknown>;
  mismatch?: string | null;
  formMessages: Array<{ type?: string; message?: string }>;
}

const MAX_PROCEDURE_STEPS = 10;

interface OpenedForm {
  form: WebSdkForm;
  messages: Array<{ type?: string; message?: string }>;
  failure: () => Error | undefined;
}

function numericRows(bag: Record<string, WebSdkRow> | undefined): Array<[number, WebSdkRow]> {
  return Object.entries(bag ?? {})
    .filter(([k]) => /^\d+$/.test(k))
    .map(([k, v]) => [Number(k), v] as [number, WebSdkRow]);
}

async function openForm(
  session: WebSdkSession,
  formName: string,
  stepTimeoutMs: number,
): Promise<OpenedForm> {
  const messages: Array<{ type?: string; message?: string }> = [];
  let failure: Error | undefined;
  let opened: WebSdkForm | undefined;
  const onMessage = (...args: unknown[]) => {
    const { form, message: m } = normalizeFormMessage(args, opened);
    const msg: WebSdkServerMessage = m ?? {};
    messages.push({ type: msg.type, message: msg.message });
    if (msg.type === 'information') {
      // An unacknowledged message blocks the form's request queue.
      form?.infoMsgConfirm?.();
      return;
    }
    failure = new Error(`form message: ${msg.type ?? 'unknown'} ${msg.message ?? ''}`.trim());
    if (msg.type === 'warning') form?.warningConfirm?.(0); // decline: never auto-accept
  };
  try {
    await session.ensureLogin();
    opened = await withTimeout(
      session.sdk.formStart(formName, onMessage, null, { company: session.company }, 0),
      stepTimeoutMs,
      `formStart(${formName})`,
    );
  } catch (err) {
    // A dead or expired SDK session shows up here; make the next attempt log in again.
    session.reset();
    throw err instanceof Error ? err : new Error(describeError(err));
  }
  return { form: opened, messages, failure: () => failure };
}

async function findRows(
  opened: OpenedForm,
  spec: ActivationSpec,
  stepTimeoutMs: number,
): Promise<Array<[number, WebSdkRow]>> {
  const { form, failure } = opened;
  await withTimeout(
    form.setSearchFilter({
      or: 0,
      ignorecase: 0,
      QueryValues: [{ field: spec.filter.field, fromval: spec.filter.value, op: '=' }],
    }),
    stepTimeoutMs,
    'setSearchFilter',
  );
  if (failure()) throw failure();
  const res = await withTimeout(form.getRows(1), stepTimeoutMs, 'getRows');
  if (failure()) throw failure();
  return numericRows(res?.[spec.form]);
}

async function closeForm(
  form: WebSdkForm | undefined,
  endTimeoutMs: number,
  session: WebSdkSession,
): Promise<void> {
  if (!form) return;
  try {
    await withTimeout(form.endCurrentForm(), endTimeoutMs, 'endCurrentForm');
  } catch {
    // A form that cannot be closed leaves a stuck request queue: log in afresh next time.
    session.reset();
  }
}

/** Cancel a procedure step without waiting on it forever. Resolves to whether it was confirmed. */
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

function acceptsPrompt(step: WebSdkProcStep, acceptPrompts: string[]): boolean {
  if (String(step.messagetype ?? '').toLowerCase() !== 'warning') return false;
  const text = String(step.message ?? '').trim();
  return text.length > 0 && acceptPrompts.some((p) => p.trim() === text);
}

/** Read-only: log in, open the form, find the row. No setActiveRow, no activation. */
export async function probeActivation(
  session: WebSdkSession,
  spec: ActivationSpec,
  deps: { stepTimeoutMs?: number; endTimeoutMs?: number } = {},
): Promise<ActivationProbe> {
  const stepTimeoutMs = deps.stepTimeoutMs ?? 30_000;
  let opened: OpenedForm | undefined;
  try {
    opened = await openForm(session, spec.form, stepTimeoutMs);
    const listed = opened.form.activations;
    const activation =
      listed?.[`${spec.activation}.P`] ?? (listed ? 'MISSING' : 'metadata not exposed by SDK');
    const rows = await findRows(opened, spec, stepTimeoutMs);
    const probe: ActivationProbe = {
      activation,
      rowFound: rows.length === 1,
      rowCount: rows.length,
      formMessages: opened.messages,
    };
    if (rows.length === 1) {
      probe.sdkRow = rows[0][1];
      probe.mismatch = spec.checkRow(rows[0][1]);
    }
    return probe;
  } finally {
    await closeForm(opened?.form, deps.endTimeoutMs ?? 10_000, session);
  }
}

/** Run the activation once. Never retries; the caller verifies the effect over OData. */
export async function runActivation(
  session: WebSdkSession,
  spec: ActivationSpec,
  deps: { stepTimeoutMs?: number; endTimeoutMs?: number } = {},
): Promise<ActivationTrace> {
  const stepTimeoutMs = deps.stepTimeoutMs ?? 30_000;
  const endTimeoutMs = deps.endTimeoutMs ?? 15_000;
  const key = `${spec.activation}.P`;
  const acceptPrompts = spec.acceptPrompts ?? [];
  const trace: ActivationTrace = {
    dispatched: false,
    outcome: 'failed',
    steps: [],
    formMessages: [],
  };
  let opened: OpenedForm | undefined;
  let current: WebSdkProcStep | undefined;
  try {
    opened = await openForm(session, spec.form, stepTimeoutMs);
    trace.formMessages = opened.messages;
    const { form, failure } = opened;
    if (failure()) throw failure();
    const activation = form.activations?.[key];
    if (!activation) {
      throw new Error(
        `${key} is not an activation of ${spec.form} for this user (activations ${form.activations ? 'listed' : 'not exposed'})`,
      );
    }
    if (activation.background !== 0) {
      throw new Error(`unexpected activation metadata for ${key}: ${JSON.stringify(activation)}`);
    }
    trace.activation = activation;
    const rows = await findRows(opened, spec, stepTimeoutMs);
    if (rows.length !== 1) {
      throw new Error(
        `SDK returned ${rows.length} rows for ${spec.filter.field} = ${spec.filter.value} in ${spec.form}`,
      );
    }
    const [index, row] = rows[0];
    const mismatch = spec.checkRow(row);
    if (mismatch) throw new Error(`SDK row is not the approved row: ${mismatch}`);
    await withTimeout(form.setActiveRow(index), stepTimeoutMs, 'setActiveRow');
    if (failure()) throw failure();

    trace.dispatched = true; // from here Priority may have changed data
    const started = form.activateStart(spec.activation, 'P', () => {});
    current = await withTimeout(started, stepTimeoutMs, 'activateStart').catch((err) => {
      // If the step arrives after we stopped waiting, cancel it instead of leaving it at a prompt.
      started.then((late) => safeCancel(late?.proc, endTimeoutMs)).catch(() => undefined);
      throw err;
    });
    for (let i = 0; i < MAX_PROCEDURE_STEPS && current && current.type !== 'end'; i++) {
      const step: WebSdkProcStep = current;
      const entry = {
        type: step.type,
        messagetype: step.messagetype,
        message: step.message,
        action: '',
      };
      trace.steps.push(entry);
      if (failure()) {
        entry.action = 'cancel (form message)';
        trace.cancelConfirmed = await safeCancel(step.proc, endTimeoutMs);
        trace.outcome = 'cancelled';
        throw failure();
      }
      if (step.type === 'message' && step.proc) {
        const kind = String(step.messagetype ?? '').toLowerCase();
        if (kind === 'information' || acceptsPrompt(step, acceptPrompts)) {
          entry.action =
            kind === 'information' ? 'message(1)' : 'message(1) — prompt accepted by caller list';
          current = await withTimeout(step.proc.message(1), stepTimeoutMs, 'proc.message');
          continue;
        }
        entry.action = 'cancel (unexpected message)';
        trace.cancelConfirmed = await safeCancel(step.proc, endTimeoutMs);
        trace.outcome = 'cancelled';
        throw new Error(
          `unexpected ${kind || 'message'} from Priority: ${step.message ?? ''}`.trim(),
        );
      }
      entry.action = `cancel (unexpected step ${step.type})`;
      trace.cancelConfirmed = await safeCancel(step.proc, endTimeoutMs);
      trace.outcome = 'cancelled';
      throw new Error(`unexpected procedure step: ${step.type}`);
    }
    if (!current || current.type !== 'end') {
      trace.cancelConfirmed = await safeCancel(current?.proc, endTimeoutMs);
      trace.outcome = 'cancelled';
      throw new Error(`procedure did not finish within ${MAX_PROCEDURE_STEPS} steps`);
    }
    const endKind = String(current.messagetype ?? '').toLowerCase();
    trace.steps.push({
      type: 'end',
      messagetype: current.messagetype,
      message: current.message,
      action: 'done',
    });
    trace.outcome = endKind && endKind !== 'information' ? 'end-with-message' : 'end';
    if (trace.outcome === 'end-with-message') {
      trace.error = `end step carried a ${endKind}: ${current.message ?? ''}`.trim();
    }
    // activateEnd can hang after 'end'; the caller's OData read-back is what decides.
    await withTimeout(form.activateEnd(), endTimeoutMs, 'activateEnd').catch(() => undefined);
    const late = failure();
    if (late) trace.error = `form message after the procedure ended: ${late.message}`;
    return trace;
  } catch (err) {
    trace.error = describeError(err);
    // A timed-out step leaves the procedure running server-side; cancelling is best effort only.
    if (trace.dispatched && current?.proc && /timed out/.test(trace.error)) {
      await safeCancel(current.proc, endTimeoutMs);
    }
    return trace;
  } finally {
    await closeForm(opened?.form, deps.endTimeoutMs ?? 10_000, session);
  }
}
