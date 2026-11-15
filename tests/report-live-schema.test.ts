import { expect, it } from 'vitest';
import type { PriorityClient } from '../src/client/priority-client.js';
import { createOperation } from '../src/runtime/operation-context.js';
import { runSalesReport } from '../src/services/reports/sales-reader.js';
import { reportMetadata } from './report-metadata-fixture.js';
it('reports a complete literal total with Priority top-level-only metadata and declared child types', async () => {
  const requests: string[] = [];
  const client = {
    request: async (path: string) => {
      requests.push(path);
      return reportMetadata(path);
    },
    list: async (form: string, query: string) => ({
      value:
        form === 'DOCUMENTS_D' || new URLSearchParams(query.slice(1)).get('$skip') !== '0'
          ? []
          : [
              {
                IVNUM: 'I',
                DEBIT: 'D',
                IVTYPE: 'A',
                IVDATE: '2026-01-01',
                STATDES: 'סופית',
                AINVOICEITEMS_SUBFORM: [{ LINEKEY: 1, PARTNAME: 'P', TQUANT: 2 }],
              },
            ],
    }),
  } as unknown as PriorityClient;
  const out = await runSalesReport(
    client,
    {
      products: ['P'],
      fromDate: '2026-01-01',
      toDate: '2026-01-01',
      bucket: 'month',
      metric: 'quantity',
      includeDeliveryNotes: true,
      windowDays: 1,
    },
    { concurrency: 2, ctx: createOperation('report', { workClass: 'report' }) },
  );
  expect(out.result.grandTotal).toBe(2);
  expect(out.result.meta.coverageComplete).toBe(true);
  expect(requests.filter((p) => p === '$metadata')).toHaveLength(1);
  expect(
    requests.some(
      (p) =>
        p.includes("entity='AINVOICEITEMS_SUBFORM'") || p.includes("entity='TRANSORDER_D_SUBFORM'"),
    ),
  ).toBe(false);
});
