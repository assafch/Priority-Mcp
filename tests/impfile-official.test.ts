import { describe, expect, it } from 'vitest';
import {
  type FileFacts,
  type ReleaseFact,
  buildCostReport,
  computeCostingReadiness,
  computeOfficialSteps,
  reconcileImportCosts,
} from '../src/lib/impfile-official.js';

/**
 * The twelve steps of Priority's own import-file procedure (SOP LBI2400273 + LBI2400656) and the
 * landed cost per product at the end of them. Fixtures are invented; no real names or numbers.
 */
const line = (part: string, qty: number, goods: number, imp: number, at: string | null) => ({
  part,
  qty,
  goodsILS: goods,
  customsILS: 0,
  additionalILS: 0,
  importILS: at ? imp : null,
  totalILS: at ? goods + imp : null,
  costRegisteredAt: at,
});
const release = (over: Partial<ReleaseFact> = {}): ReleaseFact => ({
  docno: 'BD1',
  status: 'סופית',
  date: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T10:00:00Z',
  declaration: '111',
  customsInvoice: null,
  lines: [
    line('P1', 100, 1000, 300, '2026-03-01T09:50:00Z'),
    line('P2', 50, 500, 150, '2026-03-01T09:50:00Z'),
  ],
  ...over,
});

/** A file that went through all twelve steps in the official order. */
const complete: FileFacts = {
  impfnum: 'IM1',
  closed: true,
  supplier: 'S1',
  warehouse: 'BONDED',
  invoices: [
    {
      ivnum: 'GI1',
      supplier: 'S1',
      debit: 'D',
      isGoods: true,
      isFinal: true,
      linesWithoutDeclaration: 0,
      lines: [
        { part: 'P1', qty: 100, qprice: 250, currency: 'EUR', country: 'X' },
        { part: 'P2', qty: 50, qprice: 125, currency: 'EUR', country: 'X' },
      ],
    },
    {
      ivnum: 'GI2',
      supplier: 'B1',
      debit: 'D',
      isGoods: false,
      isFinal: true,
      linesWithoutDeclaration: null,
      lines: [
        { part: 'C1', qty: 1, qprice: 400, currency: 'ש"ח', country: null },
        { part: 'C2', qty: 1, qprice: 50, currency: 'ש"ח', country: null },
        { part: "מע'מ", qty: 1, qprice: 270, currency: 'ש"ח', country: null },
      ],
    },
  ],
  receipts: [{ docno: 'GR1', status: 'סופית', warehouse: 'BONDED', ivnum: 'GI1' }],
  content: [
    { part: 'P1', qty: 100, balance: 0 },
    { part: 'P2', qty: 50, balance: 0 },
  ],
  customsEstimateParts: ['P1', 'P2'],
  releases: [release()],
  lastCostingAt: '2026-03-01T11:00:00Z',
};

const states = (f: FileFacts) => computeOfficialSteps(f).steps.map((s) => s.state);

describe('computeOfficialSteps', () => {
  it('a file processed in the official order has all twelve steps done', () => {
    const stage = computeOfficialSteps(complete);
    expect(stage.steps).toHaveLength(12);
    expect(stage.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(states(complete).every((s) => s === 'done')).toBe(true);
    expect(stage.currentStep).toBeNull();
    expect(stage.violations).toEqual([]);
  });

  it('a file that was only opened stands at step 2', () => {
    const stage = computeOfficialSteps({
      impfnum: 'IM1',
      closed: false,
      supplier: 'S1',
      warehouse: 'BONDED',
      invoices: [],
      receipts: [],
      content: [],
      customsEstimateParts: [],
      releases: [],
      lastCostingAt: '2026-01-01T00:00:00Z',
    });
    expect(stage.currentStep).toBe(2);
    expect(stage.steps[0].state).toBe('done');
    expect(stage.steps.slice(1).every((s) => s.state === 'missing')).toBe(true);
    expect(stage.nextAction).toContain('שלב 2');
  });

  it('step 2 needs an import declaration on every goods line; the country is proven at step 6', () => {
    const goods = complete.invoices[0];
    const noDecl = computeOfficialSteps({
      ...complete,
      invoices: [{ ...goods, linesWithoutDeclaration: 2 }, complete.invoices[1]],
    });
    expect(noDecl.steps[1].state).toBe('missing');
    expect(noDecl.steps[1].detail.join(' ')).toContain('2 שורות סחורה בלי הצהרת יבוא');

    // An empty country on the invoice line is not an error: Priority falls back to the supplier's
    // country. It is checked where it can be proven — on the customs estimate (step 6).
    const noCountry = computeOfficialSteps({
      ...complete,
      invoices: [
        { ...goods, lines: [{ ...goods.lines[0], country: null }, goods.lines[1]] },
        complete.invoices[1],
      ],
    });
    expect(noCountry.steps[1].state).toBe('done');
    expect(noCountry.steps[1].detail.join(' ')).toContain('ארץ מוצא');
    const estimateGap = computeOfficialSteps({ ...complete, customsEstimateWithoutCountry: 1 });
    expect(estimateGap.steps[5].state).toBe('missing');
    expect(estimateGap.steps[5].detail.join(' ')).toContain('בלי ארץ מוצא');

    const unreadable = computeOfficialSteps({
      ...complete,
      invoices: [{ ...goods, linesWithoutDeclaration: null }, complete.invoices[1]],
    });
    expect(unreadable.steps[1].state).toBe('unknown');
  });

  it('on a closed file, unproven steps before the close are historical gaps, not the current step', () => {
    const goods = complete.invoices[0];
    const stage = computeOfficialSteps({
      ...complete,
      invoices: [{ ...goods, linesWithoutDeclaration: 1 }, complete.invoices[1]],
    });
    expect(stage.steps[1].state).toBe('missing');
    expect(stage.currentStep).toBeNull();
    expect(stage.historicalGaps).toHaveLength(1);
    expect(stage.historicalGaps[0]).toContain('שלב 2');
    expect(stage.steps[11].state).toBe('done');

    const open = computeOfficialSteps({
      ...complete,
      closed: false,
      releases: [],
      invoices: [{ ...goods, linesWithoutDeclaration: 1 }, complete.invoices[1]],
    });
    expect(open.currentStep).toBe(2);
    expect(open.historicalGaps).toEqual([]);
  });

  it('import costs of exactly 0 are not proof that the costs were registered', () => {
    const zero = release({
      lines: [
        { ...line('P1', 100, 1000, 0, '2026-03-01T09:50:00Z'), importILS: 0, totalILS: 1000 },
        line('P2', 50, 500, 150, '2026-03-01T09:50:00Z'),
      ],
    });
    const stage = computeOfficialSteps({ ...complete, releases: [zero] });
    expect(stage.steps[8].state).toBe('missing');
    // …unless the file has no cost invoice at all
    const noCostInvoice = computeOfficialSteps({
      ...complete,
      invoices: [complete.invoices[0]],
      releases: [zero],
    });
    expect(noCostInvoice.steps[8].state).toBe('done');
  });

  it('step 3 names the temporary invoices', () => {
    const stage = computeOfficialSteps({
      ...complete,
      invoices: [complete.invoices[0], { ...complete.invoices[1], ivnum: 'T9', isFinal: false }],
    });
    expect(stage.steps[2].state).toBe('missing');
    expect(stage.steps[2].detail.join(' ')).toContain('T9');
    expect(stage.violations.join(' ')).toContain('T9');
  });

  it('step 4 refuses a draft receipt or a receipt into another warehouse', () => {
    expect(
      states({
        ...complete,
        receipts: [{ docno: 'GR1', status: 'טיוטא', warehouse: 'BONDED', ivnum: 'GI1' }],
      })[3],
    ).toBe('missing');
    const main = computeOfficialSteps({
      ...complete,
      receipts: [{ docno: 'GR1', status: 'סופית', warehouse: 'Main', ivnum: 'GI1' }],
    });
    expect(main.steps[3].state).toBe('missing');
    expect(main.steps[3].detail.join(' ')).toContain('Main');
    expect(states({ ...complete, receipts: null })[3]).toBe('unknown');
    // no receipt tied to the invoice: missing before any release, unknown once goods were released
    expect(states({ ...complete, receipts: [], releases: [] })[3]).toBe('missing');
    const released = computeOfficialSteps({ ...complete, receipts: [] });
    expect(released.steps[3].state).toBe('unknown');
    expect(released.steps[3].detail.join(' ')).toContain('שורות הזמנה');
  });

  it('step 5 is missing while the VAT line in the content still carries a quantity', () => {
    expect(states({ ...complete, contentVatLineQty: 0 })[4]).toBe('done');
    const stage = computeOfficialSteps({ ...complete, contentVatLineQty: 1 });
    expect(stage.steps[4].state).toBe('missing');
    expect(stage.steps[4].detail.join(' ')).toContain('לאפס');
  });

  it('step 6 is missing while the customs estimate does not cover the content', () => {
    const stage = computeOfficialSteps({ ...complete, customsEstimateParts: ['P1'] });
    expect(stage.steps[5].state).toBe('missing');
    expect(stage.steps[5].detail.join(' ')).toContain('1/2');
  });

  it('a release on an open file is a violation of the official order', () => {
    const stage = computeOfficialSteps({ ...complete, closed: false });
    expect(stage.steps[6].state).toBe('missing');
    expect(stage.currentStep).toBe(7);
    expect(stage.violations.join(' ')).toContain('BD1');
  });

  it('a final release whose lines carry no import costs is flagged', () => {
    const stage = computeOfficialSteps({
      ...complete,
      releases: [
        release({
          lines: [line('P1', 100, 1000, 0, null), line('P2', 50, 500, 150, '2026-03-01T09:50:00Z')],
        }),
      ],
    });
    expect(stage.steps[8].state).toBe('missing');
    expect(stage.steps[8].detail.join(' ')).toContain('1 שורות בלי עלויות יבוא');
    expect(stage.violations.join(' ')).toContain('בלי העלויות הנלוות');
  });

  it('a draft release with registered costs has step 9 done and step 10 still open', () => {
    const stage = computeOfficialSteps({
      ...complete,
      content: [
        { part: 'P1', qty: 100, balance: 100 },
        { part: 'P2', qty: 50, balance: 50 },
      ],
      releases: [release({ status: 'טיוטא' })],
    });
    expect(stage.steps[7].state).toBe('done');
    expect(stage.steps[8].state).toBe('done');
    expect(stage.steps[9].state).toBe('missing');
    expect(stage.currentStep).toBe(10);
    expect(stage.violations).toEqual([]);
  });

  it('a partial release is partial, and a cancelled release does not count', () => {
    const partial = computeOfficialSteps({
      ...complete,
      content: [
        { part: 'P1', qty: 100, balance: 0 },
        { part: 'P2', qty: 50, balance: 20 },
      ],
    });
    expect(partial.steps[9].state).toBe('partial');
    expect(partial.steps[9].detail.join(' ')).toContain('P2×20');

    const cancelled = computeOfficialSteps({
      ...complete,
      releases: [release({ status: 'מבוטלת' })],
    });
    expect(cancelled.steps[7].state).toBe('missing');
    expect(cancelled.violations).toEqual([]);
  });

  it('costing must have run after the last change of the release', () => {
    const stale = computeOfficialSteps({ ...complete, lastCostingAt: '2026-03-01T09:55:00Z' });
    expect(stale.steps[10].state).toBe('missing');
    expect(stale.currentStep).toBe(11);
    expect(computeOfficialSteps({ ...complete, lastCostingAt: null }).steps[10].state).toBe(
      'missing',
    );
    expect(computeOfficialSteps({ ...complete, lastCostingAt: undefined }).steps[10].state).toBe(
      'unknown',
    );
  });

  it('cannot order a costing run and a change recorded in the same minute', () => {
    const stage = computeOfficialSteps({ ...complete, lastCostingAt: '2026-03-01T10:00:00Z' });
    expect(stage.steps[10].state).toBe('unknown');
    expect(stage.steps[10].detail.join(' ')).toContain('באותה דקה');
  });

  it('unreadable releases make steps 8 to 11 unknown, never done', () => {
    const stage = computeOfficialSteps({ ...complete, releases: null });
    expect(stage.steps.slice(7, 11).every((s) => s.state === 'unknown')).toBe(true);
    expect(stage.currentStep).toBe(8);
  });
});

describe('nextAction', () => {
  const draftLine = (part: string, qty: number) => line(part, qty, 0, 0, null);
  const inBond = complete.content.map((c) => ({ ...c, balance: c.qty }));
  /** The same file before anything was received. */
  const opened: FileFacts = {
    ...complete,
    closed: false,
    receipts: [],
    content: [],
    customsEstimateParts: [],
    releases: [],
  };
  const received: FileFacts = { ...opened, receipts: complete.receipts };
  const filled: FileFacts = { ...received, content: inBond };
  const closed: FileFacts = { ...filled, customsEstimateParts: ['P1', 'P2'], closed: true };
  const draft = release({
    status: 'טיוטא',
    lines: [draftLine('P1', 100), draftLine('P2', 50)],
  });

  it.each([
    [
      2,
      'pinvoice_set_declaration',
      {
        ...opened,
        invoices: [{ ...complete.invoices[0], linesWithoutDeclaration: 2 }, complete.invoices[1]],
      },
    ],
    [4, 'bonded_receipt', opened],
    [5, 'bonded_fill_detail', received],
    [6, 'impfile_run_calc', filled],
    [8, 'bonded_release_draft', closed],
    [9, 'bonded_line_costs', { ...closed, releases: [draft] }],
  ] as Array<[number, string, FileFacts]>)(
    'step %i names the tool that does it: %s',
    (n, tool, facts) => {
      const stage = computeOfficialSteps(facts);
      expect(stage.currentStep).toBe(n);
      expect(stage.nextAction).toContain(tool);
    },
  );

  it('step 4 also says that making the receipt final is the owner’s', () => {
    expect(computeOfficialSteps(opened).nextAction).toMatch(/bonded_receipt.*הבעלים.*סופית/);
  });

  it.each([
    [
      3,
      {
        ...opened,
        invoices: [{ ...complete.invoices[0], ivnum: 'T1', isFinal: false }, complete.invoices[1]],
      },
    ],
    [7, { ...filled, customsEstimateParts: ['P1', 'P2'] }],
    [10, { ...closed, releases: [release({ status: 'טיוטא' })] }],
    [11, { ...complete, lastCostingAt: '2026-02-01T00:00:00Z' }],
  ] as Array<[number, FileFacts]>)('step %i stays with the owner', (n, facts) => {
    const stage = computeOfficialSteps(facts);
    expect(stage.currentStep).toBe(n);
    expect(stage.nextAction).toContain('הבעלים');
    expect(stage.nextAction).not.toMatch(
      /pinvoice_set_declaration|bonded_receipt|bonded_fill_detail|impfile_run_calc|bonded_release_draft|bonded_line_costs/,
    );
  });
});

describe('reconcileImportCosts', () => {
  it('ties when the costs on the releases equal the cost invoices without the VAT line', () => {
    const rec = reconcileImportCosts(complete);
    expect(rec).toMatchObject({
      importCostsOnReleases: 450,
      costInvoiceLinesTotal: 450,
      difference: 0,
      status: 'ties',
    });
  });

  it('reports the difference to the agora', () => {
    const rec = reconcileImportCosts({
      ...complete,
      releases: [
        release({
          lines: [
            line('P1', 100, 1000, 300.05, '2026-03-01T09:50:00Z'),
            line('P2', 50, 500, 150, '2026-03-01T09:50:00Z'),
          ],
        }),
      ],
    });
    expect(rec.status).toBe('differs');
    expect(rec.difference).toBe(0.05);
  });

  it('accepts a difference inside the per-line rounding of the allocation, and says so', () => {
    const rec = reconcileImportCosts({
      ...complete,
      releases: [
        release({
          lines: [
            line('P1', 100, 1000, 299.99, '2026-03-01T09:50:00Z'),
            line('P2', 50, 500, 150, '2026-03-01T09:50:00Z'),
          ],
        }),
      ],
    });
    expect(rec.status).toBe('ties-within-rounding');
    expect(rec.difference).toBe(-0.01);
    expect(rec.notes.join(' ')).toContain('סף הסבילות');
  });

  it('does not judge a partial release, a foreign-currency cost invoice or a credit', () => {
    expect(
      reconcileImportCosts({
        ...complete,
        content: [
          { part: 'P1', qty: 100, balance: 0 },
          { part: 'P2', qty: 50, balance: 20 },
        ],
      }).status,
    ).toBe('partial-release');

    const cost = complete.invoices[1];
    expect(
      reconcileImportCosts({
        ...complete,
        invoices: [
          complete.invoices[0],
          { ...cost, lines: [{ ...cost.lines[0], currency: 'EUR' }, ...cost.lines.slice(1)] },
        ],
      }).status,
    ).toBe('not-comparable');
    expect(
      reconcileImportCosts({
        ...complete,
        invoices: [complete.invoices[0], { ...cost, debit: 'C' }],
      }).status,
    ).toBe('not-comparable');
    expect(reconcileImportCosts({ ...complete, releases: [] }).status).toBe('not-released');
    expect(reconcileImportCosts({ ...complete, releases: null }).status).toBe('unknown');
  });

  it('counts only final releases', () => {
    const rec = reconcileImportCosts({
      ...complete,
      releases: [release(), release({ docno: 'BD2', status: 'טיוטא' })],
    });
    expect(rec.importCostsOnReleases).toBe(450);
  });
});

describe('buildCostReport', () => {
  const partCosts = [
    {
      part: 'P1',
      itemCost: 12.5,
      costingDate: '2026-03-01T00:00:00Z',
      movementCostByDoc: { BD1: 1300 },
    },
    {
      part: 'P2',
      itemCost: 13,
      costingDate: '2026-03-01T00:00:00Z',
      movementCostByDoc: { BD1: 650 },
    },
  ];

  it('gives the landed cost per product and matches it to the stock-entry cost', () => {
    const report = buildCostReport(complete, partCosts);
    expect(report.fullyReleased).toBe(true);
    expect(report.byPart).toEqual([
      {
        part: 'P1',
        qty: 100,
        goodsILS: 1000,
        importILS: 300,
        totalILS: 1300,
        unitLandedILS: 13,
        movementCostILS: 1300,
        movementMatches: true,
        itemCostILS: 12.5,
        costingDate: '2026-03-01T00:00:00Z',
      },
      {
        part: 'P2',
        qty: 50,
        goodsILS: 500,
        importILS: 150,
        totalILS: 650,
        unitLandedILS: 13,
        movementCostILS: 650,
        movementMatches: true,
        itemCostILS: 13,
        costingDate: '2026-03-01T00:00:00Z',
      },
    ]);
    expect(report.reconciliation.status).toBe('ties');
    expect(report.costing.afterLastChange).toBe(true);
    expect(report.warnings).toEqual([]);
  });

  it('sums a part released in two documents', () => {
    const report = buildCostReport(
      {
        ...complete,
        releases: [
          release({ lines: [line('P1', 60, 600, 180, '2026-03-01T09:50:00Z')] }),
          release({ docno: 'BD2', lines: [line('P1', 40, 400, 120, '2026-03-01T09:50:00Z')] }),
        ],
      },
      [{ part: 'P1', itemCost: 12, costingDate: null, movementCostByDoc: { BD1: 780, BD2: 520 } }],
    );
    expect(report.byPart[0]).toMatchObject({
      qty: 100,
      totalILS: 1300,
      unitLandedILS: 13,
      movementCostILS: 1300,
      movementMatches: true,
    });
  });

  it('warns when the stock-entry cost differs or a line has no costs', () => {
    const differs = buildCostReport(complete, [
      { ...partCosts[0], movementCostByDoc: { BD1: 1000 } },
      partCosts[1],
    ]);
    expect(differs.byPart[0].movementMatches).toBe(false);
    expect(differs.warnings.join(' ')).toContain('P1');

    const uncosted = buildCostReport(
      { ...complete, releases: [release({ lines: [line('P1', 100, 1000, 0, null)] })] },
      partCosts,
    );
    expect(uncosted.byPart[0].unitLandedILS).toBeNull();
    expect(uncosted.warnings.join(' ')).toContain('אין עלות מועמסת מלאה');
  });

  it('says so when a movement or the product cards could not be read', () => {
    const noMovement = buildCostReport(complete, [
      { ...partCosts[0], movementCostByDoc: {} },
      partCosts[1],
    ]);
    expect(noMovement.byPart[0].movementCostILS).toBeNull();
    expect(noMovement.byPart[0].movementMatches).toBeNull();
    const unread = buildCostReport(complete, null);
    expect(unread.byPart[0].itemCostILS).toBeNull();
    expect(unread.warnings.join(' ')).toContain('כרטיסי הפריט');
  });
});

describe('computeCostingReadiness', () => {
  const row = (over = {}) => ({
    docno: 'BD1',
    impfnum: 'IM1',
    status: 'סופית',
    updatedAt: '2026-03-01T10:00:00Z',
    lines: [line('P1', 1, 10, 3, '2026-03-01T09:50:00Z')],
    ...over,
  });

  it('is ready and not needed when costing ran after every release', () => {
    expect(
      computeCostingReadiness({
        releases: [row()],
        scanComplete: true,
        closedByFile: { IM1: true },
        lastCostingAt: '2026-03-01T11:00:00Z',
      }),
    ).toMatchObject({ readyToRun: true, costingNeeded: false, blockers: [], pendingFiles: [] });
  });

  it('is needed when a release changed after the last costing run', () => {
    const r = computeCostingReadiness({
      releases: [row(), row({ docno: 'BD2', impfnum: 'IM2', updatedAt: '2026-03-02T10:00:00Z' })],
      scanComplete: true,
      closedByFile: { IM1: true, IM2: true },
      lastCostingAt: '2026-03-01T11:00:00Z',
    });
    expect(r).toMatchObject({ readyToRun: true, costingNeeded: true, pendingFiles: ['IM2'] });
  });

  it('lists a file as ambiguous when its change and the costing run share a minute', () => {
    const r = computeCostingReadiness({
      releases: [row({ updatedAt: '2026-03-01T11:00:00Z' })],
      scanComplete: true,
      closedByFile: { IM1: true },
      lastCostingAt: '2026-03-01T11:00:00Z',
    });
    expect(r).toMatchObject({ costingNeeded: false, pendingFiles: [], ambiguousFiles: ['IM1'] });
  });

  it('blocks on a final release whose import costs are exactly 0', () => {
    const r = computeCostingReadiness({
      releases: [
        row({
          lines: [{ ...line('P1', 1, 10, 0, '2026-03-01T09:50:00Z'), importILS: 0, totalILS: 10 }],
        }),
      ],
      scanComplete: true,
      closedByFile: { IM1: true },
      lastCostingAt: '2026-03-01T11:00:00Z',
    });
    expect(r.readyToRun).toBe(false);
    expect(r.blockers[0]).toContain('עלויות יבוא 0');
  });

  it('blocks on a final release without line costs or on an open file', () => {
    const r = computeCostingReadiness({
      releases: [
        row({ lines: [line('P1', 1, 10, 0, null)] }),
        row({ docno: 'BD2', impfnum: 'IM2' }),
      ],
      scanComplete: true,
      closedByFile: { IM1: true },
      lastCostingAt: '2026-03-01T11:00:00Z',
    });
    expect(r.readyToRun).toBe(false);
    expect(r.blockers).toHaveLength(2);
    expect(r.blockers[0]).toContain('BD1');
    expect(r.blockers[1]).toContain('IM2');
  });

  it('ignores cancelled releases, lists drafts, and blocks on an incomplete scan', () => {
    const r = computeCostingReadiness({
      releases: [row({ status: 'מבוטלת', lines: [] }), row({ docno: 'BD3', status: 'טיוטא' })],
      scanComplete: false,
      closedByFile: {},
      lastCostingAt: null,
    });
    expect(r.draftReleases).toEqual(['BD3 (IM1)']);
    expect(r.readyToRun).toBe(false);
    expect(r.blockers).toHaveLength(1);
    expect(r.costingNeeded).toBe(false);
  });
});
