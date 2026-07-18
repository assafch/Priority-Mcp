import { describe, expect, it } from 'vitest';
import { textResult } from '../src/lib/write-guard.js';

describe('textResult size guard', () => {
  it('returns small results unchanged', () => {
    const data = { invoices: [{ IVNUM: 'IN1', TOTPRICE: 100 }], count: 1 };
    const text = textResult(data).content[0].text;
    expect(JSON.parse(text)).toEqual(data);
    expect(text).not.toContain('_truncated');
  });

  it('truncates an oversized array and annotates what was omitted', () => {
    const invoices = Array.from({ length: 4000 }, (_, i) => ({
      IVNUM: `IN26400${i}`,
      CDES: 'יעד כימיה בע"מ',
      DETAILS: 'x'.repeat(40),
      TOTPRICE: 1000 + i,
    }));
    const text = textResult({ invoices, count: invoices.length }).content[0].text;

    // Must stay under the budget so the harness never spills it to a temp file.
    expect(text.length).toBeLessThanOrEqual(24000);

    const parsed = JSON.parse(text); // still valid JSON
    expect(parsed.invoices.length).toBeLessThan(4000);
    expect(parsed.invoices.length).toBeGreaterThan(0);
    expect(parsed.invoices_truncated).toBeDefined();
    expect(parsed.invoices_truncated.omitted).toBe(4000 - parsed.invoices.length);
  });

  it('keeps non-array scalar fields intact while trimming the big array', () => {
    const big = {
      meta: { customer: '11005' },
      rows: Array.from({ length: 5000 }, (_, i) => ({ id: i, blob: 'y'.repeat(30) })),
    };
    const parsed = JSON.parse(textResult(big).content[0].text);
    expect(parsed.meta).toEqual({ customer: '11005' });
    expect(parsed.rows.length).toBeLessThan(5000);
  });

  it('hard-clamps an unshrinkable object (no top-level array to trim)', () => {
    // capLargeArrays can do nothing here — must still never exceed the ceiling.
    const text = textResult({ invoice: { DETAILS: 'x'.repeat(40000) } }).content[0].text;
    expect(text.length).toBeLessThanOrEqual(24000 + 120);
    expect(text).toContain('truncated');
  });

  it('hard-clamps a one-element array whose single element is enormous', () => {
    const text = textResult({ rows: [{ blob: 'z'.repeat(40000) }] }).content[0].text;
    expect(text.length).toBeLessThanOrEqual(24000 + 120);
    expect(text).toContain('truncated');
  });
});
