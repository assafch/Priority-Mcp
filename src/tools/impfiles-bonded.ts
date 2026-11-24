import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { VAT_DECLARATION_PART } from '../lib/impfile-official.js';
import { FINAL_DOC_STATUS } from '../lib/impfile-stage.js';
import { goodsReadback } from '../lib/impfiles-logic.js';
import { escapeODataString, sanitizeODataValue } from '../lib/sanitize.js';
import { textResult } from '../lib/write-guard.js';
import { loadStage } from '../services/import-stage.js';

type Row = Record<string, unknown>;
const BONDED_WAREHOUSE = 'BONDED';

/** Shared closed-gate result for the release / line-costs guidance tools. */
function fileClosedWarning(
  file: Row,
  message: string,
): { fileClosed: boolean; warnings: string[] } {
  const closed = file.CLOSED === 'Y';
  return { fileClosed: closed, warnings: closed ? [] : [message] };
}

/**
 * Bonded-warehouse module (spec §Phase 5, LBI2400656). The bonded receive→release steps are done
 * by the owner in the Priority screens; these tools GUIDE the exact LBI2400656 sequence and VERIFY
 * state by reading back the warehouse config, the file, its releases and their per-line costs.
 * Writing a release over OData is blocked by the server (src/lib/import-stage-guard.ts). Confirmed
 * live 2026-07-18: 'BONDED' is a type-D bonded warehouse (BONDED='Y'); location '0' is the bonded
 * holding location (excluded from inventory value) and 'RELEASED' is the costed/released location.
 */
export function registerBondedTools(server: McpServer, client: PriorityClient, _config: Config) {
  const warehouseConfig = async (warehouse: string): Promise<Row[]> => {
    const qb = new ODataBuilder()
      .eq('WARHSNAME', sanitizeODataValue(warehouse))
      .select('WARHSNAME', 'WARHSDES', 'LOCNAME', 'TYPE', 'BONDED', 'COSTFLAG')
      .top(200);
    const r = await client.list<Row>('WAREHOUSES', qb.build());
    return r.value;
  };

  // File header + goods content (for read-back). withItems=false fetches only the closed flag.
  const fileState = async (impfnum: string, withItems = true): Promise<Row> => {
    const qb = withItems
      ? new ODataBuilder().expand('IMPFILEITEMS_SUBFORM')
      : new ODataBuilder().select('IMPFNUM', 'STATDES', 'CLOSED');
    // Read live: the step tools change the file through programs, which leave the cache stale.
    return client.get<Row>('IMPFILES', impfnum, qb.build(), { cache: false });
  };

  // Releases of one file with, per release, how many lines carry a per-line import cost. Read
  // live: "רישום עלויות יבוא לשורה" runs as a program, so a cached answer from before it is stale
  // (first pilot file, 2026-11-23: linesWithoutCost 1 right after a clean run). An empty "מע'מ" line
  // pulled from the file content is not goods and is not counted.
  const releaseLineCosts = async (
    impfnum: string,
  ): Promise<Array<{ docno: string; status: string; lines: number; linesWithoutCost: number }>> => {
    const qb = new ODataBuilder()
      .filter(`IMPFNUM eq '${escapeODataString(impfnum)}'`)
      .select('DOCNO', 'STATDES')
      .expand(
        'TRANSORDER_J_SUBFORM($select=PARTNAME,TQUANT,KLINE;$expand=TRANSIMPFILE_SUBFORM($select=IMPFCOST,TOTCOST,UDATE))',
      )
      .top(200);
    const rows = (await client.list<Row>('DOCUMENTS_J', qb.build(), { cache: false })).value;
    return rows.map((doc) => {
      const lines = ((doc.TRANSORDER_J_SUBFORM as Row[] | undefined) ?? []).filter(
        (l) => !(l.PARTNAME === VAT_DECLARATION_PART && (Number(l.TQUANT) || 0) === 0),
      );
      const withoutCost = lines.filter((line) => {
        const cost = (line.TRANSIMPFILE_SUBFORM as Row | null | undefined)?.IMPFCOST;
        return typeof cost !== 'number' || cost === 0;
      }).length;
      return {
        docno: String(doc.DOCNO ?? ''),
        status: String(doc.STATDES ?? ''),
        lines: lines.length,
        linesWithoutCost: withoutCost,
      };
    });
  };

  server.tool(
    'bonded_status',
    `סטטוס מחסן ערובה. Report a bonded warehouse's configuration (default 'BONDED').

Reads WAREHOUSES: the bonded flag and each location's cost inclusion. The holding location is the one
NOT in inventory value (inInventoryValue=false); the costed location holds released goods. NOTE: a
warehouse can be TYPE='D' without being bonded (e.g. the main warehouse) — BONDED='Y' is the flag.`,
    {
      warehouse: z
        .string()
        .default(BONDED_WAREHOUSE)
        .describe("Warehouse WARHSNAME (default 'BONDED')"),
    },
    async (p) => {
      try {
        const rows = await warehouseConfig(p.warehouse);
        if (!rows.length)
          return textResult({ warehouse: p.warehouse, found: false, isBonded: false });
        return textResult({
          warehouse: p.warehouse,
          found: true,
          // BONDED='Y' is the authoritative bonded flag; TYPE='D' alone does NOT mean bonded.
          isBonded: rows.some((r) => r.BONDED === 'Y'),
          locations: rows.map((r) => ({
            location: r.LOCNAME,
            type: r.TYPE,
            description: r.WARHSDES ?? null,
            bonded: r.BONDED === 'Y',
            inInventoryValue: r.COSTFLAG === 'Y', // holding location = false; costed/released = true
          })),
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'bonded_receipt_guide',
    `קבלת סחורה למחסן ערובה (spec §Phase 5). READ-ONLY GUIDE — does NOT receive anything.

The step itself is done by bonded_receipt, which creates the receipt as a DRAFT (warehouse BONDED,
location 0, invoice quantities); bonded_receipt_finalize makes it final, with the owner's approval
code from its own preview. This guide only explains the step and reads back the file; results carry "mutates":
false. Receiving into the bonded holding
location keeps the goods OUT of inventory value until release (LBI2400656), and CLOSES the PO balance
even before release. Returns the step guidance + a read-back of the file's goods content.`,
    { impfnum: z.string().min(1).describe('IMPFNUM') },
    async (p) => {
      try {
        const file = await fileState(p.impfnum);
        return textResult({
          mutates: false,
          impfnum: p.impfnum,
          step: 'bonded receipt (קבלת סחורה למחסן ערובה)',
          tool: 'bonded_receipt',
          doneBy:
            "bonded_receipt (creates the draft receipt); bonded_receipt_finalize makes it final with the owner's approval code",
          stillManual:
            "הבעלים: מאשר בצ'אט את התצוגה המקדימה של bonded_receipt_finalize לפני שהקבלה הופכת לסופית.",
          screenAction: 'קבלות סחורה מספק (מחסן BONDED, איתור 0)',
          warehouse: file.WARHSNAME ?? null,
          instructions: [
            'bonded_receipt receives the goods invoice into the bonded warehouse (BONDED, bonded holding location) as a draft; the owner then sets the receipt to final.',
            'The receipt keeps the goods out of inventory value until release, and closes the PO balance (reflected by po_match).',
            'Next, once the receipt is final: bonded_fill_detail.',
          ],
          readback: goodsReadback(file.IMPFILEITEMS_SUBFORM),
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'bonded_fill_detail_guide',
    `מילוי פירוט למחסן ערובה / תכולה במחסני ערובה (spec §Phase 5). READ-ONLY GUIDE — fills in nothing.

The step itself is done by bonded_fill_detail, which runs Priority's program "מילוי פירוט למחסן
ערובה" after the receipt is final and deletes the VAT line the program copies. The pallet number in
"תכולה במחסני ערובה" is not written by any tool. This guide only explains the step and reads back
the file's goods content; results carry "mutates": false.`,
    { impfnum: z.string().min(1).describe('IMPFNUM') },
    async (p) => {
      try {
        const file = await fileState(p.impfnum);
        return textResult({
          mutates: false,
          impfnum: p.impfnum,
          step: 'fill bonded detail (מילוי פירוט למחסן ערובה)',
          tool: 'bonded_fill_detail',
          doneBy: 'bonded_fill_detail (runs the program FILL_IMPFILES)',
          stillManual:
            'מספר משטח ב"תכולה במחסני ערובה" אינו נכתב על ידי הכלי; אם רוצים אותו, הבעלים ממלא במסך.',
          screenAction: 'מילוי פירוט למחסן ערובה',
          instructions: [
            'bonded_fill_detail runs "מילוי פירוט למחסן ערובה" and verifies the content against the goods invoice.',
            'Next: impfile_run_calc ("חישוב העמסה"), check readiness with impfile_close, then impfile_close_run ("סגירת התיק", after the owner approves its preview), then bonded_release_draft.',
          ],
          readback: goodsReadback(file.IMPFILEITEMS_SUBFORM),
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'bonded_release_guide',
    `שחרור מהמחסן ערובה (קבלות סחורה ממחסן ערובה, spec §Phase 5). READ-ONLY GUIDE — releases nothing.

The draft release is created by bonded_release_draft (header + quantities, no status) and its
per-line costs by bonded_line_costs; bonded_release_finalize makes it final, with the owner's
approval code from its own preview (the server blocks every other write to a release). This guide only
explains and reads back; results carry "mutates": false. Release is done on the customs (מכס) part only, against a rishumon (declaration),
with released quantities (partial supported), the customs-broker invoice, the per-line import costs,
and the additional-costs %. The FILE MUST BE CLOSED before release. Per the SOP (LBI2400656 ד׳
13–15) "רישום עלויות יבוא לשורה" is run on the release BEFORE it is made final. Returns guidance +
read-back (unreleased quantity remaining, whether the file is closed, and which steps of the
mandatory order are proven).`,
    { impfnum: z.string().min(1).describe('IMPFNUM') },
    async (p) => {
      try {
        const [file, stage] = await Promise.all([
          fileState(p.impfnum),
          loadStage(client, p.impfnum),
        ]);
        const closedGate = fileClosedWarning(
          file,
          'File is not closed — it must be closed ("סגירת התיק", impfile_close_run) before releasing from the bonded warehouse.',
        );
        return textResult({
          mutates: false,
          impfnum: p.impfnum,
          step: 'bonded release (קבלות סחורה ממחסן ערובה)',
          tool: 'bonded_release_draft',
          doneBy:
            "bonded_release_draft (draft + quantities), then bonded_line_costs; bonded_release_finalize makes it final with the owner's approval code",
          stillManual:
            "הבעלים: מאשר בצ'אט את התצוגה המקדימה של bonded_release_finalize (תעודת השחרור לסופית), אחרי בדיקת העלויות לשורה. מספר משטח ואחוז עלויות נוספות אינם נכתבים על ידי הכלים.",
          screenAction: 'קבלות סחורה ממחסן ערובה',
          fileClosed: closedGate.fileClosed,
          // An open file lists what is still missing before the close; a closed one only the gate.
          warnings: [...closedGate.warnings, ...(stage.closed ? [] : stage.closeBlocking)],
          stage,
          instructions: [
            'bonded_release_draft: the file + rishumon (declaration) number + released quantities (whole balance, or a partial list). It leaves the release a draft.',
            'לפי ה-SOP (LBI2400656, שלב ד׳ 13–15): bonded_line_costs מריץ "רישום עלויות יבוא לשורה" כשהתיק סגור והתעודה עדיין טיוטה; בודקים את העלויות לשורה, ורק אז הבעלים משנה את הסטטוס לסופית. אחר כך תמחיר.',
            'לידיעה: עד 23.11.2026 כל ההרצות של "רישום עלויות יבוא לשורה" בחברה היו על תעודה סופית; הסדר הרשמי (על טיוטה) טרם נוסה כאן, ולכן ההרצה הראשונה של כל כלי היא פיילוט בנוכחות הבעלים.',
            'Editing after a partial release: the owner reopens the file in the screen ("ביטול סגירה של התיק") → add → close again.',
          ],
          readback: goodsReadback(file.IMPFILEITEMS_SUBFORM),
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'bonded_line_costs_guide',
    `רישום עלויות ייבוא לשורה (spec §Phase 5). READ-ONLY GUIDE — registers no costs. The FILE MUST BE
CLOSED for the real (screen) operation.

The step itself is done by bonded_line_costs, which runs Priority's program "רישום עלויות יבוא
לשורה" on one release. This guide only reads; results carry "mutates": false.
Checks the file is closed, returns the step guidance, and READS BACK every release of the file:
how many released lines carry an import cost and how many do not. Per-line import costs are
registered only on a CLOSED file, and per the SOP (LBI2400656 ד׳ 13–15) before the release is made
final. For the cost of each product see impfile_cost_report.`,
    { impfnum: z.string().min(1).describe('IMPFNUM') },
    async (p) => {
      try {
        const [file, lineCosts] = await Promise.all([
          fileState(p.impfnum, false), // only the closed flag is needed here
          // a failed read is reported as unknown, never as "all lines costed"
          releaseLineCosts(p.impfnum).catch(() => null),
        ]);
        const closedGate = fileClosedWarning(
          file,
          'File is NOT closed — per-line import costs can only be registered on a CLOSED file (close it first).',
        );
        const costWarnings =
          lineCosts === null
            ? ['לא ניתן היה לקרוא את השחרורים מערובה — לא ניתן לאשר שעלויות היבוא נרשמו.']
            : lineCosts
                .filter((r) => r.status === FINAL_DOC_STATUS && r.linesWithoutCost > 0)
                .map((r) => `בשחרור ${r.docno} יש ${r.linesWithoutCost} שורות בלי עלויות יבוא.`);
        return textResult({
          mutates: false,
          impfnum: p.impfnum,
          step: 'register import costs to line (רישום עלויות ייבוא לשורה)',
          tool: 'bonded_line_costs',
          doneBy: 'bonded_line_costs (runs the program IMPORTCOSTPERLINE on one release)',
          stillManual:
            'הבעלים: בדיקת העלויות, שינוי סטטוס תעודת השחרור לסופית, ותמחיר לתאריך נוכחי.',
          screenAction: 'רישום עלויות יבוא לשורה',
          fileClosed: closedGate.fileClosed,
          warnings: [...closedGate.warnings, ...costWarnings],
          lineCosts,
          instructions: [
            'On the closed file, bonded_line_costs registers the per-line import costs on the release while it is still a draft.',
            'To add costs after a partial release: the owner reopens the file in the screen → add → close again.',
          ],
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
