import { describe, expect, it } from 'vitest';
import { textResult } from '../src/lib/write-guard.js';

describe('bounded machine-readable results', () => {
  it('keeps a huge nested object valid and within the advertised budget', () => {
    const result = textResult({ invoice: { IVNUM: 'synthetic', DETAILS: 'x'.repeat(40000) } });
    expect(result.content[0].text.length).toBeLessThanOrEqual(24000);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(result.structuredContent);
    expect(parsed.invoice.IVNUM).toBe('synthetic');
    expect(JSON.stringify(parsed)).toContain('truncated');
  });
  it('makes arrays and scalar results structured without losing the payload', () => {
    expect(textResult([1, 2]).structuredContent).toEqual({ value: [1, 2] });
    expect(textResult('ok').structuredContent).toEqual({ value: 'ok' });
  });
  it('does not mutate source arrays or the caller object', () => {
    const input = { rows: Array.from({ length: 4000 }, (_, id) => ({ id, text: 'x'.repeat(30) })) };
    const result = textResult(input);
    expect(input.rows.length).toBe(4000);
    expect(result.structuredContent.rows_truncated).toBeDefined();
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
  });
});

it('marks truncated catalog pages incomplete and provides the actual next offset', () => {
  const result = textResult({
    capabilities: Array.from({ length: 100 }, (_, i) => ({
      name: String(i),
      description: 'x'.repeat(600),
    })),
    returned: 100,
    skip: 20,
    nextSkip: null,
    meta: { complete: true },
  });
  const data = result.structuredContent as {
    capabilities: unknown[];
    returned: number;
    nextSkip: number;
    meta: { complete: boolean };
  };
  expect(data.meta.complete).toBe(false);
  expect(data.returned).toBe(data.capabilities.length);
  expect(data.nextSkip).toBe(20 + data.capabilities.length);
});

it('does not silently truncate an array nested directly inside another array', () => {
  const result = textResult({ value: [Array.from({ length: 20000 }, (_, i) => i)] });
  const payload = result.structuredContent as { value: number[][]; _truncated?: unknown };
  expect(payload.value[0].length).toBeLessThan(20000);
  expect(payload._truncated).toBeDefined();
  expect(JSON.stringify(payload._truncated)).toContain('omitted');
});
