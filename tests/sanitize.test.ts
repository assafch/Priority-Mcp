import { describe, expect, it } from 'vitest';
import { escapeODataString, sanitizeFieldName, sanitizeODataValue } from '../src/lib/sanitize.js';

describe('sanitizeODataValue', () => {
  it('preserves apostrophes, slashes and Hebrew (no longer destructive)', () => {
    expect(sanitizeODataValue("O'Brien")).toBe("O'Brien");
    expect(sanitizeODataValue('ABC/123')).toBe('ABC/123');
    expect(sanitizeODataValue('לקוח חשוב')).toBe('לקוח חשוב');
  });
  it('strips ASCII control characters', () => {
    const withControls = `abc${String.fromCharCode(9, 127)}`;
    expect(sanitizeODataValue(withControls)).toBe('abc');
  });
});

describe('escapeODataString', () => {
  it('doubles single quotes for hand-built literals', () => {
    expect(escapeODataString("O'Brien")).toBe("O''Brien");
    expect(escapeODataString('plain')).toBe('plain');
  });
});

describe('sanitizeFieldName', () => {
  it('keeps only alphanumerics and underscore', () => {
    expect(sanitizeFieldName('CUST_NAME')).toBe('CUST_NAME');
    expect(sanitizeFieldName("DROP'; --")).toBe('DROP');
  });
});
