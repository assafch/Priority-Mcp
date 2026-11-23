import { describe, expect, it } from 'vitest';
import { type ActivationSpec, probeActivation, runActivation } from '../src/lib/form-activation.js';
import { fakeSdk } from './fake-web-sdk.js';

/**
 * The generic activation runner starts ONE direct activation of a Priority form on ONE located
 * row, through the Web SDK. It never retries, and anything it does not expect — an input dialog,
 * an unlisted warning, a second matching row — stops the run and is reported. Driven here against
 * a scripted fake SDK; nothing touches a Priority server.
 */
const ACTIVATIONS = { 'IMPFILE2.P': { background: 0, confirm: 0 } };
const ROW = { IMPFNUM: 'IM1', CLOSED: '' };

const spec = (over: Partial<ActivationSpec> = {}): ActivationSpec => ({
  form: 'IMPFILES',
  activation: 'IMPFILE2',
  filter: { field: 'IMPFNUM', value: 'IM1' },
  checkRow: (row) => (row.IMPFNUM === 'IM1' ? null : `IMPFNUM ${String(row.IMPFNUM)}`),
  ...over,
});
const FAST = { stepTimeoutMs: 40, endTimeoutMs: 20 };

describe('probeActivation', () => {
  it('returns the activation metadata and the row, and never activates', async () => {
    const fake = fakeSdk({ rows: { '1': ROW }, activations: ACTIVATIONS });
    const probe = await probeActivation(fake.session, spec(), FAST);
    expect(probe.activation).toEqual({ background: 0, confirm: 0 });
    expect(probe.rowFound).toBe(true);
    expect(probe.sdkRow).toEqual(ROW);
    expect(probe.mismatch).toBeNull();
    expect(fake.count('activateStart')).toBe(0);
    expect(fake.count('setActiveRow')).toBe(0);
    expect(fake.calls.at(-1)).toBe('endCurrentForm');
  });

  it('reports a missing activation and a row that is not the approved one', async () => {
    const fake = fakeSdk({ rows: { '1': { IMPFNUM: 'IM9' } }, activations: {} });
    const probe = await probeActivation(fake.session, spec(), FAST);
    expect(probe.activation).toBe('MISSING');
    expect(probe.rowFound).toBe(true);
    expect(probe.mismatch).toBe('IMPFNUM IM9');
  });

  it('reports rowFound false when the filter returns no row', async () => {
    const fake = fakeSdk({ rows: {}, activations: ACTIVATIONS });
    const probe = await probeActivation(fake.session, spec(), FAST);
    expect(probe.rowFound).toBe(false);
    expect(probe.sdkRow).toBeUndefined();
  });
});

describe('runActivation', () => {
  it('confirms an information message and ends: dispatched once', async () => {
    const fake = fakeSdk({
      rows: { '1': ROW },
      activations: ACTIVATIONS,
      steps: [{ type: 'message', messagetype: 'information', message: 'בוצע' }, { type: 'end' }],
    });
    const trace = await runActivation(fake.session, spec(), FAST);
    expect(trace).toMatchObject({ dispatched: true, outcome: 'end' });
    expect(trace.error).toBeUndefined();
    expect(fake.calls.filter((c) => c.startsWith('activateStart'))).toEqual([
      'activateStart(IMPFILE2,P)',
    ]);
    expect(fake.calls).toContain('formStart(IMPFILES,0)');
    expect(fake.calls).toContain('setSearchFilter([{"field":"IMPFNUM","fromval":"IM1","op":"="}])');
    expect(fake.calls).toContain('setActiveRow(1)');
    expect(fake.calls).toContain('message(1)');
    expect(trace.steps.map((s) => s.action)).toEqual(['message(1)', 'done']);
    expect(fake.calls.at(-1)).toBe('endCurrentForm');
  });

  it('fails before dispatch when the activation is not on the form', async () => {
    const fake = fakeSdk({
      rows: { '1': ROW },
      activations: { 'OTHER.P': ACTIVATIONS['IMPFILE2.P'] },
    });
    const trace = await runActivation(fake.session, spec(), FAST);
    expect(trace).toMatchObject({ dispatched: false, outcome: 'failed' });
    expect(trace.error).toMatch(/IMPFILE2\.P/);
    expect(fake.count('activateStart')).toBe(0);
    expect(fake.calls.at(-1)).toBe('endCurrentForm');
  });

  it('fails before dispatch when the activation runs in the background', async () => {
    const fake = fakeSdk({
      rows: { '1': ROW },
      activations: { 'IMPFILE2.P': { background: 1, confirm: 0 } },
    });
    const trace = await runActivation(fake.session, spec(), FAST);
    expect(trace).toMatchObject({ dispatched: false, outcome: 'failed' });
    expect(fake.count('activateStart')).toBe(0);
  });

  it.each([
    ['no row', {}, /0 rows/],
    ['two rows', { '1': ROW, '2': ROW }, /2 rows/],
    ['a row that is not the approved one', { '1': { IMPFNUM: 'IM9' } }, /IMPFNUM IM9/],
  ])('fails before dispatch on %s', async (_name, rows, reason) => {
    const fake = fakeSdk({ rows, activations: ACTIVATIONS });
    const trace = await runActivation(fake.session, spec(), FAST);
    expect(trace).toMatchObject({ dispatched: false, outcome: 'failed' });
    expect(trace.error).toMatch(reason);
    expect(fake.count('activateStart')).toBe(0);
    expect(fake.count('setActiveRow')).toBe(0);
    expect(fake.calls.at(-1)).toBe('endCurrentForm');
  });

  it('cancels an input dialog instead of answering it', async () => {
    const fake = fakeSdk({
      rows: { '1': ROW },
      activations: ACTIVATIONS,
      steps: [{ type: 'inputFields' }, { type: 'end' }],
    });
    const trace = await runActivation(fake.session, spec(), FAST);
    expect(trace).toMatchObject({ dispatched: true, outcome: 'cancelled' });
    expect(fake.proc.cancel).toHaveBeenCalledTimes(1);
    expect(fake.proc.message).not.toHaveBeenCalled();
    expect(trace.steps[0]).toMatchObject({
      type: 'inputFields',
      action: 'cancel (unexpected step inputFields)',
    });
    expect(fake.calls.at(-1)).toBe('endCurrentForm');
  });

  it('says whether the cancel was confirmed by Priority', async () => {
    const steps = [{ type: 'inputFields' }, { type: 'end' }];
    const confirmed = fakeSdk({ rows: { '1': ROW }, activations: ACTIVATIONS, steps });
    expect((await runActivation(confirmed.session, spec(), FAST)).cancelConfirmed).toBe(true);
    const hung = fakeSdk({ rows: { '1': ROW }, activations: ACTIVATIONS, steps, hangCancel: true });
    const trace = await runActivation(hung.session, spec(), FAST);
    expect(trace).toMatchObject({ outcome: 'cancelled', cancelConfirmed: false });
  });

  it('cancels a warning that the caller did not list', async () => {
    const fake = fakeSdk({
      rows: { '1': ROW },
      activations: ACTIVATIONS,
      steps: [{ type: 'message', messagetype: 'warning', message: 'להמשיך?' }, { type: 'end' }],
    });
    const trace = await runActivation(fake.session, spec(), FAST);
    expect(trace).toMatchObject({ dispatched: true, outcome: 'cancelled' });
    expect(trace.error).toMatch(/להמשיך\?/);
    expect(fake.proc.cancel).toHaveBeenCalledTimes(1);
    expect(fake.proc.message).not.toHaveBeenCalled();
  });

  it('answers OK to a warning whose exact text the caller listed', async () => {
    const fake = fakeSdk({
      rows: { '1': ROW },
      activations: ACTIVATIONS,
      steps: [{ type: 'message', messagetype: 'warning', message: 'להמשיך?' }, { type: 'end' }],
    });
    const trace = await runActivation(fake.session, spec({ acceptPrompts: ['להמשיך?'] }), FAST);
    expect(trace).toMatchObject({ dispatched: true, outcome: 'end' });
    expect(fake.proc.cancel).not.toHaveBeenCalled();
    expect(fake.calls).toContain('message(1)');
  });

  it('reports an end step that carries an error as end-with-message', async () => {
    const fake = fakeSdk({
      rows: { '1': ROW },
      activations: ACTIVATIONS,
      steps: [{ type: 'end', messagetype: 'error', message: 'אין שורות' }],
    });
    const trace = await runActivation(fake.session, spec(), FAST);
    expect(trace).toMatchObject({ dispatched: true, outcome: 'end-with-message' });
    expect(trace.error).toMatch(/אין שורות/);
  });

  it('reports a timeout after dispatch and never dispatches twice', async () => {
    const fake = fakeSdk({ rows: { '1': ROW }, activations: ACTIVATIONS, hangActivate: true });
    const trace = await runActivation(fake.session, spec(), FAST);
    expect(trace.dispatched).toBe(true);
    expect(trace.outcome).toBe('failed');
    expect(trace.error).toMatch(/timed out/);
    expect(fake.count('activateStart')).toBe(1);
    expect(fake.calls.at(-1)).toBe('endCurrentForm');
  });

  it('declines a warning shown while the form opens and dispatches nothing', async () => {
    const fake = fakeSdk({
      rows: { '1': ROW },
      activations: ACTIVATIONS,
      openMessages: [{ type: 'warning', message: 'רשומה נעולה' }],
    });
    const trace = await runActivation(fake.session, spec(), FAST);
    expect(trace).toMatchObject({ dispatched: false, outcome: 'failed' });
    expect(trace.error).toMatch(/רשומה נעולה/);
    expect(fake.calls).toContain('warningConfirm(0)');
    expect(fake.count('activateStart')).toBe(0);
    expect(fake.calls.at(-1)).toBe('endCurrentForm');
  });

  it('confirms an information message shown while the form opens and carries on', async () => {
    const fake = fakeSdk({
      rows: { '1': ROW },
      activations: ACTIVATIONS,
      openMessages: [{ type: 'information', message: 'שלום' }],
    });
    const trace = await runActivation(fake.session, spec(), FAST);
    expect(trace).toMatchObject({ dispatched: true, outcome: 'end' });
    expect(fake.calls).toContain('infoMsgConfirm');
    expect(trace.formMessages).toEqual([{ type: 'information', message: 'שלום' }]);
  });
});
