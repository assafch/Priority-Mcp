import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import {
  handleBindingFor,
  policyScopeFor,
  queryHashFor,
  resultHandles,
} from '../lib/result-handles.js';
import { MAX_RESULT_CHARS, boundedPayload } from '../lib/tool-result.js';
import { createOperation, currentOperation } from '../runtime/operation-context.js';
import {
  type SalesParams,
  type SalesState,
  salesStateEvidence,
} from '../services/reports/sales-aggregate.js';
import { runSalesReport } from '../services/reports/sales-reader.js';

/** Leave room for truthful post-format page counters, then serialize one consistent payload. */
function formatDetail(data: Record<string, unknown>, offset: number) {
  const payload = boundedPayload(data, MAX_RESULT_CHARS - 512, true);
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const meta = payload.meta as Record<string, unknown> | undefined;
  const detail = meta?.detail as Record<string, unknown> | undefined;
  if (detail) {
    detail.returnedRows = rows.length;
    detail.nextOffset =
      rows.length && offset + rows.length < Number(detail.totalRows) ? offset + rows.length : null;
    detail.outputComplete = offset + rows.length >= Number(detail.totalRows);
    if (!rows.length && Number(detail.totalRows) > offset)
      detail.fallbackUnavailable =
        'A row exceeds the text budget; use the retained resource URI for complete detail.';
  }
  return {
    structuredContent: payload,
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

export function registerSalesReportTools(
  server: McpServer,
  client: PriorityClient,
  config?: Config,
) {
  server.tool(
    'priority_product_sales_by_period',
    `Quantity (or value) of one or more products sold, bucketed by period (half-month / month / week).

One call returns the full grid — it walks the date range in adaptive windows server-side and
aggregates, so you never have to chunk AINVOICES expands by hand. Includes tax invoices and
(optionally) delivery notes, de-duplicated. Cancelled and draft invoices are excluded; returns/
credits net automatically.`,
    {
      resumeHandle: z
        .string()
        .optional()
        .describe(
          'Opaque handle from a previous identical report; replaces the last completed and missing windows.',
        ),
      detailOffset: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Read retained detail from this row offset without fetching ERP again; requires resumeHandle.',
        ),
      detailLimit: z.number().int().min(1).max(100).default(100),
      fullRefresh: z
        .boolean()
        .default(false)
        .describe('Discard retained observations and reread the entire query.'),
      deadlineMs: z
        .number()
        .int()
        .min(1)
        .max(300000)
        .default(120000)
        .describe('Overall report work deadline, milliseconds'),
      products: z
        .array(z.string().min(1))
        .min(1)
        .describe('PARTNAME(s) to report on, e.g. ["PO0001","PO0002"]'),
      fromDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Start date YYYY-MM-DD (inclusive)'),
      toDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('End date YYYY-MM-DD (inclusive)'),
      bucket: z.enum(['half-month', 'month', 'week']).default('half-month'),
      metric: z
        .enum(['quantity', 'value'])
        .default('quantity')
        .describe('quantity = units (TQUANT); value = pre-VAT line amount (QPRICE)'),
      includeDeliveryNotes: z
        .boolean()
        .default(true)
        .describe('Add delivery-note (DOCUMENTS_D) lines not billed through AINVOICES'),
      windowDays: z
        .number()
        .int()
        .min(1)
        .max(120)
        .default(31)
        .describe('Initial date-window size for expansion; auto-halves on server timeout'),
    },
    async (params, extra) => {
      try {
        const query: SalesParams = {
          products: [...new Set(params.products)],
          fromDate: params.fromDate,
          toDate: params.toDate,
          bucket: params.bucket,
          metric: params.metric,
          includeDeliveryNotes: params.includeDeliveryNotes,
          windowDays: params.windowDays,
        };
        const inherited =
          currentOperation() ??
          createOperation('priority_product_sales_by_period', { workClass: 'report' });
        const ctx = {
          ...inherited,
          workClass: 'report' as const,
          signal: extra?.signal
            ? AbortSignal.any([inherited.signal, extra.signal])
            : inherited.signal,
          deadlineAt: Math.min(inherited.deadlineAt, Date.now() + (params.deadlineMs ?? 120000)),
        };
        const queryHash = queryHashFor(query);
        const policy =
          currentOperation()?.policyScope ??
          (config ? policyScopeFor(config) : 'isolated-unconfigured-report');
        const binding = handleBindingFor(client, policy, queryHash);
        const previous = params.resumeHandle
          ? resultHandles.get<SalesState>(params.resumeHandle, binding)
          : undefined;
        if (previous && previous.kind !== 'sales-report')
          throw new Error('Handle is not a sales report; restart the query.');
        ctx.signal.throwIfAborted();
        if (params.detailOffset !== undefined) {
          if (!previous || !params.resumeHandle)
            throw new Error('Retained detail requires resumeHandle from the identical report.');
          if (params.detailOffset > previous.rows.length)
            throw new Error('Detail offset is outside retained rows.');
          const totalRows = previous.rows.length;
          return formatDetail(
            {
              rows: previous.rows.slice(
                params.detailOffset,
                params.detailOffset + (params.detailLimit ?? 100),
              ),
              meta: {
                ...salesStateEvidence(previous),
                consistency: 'multi-observation',
                snapshotConsistent: false,
                firstObservedAt: previous.firstObservedAt,
                lastObservedAt: previous.lastObservedAt,
                resumeHandle: params.resumeHandle,
                queryHash,
                detail: {
                  totalRows,
                  offset: params.detailOffset,
                  returnedRows: 0,
                  nextOffset: null,
                  resourceUri: `priority://results/${params.resumeHandle}/${queryHash}/0`,
                },
              },
            },
            params.detailOffset,
          );
        }
        const progress = extra as unknown as {
          _meta?: { progressToken?: string | number };
          sendNotification?: (notification: {
            method: 'notifications/progress';
            params: { progressToken: string | number; progress: number; total: number };
          }) => Promise<void>;
        };
        const token = progress?._meta?.progressToken;
        let lastSent = Number.NEGATIVE_INFINITY;
        let lastCount = 0;
        const output = await runSalesReport(client, query, {
          concurrency: config?.priorityReportConcurrency ?? 2,
          ctx,
          previous,
          fullRefresh: params.fullRefresh,
          onProgress:
            token !== undefined && progress.sendNotification
              ? async (update) => {
                  if (
                    ctx.signal.aborted ||
                    Date.now() >= ctx.deadlineAt ||
                    update.completed <= lastCount ||
                    Date.now() - lastSent < 2000
                  )
                    return;
                  lastSent = Date.now();
                  lastCount = update.completed;
                  await progress.sendNotification?.({
                    method: 'notifications/progress',
                    params: {
                      progressToken: token,
                      progress: update.completed,
                      total: update.total,
                    },
                  });
                }
              : undefined,
        });
        const handle = resultHandles.create(binding, output.state);
        if (params.resumeHandle && handle) resultHandles.remove(params.resumeHandle);
        const resourceUri = handle ? `priority://results/${handle}/${queryHash}/0` : null;
        const result = {
          ...output.result,
          rows: output.result.rows.slice(0, 100),
          meta: {
            ...output.result.meta,
            resumable: Boolean(handle),
            resumeHandle: handle,
            queryHash,
            detail: {
              totalRows: output.result.rows.length,
              returnedRows: Math.min(100, output.result.rows.length),
              pageSize: 100,
              nextPage: output.result.rows.length > 100 ? 1 : null,
              resourceUri,
            },
            ...(!handle ? { restartRequired: true } : {}),
          },
          warnings: [
            ...output.result.warnings,
            ...(!handle
              ? [
                  'Retained report state exceeds the bounded handle budget; narrow the query or use fullRefresh. No resumable handle was created.',
                ]
              : []),
          ],
        };
        const formatted = formatDetail(result, 0);
        return handle && resourceUri
          ? {
              ...formatted,
              content: [
                ...formatted.content,
                {
                  type: 'resource_link' as const,
                  uri: resourceUri,
                  name: 'Report detail pages',
                  mimeType: 'application/json',
                },
              ],
            }
          : formatted;
      } catch (error) {
        throw toMcpError(error);
      }
    },
  );
}
