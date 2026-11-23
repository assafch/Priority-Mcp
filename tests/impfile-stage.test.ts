import { describe, expect, it } from 'vitest';
import { type StageInput, computeStage } from '../src/lib/impfile-stage.js';

const ready: StageInput = {
  snapshot: {
    header: { IMPFNUM: 'IM1', CLOSED: null, STATDES: 'טיוטא' },
    invoices: [{ IVNUM: 'GI1' }, { IVNUM: 'GI2' }],
    goodsContent: [{ PARTNAME: 'P1' }, { PARTNAME: 'P2' }],
    customsEstimate: [{ PARTNAME: 'P1' }, { PARTNAME: 'P2' }],
  },
  receipts: [{ DOCNO: 'GR1', STATDES: 'סופית', TOWARHSNAME: 'arov', IVNUM: 'GI1' }],
  releases: [],
};

describe('computeStage', () => {
  it('a file with every step proven has nothing blocking', () => {
    const r = computeStage(ready);
    expect(r.closeBlocking).toEqual([]);
    expect(r.steps).toEqual({
      invoicesFinal: 'done',
      bondedReceipt: 'done',
      detailFilled: 'done',
      calcEvidence: 'done',
      released: 'missing',
    });
    expect(r.advisory).toHaveLength(1);
    expect(r.closed).toBe(false);
  });

  it('blocks on a temporary invoice and names it', () => {
    const r = computeStage({
      ...ready,
      snapshot: { ...ready.snapshot, invoices: [{ IVNUM: 'GI1' }, { IVNUM: 'T7' }] },
    });
    expect(r.steps.invoicesFinal).toBe('missing');
    expect(r.closeBlocking[0]).toContain('T7');
    expect(r.closeBlocking[0]).not.toContain('GI1');
  });

  it('blocks when the receipt is a draft or went to another warehouse', () => {
    expect(
      computeStage({
        ...ready,
        receipts: [{ DOCNO: 'GR1', STATDES: 'טיוטא', TOWARHSNAME: 'arov', IVNUM: 'GI1' }],
      }).steps.bondedReceipt,
    ).toBe('missing');
    expect(
      computeStage({
        ...ready,
        receipts: [{ DOCNO: 'GR1', STATDES: 'סופית', TOWARHSNAME: 'Main', IVNUM: 'GI1' }],
      }).steps.bondedReceipt,
    ).toBe('missing');
  });

  it('blocks when the customs estimate covers only part of the content', () => {
    const r = computeStage({
      ...ready,
      snapshot: { ...ready.snapshot, customsEstimate: [{ PARTNAME: 'P1' }] },
    });
    expect(r.steps.calcEvidence).toBe('missing');
    expect(r.closeBlocking.join(' ')).toContain('1/2');
  });

  it('does not count estimate rows of parts that are not in the content', () => {
    const r = computeStage({
      ...ready,
      snapshot: { ...ready.snapshot, customsEstimate: [{ PARTNAME: 'P1' }, { PARTNAME: 'P9' }] },
    });
    expect(r.steps.calcEvidence).toBe('missing');
  });

  it('an empty draft lists every missing step in sequence order', () => {
    const r = computeStage({
      snapshot: { header: { IMPFNUM: 'IM1' } },
      receipts: [],
      releases: [],
    });
    expect(r.closeBlocking).toHaveLength(4);
    expect(r.closeBlocking[0]).toContain('אין חשבונית');
    expect(r.closeBlocking[1]).toContain('arov');
    expect(r.closeBlocking[2]).toContain('מילוי פירוט');
    expect(r.closeBlocking[3]).toContain('0/0');
  });

  it('a release on an open file blocks; cancelled and draft ones do not count', () => {
    expect(
      computeStage({ ...ready, releases: [{ DOCNO: 'BD1', STATDES: 'סופית' }] }).closeBlocking.join(
        ' ',
      ),
    ).toContain('BD1');
    for (const STATDES of ['מבוטלת', 'טיוטא']) {
      const r = computeStage({ ...ready, releases: [{ DOCNO: 'BD1', STATDES }] });
      expect(r.steps.released).toBe('missing');
      expect(r.closeBlocking).toEqual([]);
    }
  });

  it('a failed read is unknown and blocks', () => {
    const r = computeStage({ ...ready, receipts: null, releases: null });
    expect(r.steps.bondedReceipt).toBe('unknown');
    expect(r.steps.released).toBe('unknown');
    expect(r.closeBlocking).toHaveLength(2);
  });

  it('reports a closed, released file as closed with nothing blocking', () => {
    const r = computeStage({
      ...ready,
      snapshot: { ...ready.snapshot, header: { CLOSED: 'Y', STATDES: 'סופי' } },
      releases: [{ DOCNO: 'BD1', STATDES: 'סופית' }],
    });
    expect(r.closed).toBe(true);
    expect(r.steps.released).toBe('done');
    expect(r.closeBlocking).toEqual([]);
  });
});
