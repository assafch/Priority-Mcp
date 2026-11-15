import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import { type WebSdkForm, type WebSdkSession, withTimeout } from '../client/web-sdk.js';
import { sanitizeODataValue } from './sanitize.js';

/**
 * Customer ledger (כרטסת לקוח) read through the Priority Web SDK.
 *
 * ACCOUNTS_RECEIVABLE is not enabled for the OData API on this tenant, but the Web SDK opens it
 * like the UI does. Its sub-form ACCFNCITEMS2 holds every journal line of the account from the
 * first entry, sorted by value date (BALDATE), with Priority's running balance (BAL). Verified
 * live 10 Nov 2026: ACCFNCITEMS is the current year only, ACCFNCITEMS4 the previous year,
 * ARFNCITEMS3 the open items.
 *
 * Read-only: formStart, setSearchFilter, getRows, setActiveRow, startSubForm, endCurrentForm.
 * No field is updated, no row saved, no activation started.
 */

export const LEDGER_FORM = 'ACCOUNTS_RECEIVABLE';
export const LEDGER_SUBFORM = 'ACCFNCITEMS2';
const MAX_PAGES = 200;

export interface LedgerLine {
  date: string;
  reference: string;
  journal: string;
  type: string;
  details: string;
  debit: number;
  credit: number;
  balance: number;
  counterAccount: string;
}

export interface LedgerCustomer {
  custname: string;
  name: string;
  taxId?: string;
  address?: string;
  city?: string;
  phone?: string;
}

export interface LedgerStatement {
  customer: LedgerCustomer;
  account: string;
  dateFrom: string;
  dateTo: string;
  opening: number;
  totalDebit: number;
  totalCredit: number;
  closing: number;
  lines: LedgerLine[];
  /** Lines in the account's whole history that were read (all pages). */
  linesRead: number;
  warnings: string[];
}

export class LedgerFailure extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'LedgerFailure';
  }
}

/** "1,051.00" → 1051; "1,051.00-" or "(1,051.00)" → -1051; empty → 0. */
export function parseAmount(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  let text = String(raw ?? '').trim();
  if (!text) return 0;
  let sign = 1;
  if (/^\(.*\)$/.test(text)) {
    sign = -1;
    text = text.slice(1, -1);
  }
  if (text.endsWith('-')) {
    sign = -sign;
    text = text.slice(0, -1);
  }
  if (text.startsWith('-')) {
    sign = -sign;
    text = text.slice(1);
  }
  const value = Number(text.replace(/,/g, ''));
  return Number.isFinite(value) ? sign * value : 0;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

/** Normalize one ACCFNCITEMS2 row (string values as the SDK returns them). */
export function toLedgerLine(row: Record<string, unknown>): LedgerLine {
  return {
    date: str(row.BALDATE).slice(0, 10),
    reference:
      str(row.IVNUM) ||
      str(row.TODOREF) ||
      str(row.FNCIREF1) ||
      str(row.FNCREF2) ||
      str(row.FNCNUM),
    journal: str(row.FNCNUM),
    type: str(row.FNCPATNAME),
    details: str(row.DETAILS),
    debit: parseAmount(row.DEBIT ?? row.DEBIT1),
    credit: parseAmount(row.CREDIT ?? row.CREDIT1),
    balance: parseAmount(row.BAL),
    counterAccount: [str(row.ACCNAME), str(row.ACCDES)].filter(Boolean).join(' '),
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Cut the full history to [dateFrom, dateTo] by value date. Opening is Priority's running balance
 * after the last line before dateFrom; closing is opening plus the range's movements, cross-checked
 * against Priority's running balance on the last line in range.
 */
export function buildStatement(
  all: LedgerLine[],
  dateFrom: string,
  dateTo: string,
): Pick<
  LedgerStatement,
  'opening' | 'totalDebit' | 'totalCredit' | 'closing' | 'lines' | 'warnings'
> {
  const warnings: string[] = [];
  const sorted = all.every((line, i) => i === 0 || all[i - 1].date <= line.date);
  if (!sorted)
    warnings.push(
      'Priority returned the lines out of value-date order; they were kept in Priority order.',
    );
  const before = all.filter((line) => line.date < dateFrom);
  const lines = all.filter((line) => line.date >= dateFrom && line.date <= dateTo);
  const opening = before.length ? before[before.length - 1].balance : 0;
  const totalDebit = round2(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = round2(lines.reduce((sum, line) => sum + line.credit, 0));
  const closing = round2(opening + totalDebit - totalCredit);
  if (lines.length) {
    const priorityClosing = lines[lines.length - 1].balance;
    if (Math.abs(priorityClosing - closing) > 0.005) {
      warnings.push(
        `Computed closing ${closing.toFixed(2)} differs from Priority's running balance ${priorityClosing.toFixed(2)} on the last line in range.`,
      );
    }
  }
  return { opening: round2(opening), totalDebit, totalCredit, closing, lines, warnings };
}

export function assertRange(dateFrom: string, dateTo: string): void {
  if (!ISO_DATE.test(dateFrom) || !ISO_DATE.test(dateTo)) {
    throw new LedgerFailure('bad-range', 'dateFrom and dateTo must be YYYY-MM-DD.');
  }
  if (dateFrom > dateTo) {
    throw new LedgerFailure('bad-range', `dateFrom ${dateFrom} is after dateTo ${dateTo}.`);
  }
}

function rowsOf(page: Record<string, Record<string, Record<string, unknown>>> | undefined) {
  const byIndex = page ? (Object.values(page)[0] ?? {}) : {};
  return Object.entries(byIndex)
    .map(([index, row]) => ({ index: Number(index), row }))
    .filter((entry) => Number.isFinite(entry.index))
    .sort((a, b) => a.index - b.index);
}

async function safeEnd(form: WebSdkForm | undefined, timeoutMs: number): Promise<void> {
  if (!form) return;
  await withTimeout(form.endCurrentForm(), timeoutMs, 'endCurrentForm').catch(() => undefined);
}

/** Read every line of the account's ledger (all pages) through the Web SDK. */
export async function readLedgerLines(
  session: WebSdkSession,
  account: string,
  timeoutMs = 60_000,
): Promise<{ accountName: string; lines: LedgerLine[] }> {
  await session.ensureLogin();
  const ignore = () => undefined;
  let parent: WebSdkForm | undefined;
  let sub: WebSdkForm | undefined;
  try {
    parent = await withTimeout(
      session.sdk.formStart(LEDGER_FORM, ignore, null, { company: session.company }, 0),
      timeoutMs,
      `formStart(${LEDGER_FORM})`,
    );
    await withTimeout(
      parent.setSearchFilter({
        or: 0,
        ignorecase: 0,
        QueryValues: [{ field: 'ACCNAME', fromval: account, op: '=' }],
      }),
      timeoutMs,
      'setSearchFilter',
    );
    const parents = rowsOf(await withTimeout(parent.getRows(1), timeoutMs, 'getRows'));
    const matches = parents.filter((entry) => str(entry.row.ACCNAME) === account);
    if (matches.length !== 1) {
      throw new LedgerFailure(
        'account-not-found',
        matches.length === 0
          ? `No receivable account '${account}' in ${LEDGER_FORM}.`
          : `${matches.length} receivable accounts named '${account}'. Refusing to guess.`,
      );
    }
    await withTimeout(parent.setActiveRow(matches[0].index), timeoutMs, 'setActiveRow');
    if (!parent.startSubForm) {
      throw new LedgerFailure('sdk-not-configured', 'This priority-web-sdk has no startSubForm().');
    }
    sub = await withTimeout(
      parent.startSubForm(LEDGER_SUBFORM, ignore, null),
      timeoutMs,
      `startSubForm(${LEDGER_SUBFORM})`,
    );
    const lines: LedgerLine[] = [];
    let from = 1;
    for (let page = 0; page < MAX_PAGES; page++) {
      const rows = rowsOf(await withTimeout(sub.getRows(from), timeoutMs, 'getRows'));
      const fresh = rows.filter((entry) => entry.index >= from);
      if (fresh.length === 0) break;
      for (const entry of fresh) lines.push(toLedgerLine(entry.row));
      from = fresh[fresh.length - 1].index + 1;
      if (page === MAX_PAGES - 1) {
        throw new LedgerFailure('too-large', `Ledger has more than ${MAX_PAGES} pages; stopped.`);
      }
    }
    return { accountName: str(matches[0].row.ACCDES), lines };
  } finally {
    await safeEnd(sub, timeoutMs);
    await safeEnd(parent, timeoutMs);
  }
}

export async function readCustomer(
  client: PriorityClient,
  custname: string,
): Promise<LedgerCustomer> {
  const value = sanitizeODataValue(custname).trim();
  const query = new ODataBuilder()
    .eq('CUSTNAME', value)
    .select('CUSTNAME', 'CUSTDES', 'WTAXNUM', 'ADDRESS', 'STATEA', 'PHONE')
    .top(2)
    .build();
  const result = await client.list<Record<string, unknown>>('CUSTOMERS', query);
  const rows = result.value ?? [];
  if (rows.length !== 1) {
    throw new LedgerFailure(
      'customer-not-found',
      rows.length === 0 ? `No customer '${value}'.` : `More than one customer '${value}'.`,
    );
  }
  const row = rows[0];
  return {
    custname: str(row.CUSTNAME),
    name: str(row.CUSTDES),
    taxId: str(row.WTAXNUM) || undefined,
    address: str(row.ADDRESS) || undefined,
    city: str(row.STATEA) || undefined,
    phone: str(row.PHONE) || undefined,
  };
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const money = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const heDate = (iso: string) =>
  ISO_DATE.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;

export interface LedgerHeader {
  /** Company name line, e.g. "אורגת סחר בע\"מ". */
  title?: string;
  /** Second line, e.g. "ח.פ. 511305930 · טל' 03-6565866". */
  details?: string;
}

/** Hebrew RTL statement page, printed by headless Chrome. */
export function renderLedgerHtml(
  statement: LedgerStatement,
  header: LedgerHeader = {},
  producedAt = new Date(),
): string {
  const c = statement.customer;
  const rows = statement.lines
    .map(
      (line) => `<tr>
<td>${heDate(line.date)}</td><td>${escapeHtml(line.reference)}</td><td>${escapeHtml(line.details)}</td>
<td class="n">${line.debit ? money(line.debit) : ''}</td><td class="n">${line.credit ? money(line.credit) : ''}</td>
<td class="n">${money(line.balance)}</td></tr>`,
    )
    .join('\n');
  const customerLines = [
    c.address && c.city ? `${c.address}, ${c.city}` : c.address || c.city,
    c.taxId ? `ח.פ./ע.מ. ${c.taxId}` : undefined,
    c.phone ? `טל' ${c.phone}` : undefined,
  ]
    .filter(Boolean)
    .map((line) => `<div>${escapeHtml(String(line))}</div>`)
    .join('');
  const produced = heDate(producedAt.toISOString().slice(0, 10));
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>כרטסת ${escapeHtml(c.name)}</title>
<style>
@page { size: A4; margin: 14mm 12mm; }
body { font-family: Arial, "Arial Hebrew", sans-serif; font-size: 10.5pt; color: #111; }
header { display: flex; justify-content: space-between; border-bottom: 2px solid #1f3a5f; padding-bottom: 6px; }
h1 { font-size: 16pt; margin: 0; color: #1f3a5f; }
.co { font-size: 9.5pt; color: #444; }
h2 { font-size: 13pt; margin: 14px 0 4px; }
.meta { display: flex; justify-content: space-between; margin-bottom: 8px; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #c8ced6; padding: 3px 5px; text-align: right; }
th { background: #e8eef5; font-weight: bold; }
td.n, th.n { text-align: left; direction: ltr; white-space: nowrap; }
tr.sum td { font-weight: bold; background: #f4f6f9; }
thead { display: table-header-group; }
footer { margin-top: 10px; font-size: 8.5pt; color: #666; }
</style></head><body>
<header><div><h1>${escapeHtml(header.title ?? '')}</h1><div class="co">${escapeHtml(header.details ?? '')}</div></div>
<div class="co">הופק: ${produced}</div></header>
<h2>כרטסת לקוח</h2>
<div class="meta"><div><b>${escapeHtml(c.name)}</b> (${escapeHtml(c.custname)})${customerLines}</div>
<div>תקופה: ${heDate(statement.dateFrom)} – ${heDate(statement.dateTo)}</div></div>
<table><thead><tr><th>תאריך ערך</th><th>אסמכתא</th><th>פרטים</th><th class="n">חובה</th><th class="n">זכות</th><th class="n">יתרה</th></tr></thead>
<tbody>
<tr class="sum"><td colspan="5">יתרת פתיחה</td><td class="n">${money(statement.opening)}</td></tr>
${rows}
<tr class="sum"><td colspan="3">סה"כ תנועות בתקופה</td><td class="n">${money(statement.totalDebit)}</td><td class="n">${money(statement.totalCredit)}</td><td></td></tr>
<tr class="sum"><td colspan="5">יתרת סגירה ליום ${heDate(statement.dateTo)}</td><td class="n">${money(statement.closing)}</td></tr>
</tbody></table>
<footer>יתרה חיובית = חוב הלקוח. מקור: Priority, חשבון ${escapeHtml(statement.account)}.</footer>
</body></html>`;
}

export function ledgerFilename(custname: string, dateFrom: string, dateTo: string): string {
  const clean = custname.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) || 'customer';
  return `ledger-${clean}-${dateFrom}_${dateTo}.pdf`;
}

export async function writeLedgerPdf(
  dir: string,
  filename: string,
  bytes: Buffer,
): Promise<string> {
  const root = resolve(dir);
  const target = resolve(root, filename);
  if (target !== join(root, filename)) {
    throw new LedgerFailure(
      'write-failed',
      'Refusing to write the PDF outside PRIORITY_PRINT_DIR.',
    );
  }
  await mkdir(root, { recursive: true });
  await writeFile(target, bytes);
  return target;
}
