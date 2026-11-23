import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import {
  FINAL_DOC_STATUS,
  buildCostReport,
  computeOfficialSteps,
  lineIsCosted,
} from '../lib/impfile-official.js';
import { textResult } from '../lib/write-guard.js';
import { loadCostingReadiness, loadFileFacts, loadPartCosts } from '../services/import-facts.js';

/**
 * The end of the import-file process as Priority's SOP defines it (LBI2400273, "תוצאות"): after
 * the file is closed, the goods are released and the costing program has run, what did each
 * product cost including its share of the import costs. Both tools only read.
 */
export function registerImpfileCostingTools(
  server: McpServer,
  client: PriorityClient,
  _config: Config,
) {
  server.tool(
    'impfile_cost_report',
    `עלות מועמסת לכל מוצר בתיק יבוא. Landed cost per product of one import file — READ ONLY.

All figures are Priority's own; nothing is estimated. Per released line, from the screen
"עלויות יבוא לשורה": ערך טובין בשקלים (goodsILS), סכום המכס (customsILS), עלויות נוספות
(additionalILS), עלויות יבוא כלליות (importILS), סה"כ עלות בשקלים (totalILS), and
unitLandedILS = total ÷ quantity. Per product it adds what Priority recorded as the cost of the
stock entry (movementCostILS, from the product card's recent movements) and the product's
"עלות" / "ת. תמחיר" after costing (itemCostILS, costingDate — an item-level cost, which can
differ from one shipment's landed cost).

'reconciliation' checks that the import costs registered on the final releases equal the cost
invoices linked to the file without the VAT-from-declaration line, to the agora
('ties-within-rounding' = a difference within a tolerance of half an agora per released line — a
tolerance chosen here for allocation rounding, not a documented Priority rule); it is judged only
when the whole file was released and every cost invoice is in local currency. 'stage' is the
twelve official steps (SOP LBI2400273 + LBI2400656) with the first one not yet done.
Only final releases count toward byPart; every release is listed under 'releases' with its line
count and how many lines carry no costs. byPart is PAGED so no product is ever dropped silently:
'parts' gives total / returned / nextSkip — call again with skip=nextSkip until nextSkip is null.
'totals' and 'reconciliation' always cover the whole file, whatever page is shown.`,
    {
      impfnum: z.string().min(1).describe('Import file number (IMPFNUM), e.g. IM26000023'),
      skip: z.number().int().min(0).default(0).describe('Products to skip (paging)'),
      top: z.number().int().min(1).max(60).default(30).describe('Products per page (max 60)'),
    },
    async (p) => {
      try {
        const { facts } = await loadFileFacts(client, p.impfnum);
        const stage = computeOfficialSteps(facts);
        const finals = (facts.releases ?? []).filter((r) => r.status === FINAL_DOC_STATUS);
        const partCosts = await loadPartCosts(
          client,
          finals.flatMap((r) => r.lines.map((l) => l.part)),
          finals.map((r) => r.docno),
        );
        const report = buildCostReport(facts, partCosts, stage);
        const zeroIsValid = !facts.invoices.some((iv) => !iv.isGoods);
        const page = report.byPart.slice(p.skip, p.skip + p.top);
        const end = p.skip + page.length;
        const sum = (pick: (row: (typeof report.byPart)[number]) => number) =>
          Math.round(report.byPart.reduce((acc, row) => acc + Math.round(pick(row) * 100), 0)) /
          100;
        return textResult({
          mutates: false,
          currency: 'ILS',
          impfnum: report.impfnum,
          closed: report.closed,
          fullyReleased: report.fullyReleased,
          totals: {
            goodsILS: sum((r) => r.goodsILS),
            importILS: sum((r) => r.importILS),
            totalILS: sum((r) => r.totalILS),
          },
          reconciliation: report.reconciliation,
          costing: report.costing,
          releases: report.releases.map((r) => ({
            docno: r.docno,
            status: r.status,
            date: r.date,
            declaration: r.declaration,
            lines: r.lines.length,
            linesWithoutCost: (facts.releases ?? [])
              .filter((f) => f.docno === r.docno)
              .flatMap((f) => f.lines)
              .filter((l) => !lineIsCosted(l, zeroIsValid)).length,
          })),
          parts: {
            total: report.byPart.length,
            skip: p.skip,
            returned: page.length,
            nextSkip: end < report.byPart.length ? end : null,
          },
          byPart: page,
          warnings: report.warnings,
          stage: {
            currentStep: stage.currentStep,
            nextAction: stage.nextAction,
            historicalGaps: stage.historicalGaps,
            steps: stage.steps.map((s) => ({ n: s.n, title: s.title, state: s.state })),
          },
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_costing_readiness',
    `מוכנות לתמחיר — על כל התיקים. Is the company ready for a costing run? READ ONLY.

The costing program ("תמחיר לתאריך נוכחי") runs on every part in the company, so its
precondition is company-wide. Scans every release from bonded (קבלות סחורה ממחסן ערובה) dated on
or after 'since' (default: the last 365 days) and reports:
  • blockers — a FINAL release with a line that carries no import costs ("רישום עלויות יבוא
    לשורה" did not run) or import costs of exactly 0 (not proven either way), or a final release on
    a file that is not closed (the costing program only takes closed files into account).
    readyToRun is false while any exists.
  • pendingFiles — files whose release or line costs changed after the last costing run;
    costingNeeded is true when there are any.
  • ambiguousFiles — the change and the last costing run carry the same minute, so their order
    cannot be told (Priority timestamps have minute resolution); another costing run settles it.
  • draftReleases — releases not yet final (not costed until they are).
This tool never runs the costing program; costing_run does, with the owner's approval code.`,
    {
      since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Scan releases dated on/after this day (YYYY-MM-DD). Default: 365 days ago.'),
    },
    async (p) => {
      try {
        const { since, readiness } = await loadCostingReadiness(client, p.since);
        if (!readiness) {
          return textResult({
            mutates: false,
            since,
            readyToRun: false,
            costingNeeded: null,
            blockers: ['לא ניתן היה לקרוא את יומן התמחיר (COSTINGLOG).'],
          });
        }
        return textResult({ mutates: false, since, ...readiness });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
