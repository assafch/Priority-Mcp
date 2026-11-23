import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import {
  type FileFacts,
  type InvoiceFact,
  type PartCostFact,
  type ReleaseFact,
  type ReleaseLineFact,
  type ReleaseScanRow,
  VAT_DECLARATION_PART,
} from '../lib/impfile-official.js';
import type { ReceiptRow } from '../lib/impfile-stage.js';
import type { ImpfileSnapshot } from '../lib/impfiles-logic.js';
import { fetchAllPages } from '../lib/paginate.js';
import { escapeODataString } from '../lib/sanitize.js';
import { IMPFILE_SUBFORMS, normalizeSnapshot } from './import-read.js';
import { readReceipts } from './import-stage.js';

type Row = Record<string, unknown>;

/**
 * Facts about import files read from Priority for the official twelve-step check and the
 * landed-cost report. Read-only. Three things learnt live on this tenant shape the queries:
 *  - TRANSIMPFILE_SUBFORM (the per-line cost screen) must be expanded WITHOUT $select: with a
 *    nested $select its computed columns (TRANSCOST, TOTCOST) come back null.
 *  - PINVOICES rejects several header fields in $select; only fields proven selectable are used.
 *  - LOGPART/PARTTRANSLAST2_SUBFORM also lists sales movements with customer names, so it is
 *    always filtered to the release documents and projected to non-personal columns.
 */
const MAX_IN_FILTER = 40;
const PART_CHUNK = 15;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rows = (v: unknown): Row[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Row[]) : [];
/** A one-to-one sub-form arrives as an object (or null); tolerate an array as well. */
const one = (v: unknown): Row | null => {
  if (Array.isArray(v)) return (v.find((x) => x && typeof x === 'object') as Row) ?? null;
  return v && typeof v === 'object' ? (v as Row) : null;
};
const orChain = (field: string, values: string[]): string =>
  `(${values.map((v) => `${field} eq '${escapeODataString(v)}'`).join(' or ')})`;

function toReleaseLine(line: Row): ReleaseLineFact {
  const cost = one(line.TRANSIMPFILE_SUBFORM);
  return {
    kline: num(line.KLINE),
    part: str(line.PARTNAME) ?? '',
    description: str(line.PDES),
    qty: num(line.TQUANT) ?? 0,
    goodsILS: cost ? num(cost.TRANSCOST) : null,
    customsILS: cost ? num(cost.CUSTOMSSUM) : null,
    additionalILS: cost ? num(cost.DUTYCOST) : null,
    importILS: cost ? num(cost.IMPFCOST) : null,
    totalILS: cost ? num(cost.TOTCOST) : null,
    costRegisteredAt: cost ? str(cost.UDATE) : null,
  };
}

const RELEASE_EXPAND = 'TRANSORDER_J_SUBFORM($expand=TRANSIMPFILE_SUBFORM)';
const RELEASE_SELECT = ['DOCNO', 'IMPFNUM', 'STATDES', 'CURDATE', 'UDATE', 'DOCREF', 'IVNUM'];

/**
 * A "מע'מ" line with no quantity on a release: Priority pulls the VAT-from-declaration line of
 * the file content into a new release (first pilot file, 2026-11-23). It carries no goods and no cost.
 */
export const isEmptyVatReleaseLine = (line: Row): boolean =>
  str(line.PARTNAME) === VAT_DECLARATION_PART &&
  (num(line.PQUANT) ?? 0) === 0 &&
  (num(line.TQUANT) ?? 0) === 0;

function toRelease(doc: Row): ReleaseFact {
  const all = rows(doc.TRANSORDER_J_SUBFORM);
  const ignored = all.filter(isEmptyVatReleaseLine).length;
  return {
    docno: str(doc.DOCNO) ?? '',
    status: str(doc.STATDES) ?? '',
    date: str(doc.CURDATE),
    updatedAt: str(doc.UDATE),
    declaration: str(doc.DOCREF),
    customsInvoice: str(doc.IVNUM),
    lines: all.filter((l) => !isEmptyVatReleaseLine(l)).map(toReleaseLine),
    ...(ignored ? { ignoredVatLines: ignored } : {}),
  };
}

async function readFileReleases(
  client: PriorityClient,
  impfnum: string,
): Promise<ReleaseFact[] | null> {
  try {
    const qb = new ODataBuilder()
      .filter(`IMPFNUM eq '${escapeODataString(impfnum)}'`)
      .select(...RELEASE_SELECT)
      .expand(RELEASE_EXPAND)
      .top(200);
    const res = await client.list<Row>('DOCUMENTS_J', qb.build(), { cache: false });
    return Array.isArray(res?.value) ? res.value.map(toRelease) : null;
  } catch {
    return null;
  }
}

/** Goods-invoice lines that carry no import declaration, per invoice; absent = not readable. */
async function readDeclarationGaps(
  client: PriorityClient,
  ivnums: string[],
): Promise<Map<string, number>> {
  const gaps = new Map<string, number>();
  if (ivnums.length === 0) return gaps;
  try {
    const qb = new ODataBuilder()
      .filter(`${orChain('IVNUM', ivnums.slice(0, MAX_IN_FILTER))} and IVTYPE eq 'P'`)
      .select('IVNUM', 'DEBIT')
      .expand('PINVOICEITEMS_SUBFORM($select=PARTNAME,TQUANT,QPRICE,CUSTOMSNUM)')
      .top(200);
    const res = await client.list<Row>('PINVOICES', qb.build(), { cache: false });
    if (!Array.isArray(res?.value)) return gaps;
    for (const iv of res.value) {
      const ivnum = str(iv.IVNUM);
      if (!ivnum || !Array.isArray(iv.PINVOICEITEMS_SUBFORM)) continue;
      const missing = rows(iv.PINVOICEITEMS_SUBFORM).filter(
        (l) =>
          str(l.PARTNAME) !== VAT_DECLARATION_PART && num(l.TQUANT) !== 0 && !str(l.CUSTOMSNUM),
      ).length;
      gaps.set(ivnum, (gaps.get(ivnum) ?? 0) + missing);
    }
  } catch {
    // leave the map empty: every invoice reads as "unknown"
  }
  return gaps;
}

/** Start time of the last costing run: null = none on record, undefined = not readable. */
export async function readLastCostingAt(
  client: PriorityClient,
): Promise<string | null | undefined> {
  try {
    const qb = new ODataBuilder()
      .select('TITLE', 'PARDATE', 'UDATE', 'EDATE')
      .orderBy('UDATE', 'desc')
      .top(1);
    const res = await client.list<Row>('COSTINGLOG', qb.build(), { cache: false });
    if (!Array.isArray(res?.value)) return undefined;
    return str(res.value[0]?.UDATE);
  } catch {
    return undefined;
  }
}

export interface LoadedFileFacts {
  facts: FileFacts;
  snapshot: ImpfileSnapshot;
  receipts: ReceiptRow[] | null;
}

/** Read one import file with everything the twelve official steps are judged on. */
export async function loadFileFacts(
  client: PriorityClient,
  impfnum: string,
): Promise<LoadedFileFacts> {
  const qb = new ODataBuilder().expand(
    ...IMPFILE_SUBFORMS.map(({ subform }) =>
      subform === 'IMPFILEINV_SUBFORM' ? 'IMPFILEINV_SUBFORM($expand=IMPFILEIVS_SUBFORM)' : subform,
    ),
  );
  const record = await client.get<Row>('IMPFILES', impfnum, qb.build(), { cache: false });
  const snapshot = normalizeSnapshot(record);
  const supplier = str(record.SUPNAME);

  const invoiceRows = rows(record.IMPFILEINV_SUBFORM);
  const goodsIvnums = invoiceRows
    .filter((iv) => supplier !== null && str(iv.SUPNAME) === supplier)
    .map((iv) => str(iv.IVNUM))
    .filter((n): n is string => !!n);

  const [receipts, releases, lastCostingAt, gaps] = await Promise.all([
    readReceipts(client, snapshot),
    readFileReleases(client, impfnum),
    readLastCostingAt(client),
    readDeclarationGaps(client, goodsIvnums),
  ]);

  const invoices: InvoiceFact[] = invoiceRows.map((iv) => {
    const ivnum = str(iv.IVNUM) ?? '';
    const isGoods = supplier !== null && str(iv.SUPNAME) === supplier;
    return {
      ivnum,
      supplier: str(iv.SUPNAME),
      debit: str(iv.DEBIT),
      isGoods,
      isFinal: !/^T\d/i.test(ivnum),
      // A line zeroed to neutralise a duplicate is not part of the invoice any more.
      lines: rows(iv.IMPFILEIVS_SUBFORM)
        .filter((l) => num(l.TQUANT) !== 0)
        .map((l) => ({
          part: str(l.PARTNAME) ?? '',
          qty: num(l.TQUANT),
          qprice: num(l.QPRICE),
          currency: str(l.CODE),
          country: str(l.COUNTRYNAME),
        })),
      linesWithoutDeclaration: isGoods
        ? gaps.has(ivnum)
          ? (gaps.get(ivnum) as number)
          : null
        : null,
    };
  });

  const vatLines = rows(record.IMPFILEITEMS_SUBFORM).filter(
    (c) => str(c.PARTNAME) === VAT_DECLARATION_PART,
  );
  const facts: FileFacts = {
    impfnum,
    closed: record.CLOSED === 'Y',
    supplier,
    warehouse: str(record.WARHSNAME),
    invoices,
    receipts:
      receipts === null
        ? null
        : receipts.map((r) => ({
            docno: r.DOCNO,
            status: r.STATDES,
            warehouse: r.TOWARHSNAME,
            ivnum: r.IVNUM,
          })),
    content: rows(record.IMPFILEITEMS_SUBFORM)
      .filter((c) => str(c.PARTNAME) && str(c.PARTNAME) !== VAT_DECLARATION_PART)
      .map((c) => ({
        part: str(c.PARTNAME) as string,
        qty: num(c.TQUANT) ?? 0,
        balance: num(c.TBALANCE) ?? 0,
      })),
    customsEstimateParts: [
      ...new Set(
        rows(record.IMPFILECUSTOMS_SUBFORM)
          .map((c) => str(c.PARTNAME))
          .filter((p): p is string => !!p),
      ),
    ],
    contentVatLineQty: vatLines.length
      ? vatLines.reduce((sum, c) => sum + Math.abs(num(c.TQUANT) ?? 0), 0)
      : null,
    customsEstimateWithoutCountry: rows(record.IMPFILECUSTOMS_SUBFORM).filter(
      (c) => str(c.PARTNAME) && !str(c.COUNTRYNAME),
    ).length,
    releases,
    lastCostingAt,
  };
  return { facts, snapshot, receipts };
}

/**
 * Product-card cost ("עלות", "ת. תמחיר") and the cost Priority recorded on the stock movements of
 * the given documents. null = not readable.
 */
export async function loadPartCosts(
  client: PriorityClient,
  parts: string[],
  docnos: string[],
): Promise<PartCostFact[] | null> {
  const unique = [...new Set(parts.filter(Boolean))];
  if (unique.length === 0) return [];
  const docs = [...new Set(docnos.filter(Boolean))].slice(0, MAX_IN_FILTER);
  const out: PartCostFact[] = [];
  try {
    for (let i = 0; i < unique.length; i += PART_CHUNK) {
      const qb = new ODataBuilder()
        .filter(orChain('PARTNAME', unique.slice(i, i + PART_CHUNK)))
        .select('PARTNAME', 'COST', 'COSTDATE')
        .top(PART_CHUNK);
      if (docs.length) {
        const docFilter = docs.map((d) => `LOGDOCNO eq '${escapeODataString(d)}'`).join(' or ');
        qb.expand(
          `PARTTRANSLAST2_SUBFORM($filter=${docFilter};$select=CURDATE,LOGDOCNO,DOCDES,TOWARHSNAME,TQUANT,COST,SECONDCOST,CFNAME,TYPE)`,
        );
      }
      const res = await client.list<Row>('LOGPART', qb.build(), { cache: false });
      if (!Array.isArray(res?.value)) return null;
      for (const p of res.value) {
        const byDoc: Record<string, number> = {};
        for (const m of rows(p.PARTTRANSLAST2_SUBFORM)) {
          const doc = str(m.LOGDOCNO);
          const cost = num(m.COST);
          if (doc && cost !== null) byDoc[doc] = Math.round(((byDoc[doc] ?? 0) + cost) * 100) / 100;
        }
        out.push({
          part: str(p.PARTNAME) ?? '',
          itemCost: num(p.COST),
          costingDate: str(p.COSTDATE),
          movementCostByDoc: byDoc,
        });
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** Every release document dated on or after `since`, with its lines and their cost rows. */
export async function scanReleases(
  client: PriorityClient,
  since: string,
  maxRows = 2000,
): Promise<{ releases: ReleaseScanRow[]; complete: boolean }> {
  const scan = await fetchAllPages<Row>(
    async (skip, top) => {
      const qb = new ODataBuilder()
        .filter(`CURDATE ge ${since}T00:00:00Z`)
        .select(...RELEASE_SELECT)
        .expand(RELEASE_EXPAND)
        .orderBy('DOCNO', 'asc')
        .top(top)
        .skip(skip);
      const res = await client.list<Row>('DOCUMENTS_J', qb.build(), { cache: false });
      return Array.isArray(res?.value) ? res.value : [];
    },
    { pageSize: 40, maxRows },
  );
  return {
    releases: scan.rows.map((doc) => {
      const r = toRelease(doc);
      return {
        docno: r.docno,
        impfnum: str(doc.IMPFNUM) ?? '',
        status: r.status,
        updatedAt: r.updatedAt,
        lines: r.lines,
      };
    }),
    complete: scan.complete,
  };
}

/** CLOSED flag of every import file, keyed by IMPFNUM. */
export async function readClosedByFile(client: PriorityClient): Promise<Record<string, boolean>> {
  const scan = await fetchAllPages<Row>(
    async (skip, top) => {
      const qb = new ODataBuilder()
        .select('IMPFNUM', 'CLOSED', 'STATDES')
        .orderBy('IMPFNUM', 'asc')
        .top(top)
        .skip(skip);
      const res = await client.list<Row>('IMPFILES', qb.build(), { cache: false });
      return Array.isArray(res?.value) ? res.value : [];
    },
    { pageSize: 500, maxRows: 5000 },
  );
  if (!scan.complete) throw new Error('Could not read the complete list of import files.');
  const out: Record<string, boolean> = {};
  for (const f of scan.rows) {
    const key = str(f.IMPFNUM);
    if (key) out[key] = f.CLOSED === 'Y';
  }
  return out;
}
