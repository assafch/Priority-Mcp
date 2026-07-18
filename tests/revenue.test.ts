import { describe, expect, it } from 'vitest';
import {
  FINAL_INVOICE_STATUS,
  groupRevenueByMonth,
  rankCustomersByRevenue,
  sumInvoiceRevenue,
} from '../src/lib/revenue.js';

// AINVOICES header rows: TOTPRICE is VAT-inclusive (payable), VAT is the tax, so the
// pre-VAT net revenue is TOTPRICE - VAT. These fixtures mirror live shapes from the audit
// (e.g. IN264000240: QPRICE/net 4147.45, VAT 746.55, TOTPRICE 4894.00).
const rows = [
  { IVNUM: 'A1', IVDATE: '2026-01-05T00:00:00Z', CUSTNAME: 'C1', VAT: 746.55, TOTPRICE: 4894 },
  { IVNUM: 'A2', IVDATE: '2026-01-20T00:00:00Z', CUSTNAME: 'C2', VAT: 18, TOTPRICE: 118 },
  { IVNUM: 'A3', IVDATE: '2026-02-10T00:00:00Z', CUSTNAME: 'C1', VAT: 18, TOTPRICE: 118 },
];

describe('sumInvoiceRevenue', () => {
  it('reports net as VAT-exclusive (TOTPRICE - VAT), not the VAT-inclusive gross', () => {
    const t = sumInvoiceRevenue(rows);
    expect(t.grossWithVat).toBeCloseTo(4894 + 118 + 118, 2);
    expect(t.vat).toBeCloseTo(746.55 + 18 + 18, 2);
    expect(t.netRevenue).toBeCloseTo(4894 + 118 + 118 - (746.55 + 18 + 18), 2);
    // The old bug summed TOTPRICE and called it revenue — net must be strictly less.
    expect(t.netRevenue).toBeLessThan(t.grossWithVat);
    expect(t.count).toBe(3);
  });

  it('treats a missing VAT field as zero (net falls back to gross)', () => {
    const t = sumInvoiceRevenue([{ TOTPRICE: 100 }]);
    expect(t.netRevenue).toBe(100);
    expect(t.vat).toBe(0);
  });

  it('nets credit memos (negative TOTPRICE) down', () => {
    const t = sumInvoiceRevenue([
      { TOTPRICE: 118, VAT: 18 },
      { TOTPRICE: -118, VAT: -18 }, // credit memo
    ]);
    expect(t.netRevenue).toBeCloseTo(0, 6);
    expect(t.grossWithVat).toBeCloseTo(0, 6);
  });

  it('is empty-safe', () => {
    expect(sumInvoiceRevenue([])).toEqual({ netRevenue: 0, vat: 0, grossWithVat: 0, count: 0 });
  });
});

describe('rankCustomersByRevenue', () => {
  it('aggregates by CUSTNAME across pages and ranks by net revenue descending', () => {
    const ranked = rankCustomersByRevenue(rows, 10);
    expect(ranked.map((r) => r.custName)).toEqual(['C1', 'C2']);
    // C1 spans two invoices (A1 + A3) — proves cross-row aggregation, the multi-page bug.
    expect(ranked[0].invoiceCount).toBe(2);
    expect(ranked[0].netRevenue).toBeCloseTo(4894 - 746.55 + (118 - 18), 2);
    expect(ranked[0].grossWithVat).toBeCloseTo(4894 + 118, 2);
  });

  it('respects the topN slice', () => {
    expect(rankCustomersByRevenue(rows, 1)).toHaveLength(1);
    expect(rankCustomersByRevenue(rows, 1)[0].custName).toBe('C1');
  });

  it('coalesces a missing CUSTNAME into a single empty-name bucket', () => {
    const ranked = rankCustomersByRevenue([{ TOTPRICE: 10 }, { TOTPRICE: 20 }], 10);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].invoiceCount).toBe(2);
  });
});

describe('groupRevenueByMonth', () => {
  it('buckets by YYYY-MM, sorted ascending, with per-month net/gross totals', () => {
    const months = groupRevenueByMonth(rows);
    expect(months.map((m) => m.period)).toEqual(['2026-01', '2026-02']);
    expect(months[0].count).toBe(2);
    expect(months[0].grossWithVat).toBeCloseTo(4894 + 118, 2);
    expect(months[1].period).toBe('2026-02');
    expect(months[1].netRevenue).toBeCloseTo(118 - 18, 2);
  });

  it('skips rows with an unparseable IVDATE rather than crashing', () => {
    const months = groupRevenueByMonth([{ IVDATE: null, TOTPRICE: 5 }, ...rows]);
    expect(months.map((m) => m.period)).toEqual(['2026-01', '2026-02']);
  });
});

describe('FINAL_INVOICE_STATUS', () => {
  it('is the Hebrew "final" status that excludes drafts and cancelled invoices', () => {
    // Drafts are 'טיוטא', cancelled are 'מבוטלת'; only 'סופית' rows are real revenue.
    expect(FINAL_INVOICE_STATUS).toBe('סופית');
  });
});
