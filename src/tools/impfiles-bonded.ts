import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { FINAL_DOC_STATUS } from '../lib/impfile-stage.js';
import { goodsReadback } from '../lib/impfiles-logic.js';
import { escapeODataString, sanitizeODataValue } from '../lib/sanitize.js';
import { textResult } from '../lib/write-guard.js';
import { loadStage } from '../services/import-stage.js';

type Row = Record<string, unknown>;
const BONDED_WAREHOUSE = 'arov';

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
 * by Assaf in the Priority screens; these tools GUIDE the exact LBI2400656 sequence and VERIFY
 * state by reading back the warehouse config, the file, its releases and their per-line costs.
 * Writing a release over OData is blocked by the server (src/lib/import-stage-guard.ts). Confirmed
 * live 2026-07-18: 'arov' is a type-D bonded warehouse (BONDED='Y'); location '0' is the bonded
 * holding location (excluded from inventory value) and 'arova' is the costed/released location.
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
    return client.get<Row>('IMPFILES', impfnum, qb.build());
  };

  // Releases of one file with, per release, how many lines carry a per-line import cost.
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
    const rows = (await client.list<Row>('DOCUMENTS_J', qb.build())).value;
    return rows.map((doc) => {
      const lines = (doc.TRANSORDER_J_SUBFORM as Row[] | undefined) ?? [];
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
    `סטטוס מחסן ערובה. Report a bonded warehouse's configuration (default 'arov').

Reads WAREHOUSES: the bonded flag and each location's cost inclusion. The holding location is the one
NOT in inventory value (inInventoryValue=false); the costed location holds released goods. NOTE: a
warehouse can be TYPE='D' without being bonded (e.g. the main warehouse) — BONDED='Y' is the flag.`,
    {
      warehouse: z
        .string()
        .default(BONDED_WAREHOUSE)
        .describe("Warehouse WARHSNAME (default 'arov')"),
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

⚠️ Done by Assaf in the screen "קבלות סחורה מספק" (warehouse arov, location 0); this tool only explains
the step and reads back the file; results carry "mutates": false. Receiving into the bonded holding
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
          doneBy: 'Assaf, in the screen',
          screenAction: 'קבלות סחורה מספק (מחסן arov, איתור 0)',
          warehouse: file.WARHSNAME ?? null,
          instructions: [
            'Receive the supplier goods into the bonded warehouse (arov, bonded holding location).',
            'The receipt keeps the goods out of inventory value until release, and closes the PO balance (reflected by po_match).',
            'Next: bonded_fill_detail to record the pallet contents.',
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

⚠️ Done by Assaf in the import-file screen; results carry "mutates": false. After the bonded receipt, run "מילוי פירוט למחסן ערובה" and record the pallet
number in "תכולה במחסני ערובה". Returns the step guidance + a read-back of the file's goods content.`,
    { impfnum: z.string().min(1).describe('IMPFNUM') },
    async (p) => {
      try {
        const file = await fileState(p.impfnum);
        return textResult({
          mutates: false,
          impfnum: p.impfnum,
          step: 'fill bonded detail (מילוי פירוט למחסן ערובה)',
          doneBy: 'Assaf, in the screen',
          screenAction: 'מילוי פירוט למחסן ערובה',
          instructions: [
            'Fill "מילוי פירוט למחסן ערובה" and record the pallet number in "תכולה במחסני ערובה".',
            'Next: run "חישוב העמסה", check readiness with impfile_close, close the file in the screen ("סגירת התיק"), then bonded_release_guide.',
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

⚠️ Done by Assaf in the screen "קבלות סחורה ממחסן ערובה" (the server blocks writing a release over the
API); results carry "mutates": false. Release is done on the customs (מכס) part only, against a rishumon (declaration),
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
          'File is not closed — it must be closed in the screen ("סגירת התיק") before releasing from the bonded warehouse.',
        );
        return textResult({
          mutates: false,
          impfnum: p.impfnum,
          step: 'bonded release (קבלות סחורה ממחסן ערובה)',
          doneBy: 'Assaf, in the screen',
          screenAction: 'קבלות סחורה ממחסן ערובה',
          fileClosed: closedGate.fileClosed,
          // An open file lists what is still missing before the close; a closed one only the gate.
          warnings: [...closedGate.warnings, ...(stage.closed ? [] : stage.closeBlocking)],
          stage,
          instructions: [
            'In "קבלות סחורה ממחסן ערובה": select the file + rishumon (declaration) number + the customs-broker invoice (on the מכס part ONLY).',
            'Enter the released quantities (partial allowed), the per-line import costs, and the additional-costs %.',
            'לפי ה-SOP (LBI2400656, שלב ד׳ 13–15): להריץ "רישום עלויות יבוא לשורה" כשהתיק סגור והתעודה עדיין טיוטה, לבדוק את העלויות במסך "עלויות יבוא לשורה", ורק אז לשנות את הסטטוס לסופית. אחר כך תמחיר.',
            'לידיעה: עד 23.11.2026 כל ההרצות של "רישום עלויות יבוא לשורה" בחברה היו על תעודה סופית; הסדר הרשמי (על טיוטה) טרם נוסה כאן.',
            'Editing after a partial release: Assaf reopens the file in the screen ("ביטול סגירה של התיק") → add → close again.',
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

⚠️ Done by Assaf in the release screen ("רישום עלויות יבוא לשורה"); results carry "mutates": false.
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
          doneBy: 'Assaf, in the screen',
          screenAction: 'רישום עלויות יבוא לשורה',
          fileClosed: closedGate.fileClosed,
          warnings: [...closedGate.warnings, ...costWarnings],
          lineCosts,
          instructions: [
            'On the closed file, register the per-line import costs in "רישום עלויות ייבוא לשורה".',
            'To add costs after a partial release: Assaf reopens the file in the screen → add → close again.',
          ],
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
