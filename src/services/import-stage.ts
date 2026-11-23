import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import {
  type ReceiptRow,
  type ReleaseRow,
  type StageResult,
  computeStage,
} from '../lib/impfile-stage.js';
import type { ImpfileSnapshot } from '../lib/impfiles-logic.js';
import { escapeODataString } from '../lib/sanitize.js';
import { loadSnapshot } from './import-read.js';

/** Receipts are looked up by the file's final invoices; more than this many is not a real file. */
const MAX_INVOICES_IN_FILTER = 40;

export async function readReceipts(
  client: PriorityClient,
  snapshot: ImpfileSnapshot,
): Promise<ReceiptRow[] | null> {
  const ivnums = (snapshot.invoices ?? [])
    .map((iv) => (typeof iv.IVNUM === 'string' ? iv.IVNUM.trim() : ''))
    .filter((n) => n && !/^T\d/i.test(n))
    .slice(0, MAX_INVOICES_IN_FILTER);
  if (ivnums.length === 0) return [];
  try {
    const qb = new ODataBuilder()
      .filter(ivnums.map((n) => `IVNUM eq '${escapeODataString(n)}'`).join(' or '))
      .select('DOCNO', 'STATDES', 'TOWARHSNAME', 'IVNUM')
      .top(200);
    return (await client.list<ReceiptRow>('DOCUMENTS_P', qb.build())).value;
  } catch {
    return null; // unknown, never "no receipt" and never "received"
  }
}

async function readReleases(client: PriorityClient, impfnum: string): Promise<ReleaseRow[] | null> {
  try {
    const qb = new ODataBuilder()
      .filter(`IMPFNUM eq '${escapeODataString(impfnum)}'`)
      .select('DOCNO', 'STATDES')
      .top(200);
    return (await client.list<ReleaseRow>('DOCUMENTS_J', qb.build())).value;
  } catch {
    return null;
  }
}

/**
 * Read one import file with its receipts and releases and compute which steps of the mandatory
 * order are proven. The file read itself throws on failure; each document read degrades to
 * 'unknown' on its own.
 */
export async function loadStageWithSnapshot(
  client: PriorityClient,
  impfnum: string,
): Promise<{ snapshot: ImpfileSnapshot; stage: StageResult }> {
  const snapshot = await loadSnapshot(client, impfnum, { cache: false });
  const [receipts, releases] = await Promise.all([
    readReceipts(client, snapshot),
    readReleases(client, impfnum),
  ]);
  return { snapshot, stage: computeStage({ snapshot, receipts, releases }) };
}

export async function loadStage(
  client: PriorityClient,
  impfnum: string,
): Promise<StageResult & { impfnum: string }> {
  const { stage } = await loadStageWithSnapshot(client, impfnum);
  return { impfnum, ...stage };
}
