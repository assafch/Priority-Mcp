import { describe, expect, it } from 'vitest';
import { fetchAllPages } from '../src/lib/paginate.js';

/** A fake pager over an in-memory array that records how it was called. */
function pagerOver(total: number) {
  const all = Array.from({ length: total }, (_, i) => i);
  const calls: Array<{ skip: number; top: number }> = [];
  const fetchPage = async (skip: number, top: number) => {
    calls.push({ skip, top });
    return all.slice(skip, skip + top);
  };
  return { fetchPage, calls };
}

describe('fetchAllPages', () => {
  it('collects EVERY row across multiple pages (the truncation bug fix)', async () => {
    const { fetchPage, calls } = pagerOver(1250);
    const scan = await fetchAllPages(fetchPage, { pageSize: 500, maxRows: 100000 });
    expect(scan.rows).toHaveLength(1250);
    expect(scan.capped).toBe(false);
    // 500 + 500 + 250(short) => 3 pages, stopping on the short page.
    expect(scan.pages).toBe(3);
    expect(calls.map((c) => c.skip)).toEqual([0, 500, 1000]);
  });

  it('stops after a single short page without a wasted extra request', async () => {
    const { fetchPage, calls } = pagerOver(42);
    const scan = await fetchAllPages(fetchPage, { pageSize: 500 });
    expect(scan.rows).toHaveLength(42);
    expect(scan.pages).toBe(1);
    expect(calls).toHaveLength(1);
    expect(scan.capped).toBe(false);
  });

  it('stops after an exactly-full final page (next fetch returns empty)', async () => {
    const { fetchPage } = pagerOver(1000);
    const scan = await fetchAllPages(fetchPage, { pageSize: 500 });
    // 500 + 500(full) + 0(empty short) => detects exhaustion on the empty page.
    expect(scan.rows).toHaveLength(1000);
    expect(scan.pages).toBe(3);
    expect(scan.capped).toBe(false);
  });

  it('caps at maxRows and flags the scan as incomplete', async () => {
    const { fetchPage } = pagerOver(10000);
    const scan = await fetchAllPages(fetchPage, { pageSize: 500, maxRows: 1000 });
    expect(scan.capped).toBe(true);
    expect(scan.rows.length).toBeGreaterThanOrEqual(1000);
    // Must not scan the whole 10k once the cap is reached.
    expect(scan.rows.length).toBeLessThan(10000);
  });

  it('is empty-safe (no rows, one probing request)', async () => {
    const { fetchPage, calls } = pagerOver(0);
    const scan = await fetchAllPages(fetchPage, { pageSize: 500 });
    expect(scan.rows).toHaveLength(0);
    expect(scan.pages).toBe(1);
    expect(calls).toHaveLength(1);
  });
});
