import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
import { withOperation } from '../src/runtime/operation-context.js';
import { createOperation } from '../src/runtime/operation-context.js';
import { runSalesReport } from '../src/services/reports/sales-reader.js';
import { addDays } from '../src/services/reports/sales-reader.js';
import { runWindows } from '../src/services/reports/window-runner.js';
import { registerFinanceTools } from '../src/tools/finance.js';
import { registerInvoiceTools } from '../src/tools/invoices.js';
import { registerSalesReportTools } from '../src/tools/sales-report.js';
const lineMetadata = (path: string) => {
  const entity = path.match(/entity='([^']+)'/)?.[1] ?? '';
  const keys =
    entity === 'AINVOICES'
      ? ['IVNUM', 'DEBIT', 'IVTYPE']
      : entity === 'DOCUMENTS_D'
        ? ['DOCNO']
        : ['LINEKEY'];
  return `<Schema><EntityType Name="${entity}"><Key>${keys.map((name) => `<PropertyRef Name="${name}" />`).join('')}</Key>${[...keys, 'PARTNAME'].map((name) => `<Property Name="${name}" Type="Edm.String" />`).join('')}</EntityType></Schema>`;
};
const params = {
  products: ['P'],
  fromDate: '2026-01-01',
  toDate: '2026-01-03',
  bucket: 'month' as const,
  metric: 'quantity' as const,
  includeDeliveryNotes: true,
  windowDays: 1,
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('bounded report windows and replacement resume', () => {
  it('notifies only the supplied active progress token with globally increasing window counts', async () => {
    vi.useFakeTimers();
    let handler!: (params: Record<string, unknown>, extra: unknown) => Promise<unknown>;
    const server = {
      tool: (_name: string, _description: string, _schema: unknown, run: typeof handler) => {
        handler = run;
      },
    } as unknown as McpServer;
    const client = {
      request: async (path: string) => lineMetadata(path),
      list: async (form: string, query: string) => {
        await new Promise((resolve) => setTimeout(resolve, 2100));
        if (
          form === 'DOCUMENTS_D' ||
          Number(new URLSearchParams(query.slice(1)).get('$skip') ?? 0) > 0
        )
          return { value: [] };
        const day = Number(
          (new URLSearchParams(query.slice(1)).get('$filter') ?? '').match(/2026-01-(\d\d)/)?.[1] ??
            1,
        );
        return {
          value: [
            {
              IVNUM: `I${day}`,
              DEBIT: 'D',
              IVTYPE: 'A',
              IVDATE: `2026-01-0${day}`,
              AINVOICEITEMS_SUBFORM: [{ LINEKEY: 1, PARTNAME: 'P', TQUANT: 1 }],
            },
          ],
        };
      },
      listNext: async () => ({ value: [] }),
    } as unknown as PriorityClient;
    registerSalesReportTools(server, client);
    const notifications: Array<{ at: number; token: number; count: number; total: number }> = [];
    const sendNotification = async (message: {
      params: { progressToken: number; progress: number; total: number };
    }) => {
      notifications.push({
        at: Date.now(),
        token: message.params.progressToken,
        count: message.params.progress,
        total: message.params.total,
      });
    };
    const first = handler(
      { ...params, deadlineMs: 30000 },
      { _meta: { progressToken: 0 }, sendNotification },
    );
    await vi.runAllTimersAsync();
    await first;
    expect(notifications.map((n) => n.count)).toEqual([1, 3, 4, 6]);
    expect(notifications.every((n) => n.token === 0 && n.total === 6)).toBe(true);
    for (let i = 1; i < notifications.length; i++)
      expect(notifications[i].at - notifications[i - 1].at).toBeGreaterThanOrEqual(2000);
    notifications.length = 0;
    const second = handler({ ...params, deadlineMs: 30000 }, { sendNotification });
    await vi.runAllTimersAsync();
    await second;
    expect(notifications).toEqual([]);
  });
  it('reports actual formatted detail count and pages retained rows without another ERP read', async () => {
    let handler!: (
      params: Record<string, unknown>,
    ) => Promise<{ content: { type: string; text?: string }[] }>;
    const server = {
      tool: (_name: string, _description: string, _schema: unknown, run: typeof handler) => {
        handler = run;
      },
    } as unknown as McpServer;
    let calls = 0;
    const products = Array.from({ length: 180 }, (_, i) => `P${i}`);
    const invoices = Array.from({ length: 120 }, (_, day) => ({
      IVNUM: `I${day}`,
      DEBIT: 'D',
      IVTYPE: 'A',
      IVDATE: addDays('2026-01-01', day),
      AINVOICEITEMS_SUBFORM: products.map((PARTNAME, lineIndex) => ({
        LINEKEY: lineIndex + 1,
        PARTNAME,
        TQUANT: 1,
      })),
    }));
    const client = {
      request: async (path: string) => lineMetadata(path),
      list: async (_form: string, query: string) => {
        calls++;
        return {
          value: Number(new URLSearchParams(query.slice(1)).get('$skip') ?? 0) > 0 ? [] : invoices,
        };
      },
      listNext: async () => ({ value: [] }),
    } as unknown as PriorityClient;
    registerSalesReportTools(server, client);
    const query = {
      ...params,
      products,
      fromDate: '2026-01-01',
      toDate: '2026-04-30',
      bucket: 'week',
      windowDays: 120,
      includeDeliveryNotes: false,
      deadlineMs: 1000,
    };
    const call = async (args: Record<string, unknown>) =>
      JSON.parse((await handler(args)).content.find((c) => c.type === 'text')?.text ?? '{}');
    const first = await call(query);
    expect(first.meta.detail.returnedRows).toBe(first.rows.length);
    expect(first.grandTotal).toBe(21600);
    expect(first.meta.complete).toBe(true);
    expect(first.meta.coverageComplete).toBe(true);
    expect(first.meta.detail.outputComplete).toBe(false);
    const before = calls;
    let offset = 0;
    const periods: string[] = [];
    do {
      const page = await call({
        ...query,
        resumeHandle: first.meta.resumeHandle,
        detailOffset: offset,
        detailLimit: 100,
      });
      expect(page.meta.detail.returnedRows).toBe(page.rows.length);
      periods.push(...page.rows.map((r: { period: string }) => r.period));
      offset = page.meta.detail.nextOffset;
    } while (offset !== null);
    expect(periods).toHaveLength(first.meta.detail.totalRows);
    expect(new Set(periods).size).toBe(periods.length);
    expect(calls).toBe(before);
  });
  it('failed nested invoice continuation stays incomplete and prevents delivery inclusion', async () => {
    let deliveryReads = 0;
    const client = {
      request: async (path: string) => lineMetadata(path),
      list: async (form: string, query: string) => {
        if (form === 'DOCUMENTS_D') {
          deliveryReads++;
          return { value: [] };
        }
        if (Number(new URLSearchParams(query.slice(1)).get('$skip') ?? 0) > 0) return { value: [] };
        return {
          value: [
            {
              IVNUM: 'I',
              DEBIT: 'D',
              IVTYPE: 'A',
              IVDATE: '2026-01-01',
              AINVOICEITEMS_SUBFORM: [{ LINEKEY: 1, PARTNAME: 'P', TQUANT: 1 }],
              'AINVOICEITEMS_SUBFORM@odata.nextLink': 'nested',
            },
          ],
        };
      },
      listNext: async () => {
        throw new Error('terminated');
      },
    } as unknown as PriorityClient;
    const result = await runSalesReport(
      client,
      { ...params, toDate: '2026-01-01' },
      { concurrency: 2, ctx: createOperation('report', { workClass: 'report' }) },
    );
    expect(result.result.meta.coverageComplete).toBe(false);
    expect(deliveryReads).toBe(0);
  });
  it('financial and unpaid-invoice scans expose cancellation before requesting any page', async () => {
    const handlers = new Map<
      string,
      (params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>
    >();
    const server = {
      tool: (
        name: string,
        _description: string,
        _schema: unknown,
        handler: (params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>,
      ) => handlers.set(name, handler),
    } as unknown as McpServer;
    let calls = 0;
    const client = {
      request: async (path: string) => lineMetadata(path),
      list: async () => {
        calls++;
        return { value: [] };
      },
      listNext: async () => ({ value: [] }),
    } as unknown as PriorityClient;
    registerFinanceTools(server, client);
    registerInvoiceTools(server, client, {} as Config);
    for (const [name, params] of [
      ['priority_get_cash_position', { includeInactive: false }],
      ['priority_get_unpaid_invoices_for_customer', { customerId: 'C', top: 100 }],
    ] as const) {
      const handler = handlers.get(name);
      if (!handler) throw new Error('missing handler');
      const result = await withOperation(
        createOperation(name, { signal: AbortSignal.abort() }),
        () => handler(params),
      );
      expect(JSON.parse(result.content[0].text).meta).toMatchObject({
        complete: false,
        consistency: 'multi-observation',
        snapshotConsistent: false,
      });
    }
    expect(calls).toBe(0);
  });
  it('preserves literal totals through fifty real-client synthetic network runs with at most two heavy reads', async () => {
    let active = 0;
    let max = 0;
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      active++;
      max = Math.max(max, active);
      calls++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      const parsed = new URL(url);
      if (parsed.pathname.includes('GetMetadataFor')) {
        active--;
        return new Response(lineMetadata(decodeURIComponent(parsed.pathname)), {
          headers: { 'content-type': 'application/xml' },
        });
      }
      const day = Number(
        (parsed.searchParams.get('$filter') ?? '').match(/2026-01-(\d\d)/)?.[1] ?? 1,
      );
      const rows =
        parsed.pathname.endsWith('/AINVOICES') &&
        Number(parsed.searchParams.get('$skip') ?? 0) === 0
          ? [
              {
                IVNUM: `I${day}`,
                DEBIT: 'D',
                IVTYPE: 'A',
                STATDES: 'סופית',
                IVDATE: `2026-01-0${day}`,
                AINVOICEITEMS_SUBFORM: [{ LINEKEY: 1, PARTNAME: 'P', TQUANT: day }],
              },
            ]
          : [];
      active--;
      return new Response(JSON.stringify({ value: rows }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const client = new PriorityClient(
      {
        priorityBaseUrl: 'https://report.fixture/odata/Priority/test.ini',
        priorityCompany: 'demo',
        priorityPat: 'synthetic-report',
        priorityReadOnly: true,
        cacheTtlSeconds: 60,
        rateLimitPerMinute: 10000,
        requestTimeoutMs: 1000,
      } as Config,
      { debug: () => {}, warn: () => {} } as unknown as Logger,
    );
    try {
      for (let i = 0; i < 50; i++) {
        const output = await runSalesReport(client, params, {
          concurrency: (i % 2) + 1,
          ctx: createOperation('report', { workClass: 'report' }),
        });
        expect(output.result.grandTotal).toBe(6);
        expect(output.result.meta.coverageComplete).toBe(true);
      }
      expect(calls).toBe(454);
      expect(max).toBe(2);
      expect(active).toBe(0);
    } finally {
      client.close();
    }
  });
  it('admits at most two windows and emits increasing throttled completed-window progress', async () => {
    vi.useFakeTimers();
    let active = 0;
    let max = 0;
    const progress: number[] = [];
    const work = runWindows(
      [1, 2, 3, 4],
      {
        concurrency: 2,
        ctx: createOperation('report', { workClass: 'report' }),
        onProgress: (p) => {
          progress.push(p.completed);
        },
      },
      async (n) => {
        active++;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 2100));
        active--;
        return n;
      },
    );
    await vi.runAllTimersAsync();
    expect((await work).results.map((x) => x.value)).toEqual([1, 2, 3, 4]);
    expect(max).toBe(2);
    expect(progress).toEqual([1, 3]);
  });
  const fixture = () => {
    let day2 = 2;
    let day1 = 1;
    let fail = true;
    const calls: string[] = [];
    const client = {
      request: async (path: string) => lineMetadata(path),
      scopeId: 'report-fixture',
      cacheGeneration: () => 0,
      list: async (form: string, query: string) => {
        const q = new URLSearchParams(query.slice(1));
        const filter = q.get('$filter') ?? '';
        calls.push(`${form}:${filter}`);
        const day = Number(filter.match(/2026-01-(\d\d)/)?.[1] ?? 1);
        if (form === 'DOCUMENTS_D') return { value: [] };
        if (day === 3 && fail) throw new Error('terminated');
        if (Number(q.get('$skip') ?? 0) > 0) return { value: [] };
        return {
          value: [
            {
              IVNUM: `I${day}`,
              DEBIT: 'D',
              IVTYPE: 'A',
              STATDES: 'סופית',
              IVDATE: `2026-01-0${day}`,
              AINVOICEITEMS_SUBFORM: [
                { LINEKEY: 1, PARTNAME: 'P', TQUANT: day === 1 ? day1 : day === 2 ? day2 : 3 },
              ],
            },
          ],
        };
      },
      listNext: async () => ({ value: [] }),
    } as unknown as PriorityClient;
    return {
      client,
      calls,
      change: () => {
        day1 = 100;
        day2 = 20;
        fail = false;
      },
    };
  };
  it('resumes last-complete plus missing windows by replacement and labels retained observations', async () => {
    const f = fixture();
    const first = await runSalesReport(f.client, params, {
      concurrency: 2,
      ctx: createOperation('report', { workClass: 'report' }),
    });
    expect(first.result.grandTotal).toBe(3);
    expect(first.result.meta.coverageComplete).toBe(false);
    expect(f.calls.some((c) => c.startsWith('DOCUMENTS_D'))).toBe(false);
    f.change();
    f.calls.length = 0;
    const resumed = await runSalesReport(f.client, params, {
      concurrency: 2,
      ctx: createOperation('report', { workClass: 'report' }),
      previous: first.state,
    });
    expect(resumed.result.grandTotal).toBe(24);
    expect(resumed.result.meta).toMatchObject({
      complete: true,
      coverageComplete: true,
      consistency: 'multi-observation',
      snapshotConsistent: false,
    });
    expect(resumed.result.meta.retainedWindows).toContainEqual(
      expect.objectContaining({ source: 'AINVOICES', from: '2026-01-01' }),
    );
    expect(
      f.calls.filter((c) => c.startsWith('AINVOICES')).some((c) => c.includes('2026-01-01')),
    ).toBe(false);
    const full = await runSalesReport(f.client, params, {
      concurrency: 1,
      ctx: createOperation('report', { workClass: 'report' }),
      previous: first.state,
      fullRefresh: true,
    });
    expect(full.result.grandTotal).toBe(123);
  });
  it('serial and parallel totals preserve credits/drafts/duplicate source rows and delivery deduplication', async () => {
    const client = {
      request: async (path: string) => lineMetadata(path),
      list: async (form: string, query: string) => {
        if (Number(new URLSearchParams(query.slice(1)).get('$skip') ?? 0) > 0) return { value: [] };
        if (form === 'DOCUMENTS_D')
          return {
            value: [
              {
                DOCNO: 'D1',
                CURDATE: '2026-01-01',
                STATDES: 'סופית',
                IVALL: 'Y',
                TRANSORDER_D_SUBFORM: [
                  { LINEKEY: 1, PARTNAME: 'P', TQUANT: 99, IVNUM: 'I1' },
                  { LINEKEY: 2, PARTNAME: 'P', TQUANT: 4, IVNUM: 'SI1' },
                ],
              },
            ],
          };
        return {
          value: [
            {
              IVNUM: 'I1',
              DEBIT: 'D',
              IVTYPE: 'A',
              STATDES: 'סופית',
              IVDATE: '2026-01-01',
              AINVOICEITEMS_SUBFORM: [{ LINEKEY: 1, PARTNAME: 'P', TQUANT: 10 }],
            },
            {
              IVNUM: 'C1',
              DEBIT: 'C',
              IVTYPE: 'A',
              STATDES: 'סופית',
              IVDATE: '2026-01-01',
              AINVOICEITEMS_SUBFORM: [{ LINEKEY: 1, PARTNAME: 'P', TQUANT: -2 }],
            },
            {
              IVNUM: 'draft',
              STATDES: 'טיוטא',
              IVDATE: '2026-01-01',
              AINVOICEITEMS_SUBFORM: [{ LINEKEY: 1, PARTNAME: 'P', TQUANT: 100 }],
            },
          ],
        };
      },
      listNext: async () => ({ value: [] }),
    } as unknown as PriorityClient;
    for (const concurrency of [1, 2]) {
      const report = await runSalesReport(client, params, {
        concurrency,
        ctx: createOperation('report', { workClass: 'report' }),
      });
      expect(report.result.grandTotal).toBe(12);
      expect(report.result.meta.coverageComplete).toBe(true);
    }
  });
});
