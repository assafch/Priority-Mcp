import { describe, expect, it } from 'vitest';
import { evidenceSchema, formatResult } from '../src/lib/result-contracts.js';
const meta = {
  source: 'fixture',
  observedAt: '2026-10-25T00:00:00Z',
  freshness: 'live' as const,
  complete: true,
  warnings: [],
  traceId: 'test',
  nextCursor: null,
};
describe('bounded summaries', () => {
  it('preserves full-source aggregate completeness while bounding display rows', () => {
    const result = formatResult(
      {
        rows: Array.from({ length: 100 }, (_, i) => ({ id: i, name: 'a'.repeat(200) })),
        total: 100,
      },
      { mode: 'summary', rowLimit: 25, meta },
    );
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(result.content[0].text.length).toBeLessThanOrEqual(8000);
    expect(result.structuredContent.meta.complete).toBe(true);
    expect(result.structuredContent.meta.outputTruncated).toBe(true);
    expect(result.structuredContent.total).toBe(100);
    expect(result.structuredContent.rows.length).toBeLessThanOrEqual(25);
    expect(evidenceSchema.safeParse(result.structuredContent.meta).success).toBe(true);
  });
});

it('preserves the typed workflow envelope when wide data exceeds the summary budget', async () => {
  const { outputSchemaFor } = await import('../src/lib/result-contracts.js');
  const result = formatResult(
    {
      identity: { form: 'CUSTOMERS', keys: { CUSTNAME: '0012' } },
      sections: {
        identity: {
          status: 'available',
          data: Object.fromEntries(
            Array.from({ length: 100 }, (_, i) => [`FIELD${i}`, 'אב'.repeat(75)]),
          ),
          meta,
        },
        balance: { status: 'available', data: { amount: 12 }, meta },
      },
    },
    { mode: 'summary', rowLimit: 25, meta },
  );
  expect(
    outputSchemaFor('priority_customer_snapshot').safeParse(result.structuredContent).success,
  ).toBe(true);
  expect(result.content[0].text.length).toBeLessThanOrEqual(8000);
  expect(result.structuredContent.meta.outputTruncated).toBe(true);
});

it('keeps authoritative retained-source age separate from current request observations', async () => {
  const { createOperation, withOperation, recordReadObservation } = await import(
    '../src/runtime/operation-context.js'
  );
  const { textResult } = await import('../src/lib/tool-result.js');
  const ctx = createOperation('priority_product_sales_by_period');
  const earlier = '2026-10-01T00:00:00.000Z';
  const later = '2026-10-25T00:00:00.000Z';
  await withOperation(ctx, async () => {
    recordReadObservation(ctx, Date.parse(later), false, true);
    const value = textResult({
      total: 12,
      meta: {
        observedAt: earlier,
        firstObservedAt: earlier,
        lastObservedAt: later,
        freshness: 'stale',
        ageMs: 24 * 86400000,
        complete: true,
      },
    }).structuredContent;
    expect(value.meta).toMatchObject({
      observedAt: earlier,
      firstObservedAt: earlier,
      lastObservedAt: later,
      freshness: 'stale',
    });
    expect(value.meta.ageMs).toBeGreaterThanOrEqual(24 * 86400000);
    expect(value.meta.requestObservations.observedAt).toBe(later);
  });
});
