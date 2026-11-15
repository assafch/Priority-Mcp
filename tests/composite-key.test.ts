import { describe, expect, it } from 'vitest';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';

const config = {
  priorityBaseUrl: 'https://p.example/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityPat: 'tok',
  priorityReadOnly: true,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 120,
  requestTimeoutMs: 120000,
  logLevel: 'error',
} as unknown as Config;

const client = new PriorityClient(config, createLogger(config));

describe('resolveCompositeUrl', () => {
  it('builds a composite-key predicate for PINVOICES', () => {
    expect(
      client.resolveCompositeUrl('PINVOICES', { IVNUM: 'GI25000025', DEBIT: 'D', IVTYPE: 'P' }),
    ).toBe(
      "https://p.example/odata/Priority/tabula.ini/demo/PINVOICES(IVNUM='GI25000025',DEBIT='D',IVTYPE='P')",
    );
  });

  it('doubles embedded quotes (OData escape) and emits numbers bare', () => {
    const url = client.resolveCompositeUrl('X', { A: "O'B", N: 5 });
    // encodeURIComponent leaves apostrophes untouched, so the doubled-quote OData escape survives.
    expect(url).toContain("A='O''B'"); // O'B → O''B
    expect(url).toContain('N=5');
  });

  it('appends a query string when provided', () => {
    const url = client.resolveCompositeUrl(
      'PINVOICES',
      { IVNUM: 'x', DEBIT: 'D', IVTYPE: 'P' },
      '?$select=IMPFNUM',
    );
    expect(url.endsWith("IVTYPE='P')?$select=IMPFNUM")).toBe(true);
  });
});
