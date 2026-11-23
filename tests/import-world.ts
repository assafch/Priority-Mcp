import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { vi } from 'vitest';
import { z } from 'zod';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';

/**
 * A small in-memory Priority for the import-step tool tests: one import file, its invoices,
 * receipts and releases, served over a stubbed `fetch`. Reads answer from the state, writes
 * change it and are recorded, so a test can assert exactly what was sent and what a read-back
 * sees afterwards. Every value is invented.
 */
export type Row = Record<string, unknown>;

export const testConfig = {
  priorityBaseUrl: 'https://p.test/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityPat: 'x',
  priorityReadOnly: false,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 10000,
  requestTimeoutMs: 500,
  logLevel: 'error',
} as unknown as Config;
const BASE = 'https://p.test/odata/Priority/tabula.ini/demo/';

export interface Write {
  method: string;
  path: string;
  body: Row;
}

export interface World {
  file: Row;
  pinvoices: Row[];
  receipts: Row[];
  releases: Row[];
  /** COUNTRIES rows; 'blocked' answers like a form that is not exposed to the API. */
  countries: Row[] | 'blocked';
  /** Lines Priority "pulls" into a new receipt; default: the goods invoice's product lines. */
  pulledReceiptLines?: Row[];
  /** A request that never answers: the client gives up at its timeout (like a lost response). */
  hang?: (method: string, path: string) => boolean;
  /** Return a Response to short-circuit a request (inject a failure). */
  intercept?: (method: string, path: string, body: Row | undefined) => Response | undefined;
  /**
   * Forms that answer every read with 200 and an empty list, filtered or not: the episode seen
   * live on 2026-11-23, when a form's reads came back empty although its documents existed.
   */
  blind?: string[];
  writes: Write[];
  gets: string[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
export const priorityError = (status: number, message: string) =>
  json({ FORM: { InterfaceErrors: { text: message } } }, status);

const quoted = (path: string, field: string): string[] =>
  [...path.matchAll(new RegExp(`${field} eq '([^']*)'`, 'g'))].map((m) => m[1]);
/** An older, unrelated document: what an unfiltered read of a busy form always finds. */
const BACKGROUND: Record<string, Row> = {
  PINVOICES: { IVNUM: 'OLD1', DEBIT: 'D', IVTYPE: 'P' },
  DOCUMENTS_P: { DOCNO: 'OLDGR', TYPE: 'P' },
  DOCUMENTS_J: { DOCNO: 'OLDBD', TYPE: 'J' },
};
const keyPart = (segment: string, field: string): string | undefined =>
  segment.match(new RegExp(`${field}='([^']*)'`))?.[1] ??
  segment.match(new RegExp(`${field}=(\\d+)`))?.[1];

/** An open file: one final goods invoice (two products), one final cost invoice, nothing received. */
export function openWorld(over: Partial<World> = {}): World {
  return {
    file: {
      IMPFNUM: 'IM1',
      STATDES: 'טיוטא',
      CLOSED: null,
      SUPNAME: 'S1',
      WARHSNAME: 'arov',
      CUSTOMSNUM: 'D1',
      IMPFILEINV_SUBFORM: [
        {
          IVNUM: 'GI1',
          SUPNAME: 'S1',
          DEBIT: 'D',
          TYPE: 'P',
          IMPFILEIVS_SUBFORM: [
            { KLINE: 1, PARTNAME: 'P1', TQUANT: 10, QPRICE: 100, CODE: 'EUR', COUNTRYNAME: null },
            { KLINE: 2, PARTNAME: 'P2', TQUANT: 5, QPRICE: 50, CODE: 'EUR', COUNTRYNAME: null },
          ],
        },
        {
          IVNUM: 'GI2',
          SUPNAME: 'S2',
          DEBIT: 'D',
          TYPE: 'P',
          IMPFILEIVS_SUBFORM: [
            { KLINE: 1, PARTNAME: 'C1', TQUANT: 1, QPRICE: 300, CODE: 'ש"ח', COUNTRYNAME: null },
          ],
        },
      ],
      IMPFILEITEMS_SUBFORM: [],
      IMPFILECUSTOMS_SUBFORM: [],
    },
    pinvoices: [
      {
        IVNUM: 'GI1',
        DEBIT: 'D',
        IVTYPE: 'P',
        SUPNAME: 'S1',
        STATDES: 'סופית',
        IMPFNUM: 'IM1',
        CODE: 'EUR',
        TOTPRICE: 150,
        PINVOICEITEMS_SUBFORM: [
          {
            KLINE: 1,
            PARTNAME: 'P1',
            TQUANT: 10,
            CUSTOMSNUM: 'D1',
            CUSTOMSDATE: '2026-01-05T00:00:00Z',
          },
          {
            KLINE: 2,
            PARTNAME: 'P2',
            TQUANT: 5,
            CUSTOMSNUM: 'D1',
            CUSTOMSDATE: '2026-01-05T00:00:00Z',
          },
        ],
      },
    ],
    receipts: [],
    releases: [],
    countries: 'blocked',
    writes: [],
    gets: [],
    ...over,
  };
}

function lineOf(list: unknown, kline: string | undefined): Row | undefined {
  return (list as Row[] | undefined)?.find((l) => String(l.KLINE) === kline);
}

function handle(world: World, method: string, path: string, body: Row | undefined): Response {
  const short = world.intercept?.(method, path, body);
  if (short) return short;
  const [resource] = path.split('?');
  const segments = resource.split('/');
  const form = segments[0].replace(/\(.*$/, '');

  if (method === 'GET') {
    world.gets.push(path);
    if (world.blind?.includes(form)) return json({ value: [] });
    if (BACKGROUND[form] && !path.includes('$filter')) return json({ value: [BACKGROUND[form]] });
    if (form === 'IMPFILES') return json(world.file);
    if (form === 'COSTINGLOG') return json({ value: [] });
    if (form === 'COUNTRIES') {
      if (world.countries === 'blocked') return priorityError(400, 'לא ניתן להפעיל API למסך זה.');
      const wanted = quoted(path, 'COUNTRYNAME');
      return json({ value: world.countries.filter((c) => wanted.includes(String(c.COUNTRYNAME))) });
    }
    if (form === 'PINVOICES') {
      const wanted = quoted(path, 'IVNUM');
      return json({ value: world.pinvoices.filter((iv) => wanted.includes(String(iv.IVNUM))) });
    }
    if (form === 'IMPFILEIV') {
      const wanted = quoted(path, 'IVNUM');
      const linked = (world.file.IMPFILEINV_SUBFORM as Row[]) ?? [];
      return json({ value: linked.filter((iv) => wanted.includes(String(iv.IVNUM))) });
    }
    if (form === 'DOCUMENTS_P') {
      const ivnums = quoted(path, 'IVNUM');
      const docnos = quoted(path, 'DOCNO');
      return json({
        value: world.receipts.filter(
          (r) => ivnums.includes(String(r.IVNUM)) || docnos.includes(String(r.DOCNO)),
        ),
      });
    }
    if (form === 'DOCUMENTS_J') {
      const docnos = quoted(path, 'DOCNO');
      return json({
        value: docnos.length
          ? world.releases.filter((r) => docnos.includes(String(r.DOCNO)))
          : world.releases,
      });
    }
    throw new Error(`unexpected GET ${path}`);
  }

  world.writes.push({ method, path: resource, body: body ?? {} });
  if (method === 'POST' && resource === 'DOCUMENTS_P') {
    const invoice = world.pinvoices.find((iv) => iv.IVNUM === body?.IVNUM);
    const pulled =
      world.pulledReceiptLines ??
      ((invoice?.PINVOICEITEMS_SUBFORM as Row[]) ?? [])
        .filter((l) => l.PARTNAME !== "מע'מ" && l.PARTNAME !== '000' && l.TQUANT !== 0)
        .map((l, i) => ({ KLINE: i + 1, PARTNAME: l.PARTNAME, PQUANT: l.TQUANT, TQUANT: 0 }));
    const doc: Row = {
      DOCNO: `GR${world.receipts.length + 1}`,
      TYPE: 'P',
      STATDES: 'טיוטא',
      TOTPRICE: invoice?.TOTPRICE ?? 0,
      ...body,
      TRANSORDER_P_SUBFORM: pulled.map((l) => ({ ...l })),
    };
    world.receipts.push(doc);
    return json(doc, 201);
  }
  if (method === 'POST' && resource === 'DOCUMENTS_J') {
    const content = (world.file.IMPFILEITEMS_SUBFORM as Row[]) ?? [];
    const doc: Row = {
      DOCNO: `BD${world.releases.length + 1}`,
      TYPE: 'J',
      STATDES: 'טיוטא',
      UDATE: '2026-01-10T10:00:00Z',
      IVNUM: null,
      ...body,
      TRANSORDER_J_SUBFORM: content
        .filter((c) => c.PARTNAME !== "מע'מ" && Number(c.TBALANCE) > 0)
        .map((c, i) => ({ KLINE: i + 1, PARTNAME: c.PARTNAME, PQUANT: c.TBALANCE, TQUANT: 0 })),
    };
    world.releases.push(doc);
    return json(doc, 201);
  }
  if (method === 'PATCH' && segments.length === 2) {
    const kline = keyPart(segments[1], 'KLINE');
    let target: Row | undefined;
    if (form === 'PINVOICES') {
      const iv = world.pinvoices.find((r) => r.IVNUM === keyPart(segments[0], 'IVNUM'));
      target = lineOf(iv?.PINVOICEITEMS_SUBFORM, kline);
    } else if (form === 'DOCUMENTS_P') {
      const doc = world.receipts.find((r) => r.DOCNO === keyPart(segments[0], 'DOCNO'));
      target = lineOf(doc?.TRANSORDER_P_SUBFORM, kline);
    } else if (form === 'DOCUMENTS_J') {
      const doc = world.releases.find((r) => r.DOCNO === keyPart(segments[0], 'DOCNO'));
      target = lineOf(doc?.TRANSORDER_J_SUBFORM, kline);
    } else if (form === 'IMPFILES') {
      target = lineOf(world.file.IMPFILEITEMS_SUBFORM, kline);
    } else if (form === 'IMPFILEIV') {
      const iv = ((world.file.IMPFILEINV_SUBFORM as Row[]) ?? []).find(
        (r) => r.IVNUM === keyPart(segments[0], 'IVNUM'),
      );
      target = lineOf(iv?.IMPFILEIVS_SUBFORM, kline);
    }
    if (!target) return priorityError(404, 'row not found');
    Object.assign(target, body);
    return json(target);
  }
  throw new Error(`unexpected ${method} ${path}`);
}

/** Install the world as `fetch`. */
export function serve(world: World) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = decodeURIComponent(String(input instanceof Request ? input.url : input));
    const path = url.startsWith(BASE) ? url.slice(BASE.length) : url;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Row) : undefined;
    if (world.hang?.(method, path)) {
      if (method !== 'GET')
        world.writes.push({ method, path: path.split('?')[0], body: body ?? {} });
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
      });
    }
    return handle(world, method, path, body);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export const tempLedger = () => join(mkdtempSync(join(tmpdir(), 'import-steps-')), 'steps.jsonl');

/** Register tools on a fake server and call them by name; results come back parsed. */
export function toolHarness(
  register: (server: McpServer, client: PriorityClient, config: Config) => void,
  config: Config = testConfig,
) {
  const client = new PriorityClient(config, createLogger(config));
  type Result = { content: Array<{ type: string; text: string }>; isError?: boolean };
  type Handler = (p: unknown) => Promise<Result>;
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _desc: string, schema: z.ZodRawShape, fn: Handler) =>
      handlers.set(name, (p) => fn(z.object(schema).parse(p))),
  } as unknown as McpServer;
  register(server, client, config);
  const raw = async (name: string, p: unknown) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Tool missing: ${name}`);
    return handler(p);
  };
  return {
    client,
    names: () => [...handlers.keys()],
    raw,
    call: async (name: string, p: unknown) => JSON.parse((await raw(name, p)).content[0].text),
  };
}
