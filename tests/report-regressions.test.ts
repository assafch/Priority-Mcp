import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { PriorityError } from '../src/client/errors.js';
import type { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { dateRange } from '../src/lib/dates.js';
import { fetchAllPages } from '../src/lib/paginate.js';
import { registerFinanceTools } from '../src/tools/finance.js';
import { registerInvoiceTools } from '../src/tools/invoices.js';
import { registerPurchaseOrderTools } from '../src/tools/purchase-orders.js';
import { registerSalesReportTools } from '../src/tools/sales-report.js';

function harness(
  register: (server: McpServer, client: PriorityClient) => void,
  list: ReturnType<typeof vi.fn>,
  listNext = vi.fn(),
) {
  type Handler = (
    params: Record<string, unknown>,
    extra?: { signal?: AbortSignal },
  ) => Promise<{ content: { text: string }[] }>;
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _description: string, _schema: unknown, handler: Handler) =>
      handlers.set(name, handler),
  };
  register(server as unknown as McpServer, { list, listNext } as unknown as PriorityClient);
  return async (
    name: string,
    params: Record<string, unknown>,
    extra?: { signal?: AbortSignal },
  ) => {
    const handler = handlers.get(name);
    if (!handler) throw new Error(`Missing handler: ${name}`);
    return JSON.parse((await handler(params, extra)).content[0].text);
  };
}
const salesParams = {
  products: ['P'],
  fromDate: '2026-01-01',
  toDate: '2026-01-02',
  bucket: 'month',
  metric: 'quantity',
  includeDeliveryNotes: false,
  windowDays: 31,
  deadlineMs: 1000,
};

describe('audited report regressions', () => {
  it('purchase-order date ranges include the final fractional second and reject reversed ranges', async () => {
    const list = vi.fn().mockResolvedValue({ value: [] });
    const call = harness((s, c) => registerPurchaseOrderTools(s, c, {} as Config), list);
    const params = {
      dateFrom: '2026-10-01',
      dateTo: '2026-10-25',
      top: 50,
      skip: 0,
      orderDir: 'desc',
    };
    await call('priority_list_purchase_orders', params);
    expect(decodeURIComponent(list.mock.calls[0][1])).toContain('CURDATE lt 2026-10-26T00:00:00Z');
    list.mockClear();
    await expect(
      call('priority_list_purchase_orders', { ...params, dateFrom: '2026-10-26' }),
    ).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });
  it('never exceeds a non-page-aligned maxRows', async () => {
    const scan = await fetchAllPages(async () => Array.from({ length: 500 }, (_, i) => i), {
      maxRows: 600,
    });
    expect(scan.rows).toHaveLength(600);
    expect(scan.complete).toBe(false);
    expect(scan.stopReason).toBe('maxRows');
  });
  it('follows next links even on a short page', async () => {
    const next = vi.fn().mockResolvedValue({ value: [2] });
    const initial = vi
      .fn()
      .mockResolvedValueOnce({ value: [1], '@odata.nextLink': 'safe-next' })
      .mockResolvedValue({ value: [] });
    const scan = await fetchAllPages(initial, { fetchNext: next });
    expect(scan.rows).toEqual([1, 2]);
    expect(next).toHaveBeenCalledWith('safe-next');
    expect(scan.complete).toBe(true);
  });
  it('probes unresolved short envelope pages instead of losing server-limited rows', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({ value: [1, 2] })
      .mockResolvedValueOnce({ value: [3] })
      .mockResolvedValue({ value: [] });
    const scan = await fetchAllPages(fetch);
    expect(scan.rows).toEqual([1, 2, 3]);
    expect(fetch.mock.calls[1]?.[0]).toBe(2);
  });
  it('rejects loops and reports a missing continuation callback explicitly', async () => {
    const scan = await fetchAllPages(async () => ({ value: [1], '@odata.nextLink': 'a' }));
    expect(scan.complete).toBe(false);
    expect(scan.stopReason).toBe('continuationUnavailable');
    const loop = await fetchAllPages(async () => ({ value: [1], '@odata.nextLink': 'a' }), {
      fetchNext: async () => ({ value: [2], '@odata.nextLink': 'a' }),
    });
    expect(loop.stopReason).toBe('continuationLoop');
  });
  it('validates real calendar dates and range order, including offset meaning', () => {
    expect(() => dateRange('2026-02-30', '2026-03-01')).toThrow();
    expect(() => dateRange('garbage', '2026-03-01')).toThrow();
    expect(() => dateRange('2026-03-02', '2026-03-01')).toThrow();
    expect(dateRange('2026-01-01', '2026-01-01')).toEqual({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
      upperOperator: 'lt',
    });
    expect(dateRange(undefined, '2026-01-01T23:59:59.999+02:00').upperOperator).toBe('le');
  });
  it('5000 reconciled invoices means zero found and a truthful scan cap', async () => {
    const list = vi.fn().mockImplementation(async (_form, query) => {
      const skip = Number(new URLSearchParams(query.slice(1)).get('$skip'));
      return {
        value:
          skip < 5000
            ? Array.from({ length: 200 }, (_, i) => ({
                IVNUM: String(skip + i),
                IVRECONDATE: '2026-01-01',
              }))
            : [],
      };
    });
    const call = harness((s, c) => registerInvoiceTools(s, c, {} as Config), list);
    const result = await call('priority_get_unpaid_invoices_for_customer', {
      customerId: 'C',
      top: 100,
    });
    expect(result.count).toBe(0);
    expect(result.scan).toMatchObject({
      scanned: 5000,
      found: 0,
      returned: 0,
      complete: false,
      stopReason: 'maxRows',
    });
    expect(result.note).not.toContain('at least 100');
  });
  it('does not describe a non-final numeric invoice as a posted debt signal', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ value: [{ IVNUM: '123', STATDES: 'טיוטא', IVRECONDATE: null }] })
      .mockResolvedValue({ value: [] });
    const call = harness((s, c) => registerInvoiceTools(s, c, {} as Config), list);
    const result = await call('priority_get_unpaid_invoices_for_customer', {
      customerId: 'C',
      top: 100,
    });
    expect(result.scan.found).toBe(0);
    expect(result.count).toBe(0);
  });
  it('pages cash accounts beyond the old 200-account truncation', async () => {
    const list = vi.fn().mockImplementation(async (_form, query) => {
      const params = new URLSearchParams(query.slice(1));
      const skip = Number(params.get('$skip'));
      return {
        value: Array.from({ length: Math.min(100, 250 - skip) }, (_, i) => ({
          ACCNAME: String(skip + i),
          CODE: 'ILS',
          BALANCE1: 1,
          BALANCE3: 1,
        })),
      };
    });
    const call = harness(registerFinanceTools, list);
    const result = await call('priority_get_cash_position', { includeInactive: false });
    expect(result.totalLocalCurrency).toBe(250);
    expect(result.scan.complete).toBe(true);
  });
  it('rejects invalid ranges before customer lookup or report requests', async () => {
    const list = vi.fn();
    const call = harness((s, c) => registerInvoiceTools(s, c, {} as Config), list);
    await expect(
      call('priority_list_invoices', {
        customerName: 'C',
        dateFrom: '2026-02-30',
        dateTo: '2026-03-01',
        orderBy: 'IVDATE',
        orderDir: 'asc',
        top: 50,
        skip: 0,
      }),
    ).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });
  it('adapts a 408 window immediately and includes nested continuation', async () => {
    const list = vi.fn().mockImplementation(async (_form, query) => {
      const filter = new URLSearchParams(query.slice(1)).get('$filter') ?? '';
      if (filter.includes('2026-01-03') && filter.includes('2026-01-01'))
        throw new PriorityError('timeout', 408);
      if (query.includes('$skip=1')) return { value: [] };
      return {
        value: [
          {
            IVNUM: filter.includes('2026-01-01') ? 'A' : 'B',
            IVDATE: '2026-01-01',
            AINVOICEITEMS_SUBFORM: [{ PARTNAME: 'P', TQUANT: 1 }],
            'AINVOICEITEMS_SUBFORM@odata.nextLink': 'nested',
          },
        ],
      };
    });
    const next = vi.fn().mockResolvedValue({ value: [{ PARTNAME: 'P', TQUANT: 2 }] });
    const call = harness(registerSalesReportTools, list, next);
    const result = await call('priority_product_sales_by_period', salesParams);
    expect(result.grandTotal).toBe(6);
    expect(result.meta.complete).toBe(true);
    expect(next).toHaveBeenCalledTimes(2);
  });
  it.each([501, 505])('does not retry deterministic %i responses', async (status) => {
    const list = vi.fn().mockRejectedValue(new PriorityError('unsupported', status));
    const call = harness(registerSalesReportTools, list);
    await expect(call('priority_product_sales_by_period', salesParams)).rejects.toThrow();
    expect(list).toHaveBeenCalledTimes(1);
  });
  it('keeps Priority source calendar dates for period buckets across UTC boundaries', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        value: [
          {
            IVNUM: 'A',
            IVDATE: '2026-01-01T00:00:00+02:00',
            AINVOICEITEMS_SUBFORM: [{ PARTNAME: 'P', TQUANT: 1 }],
          },
        ],
      })
      .mockResolvedValue({ value: [] });
    const call = harness(registerSalesReportTools, list);
    const result = await call('priority_product_sales_by_period', salesParams);
    expect(result.rows[0].period).toBe('2026-01');
  });
  it('cancels an in-flight report without issuing more reads', async () => {
    const list = vi.fn().mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const call = harness(registerSalesReportTools, list);
    const pending = call('priority_product_sales_by_period', salesParams, {
      signal: controller.signal,
    });
    controller.abort();
    const result = await pending;
    expect(result.meta.complete).toBe(false);
    expect(result.meta.missingWindows[0].reason).toBe('cancelled');
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0][2].signal.aborted).toBe(true);
  });
  it('pages invoice revenues with a full composite order and a half-open final day', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        value: [{ IVNUM: 'A', IVDATE: '2026-01-01T23:59:59.999Z', TOTPRICE: 118, VAT: 18 }],
        '@odata.nextLink': 'next',
      })
      .mockResolvedValue({ value: [] });
    const next = vi.fn().mockResolvedValue({
      value: [{ IVNUM: 'B', IVDATE: '2026-01-01T23:59:59.9999Z', TOTPRICE: 118, VAT: 18 }],
    });
    const call = harness(registerFinanceTools, list, next);
    const result = await call('priority_get_revenue_by_period', {
      dateFrom: '2026-01-01',
      dateTo: '2026-01-01',
    });
    expect(result.totalNetRevenue).toBe(200);
    expect(result.scan.complete).toBe(true);
    const query = new URLSearchParams(list.mock.calls[0][1].slice(1));
    expect(query.get('$filter')).toContain('IVDATE lt 2026-01-02T00:00:00Z');
    expect(query.get('$orderby')).toBe('IVDATE asc,IVNUM asc,DEBIT asc,IVTYPE asc');
  });
  it('marks invoice details with unfinished expanded pages incomplete', async () => {
    const list = vi.fn().mockResolvedValue({
      value: [
        {
          IVNUM: 'A',
          AINVOICEITEMS_SUBFORM: [],
          'AINVOICEITEMS_SUBFORM@odata.nextLink': 'nested',
        },
      ],
    });
    const call = harness((s, c) => registerInvoiceTools(s, c, {} as Config), list);
    const result = await call('priority_get_invoice', { invoiceNumber: 'A' });
    expect(result.completeness).toMatchObject({ complete: false });
  });
  it('bounds stalled reports and records missing windows', async () => {
    const list = vi.fn().mockImplementation(() => new Promise(() => {}));
    const call = harness(registerSalesReportTools, list);
    const result = await call('priority_product_sales_by_period', {
      ...salesParams,
      deadlineMs: 20,
    });
    expect(result.meta.complete).toBe(false);
    expect(result.meta.missingWindows.length).toBeGreaterThan(0);
    expect(list.mock.calls[0][2].signal.aborted).toBe(true);
  });
});
