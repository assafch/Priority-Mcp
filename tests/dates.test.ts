import { describe, expect, it } from 'vitest';
import { dateFrom, dateTo, toODataDateTime } from '../src/lib/dates.js';

describe('toODataDateTime', () => {
  it('expands a date-only literal to a full UTC datetimeoffset (Priority rejects bare dates)', () => {
    expect(toODataDateTime('2026-05-01')).toBe('2026-05-01T00:00:00Z');
    expect(toODataDateTime('2026-05-31', { endOfDay: true })).toBe('2026-05-31T23:59:59Z');
  });

  it('passes through values that already carry a zone offset', () => {
    expect(toODataDateTime('2026-05-01T08:30:00Z')).toBe('2026-05-01T08:30:00Z');
    expect(toODataDateTime('2026-05-01T08:30:00+02:00')).toBe('2026-05-01T08:30:00+02:00');
  });

  it('tags an offset-less datetime as UTC (this install 400s without an offset)', () => {
    expect(toODataDateTime('2026-05-01T10:30')).toBe('2026-05-01T10:30Z');
    expect(toODataDateTime('2026-05-01T10:30:00')).toBe('2026-05-01T10:30:00Z');
    expect(toODataDateTime('2026-05-01 10:30:00')).toBe('2026-05-01T10:30:00Z'); // space separator
  });

  it('dateFrom/dateTo bracket a day for inclusive range filters', () => {
    expect(dateFrom('2026-05-01')).toBe('2026-05-01T00:00:00Z');
    expect(dateTo('2026-05-31')).toBe('2026-05-31T23:59:59Z');
  });
});
