import { describe, expect, it } from 'vitest';
import { parseRetryAfterMs } from '../src/client/errors.js';
import { isRetryable, isSafeEntityName } from '../src/client/priority-client.js';

describe('isRetryable (retry policy — no duplicate writes)', () => {
  it('retries GET on 5xx, 429, and network errors (idempotent)', () => {
    expect(isRetryable('GET', 500)).toBe(true);
    expect(isRetryable('GET', 502)).toBe(true);
    expect(isRetryable('GET', 503)).toBe(true);
    expect(isRetryable('GET', 429)).toBe(true);
    expect(isRetryable('GET', undefined)).toBe(true); // network-level TypeError
  });

  it('never retries deterministic 4xx client errors (any method)', () => {
    for (const m of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
      expect(isRetryable(m, 400)).toBe(false);
      expect(isRetryable(m, 401)).toBe(false);
      expect(isRetryable(m, 403)).toBe(false);
      expect(isRetryable(m, 404)).toBe(false);
    }
  });

  it('does NOT retry writes on 5xx or network errors (ambiguous commit ⇒ duplicate risk)', () => {
    for (const m of ['POST', 'PATCH', 'DELETE'] as const) {
      expect(isRetryable(m, 500)).toBe(false);
      expect(isRetryable(m, 502)).toBe(false);
      expect(isRetryable(m, 503)).toBe(false);
      expect(isRetryable(m, undefined)).toBe(false); // network failure after possible commit
    }
  });

  it('DOES retry writes on a clean 429 (server rejected before processing)', () => {
    for (const m of ['POST', 'PATCH', 'DELETE'] as const) {
      expect(isRetryable(m, 429)).toBe(true);
    }
  });

  it('never retries 501/505 (permanent server-side limitations)', () => {
    for (const m of ['GET', 'POST'] as const) {
      expect(isRetryable(m, 501)).toBe(false); // e.g. unsupported OData function
      expect(isRetryable(m, 505)).toBe(false);
    }
  });
});

describe('isSafeEntityName (path-traversal guard)', () => {
  it('accepts plain form names and legitimate OData navigation', () => {
    expect(isSafeEntityName('CUSTOMERS')).toBe(true);
    expect(isSafeEntityName('AINVOICES')).toBe(true);
    expect(
      isSafeEntityName("AINVOICES(IVNUM='IN1',DEBIT='D',IVTYPE='A')/AINVOICEITEMS_SUBFORM"),
    ).toBe(true);
  });

  it('rejects traversal that would escape the company path', () => {
    expect(isSafeEntityName('../demodata/CUSTOMERS')).toBe(false);
    expect(isSafeEntityName('CUSTOMERS/../../other/CUSTOMERS')).toBe(false);
    expect(isSafeEntityName('/etc/passwd')).toBe(false);
    expect(isSafeEntityName('..\\other\\CUSTOMERS')).toBe(false);
    expect(isSafeEntityName('%2e%2e/otherCompany/CUSTOMERS')).toBe(false); // percent-encoded ..
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30000);
    expect(parseRetryAfterMs('0')).toBe(0);
  });
  it('parses an HTTP-date relative to now', () => {
    const now = 1_000_000;
    expect(parseRetryAfterMs(new Date(now + 5000).toUTCString(), now)).toBeGreaterThanOrEqual(4000);
  });
  it('returns undefined for missing or unparseable values', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });
});
