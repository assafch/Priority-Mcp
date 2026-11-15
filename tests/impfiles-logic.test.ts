import { describe, expect, it } from 'vitest';
import {
  VAT_DECLARATION_PART,
  brokerHasLines,
  buildBrokerInvoiceBody,
  buildGoodsInvoiceBody,
  computeLandedCost,
  goodsReadback,
  matchThreeWay,
  preflight,
} from '../src/lib/impfiles-logic.js';

const goodsHeader = {
  supplier: '200001',
  invoiceNumber: 'P13042',
  invoiceDate: '2025-02-27',
  currency: '$',
  impfnum: 'IM25000009',
  po: 'PO25000003',
};

describe('buildGoodsInvoiceBody', () => {
  it('builds the header + SKU lines (mirrors goods invoice GI25000025)', () => {
    const body = buildGoodsInvoiceBody({
      header: goodsHeader,
      lines: [
        { part: 'POL0001', qty: 400, price: 7.3 },
        { part: 'POL0002', qty: 216, price: 7.3 },
      ],
    });
    expect(body).toMatchObject({
      SUPNAME: '200001',
      BOOKNUM: 'P13042',
      IVDATE: '2025-02-27',
      CODE: '$',
      DEBIT: 'D',
      OTYPE: 'P',
      IMPFNUM: 'IM25000009',
      ORDNAME: 'PO25000003',
    });
    expect(body.PINVOICEITEMS_SUBFORM).toEqual([
      { PARTNAME: 'POL0001', TQUANT: 400, PRICE: 7.3 },
      { PARTNAME: 'POL0002', TQUANT: 216, PRICE: 7.3 },
    ]);
  });

  it('omits PRICE when not supplied (price comes from the order)', () => {
    const body = buildGoodsInvoiceBody({
      header: goodsHeader,
      lines: [{ part: 'POL0003', qty: 480 }],
    });
    const items = body.PINVOICEITEMS_SUBFORM as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({ PARTNAME: 'POL0003', TQUANT: 480 });
    expect(items[0]).not.toHaveProperty('PRICE');
  });

  it('omits ORDNAME when no PO is given', () => {
    const { po, ...noPo } = goodsHeader;
    const body = buildGoodsInvoiceBody({ header: noPo, lines: [{ part: 'X', qty: 1 }] });
    expect(body).not.toHaveProperty('ORDNAME');
  });
});

describe('buildBrokerInvoiceBody', () => {
  const header = {
    supplier: '200026',
    invoiceNumber: '62503701',
    invoiceDate: '2025-05-15',
    currency: 'ש"ח',
    impfnum: 'IM25000009',
  };

  it("records cost lines + the VAT-from-declaration line on the מע'מ part (mirrors GI25000026)", () => {
    const body = buildBrokerInvoiceBody({
      header,
      costLines: [
        { part: 'AVI001', amount: 3518.39 }, // sea freight — not VAT-taxable
        { part: 'AVI007', amount: 300, vat: true }, // customs brokerage — taxable
      ],
      declarationVat: [
        { amount: 11147, declaration: 'IL-2025-0001', declarationDate: '2025-05-10' },
      ],
    });
    const items = body.PINVOICEITEMS_SUBFORM as Array<Record<string, unknown>>;
    // Cost line without VAT carries no VATFLAG; taxable one carries VATFLAG='Y'.
    expect(items[0]).toEqual({ PARTNAME: 'AVI001', TQUANT: 1, PRICE: 3518.39 });
    expect(items[1]).toEqual({ PARTNAME: 'AVI007', TQUANT: 1, PRICE: 300, VATFLAG: 'Y' });
    // The declaration-VAT line uses the system part, is always VAT-flagged, and carries the declaration.
    expect(items[2]).toEqual({
      PARTNAME: "מע'מ",
      TQUANT: 1,
      PRICE: 11147,
      VATFLAG: 'Y',
      CUSTOMSNUM: 'IL-2025-0001',
      CUSTOMSDATE: '2025-05-10',
    });
    expect(body).toMatchObject({ DEBIT: 'D', OTYPE: 'P', IMPFNUM: 'IM25000009', CODE: 'ש"ח' });
  });

  it('emits one VAT line per declaration and honors a custom VAT part override', () => {
    const body = buildBrokerInvoiceBody({
      header,
      declarationVat: [{ amount: 100 }, { amount: 200, declaration: 'D2' }],
      vatDeclarationPart: 'CUSTOM_VAT',
    });
    const items = body.PINVOICEITEMS_SUBFORM as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.PARTNAME === 'CUSTOM_VAT' && i.VATFLAG === 'Y')).toBe(true);
    expect(items[0]).not.toHaveProperty('CUSTOMSNUM');
  });

  it('falls back to the default VAT part when the override is an empty string', () => {
    const body = buildBrokerInvoiceBody({
      header,
      declarationVat: [{ amount: 100 }],
      vatDeclarationPart: '',
    });
    const items = body.PINVOICEITEMS_SUBFORM as Array<Record<string, unknown>>;
    expect(items[0].PARTNAME).toBe("מע'מ");
  });

  it('records a C-loaded customs duty line with its declaration', () => {
    const body = buildBrokerInvoiceBody({
      header,
      customsDuty: [{ part: 'CUSTOMS_DUTY', amount: 540, declaration: 'IL-2025-0002' }],
    });
    const items = body.PINVOICEITEMS_SUBFORM as Array<Record<string, unknown>>;
    expect(items[0]).toEqual({
      PARTNAME: 'CUSTOMS_DUTY',
      TQUANT: 1,
      PRICE: 540,
      CUSTOMSNUM: 'IL-2025-0002',
    });
  });
});

describe('brokerHasLines / constant', () => {
  it('VAT_DECLARATION_PART is the exact live part name', () => {
    expect(VAT_DECLARATION_PART).toBe("מע'מ");
  });

  it('brokerHasLines is false only when every list is empty', () => {
    expect(brokerHasLines({})).toBe(false);
    expect(brokerHasLines({ costLines: [], customsDuty: [], declarationVat: [] })).toBe(false);
    expect(brokerHasLines({ declarationVat: [{ amount: 1 }] })).toBe(true);
    expect(brokerHasLines({ costLines: [{ part: 'A', amount: 1 }] })).toBe(true);
  });
});

describe('matchThreeWay', () => {
  const line = (PARTNAME: string, TQUANT: number, extra = {}) => ({ PARTNAME, TQUANT, ...extra });

  it('marks a fully ordered/received/invoiced part as matched (mirrors PO25000003)', () => {
    const { lines, summary } = matchThreeWay(
      [line('POL0001', 400, { PRICE: 7.3, CODE: '$', PDES: 'AQUAMEND' })],
      [line('POL0001', 400)],
      [line('POL0001', 400)],
    );
    expect(lines[0]).toMatchObject({
      part: 'POL0001',
      ordered: 400,
      received: 400,
      invoiced: 400,
      balance: 0,
      unitPrice: 7.3,
      currency: '$',
      verdict: 'matched',
    });
    expect(summary).toEqual({ parts: 1, matched: 1, issues: 0 });
  });

  it('classifies each mismatch bucket', () => {
    const { lines } = matchThreeWay(
      [line('A', 100), line('B', 100), line('C', 100), line('D', 100)],
      [line('B', 100), line('C', 60), line('D', 100), line('E', 5)],
      [line('B', 0), line('C', 60), line('D', 0)],
    );
    const v = Object.fromEntries(lines.map((l) => [l.part, l.verdict]));
    expect(v.A).toBe('ordered-not-arrived'); // ordered, none received
    expect(v.B).toBe('received-not-invoiced'); // received 100, invoiced 0
    expect(v.C).toBe('qty-gap'); // ordered 100, received 60
    expect(v.D).toBe('received-not-invoiced'); // received=ordered but invoiced 0
    expect(v.E).toBe('arrived-not-ordered'); // received with no order
  });

  it('flags a partial receipt as qty-gap, not received-not-invoiced', () => {
    const { lines } = matchThreeWay([line('P', 100)], [line('P', 50)], [line('P', 0)]);
    expect(lines[0].verdict).toBe('qty-gap'); // 50 units still outstanding on the order
  });

  it('flags an invoiced-only part as invoiced-not-received', () => {
    const { lines } = matchThreeWay([], [], [line('Z', 5)]);
    expect(lines[0]).toMatchObject({
      ordered: 0,
      received: 0,
      invoiced: 5,
      verdict: 'invoiced-not-received',
    });
  });

  it('is float-tolerant when receipts sum to a binary-imperfect total', () => {
    const { lines } = matchThreeWay(
      [line('F', 0.3)],
      [line('F', 0.1), line('F', 0.2)], // 0.1 + 0.2 = 0.30000000000000004
      [line('F', 0.3)],
    );
    expect(lines[0].verdict).toBe('matched');
  });

  it('reports a quantity-weighted unit price across duplicate order lines', () => {
    const { lines } = matchThreeWay(
      [line('W', 100, { PRICE: 7 }), line('W', 50, { PRICE: 8 })],
      [line('W', 150)],
      [line('W', 150)],
    );
    // (100*7 + 50*8) / 150 = 1100/150 = 7.33
    expect(lines[0]).toMatchObject({ ordered: 150, verdict: 'matched', unitPrice: 7.33 });
  });
});

describe('preflight', () => {
  const base = {
    header: { SUPNAME: '200001' },
    invoices: [{ SUPNAME: '200001', TOTPRICE: 100 }],
    goodsContent: [{ PARTNAME: 'X', WEIGHT: 0 }],
    customsEstimate: [{ PARTNAME: 'X', COUNTRYNAME: 'United States', CUSTOMSITEMNAME: null }],
  };

  it('passes a normal file (product present, no storno) with duty-free info', () => {
    const r = preflight(base);
    expect(r.ok).toBe(true);
    expect(r.blocking).toEqual([]);
    expect(r.info.join(' ')).toContain('duty-free');
    expect(r.advisory.join(' ')).toContain('weight'); // weights not populated
  });

  it('blocks a cost-only file (no product content / goods invoice)', () => {
    const r = preflight({
      header: { SUPNAME: '200001' },
      invoices: [{ SUPNAME: '200026', TOTPRICE: 100 }], // only a forwarder invoice
      goodsContent: [],
      customsEstimate: [],
    });
    expect(r.ok).toBe(false);
    expect(r.blocking.join(' ')).toContain('only cost lines');
  });

  it('blocks when a linked invoice is a credit/storno', () => {
    const r = preflight({ ...base, invoices: [{ SUPNAME: '200001', STORNOFLAG: 'Y' }] });
    expect(r.ok).toBe(false);
    expect(r.blocking.join(' ')).toContain('storno');
  });

  it('does NOT treat STORNOFLAG="N" as a storno', () => {
    const r = preflight({ ...base, invoices: [{ SUPNAME: '200001', STORNOFLAG: 'N' }] });
    expect(r.blocking).toEqual([]);
  });

  it('advises (not blocks) a blank-supplier file that has invoices', () => {
    const r = preflight({
      header: {},
      invoices: [{ SUPNAME: '200026' }],
      goodsContent: [],
      customsEstimate: [],
    });
    expect(r.ok).toBe(true);
    expect(r.advisory.join(' ')).toContain('blank');
  });

  it('accepts extra product lines (MANIVPARTS2) as product content', () => {
    const r = preflight({
      header: { SUPNAME: '200001' },
      invoices: [{ SUPNAME: '200026' }], // only a cost invoice
      goodsContent: [],
      extraProductLines: [{ PARTNAME: 'X' }],
      customsEstimate: [],
    });
    expect(r.blocking).toEqual([]);
  });

  it('flags PARTIAL missing weights, not just all-missing', () => {
    const r = preflight({
      ...base,
      goodsContent: [
        { PARTNAME: 'A', WEIGHT: 5 },
        { PARTNAME: 'B', WEIGHT: 0 },
      ],
    });
    expect(r.advisory.join(' ')).toContain('1 of 2');
  });
});

describe('computeLandedCost', () => {
  it('spreads ancillary cost value-weighted across parts and excludes VAT', () => {
    const r = computeLandedCost({
      header: { SUPNAME: '200001' },
      // goods invoice (own supplier) + a forwarder invoice. TOTPRICE (VAT-inclusive) is present so the
      // test proves ancillary uses pre-VAT DISPRICE (300), NOT the VAT-inclusive total (11793).
      invoices: [
        { SUPNAME: '200001', DISPRICE: 0 },
        { SUPNAME: '200026', DISPRICE: 300, TOTPRICE: 11793 },
      ],
      goodsContent: [
        { PARTNAME: 'A', TQUANT: 10 },
        { PARTNAME: 'B', TQUANT: 5 },
      ],
      customsEstimate: [
        { PARTNAME: 'A', PRICE: 300 }, // ILS goods value
        { PARTNAME: 'B', PRICE: 100 },
      ],
    });
    expect(r.ancillaryCostsILS).toBe(300); // pre-VAT DISPRICE, not TOTPRICE 11793
    expect(r.totalGoodsValueILS).toBe(400);
    const a = r.lines.find((l) => l.part === 'A');
    const b = r.lines.find((l) => l.part === 'B');
    // A holds 300/400 = 75% of value → 225 of the 300 ancillary; B holds 75.
    expect(a).toMatchObject({ goodsValueILS: 300, allocatedCostILS: 225, landedCostILS: 525 });
    expect(a?.unitLandedCostILS).toBe(52.5); // 525 / 10
    expect(b).toMatchObject({ allocatedCostILS: 75, landedCostILS: 175 });
    // Landed total conserves goods value + ancillary.
    expect(r.lines.reduce((s, l) => s + l.landedCostILS, 0)).toBe(700);
  });

  it('aggregates a part that spans multiple customs-estimate lines into one row', () => {
    const r = computeLandedCost({
      header: { SUPNAME: '200001' },
      invoices: [],
      goodsContent: [{ PARTNAME: 'A', TQUANT: 10 }],
      customsEstimate: [
        { PARTNAME: 'A', PRICE: 200 }, // same part, two origins
        { PARTNAME: 'A', PRICE: 100 },
      ],
    });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ part: 'A', goodsValueILS: 300, unitLandedCostILS: 30 });
  });

  it('treats ancillary as 0 and warns when the header supplier is blank', () => {
    const r = computeLandedCost({
      header: {},
      invoices: [{ SUPNAME: '200026', DISPRICE: 300 }],
      goodsContent: [{ PARTNAME: 'A', TQUANT: 10 }],
      customsEstimate: [{ PARTNAME: 'A', PRICE: 300 }],
    });
    expect(r.ancillaryCostsILS).toBe(0);
    expect(r.warnings.join(' ')).toContain('blank');
  });

  it('falls back to quantity-weighting (with a warning) when no customs values are populated', () => {
    const r = computeLandedCost({
      header: { SUPNAME: '200001' },
      invoices: [{ SUPNAME: '200026', DISPRICE: 300 }],
      goodsContent: [
        { PARTNAME: 'A', TQUANT: 30 },
        { PARTNAME: 'B', TQUANT: 10 },
      ],
      customsEstimate: [
        { PARTNAME: 'A', PRICE: 0 },
        { PARTNAME: 'B', PRICE: 0 },
      ],
    });
    expect(r.basis).toContain('quantity');
    expect(r.warnings.join(' ')).toContain('quantity');
    // Ancillary 300 spread by qty (30:10) → 225 / 75, never dropped.
    expect(r.lines.find((l) => l.part === 'A')?.allocatedCostILS).toBe(225);
    expect(r.lines.reduce((s, l) => s + l.allocatedCostILS, 0)).toBe(300);
  });
});

describe('goodsReadback', () => {
  it('sums unreleased TBALANCE across goods lines', () => {
    expect(
      goodsReadback([
        { PARTNAME: 'A', TBALANCE: 3 },
        { PARTNAME: 'B', TBALANCE: 2 },
      ]),
    ).toEqual({ goodsLines: 2, unreleasedQty: 5 });
  });

  it('reports 0 unreleased for a fully-released file', () => {
    expect(goodsReadback([{ TBALANCE: 0 }, { TBALANCE: 0 }])).toEqual({
      goodsLines: 2,
      unreleasedQty: 0,
    });
  });

  it('is defensive against a non-array subform value', () => {
    expect(goodsReadback(undefined)).toEqual({ goodsLines: 0, unreleasedQty: 0 });
    expect(goodsReadback({ PARTNAME: 'A', TBALANCE: 5 })).toEqual({
      goodsLines: 0,
      unreleasedQty: 0,
    });
  });
});
