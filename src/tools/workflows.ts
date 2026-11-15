import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { formatResult } from '../lib/result-contracts.js';
import { createOperation, currentOperation } from '../runtime/operation-context.js';
import { customerSnapshot } from '../services/customer-snapshot.js';
import { importDiagnosis } from '../services/import-diagnosis.js';
import { orderDiagnosis } from '../services/order-diagnosis.js';
const limits = {
  maxRows: z.number().int().min(1).max(500).default(100),
  maxPages: z.number().int().min(1).max(20).default(8),
  budgetMs: z.number().int().min(1).max(120000).default(20000),
};
export function registerReadWorkflowTools(
  server: McpServer,
  client: PriorityClient,
  config: Config,
): void {
  const context = (toolName: string, budgetMs: number) => {
    const ctx = currentOperation() ?? createOperation(toolName, { metrics: client.metrics });
    return { ...ctx, deadlineAt: Math.min(ctx.deadlineAt, Date.now() + budgetMs), client, config };
  };
  server.tool(
    'priority_customer_snapshot',
    'Read an exact customer identity, balance, bounded orders and invoices with source evidence and component policy. Requires CUSTNAME; resolve/select names first. Ledger balances do not establish bank receipt.',
    {
      customerId: z.string().min(1).max(256),
      sections: z.array(z.enum(['balance', 'orders', 'invoices'])).optional(),
      ...limits,
    },
    async (input) => {
      const ctx = context('priority_customer_snapshot', input.budgetMs);
      const result = await customerSnapshot(
        {
          customerId: input.customerId,
          sections: input.sections,
          budget: { maxRows: input.maxRows, maxPages: input.maxPages, deadlineAt: ctx.deadlineAt },
        },
        ctx,
      );
      return formatResult(
        { identity: result.identity, sections: result.sections },
        { mode: 'summary', rowLimit: 25, meta: result.meta },
      );
    },
  );
  server.tool(
    'priority_order_diagnosis',
    'Read one exact order and bounded shipment-source evidence by default. Request sections: ["lines", "shipments"] to include bounded line state. Requires ORDNAME; no fuzzy substitutions. ERP labels/tracking are not carrier delivery proof.',
    {
      orderNumber: z.string().min(1).max(256),
      sections: z
        .array(z.enum(['lines', 'shipments']))
        .optional()
        .describe('Defaults to shipments. Include lines explicitly for bounded order-line state.'),
      ...limits,
    },
    async (input) => {
      const ctx = context('priority_order_diagnosis', input.budgetMs);
      const result = await orderDiagnosis(
        {
          orderNumber: input.orderNumber,
          sections: input.sections,
          budget: { maxRows: input.maxRows, maxPages: input.maxPages, deadlineAt: ctx.deadlineAt },
        },
        ctx,
      );
      return formatResult(
        { identity: result.identity, sections: result.sections },
        { mode: 'summary', rowLimit: 25, meta: result.meta },
      );
    },
  );
  server.tool(
    'priority_import_diagnosis',
    'Read one exact import-file snapshot and compute policy-allowed preflight/landed-cost diagnostics from that same snapshot. Missing/truncated source rows prevent financial calculations. Requires IMPFNUM.',
    {
      impfnum: z.string().min(1).max(256),
      sections: z.array(z.enum(['snapshot', 'preflight', 'landedCost'])).optional(),
      ...limits,
    },
    async (input) => {
      const ctx = context('priority_import_diagnosis', input.budgetMs);
      const result = await importDiagnosis(
        {
          impfnum: input.impfnum,
          sections: input.sections,
          budget: { maxRows: input.maxRows, maxPages: input.maxPages, deadlineAt: ctx.deadlineAt },
        },
        ctx,
      );
      return formatResult(
        { identity: result.identity, sections: result.sections },
        { mode: 'summary', rowLimit: 25, meta: result.meta },
      );
    },
  );
}
