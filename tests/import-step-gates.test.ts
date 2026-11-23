import { describe, expect, it } from 'vitest';
import type { FileFacts, InvoiceFact, ReleaseFact } from '../src/lib/impfile-official.js';
import { gate, gateWarnings } from '../src/lib/import-step-gates.js';

/**
 * Every phase-B tool asks gate() before it changes anything. A gate returns the reasons to
 * refuse, in Hebrew; an empty list means the step may run. A fact that could not be read is a
 * reason to refuse, never a reason to proceed. Fixtures are invented.
 */
const line = (part: string, qty: number) => ({
  part,
  qty,
  qprice: 1,
  currency: 'EUR',
  country: 'DE',
});
const goods = (over: Partial<InvoiceFact> = {}): InvoiceFact => ({
  ivnum: 'GI1',
  supplier: 'S1',
  debit: 'D',
  isGoods: true,
  isFinal: true,
  lines: [line('P1', 10), line('P2', 5)],
  linesWithoutDeclaration: 0,
  ...over,
});
const cost = (over: Partial<InvoiceFact> = {}): InvoiceFact => ({
  ivnum: 'GI2',
  supplier: 'S2',
  debit: 'D',
  isGoods: false,
  isFinal: true,
  lines: [line('000', 1)],
  linesWithoutDeclaration: 0,
  ...over,
});
const release = (over: Partial<ReleaseFact> = {}): ReleaseFact => ({
  docno: 'BD1',
  status: 'טיוטא',
  date: '2026-01-10T00:00:00Z',
  updatedAt: '2026-01-10T10:00:00Z',
  declaration: 'D1',
  customsInvoice: null,
  lines: [
    {
      part: 'P1',
      qty: 10,
      goodsILS: null,
      customsILS: null,
      additionalILS: null,
      importILS: null,
      totalILS: null,
      costRegisteredAt: null,
    },
  ],
  ...over,
});
const finalReceipt = { docno: 'GR1', status: 'סופית', warehouse: 'BONDED', ivnum: 'GI1' };
const content = [
  { part: 'P1', qty: 10, balance: 10 },
  { part: 'P2', qty: 5, balance: 5 },
];
/** An open file with final invoices and nothing received yet. */
const facts = (over: Partial<FileFacts> = {}): FileFacts => ({
  impfnum: 'IM1',
  closed: false,
  supplier: 'S1',
  warehouse: 'BONDED',
  invoices: [goods(), cost()],
  receipts: [],
  content: [],
  contentVatLineQty: null,
  customsEstimateParts: [],
  customsEstimateWithoutCountry: 0,
  releases: [],
  lastCostingAt: null,
  ...over,
});
/** The same file after close, with the whole quantity still in bond. */
const closedFacts = (over: Partial<FileFacts> = {}): FileFacts =>
  facts({
    closed: true,
    receipts: [finalReceipt],
    content,
    customsEstimateParts: ['P1', 'P2'],
    ...over,
  });

describe('gate: declaration', () => {
  const draft = facts({ invoices: [goods({ ivnum: 'T1', isFinal: false }), cost()] });
  it('allows a draft invoice of an open file', () => {
    expect(gate('declaration', draft, { invoiceNumber: 'T1' })).toEqual([]);
  });
  it('refuses a closed file', () => {
    expect(gate('declaration', { ...draft, closed: true }, { invoiceNumber: 'T1' })).toEqual([
      expect.stringMatching(/התיק סגור/),
    ]);
  });
  it('refuses an invoice that is already final', () => {
    expect(gate('declaration', facts(), { invoiceNumber: 'GI1' })).toEqual([
      expect.stringMatching(/אינה טיוטה/),
    ]);
  });
  it('refuses an invoice that is not linked to the file, or no invoice at all', () => {
    expect(gate('declaration', draft, { invoiceNumber: 'T9' })).toEqual([
      expect.stringMatching(/אינה מקושרת/),
    ]);
    expect(gate('declaration', draft)).toEqual([expect.stringMatching(/מספר חשבונית/)]);
  });
});

describe('gate: receipt', () => {
  it('allows an open BONDED file with one final goods invoice', () => {
    expect(gate('receipt', facts())).toEqual([]);
  });
  it('refuses a closed file', () => {
    expect(gate('receipt', facts({ closed: true }))).toEqual([expect.stringMatching(/התיק סגור/)]);
  });
  it('refuses a file whose warehouse is not BONDED', () => {
    expect(gate('receipt', facts({ warehouse: 'Main' }))).toEqual([expect.stringMatching(/BONDED/)]);
  });
  it('refuses while a goods invoice is still temporary', () => {
    const f = facts({ invoices: [goods({ ivnum: 'T1', isFinal: false }), cost()] });
    expect(gate('receipt', f).join(' ')).toMatch(/זמנית.*T1/);
  });
  it('refuses a file with no goods invoice', () => {
    expect(gate('receipt', facts({ invoices: [cost()] })).join(' ')).toMatch(/אין חשבונית סחורה/);
  });
  it('refuses when the receipts or the goods lines could not be read', () => {
    expect(gate('receipt', facts({ receipts: null })).join(' ')).toMatch(/לא ניתן היה לקרוא/);
    const unread = facts({
      invoices: [goods({ lines: [], linesWithoutDeclaration: null }), cost()],
    });
    expect(gate('receipt', unread).join(' ')).toMatch(/לא ניתן היה לקרוא/);
  });
  it('refuses when the goods evidently entered the bonded warehouse another way', () => {
    expect(gate('receipt', facts({ content })).join(' ')).toMatch(/תכולת התיק כבר/);
    expect(gate('receipt', facts({ releases: [release()] })).join(' ')).toMatch(/תעודת שחרור/);
    const cancelled = facts({ releases: [release({ status: 'מבוטלת' })] });
    expect(gate('receipt', cancelled)).toEqual([]);
  });
  it('warns, and does not refuse, when a goods line has no import declaration', () => {
    const f = facts({ invoices: [goods({ linesWithoutDeclaration: 2 }), cost()] });
    expect(gate('receipt', f)).toEqual([]);
    expect(gateWarnings('receipt', f)).toEqual([expect.stringMatching(/2 שורות.*הצהרת יבוא/)]);
    expect(gateWarnings('receipt', facts())).toEqual([]);
  });
});

describe('gate: fillDetail', () => {
  const received = facts({ receipts: [finalReceipt] });
  it('allows an open file with a final receipt and empty content', () => {
    expect(gate('fillDetail', received)).toEqual([]);
  });
  it('refuses a closed file', () => {
    expect(gate('fillDetail', { ...received, closed: true }).join(' ')).toMatch(/התיק סגור/);
  });
  it('refuses while the receipt is missing, a draft, or unreadable', () => {
    expect(gate('fillDetail', facts()).join(' ')).toMatch(/קבלה/);
    const draft = facts({ receipts: [{ ...finalReceipt, status: 'טיוטא' }] });
    expect(gate('fillDetail', draft).join(' ')).toMatch(/קבלה/);
    expect(gate('fillDetail', facts({ receipts: null })).join(' ')).toMatch(/לא ניתן היה לקרוא/);
  });
  it('refuses when the content already has product lines', () => {
    expect(gate('fillDetail', { ...received, content }).join(' ')).toMatch(/כבר יש שורות/);
  });
  it('refuses while one of several goods invoices is not final or not yet received', () => {
    const second = goods({ ivnum: 'GI3' });
    const twoInvoices = { ...received, invoices: [goods(), second, cost()] };
    expect(gate('fillDetail', twoInvoices).join(' ')).toMatch(/GI3/);
    const temporary = { ...received, invoices: [goods(), goods({ ivnum: 'T3', isFinal: false })] };
    expect(gate('fillDetail', temporary).join(' ')).toMatch(/T3/);
    const both = {
      ...twoInvoices,
      receipts: [finalReceipt, { ...finalReceipt, docno: 'GR2', ivnum: 'GI3' }],
    };
    expect(gate('fillDetail', both)).toEqual([]);
  });
});

describe('gate: calc', () => {
  const ready = facts({ receipts: [finalReceipt], content });
  it('allows an open file whose invoices, receipt and detail are done', () => {
    expect(gate('calc', ready)).toEqual([]);
  });
  it('refuses a closed file', () => {
    expect(gate('calc', { ...ready, closed: true }).join(' ')).toMatch(/התיק סגור/);
  });
  it('refuses while an invoice is temporary', () => {
    const f = { ...ready, invoices: [goods(), cost({ ivnum: 'T2', isFinal: false })] };
    expect(gate('calc', f).join(' ')).toMatch(/שלב 3/);
  });
  it('refuses without a final receipt, and when the receipts are unreadable', () => {
    expect(gate('calc', { ...ready, receipts: [] }).join(' ')).toMatch(/שלב 4/);
    expect(gate('calc', { ...ready, receipts: null }).join(' ')).toMatch(/שלב 4/);
  });
  it('refuses while one of several goods invoices was not received', () => {
    const f = { ...ready, invoices: [goods(), goods({ ivnum: 'GI3' }), cost()] };
    expect(gate('calc', f).join(' ')).toMatch(/GI3/);
  });
  it('refuses while the detail is empty or still holds the VAT line', () => {
    expect(gate('calc', { ...ready, content: [] }).join(' ')).toMatch(/שלב 5/);
    expect(gate('calc', { ...ready, contentVatLineQty: 1 }).join(' ')).toMatch(/שלב 5/);
  });
});

describe('gate: releaseDraft', () => {
  it('allows a closed file with a balance, cost invoice and no open release', () => {
    expect(gate('releaseDraft', closedFacts())).toEqual([]);
  });
  it('refuses an open file', () => {
    expect(gate('releaseDraft', closedFacts({ closed: false })).join(' ')).toMatch(
      /התיק אינו סגור/,
    );
  });
  it('refuses when nothing is left in bond', () => {
    const empty = closedFacts({ content: content.map((c) => ({ ...c, balance: 0 })) });
    expect(gate('releaseDraft', empty).join(' ')).toMatch(/אין יתרה/);
  });
  it('refuses a second draft release, except the one being continued', () => {
    const f = closedFacts({ releases: [release()] });
    expect(gate('releaseDraft', f).join(' ')).toMatch(/BD1/);
    expect(gate('releaseDraft', f, { releaseDocno: 'BD1' })).toEqual([]);
  });
  it('ignores cancelled and final releases of an earlier partial release', () => {
    const f = closedFacts({
      releases: [release({ docno: 'BD0', status: 'מבוטלת' }), release({ status: 'סופית' })],
    });
    expect(gate('releaseDraft', f)).toEqual([]);
  });
  it('refuses without a cost invoice unless the caller allows it', () => {
    const f = closedFacts({ invoices: [goods()] });
    expect(gate('releaseDraft', f).join(' ')).toMatch(/חשבונית עלויות/);
    expect(gate('releaseDraft', f, { allowWithoutCostInvoice: true })).toEqual([]);
  });
  it('refuses while a linked invoice is temporary, and when releases are unreadable', () => {
    const temp = closedFacts({ invoices: [goods(), cost({ ivnum: 'T2', isFinal: false })] });
    expect(gate('releaseDraft', temp).join(' ')).toMatch(/זמנית.*T2/);
    expect(gate('releaseDraft', closedFacts({ releases: null })).join(' ')).toMatch(
      /לא ניתן היה לקרוא/,
    );
  });
});

describe('gate: lineCosts', () => {
  const f = closedFacts({ releases: [release()] });
  it('allows a draft release with lines on a closed file', () => {
    expect(gate('lineCosts', f, { releaseDocno: 'BD1' })).toEqual([]);
  });
  it('refuses an open file', () => {
    expect(gate('lineCosts', { ...f, closed: false }, { releaseDocno: 'BD1' }).join(' ')).toMatch(
      /התיק אינו סגור/,
    );
  });
  it('refuses a release that is missing, cancelled, or empty', () => {
    expect(gate('lineCosts', f, { releaseDocno: 'BD9' }).join(' ')).toMatch(/לא נמצאה/);
    expect(gate('lineCosts', f).join(' ')).toMatch(/לא נמצאה/);
    const cancelled = closedFacts({ releases: [release({ status: 'מבוטלת' })] });
    expect(gate('lineCosts', cancelled, { releaseDocno: 'BD1' }).join(' ')).toMatch(/מבוטלת/);
    const empty = closedFacts({ releases: [release({ lines: [] })] });
    expect(gate('lineCosts', empty, { releaseDocno: 'BD1' }).join(' ')).toMatch(/אין שורות/);
  });
  it('refuses a final release unless the caller asks for the repair path', () => {
    const final = closedFacts({ releases: [release({ status: 'סופית' })] });
    expect(gate('lineCosts', final, { releaseDocno: 'BD1' }).join(' ')).toMatch(/סופית/);
    expect(gate('lineCosts', final, { releaseDocno: 'BD1', onFinalRelease: true })).toEqual([]);
  });
  it('refuses when the releases could not be read', () => {
    expect(
      gate('lineCosts', closedFacts({ releases: null }), { releaseDocno: 'BD1' }).join(' '),
    ).toMatch(/לא ניתן היה לקרוא/);
  });
});
