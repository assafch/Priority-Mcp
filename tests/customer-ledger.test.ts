import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { PriorityClient } from '../src/client/priority-client.js';
import type { WebSdkSession } from '../src/client/web-sdk.js';
import {
  LEDGER_SUBFORM,
  type LedgerLine,
  buildStatement,
  parseAmount,
  readLedgerLines,
  renderLedgerHtml,
  toLedgerLine,
} from '../src/lib/customer-ledger.js';
import { registerCustomerLedgerTool } from '../src/tools/customer-ledger.js';

/** ACCFNCITEMS2 row in the shape the live SDK returned (10 Nov 2026): strings with thousands commas. */
const row = (date: string, ref: string, debit: string, credit: string, bal: string) => ({
  BALDATE: date,
  FNCNUM: `F${ref}`,
  IVNUM: ref,
  FNCPATNAME: debit !== '0.00' ? 'חל' : 'ק',
  DETAILS: debit !== '0.00' ? 'חשבונית מס' : 'קבלה',
  DEBIT: debit,
  CREDIT: credit,
  BAL: bal,
  ACCNAME: '90001',
  ACCDES: 'הכנסות ממכירות בארץ',
});

const HISTORY = [
  row('2025-03-01', 'IN1', '1,000.00', '0.00', '1,000.00'),
  row('2025-12-14', 'RC1', '0.00', '400.00', '600.00'),
  row('2026-01-15', 'RC2', '0.00', '100.00', '500.00'),
  row('2026-10-07', 'IN2', '3,800.00', '0.00', '4,300.00'),
];

/**
 * Scripted Web SDK: ACCOUNTS_RECEIVABLE with one account, and an ACCFNCITEMS2 sub-form that
 * serves `pageSize` rows per getRows(from) call, like the SDK's paging. Records every call.
 */
function fakeSession(
  opts: { accounts?: string[]; rows?: Record<string, unknown>[]; pageSize?: number } = {},
) {
  const calls: string[] = [];
  const accounts = opts.accounts ?? ['11105'];
  const rows = opts.rows ?? HISTORY;
  const pageSize = opts.pageSize ?? 2;
  const sub = {
    getRows: vi.fn(async (from: number) => {
      calls.push(`sub.getRows(${from})`);
      const page: Record<string, Record<string, unknown>> = {};
      rows.slice(from - 1, from - 1 + pageSize).forEach((r, i) => {
        page[String(from + i)] = r;
      });
      return { [LEDGER_SUBFORM]: page };
    }),
    endCurrentForm: vi.fn(async () => calls.push('sub.end')),
  };
  const parent = {
    setSearchFilter: vi.fn(async (f: unknown) => calls.push(`filter ${JSON.stringify(f)}`)),
    getRows: vi.fn(async () => {
      const page: Record<string, Record<string, unknown>> = {};
      accounts.forEach((acc, i) => {
        page[String(i + 1)] = { ACCNAME: acc, ACCDES: 'הכל בו מוטי בע"מ' };
      });
      return { ACCOUNTS_RECEIVABLE: page };
    }),
    setActiveRow: vi.fn(async (n: number) => calls.push(`setActiveRow(${n})`)),
    startSubForm: vi.fn(async (name: string) => {
      calls.push(`startSubForm(${name})`);
      return sub;
    }),
    endCurrentForm: vi.fn(async () => calls.push('parent.end')),
  };
  const formStart = vi.fn(async (name: string) => {
    calls.push(`formStart(${name})`);
    return parent;
  });
  const session = {
    company: 'a051014',
    ensureLogin: vi.fn(async () => undefined),
    sdk: { formStart, login: vi.fn(), procStart: vi.fn() },
  } as unknown as WebSdkSession;
  return { session, calls, parent, sub };
}

describe('ledger parsing and statement', () => {
  it('parses Priority amount strings', () => {
    expect(parseAmount('1,051.00')).toBe(1051);
    expect(parseAmount('1,051.00-')).toBe(-1051);
    expect(parseAmount('-25.50')).toBe(-25.5);
    expect(parseAmount('(10.00)')).toBe(-10);
    expect(parseAmount('')).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
  });

  it('normalizes a live-shaped row', () => {
    expect(toLedgerLine(HISTORY[3])).toMatchObject({
      date: '2026-10-07',
      reference: 'IN2',
      debit: 3800,
      credit: 0,
      balance: 4300,
      type: 'חל',
    });
  });

  it('takes the opening from the running balance before the range and checks the closing', () => {
    const lines = HISTORY.map(toLedgerLine);
    const s = buildStatement(lines, '2026-01-01', '2026-12-31');
    expect(s.opening).toBe(600);
    expect(s.lines.map((l) => l.reference)).toEqual(['RC2', 'IN2']);
    expect(s.totalDebit).toBe(3800);
    expect(s.totalCredit).toBe(100);
    expect(s.closing).toBe(4300);
    expect(s.warnings).toEqual([]);
  });

  it('starts from zero before the first entry and warns when Priority disagrees', () => {
    const lines: LedgerLine[] = HISTORY.map(toLedgerLine);
    lines[1] = { ...lines[1], balance: 999 };
    const s = buildStatement(lines, '2020-01-01', '2025-12-31');
    expect(s.opening).toBe(0);
    expect(s.closing).toBe(600);
    expect(s.warnings[0]).toContain('differs');
  });

  it('renders escaped RTL HTML with opening, totals and closing', () => {
    const lines = HISTORY.map(toLedgerLine);
    const html = renderLedgerHtml(
      {
        customer: { custname: '11105', name: 'הכל בו <מוטי>', taxId: '514873579' },
        account: '11105',
        dateFrom: '2026-01-01',
        dateTo: '2026-12-31',
        linesRead: 4,
        ...buildStatement(lines, '2026-01-01', '2026-12-31'),
      },
      { title: 'אורגת סחר בע"מ', details: 'ח.פ. 511305930' },
      new Date('2026-11-10T08:00:00Z'),
    );
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('הכל בו &#60;מוטי&#62;');
    expect(html).toContain('יתרת פתיחה');
    expect(html).toContain('600.00');
    expect(html).toContain('3,800.00');
    expect(html).toContain('4,300.00');
    expect(html).toContain('01/01/2026 – 31/12/2026');
    expect(html).toContain('10/11/2026');
  });
});

describe('readLedgerLines (Web SDK, read-only)', () => {
  it('pages through every row and only reads', async () => {
    const fake = fakeSession({ pageSize: 3 });
    const { lines } = await readLedgerLines(fake.session, '11105');
    expect(lines).toHaveLength(4);
    expect(fake.calls).toEqual([
      'formStart(ACCOUNTS_RECEIVABLE)',
      expect.stringContaining('"field":"ACCNAME","fromval":"11105"'),
      'setActiveRow(1)',
      `startSubForm(${LEDGER_SUBFORM})`,
      'sub.getRows(1)',
      'sub.getRows(4)',
      'sub.getRows(5)',
      'sub.end',
      'parent.end',
    ]);
  });

  it('refuses when the account is missing or ambiguous, and still closes the form', async () => {
    const none = fakeSession({ accounts: [] });
    await expect(readLedgerLines(none.session, '11105')).rejects.toMatchObject({
      reason: 'account-not-found',
    });
    expect(none.calls).toContain('parent.end');
    const two = fakeSession({ accounts: ['11105', '11105'] });
    await expect(readLedgerLines(two.session, '11105')).rejects.toMatchObject({
      reason: 'account-not-found',
    });
  });
});

describe('priority_customer_ledger tool', () => {
  function register(deps: Parameters<typeof registerCustomerLedgerTool>[3]) {
    const handlers = new Map<string, (p: unknown) => Promise<Record<string, unknown>>>();
    let description = '';
    const server = {
      tool: (
        name: string,
        desc: string,
        schema: z.ZodRawShape,
        fn: (p: unknown) => Promise<unknown>,
      ) => {
        description = desc;
        handlers.set(name, async (p) => (await fn(z.object(schema).parse(p))) as never);
      },
    } as unknown as McpServer;
    const list = vi.fn(async () => ({
      value: [{ CUSTNAME: '11105', CUSTDES: 'הכל בו מוטי בע"מ', WTAXNUM: '514873579' }],
    }));
    registerCustomerLedgerTool(server, { list } as unknown as PriorityClient, {} as never, deps);
    const handler = handlers.get('priority_customer_ledger');
    if (!handler) throw new Error('not registered');
    return { handler, description, list };
  }

  it('returns the statement and the PDF', async () => {
    const fake = fakeSession();
    const htmlToPdf = vi.fn(async () => Buffer.from('%PDF-1.4 fake'));
    const { handler, description } = register({ session: () => fake.session, htmlToPdf });
    expect(description).toContain('Read-only');
    expect(description).toContain('ACCFNCITEMS2');
    const result = (await handler({
      customerId: '11105',
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
    })) as {
      content: Array<{ text?: string; resource?: { blob: string; mimeType: string } }>;
    };
    const body = JSON.parse(result.content[0].text ?? '{}');
    expect(body).toMatchObject({
      status: 'ok',
      opening: 600,
      closing: 4300,
      lineCount: 2,
      filename: 'ledger-11105-2026-01-01_2026-12-31.pdf',
      mimeType: 'application/pdf',
    });
    expect(result.content[1].resource?.mimeType).toBe('application/pdf');
    expect(Buffer.from(result.content[1].resource?.blob ?? '', 'base64').toString()).toContain(
      '%PDF',
    );
    expect(htmlToPdf).toHaveBeenCalledOnce();
  });

  it('rejects an inverted range before touching Priority', async () => {
    const fake = fakeSession();
    const { handler, list } = register({ session: () => fake.session, htmlToPdf: vi.fn() });
    const result = await handler({
      customerId: '11105',
      dateFrom: '2026-12-31',
      dateTo: '2026-01-01',
    });
    expect(result).toMatchObject({ isError: true });
    expect(list).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });

  it('returns data only when pdf is false', async () => {
    const fake = fakeSession();
    const htmlToPdf = vi.fn();
    const { handler } = register({ session: () => fake.session, htmlToPdf });
    const result = (await handler({
      customerId: '11105',
      dateFrom: '2025-01-01',
      dateTo: '2025-12-31',
      pdf: false,
    })) as { content: Array<{ text?: string }> };
    expect(JSON.parse(result.content[0].text ?? '{}')).toMatchObject({ opening: 0, closing: 600 });
    expect(htmlToPdf).not.toHaveBeenCalled();
  });
});
