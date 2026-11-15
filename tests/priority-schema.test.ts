import { describe, expect, it } from 'vitest';
import { getDateField, getSchema, isCompositeKey } from '../src/lib/priority-schema.js';

describe('priority-schema', () => {
  it('uses IVDATE for AINVOICES (not CURDATE — the bug that broke invoice date filters)', () => {
    expect(getDateField('AINVOICES')).toBe('IVDATE');
    const s = getSchema('AINVOICES');
    expect(s?.defaultSelect).toContain('IVDATE');
    expect(s?.defaultSelect).not.toContain('CURDATE');
  });

  it('uses CURDATE for ORDERS and PORDERS (verified to exist on those forms)', () => {
    expect(getDateField('ORDERS')).toBe('CURDATE');
    expect(getDateField('PORDERS')).toBe('CURDATE');
  });

  it('returns undefined date field for unknown forms', () => {
    expect(getDateField('NOPE')).toBeUndefined();
    expect(getSchema('NOPE')).toBeUndefined();
  });

  it('flags AINVOICES as composite-keyed (single-value .get would 404)', () => {
    expect(isCompositeKey('AINVOICES')).toBe(true);
    expect(getSchema('AINVOICES')?.key).toEqual(['IVNUM', 'DEBIT', 'IVTYPE']);
  });

  it('treats single-key and unknown forms as non-composite', () => {
    expect(isCompositeKey('ORDERS')).toBe(false);
    expect(isCompositeKey('CUSTOMERS')).toBe(false);
    expect(isCompositeKey('NOPE')).toBe(false);
  });

  it('only lists verified-existing search fields for CUSTOMERS', () => {
    const s = getSchema('CUSTOMERS');
    expect(s?.searchFields).toEqual(['CUSTDES', 'CUSTNAME', 'PHONE', 'EMAIL', 'WTAXNUM']);
    // SNAME / CUSTBALANCE do NOT exist on this install and must not be projected.
    expect(s?.defaultSelect).not.toContain('SNAME');
    expect(s?.defaultSelect).not.toContain('CUSTBALANCE');
  });
});
