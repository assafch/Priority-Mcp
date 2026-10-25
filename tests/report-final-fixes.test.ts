import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { registerResultResources } from '../src/resources/results.js';
import { createOperation } from '../src/runtime/operation-context.js';
import { runSalesReport } from '../src/services/reports/sales-reader.js';
import { registerSalesReportTools } from '../src/tools/sales-report.js';

const params = {
  products: ['P'],
  fromDate: '2026-01-01',
  toDate: '2026-01-01',
  bucket: 'month' as const,
  metric: 'quantity' as const,
  includeDeliveryNotes: true,
  windowDays: 1,
};
const invoice = (extra: Record<string, unknown> = {}) => ({
  IVNUM: 'I',
  DEBIT: 'D',
  IVTYPE: 'A',
  STATDES: 'סופית',
  IVDATE: '2026-01-01',
  AINVOICEITEMS_SUBFORM: [{ LINEKEY: 1, PARTNAME: 'P', TQUANT: 2 }],
  ...extra,
});
import { reportMetadata } from './report-metadata-fixture.js';
function backend(
  row: Record<string, unknown>,
  next: () => Promise<unknown> = async () => ({ value: [] }),
) {
  let deliveryReads = 0;
  const queries: string[] = [];
  const client = {
    scopeId: 'fix-fixture',
    cacheGeneration: () => 0,
    request: async (path: string) => reportMetadata(path),
    list: async (form: string, query: string) => {
      queries.push(query);
      if (form === 'DOCUMENTS_D') {
        deliveryReads++;
        return { value: [] };
      }
      return {
        value: Number(new URLSearchParams(query.slice(1)).get('$skip') ?? 0) > 0 ? [] : [row],
      };
    },
    listNext: next,
  } as unknown as PriorityClient;
  return { client, queries, deliveryReads: () => deliveryReads };
}
const run = (client: PriorityClient, options = {}) =>
  runSalesReport(client, params, {
    concurrency: 2,
    ctx: createOperation('report', { workClass: 'report' }),
    ...options,
  });
afterEach(() => vi.useRealTimers());
describe('report coverage and identity review regressions', () => {
  it('uses the complete targeted parent schema key including tenant-specific fields', async () => {
    const f = backend(invoice());
    const request = f.client.request.bind(f.client);
    f.client.request = async (path, ...args) =>
      path.includes("entity='AINVOICES'")
        ? ('<Schema><EntityType Name="AINVOICES"><Key><PropertyRef Name="IVNUM"/><PropertyRef Name="DEBIT"/><PropertyRef Name="IVTYPE"/><PropertyRef Name="BRANCH"/></Key><Property Name="IVNUM" Type="Edm.String"/><Property Name="DEBIT" Type="Edm.String"/><Property Name="IVTYPE" Type="Edm.String"/><Property Name="BRANCH" Type="Edm.String"/></EntityType></Schema>' as never)
        : request(path, ...args);
    const output = await run(f.client);
    expect(output.result.meta.coverageComplete).toBe(false);
    expect(output.result.grandTotal).toBe(0);
    expect(new URLSearchParams(f.queries[0].slice(1)).get('$select')).toContain('BRANCH');
  });
  it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, ''])(
    'keeps an unknown selected quantity %s incomplete and unsummed',
    async (value) => {
      const f = backend(
        invoice({ AINVOICEITEMS_SUBFORM: [{ LINEKEY: 1, PARTNAME: 'P', TQUANT: value }] }),
      );
      const output = await run(f.client);
      expect(output.result.meta.coverageComplete).toBe(false);
      expect(output.result.grandTotal).toBe(0);
      expect(f.deliveryReads()).toBe(0);
    },
  );
  it('accepts literal selected zero and negative credit but does not substitute quantity for missing value', async () => {
    const zero = await run(
      backend(
        invoice({
          AINVOICEITEMS_SUBFORM: [
            { LINEKEY: 1, PARTNAME: 'P', TQUANT: 0 },
            { LINEKEY: 2, PARTNAME: 'P', TQUANT: -2 },
          ],
        }),
      ).client,
    );
    expect(zero.result.grandTotal).toBe(-2);
    expect(zero.result.meta.coverageComplete).toBe(true);
    const f = backend(invoice());
    const value = await runSalesReport(
      f.client,
      { ...params, metric: 'value' },
      { concurrency: 2, ctx: createOperation('report', { workClass: 'report' }) },
    );
    expect(value.result.meta.coverageComplete).toBe(false);
    expect(value.result.grandTotal).toBe(0);
  });
  it.each([undefined, null, {}])(
    'does not turn missing or malformed expanded collection %s into complete zero',
    async (collection) => {
      const f = backend(invoice({ AINVOICEITEMS_SUBFORM: collection }));
      const output = await run(f.client);
      expect(output.result.meta).toMatchObject({
        complete: false,
        coverageComplete: false,
        expandedLinesComplete: false,
      });
      expect(f.deliveryReads()).toBe(0);
    },
  );
  it.each(['IVNUM', 'DEBIT', 'IVTYPE'])(
    'rejects incomplete parent key %s instead of collapsing null identities',
    async (field) => {
      const f = backend(invoice({ [field]: undefined }));
      const output = await run(f.client);
      expect(output.result.meta.coverageComplete).toBe(false);
      expect(output.result.grandTotal).toBe(0);
      expect(f.deliveryReads()).toBe(0);
    },
  );
  it('retains valid empty arrays as verified empty collection coverage', async () => {
    const f = backend(invoice({ AINVOICEITEMS_SUBFORM: [] }));
    const output = await run(f.client);
    expect(output.result.meta.coverageComplete).toBe(true);
    expect(output.result.grandTotal).toBe(0);
    expect(f.deliveryReads()).toBe(1);
  });
  it('deduplicates only schema-backed line keys across continuation and retains equal distinct lines', async () => {
    const f = backend(invoice({ 'AINVOICEITEMS_SUBFORM@odata.nextLink': 'next' }), async () => ({
      value: [
        { LINEKEY: 1, PARTNAME: 'P', TQUANT: 2 },
        { LINEKEY: 2, PARTNAME: 'P', TQUANT: 2 },
      ],
    }));
    const output = await run(f.client);
    expect(output.result.grandTotal).toBe(4);
    expect(output.result.meta.coverageComplete).toBe(true);
    const query = new URLSearchParams(f.queries[0].slice(1));
    expect(query.get('$expand')).toContain('$select=LINEKEY,PARTNAME,TQUANT,QPRICE');
    expect(query.get('$expand')).toContain('$orderby=LINEKEY');
  });
  it('marks unknown or missing line identity incomplete without deduplicating by product/amount', async () => {
    const f = backend(invoice({ AINVOICEITEMS_SUBFORM: [{ PARTNAME: 'P', TQUANT: 2 }] }));
    const output = await run(f.client);
    expect(output.result.meta.coverageComplete).toBe(false);
    expect(output.result.meta.expandedLinesComplete).toBe(false);
    expect(output.result.grandTotal).toBe(0);
    expect(f.deliveryReads()).toBe(0);
  });
  it('does not promote source keys to verified identity when targeted metadata is unavailable', async () => {
    const f = backend(invoice());
    f.client.request = async () => {
      throw new Error('metadata unavailable');
    };
    const output = await run(f.client);
    expect(output.result.meta.coverageComplete).toBe(false);
    expect(output.result.grandTotal).toBe(0);
    expect(output.result.warnings.join(' ')).toContain('targeted metadata');
  });
  it('requires only the selected metric and accepts literal zero value', async () => {
    const f = backend(
      invoice({
        AINVOICEITEMS_SUBFORM: [
          { LINEKEY: 1, PARTNAME: 'P', QPRICE: 0 },
          { LINEKEY: 2, PARTNAME: 'P', QPRICE: 12 },
        ],
      }),
    );
    const output = await runSalesReport(
      f.client,
      { ...params, metric: 'value' },
      { concurrency: 2, ctx: createOperation('report', { workClass: 'report' }) },
    );
    expect(output.result.meta.coverageComplete).toBe(true);
    expect(output.result.grandTotal).toBe(12);
  });
  it('keeps never-attempted and failed reads unobserved and independently marks failed nested coverage', async () => {
    const f = backend(invoice());
    const expired = await run(f.client, {
      ctx: createOperation('report', { deadlineAt: Date.now() - 1 }),
    });
    expect(f.queries).toHaveLength(0);
    expect(expired.result.meta).toMatchObject({
      firstObservedAt: null,
      lastObservedAt: null,
      expandedLinesComplete: false,
    });
    const nested = backend(
      invoice({ 'AINVOICEITEMS_SUBFORM@odata.nextLink': 'next' }),
      async () => {
        throw new Error('terminated');
      },
    );
    const partial = await run(nested.client);
    expect(partial.result.meta).toMatchObject({
      coverageComplete: false,
      expandedLinesComplete: false,
    });
  });
  it('preserves incomplete source evidence in tool detail and independently readable resource pages', async () => {
    let tool!: (
      p: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: string; text?: string }> }>;
    let resource!: (
      uri: URL,
      variables: Record<string, string>,
    ) => Promise<{ contents: Array<{ text: string }> }>;
    const server = {
      tool: (_n: string, _d: string, _s: unknown, run: typeof tool) => {
        tool = run;
      },
      resource: (_n: string, _template: unknown, _meta: unknown, run: typeof resource) => {
        resource = run;
      },
    } as unknown as McpServer;
    const f = backend(invoice());
    f.client.list = async () => {
      throw new Error('terminated');
    };
    const config = { priorityReadOnly: true } as Config;
    registerSalesReportTools(server, f.client, config);
    registerResultResources(server, f.client, config);
    const first = JSON.parse((await tool({ ...params, deadlineMs: 1000 })).content[0].text ?? '{}');
    const detail = JSON.parse(
      (await tool({ ...params, resumeHandle: first.meta.resumeHandle, detailOffset: 0 })).content[0]
        .text ?? '{}',
    );
    expect(detail.meta).toMatchObject({
      complete: false,
      coverageComplete: false,
      firstObservedAt: null,
      lastObservedAt: null,
    });
    expect(detail.meta.missingWindows).toHaveLength(2);
    expect(detail.meta.detail.outputComplete).toBe(true);
    const page = JSON.parse(
      (
        await resource(new URL(first.meta.detail.resourceUri), {
          handle: first.meta.resumeHandle,
          queryHash: first.meta.queryHash,
          page: '0',
        })
      ).contents[0].text,
    );
    expect(page.meta).toMatchObject({
      complete: false,
      coverageComplete: false,
      firstObservedAt: null,
      lastObservedAt: null,
    });
    expect(page.meta.missingWindows).toHaveLength(2);
    expect(page.outputComplete).toBe(true);
  });
});
