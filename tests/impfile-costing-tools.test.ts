import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { registerImpfileCostingTools } from '../src/tools/impfile-costing.js';
import { registerImpfileTools } from '../src/tools/impfiles.js';

/**
 * impfile_cost_report and impfile_costing_readiness only read, take every figure from Priority,
 * and say "unknown" instead of guessing when a read fails. Fixtures are invented.
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

type Register = (server: McpServer, client: PriorityClient, config: Config) => void;
function harness(register: Register = registerImpfileCostingTools) {
  const client = new PriorityClient(config, logger);
  type Handler = (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _desc: string, schema: z.ZodRawShape, fn: Handler) =>
      handlers.set(name, (p) => fn(z.object(schema).parse(p))),
  } as unknown as McpServer;
  register(server, client, config);
  return {
    call: async (name: string, p: unknown) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool missing: ${name}`);
      return JSON.parse((await handler(p)).content[0].text);
    },
  };
}
const respond = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const fileRecord = {
  IMPFNUM: 'IM1',
  STATDES: 'סופי',
  CLOSED: 'Y',
  SUPNAME: 'S1',
  WARHSNAME: 'arov',
  IMPFILEINV_SUBFORM: [
    {
      IVNUM: 'GI1',
      SUPNAME: 'S1',
      DEBIT: 'D',
      TYPE: 'P',
      IMPFILEIVS_SUBFORM: [
        { PARTNAME: 'P1', TQUANT: 100, QPRICE: 250, CODE: 'EUR', COUNTRYNAME: 'X', KLINE: 1 },
      ],
    },
    {
      IVNUM: 'GI2',
      SUPNAME: 'B1',
      DEBIT: 'D',
      TYPE: 'P',
      IMPFILEIVS_SUBFORM: [
        { PARTNAME: 'C1', TQUANT: 1, QPRICE: 300, CODE: 'ש"ח', COUNTRYNAME: null, KLINE: 1 },
        { PARTNAME: "מע'מ", TQUANT: 1, QPRICE: 180, CODE: 'ש"ח', COUNTRYNAME: null, KLINE: 2 },
      ],
    },
  ],
  IMPFILEITEMS_SUBFORM: [
    { PARTNAME: 'P1', TQUANT: 100, TBALANCE: 0, WEIGHT: 1 },
    { PARTNAME: "מע'מ", TQUANT: 0, TBALANCE: 0 },
  ],
  IMPFILECUSTOMS_SUBFORM: [{ PARTNAME: 'P1', COUNTRYNAME: 'X' }],
};
const releaseDoc = {
  DOCNO: 'BD1',
  IMPFNUM: 'IM1',
  STATDES: 'סופית',
  CURDATE: '2026-03-01T00:00:00Z',
  UDATE: '2026-03-01T10:00:00Z',
  DOCREF: '111',
  IVNUM: null,
  TRANSORDER_J_SUBFORM: [
    {
      PARTNAME: 'P1',
      TQUANT: 100,
      KLINE: 1,
      TRANSIMPFILE_SUBFORM: {
        TRANSCOST: 1000,
        CUSTOMSSUM: 0,
        DUTYCOST: 0,
        IMPFCOST: 300,
        TOTCOST: 1300,
        UDATE: '2026-03-01T09:50:00Z',
      },
    },
  ],
};

interface World {
  releases?: object[] | Error;
  logpart?: object[] | Error;
  costing?: object[] | Error;
  files?: object[];
}
function stubWorld(world: World = {}) {
  const pick = (v: object[] | Error | undefined, fallback: object[]) => {
    if (v instanceof Error) throw v;
    return respond({ value: v ?? fallback });
  };
  const fetchMock = vi.fn(async (url: unknown, init?: { method?: string }) => {
    if ((init?.method ?? 'GET') !== 'GET') throw new Error('unexpected write');
    const u = decodeURIComponent(String(url));
    if (u.includes("/IMPFILES('")) return respond(fileRecord);
    if (u.includes('/IMPFILES?')) {
      return respond({ value: world.files ?? [{ IMPFNUM: 'IM1', CLOSED: 'Y', STATDES: 'סופי' }] });
    }
    if (u.includes('/DOCUMENTS_P')) {
      return respond({
        value: [{ DOCNO: 'GR1', STATDES: 'סופית', TOWARHSNAME: 'arov', IVNUM: 'GI1' }],
      });
    }
    if (u.includes('/DOCUMENTS_J')) return pick(world.releases, [releaseDoc]);
    if (u.includes('/PINVOICES')) {
      return respond({
        value: [
          {
            IVNUM: 'GI1',
            DEBIT: 'D',
            PINVOICEITEMS_SUBFORM: [
              { PARTNAME: 'P1', TQUANT: 100, QPRICE: 250, CUSTOMSNUM: '111' },
            ],
          },
        ],
      });
    }
    if (u.includes('/COSTINGLOG')) return pick(world.costing, [{ UDATE: '2026-03-01T11:00:00Z' }]);
    if (u.includes('/LOGPART')) {
      return pick(world.logpart, [
        {
          PARTNAME: 'P1',
          COST: 12.5,
          COSTDATE: '2026-03-01T00:00:00Z',
          PARTTRANSLAST2_SUBFORM: [{ LOGDOCNO: 'BD1', TQUANT: 100, COST: 1300, TYPE: 'J' }],
        },
      ]);
    }
    throw new Error(`unexpected read ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const urls = (fetchMock: ReturnType<typeof stubWorld>) =>
  fetchMock.mock.calls.map(([u]) => decodeURIComponent(String(u)));

describe('impfile_cost_report', () => {
  it('reports the landed cost per product from Priority figures and reconciles to the agora', async () => {
    const fetchMock = stubWorld();
    const r = await harness().call('impfile_cost_report', { impfnum: 'IM1' });
    expect(r).toMatchObject({ mutates: false, currency: 'ILS', closed: true, fullyReleased: true });
    expect(r.byPart).toEqual([
      {
        part: 'P1',
        qty: 100,
        goodsILS: 1000,
        importILS: 300,
        totalILS: 1300,
        unitLandedILS: 13,
        movementCostILS: 1300,
        movementMatches: true,
        itemCostILS: 12.5,
        costingDate: '2026-03-01T00:00:00Z',
      },
    ]);
    expect(r.reconciliation).toMatchObject({
      importCostsOnReleases: 300,
      costInvoiceLinesTotal: 300,
      difference: 0,
      status: 'ties',
    });
    expect(r.stage.currentStep).toBeNull();
    expect(r.warnings).toEqual([]);
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('reads the per-line cost screen without a $select, and only the release rows of the product card', async () => {
    const fetchMock = stubWorld();
    await harness().call('impfile_cost_report', { impfnum: 'IM1' });
    const release = urls(fetchMock).find((u) => u.includes('/DOCUMENTS_J'));
    expect(release).toContain('TRANSORDER_J_SUBFORM($expand=TRANSIMPFILE_SUBFORM)');
    const card = urls(fetchMock).find((u) => u.includes('/LOGPART')) ?? '';
    expect(card).toContain("PARTTRANSLAST2_SUBFORM($filter=LOGDOCNO eq 'BD1'");
    expect(card).not.toContain('SUPCUSTDES');
    expect(card).not.toContain('SUPCUSTNAME');
  });

  it('pages the products so that none is dropped by the output size limit', async () => {
    const lines = Array.from({ length: 45 }, (_, i) => ({
      PARTNAME: `P${i + 1}`,
      PDES: 'תיאור מוצר ארוך '.repeat(3),
      TQUANT: 10,
      KLINE: i + 1,
      TRANSIMPFILE_SUBFORM: {
        TRANSCOST: 100,
        CUSTOMSSUM: 0,
        DUTYCOST: 0,
        IMPFCOST: 30,
        TOTCOST: 130,
        UDATE: '2026-03-01T09:50:00Z',
      },
    }));
    stubWorld({ releases: [{ ...releaseDoc, TRANSORDER_J_SUBFORM: lines }], logpart: [] });
    const h = harness();
    const first = await h.call('impfile_cost_report', { impfnum: 'IM1' });
    expect(first.parts).toEqual({ total: 45, skip: 0, returned: 30, nextSkip: 30 });
    expect(first.byPart).toHaveLength(30);
    expect(first.byPart_truncated).toBeUndefined();
    expect(first.totals).toEqual({ goodsILS: 4500, importILS: 1350, totalILS: 5850 });
    expect(first.releases).toEqual([
      {
        docno: 'BD1',
        status: 'סופית',
        date: '2026-03-01T00:00:00Z',
        declaration: '111',
        lines: 45,
        linesWithoutCost: 0,
      },
    ]);
    const second = await h.call('impfile_cost_report', {
      impfnum: 'IM1',
      skip: first.parts.nextSkip,
    });
    expect(second.parts).toEqual({ total: 45, skip: 30, returned: 15, nextSkip: null });
    expect(second.totals).toEqual(first.totals);
    const seen = new Set([...first.byPart, ...second.byPart].map((x: { part: string }) => x.part));
    expect(seen.size).toBe(45);
  });

  it('says unknown instead of guessing when the releases cannot be read', async () => {
    stubWorld({ releases: new DOMException('timeout', 'TimeoutError') });
    const r = await harness().call('impfile_cost_report', { impfnum: 'IM1' });
    expect(r.byPart).toEqual([]);
    expect(r.reconciliation.status).toBe('unknown');
    expect(r.stage.currentStep).toBe(8);
    expect(r.warnings.join(' ')).toContain('תעודות השחרור');
  });

  it('keeps the shipment cost and warns when the product cards cannot be read', async () => {
    stubWorld({ logpart: new DOMException('timeout', 'TimeoutError') });
    const r = await harness().call('impfile_cost_report', { impfnum: 'IM1' });
    expect(r.byPart[0]).toMatchObject({
      unitLandedILS: 13,
      itemCostILS: null,
      movementCostILS: null,
    });
    expect(r.warnings.join(' ')).toContain('כרטיסי הפריט');
  });

  it('flags a final release whose line has no import costs', async () => {
    stubWorld({
      releases: [
        {
          ...releaseDoc,
          TRANSORDER_J_SUBFORM: [
            { PARTNAME: 'P1', TQUANT: 100, KLINE: 1, TRANSIMPFILE_SUBFORM: null },
          ],
        },
      ],
    });
    const r = await harness().call('impfile_cost_report', { impfnum: 'IM1' });
    expect(r.byPart[0].unitLandedILS).toBeNull();
    expect(r.stage.currentStep).toBe(9);
    expect(r.warnings.join(' ')).toContain('בלי העלויות הנלוות');
  });
});

describe('impfile_costing_readiness', () => {
  it('is ready and not needed when costing ran after every release', async () => {
    const fetchMock = stubWorld();
    const r = await harness().call('impfile_costing_readiness', { since: '2026-01-01' });
    expect(r).toMatchObject({
      mutates: false,
      since: '2026-01-01',
      readyToRun: true,
      costingNeeded: false,
      blockers: [],
      pendingFiles: [],
    });
    expect(urls(fetchMock).find((u) => u.includes('/DOCUMENTS_J'))).toContain(
      'CURDATE ge 2026-01-01T00:00:00Z',
    );
  });

  it('needs a run when a release is newer than the last costing', async () => {
    stubWorld({ costing: [{ UDATE: '2026-02-01T00:00:00Z' }] });
    const r = await harness().call('impfile_costing_readiness', {});
    expect(r).toMatchObject({ readyToRun: true, costingNeeded: true, pendingFiles: ['IM1'] });
  });

  it('blocks when a final release sits on an open file', async () => {
    stubWorld({ files: [{ IMPFNUM: 'IM1', CLOSED: null, STATDES: 'טיוטא' }] });
    const r = await harness().call('impfile_costing_readiness', {});
    expect(r.readyToRun).toBe(false);
    expect(r.blockers.join(' ')).toContain('שאינו סגור');
  });

  it('is not ready when the costing log cannot be read', async () => {
    stubWorld({ costing: new DOMException('timeout', 'TimeoutError') });
    const r = await harness().call('impfile_costing_readiness', {});
    expect(r.readyToRun).toBe(false);
    expect(r.costingNeeded).toBeNull();
  });

  it('rejects a malformed date', async () => {
    stubWorld();
    await expect(
      harness().call('impfile_costing_readiness', { since: '1.1.2026' }),
    ).rejects.toThrow();
  });
});

describe('impfile_preflight', () => {
  it('carries the twelve official steps with the current one', async () => {
    stubWorld();
    const r = await harness(registerImpfileTools).call('impfile_preflight', { impfnum: 'IM1' });
    expect(r.official.steps).toHaveLength(12);
    expect(r.official.currentStep).toBeNull();
    expect(r.official.violations).toEqual([]);
    expect(r.stage.closed).toBe(true);
  });
});
