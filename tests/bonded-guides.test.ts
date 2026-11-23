import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { registerBondedTools } from '../src/tools/impfiles-bonded.js';

/**
 * The bonded guides never write. They say who does each step and read back what Priority shows:
 * the stage of the file before a release, and the per-line import costs after it.
 */
const config = {
  priorityBaseUrl: 'https://p.test/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityPat: 'x',
  priorityReadOnly: false,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 10000,
  requestTimeoutMs: 500,
  logLevel: 'error',
} as unknown as Config;
const logger = createLogger(config);

afterEach(() => vi.unstubAllGlobals());

function harness() {
  const client = new PriorityClient(config, logger);
  type Handler = (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const handlers = new Map<string, Handler>();
  const descriptions = new Map<string, string>();
  const server = {
    tool: (name: string, desc: string, schema: z.ZodRawShape, fn: Handler) => {
      descriptions.set(name, desc);
      handlers.set(name, (p) => fn(z.object(schema).parse(p)));
    },
  } as unknown as McpServer;
  registerBondedTools(server, client, config);
  return {
    descriptions,
    call: async (name: string, p: unknown) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool missing: ${name}`);
      return JSON.parse((await handler(p)).content[0].text);
    },
  };
}

function respond(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function stub(file: object, releases: object[] | Error) {
  const fetchMock = vi.fn(async (url: unknown, init?: { method?: string }) => {
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('unexpected write');
    const u = decodeURIComponent(String(url));
    if (u.includes('/DOCUMENTS_J')) {
      if (releases instanceof Error) throw releases;
      return respond({ value: releases });
    }
    if (u.includes('/DOCUMENTS_P')) return respond({ value: [] });
    return respond(file);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const closedFile = { IMPFNUM: 'IM1', STATDES: 'סופי', CLOSED: 'Y' };
const release = {
  DOCNO: 'BD1',
  STATDES: 'סופית',
  TRANSORDER_J_SUBFORM: [
    {
      PARTNAME: 'P1',
      TQUANT: 5,
      KLINE: 1,
      TRANSIMPFILE_SUBFORM: { IMPFCOST: 12.5, TOTCOST: 50, UDATE: '2026-01-01T00:00:00Z' },
    },
    {
      PARTNAME: 'P2',
      TQUANT: 3,
      KLINE: 2,
      TRANSIMPFILE_SUBFORM: { IMPFCOST: null, TOTCOST: null, UDATE: null },
    },
    { PARTNAME: 'P3', TQUANT: 1, KLINE: 3, TRANSIMPFILE_SUBFORM: null },
  ],
};

describe('bonded_line_costs_guide', () => {
  it('counts released lines that carry no import cost', async () => {
    const fetchMock = stub(closedFile, [release]);
    const r = await harness().call('bonded_line_costs_guide', { impfnum: 'IM1' });
    expect(r.lineCosts).toEqual([{ docno: 'BD1', status: 'סופית', lines: 3, linesWithoutCost: 2 }]);
    expect(r.warnings.join(' ')).toContain('BD1');
    expect(r.mutates).toBe(false);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('has no warning when every line of a final release is costed', async () => {
    stub(closedFile, [
      { ...release, TRANSORDER_J_SUBFORM: [release.TRANSORDER_J_SUBFORM[0]] },
      { DOCNO: 'BD2', STATDES: 'טיוטא', TRANSORDER_J_SUBFORM: [release.TRANSORDER_J_SUBFORM[1]] },
    ]);
    const r = await harness().call('bonded_line_costs_guide', { impfnum: 'IM1' });
    expect(r.warnings).toEqual([]);
    expect(r.lineCosts).toHaveLength(2);
  });

  it('reports an unreadable release list as unknown, not as costed', async () => {
    stub(closedFile, new DOMException('timeout', 'TimeoutError'));
    const r = await harness().call('bonded_line_costs_guide', { impfnum: 'IM1' });
    expect(r.lineCosts).toBeNull();
    expect(r.warnings.join(' ')).toContain('לא ניתן היה לקרוא');
  });
});

describe('bonded_release_guide', () => {
  it('lists what is missing before a release on an open file', async () => {
    stub({ IMPFNUM: 'IM1', STATDES: 'טיוטא', CLOSED: null, IMPFILEITEMS_SUBFORM: [] }, []);
    const r = await harness().call('bonded_release_guide', { impfnum: 'IM1' });
    expect(r.mutates).toBe(false);
    expect(r.fileClosed).toBe(false);
    expect(r.warnings.length).toBeGreaterThan(1);
    expect(r.instructions.join(' ')).toContain('רישום עלויות יבוא לשורה');
  });
});

describe('guide descriptions', () => {
  it('none claims the step is impossible over the API', () => {
    const { descriptions } = harness();
    expect(descriptions.size).toBe(5);
    for (const text of descriptions.values()) {
      expect(text).not.toMatch(/not OData-writable|UI-only/i);
    }
  });
});
