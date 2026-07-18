import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { goodsReadback } from '../lib/impfiles-logic.js';
import { sanitizeODataValue } from '../lib/sanitize.js';
import { textResult } from '../lib/write-guard.js';

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
 * Bonded-warehouse module (spec §Phase 5, LBI2400656). The bonded receive→release procedures are
 * Priority SCREEN operations (not OData-writable on this install), so these tools GUIDE the exact
 * LBI2400656 sequence and VERIFY state by reading back the warehouse config + the file. Confirmed
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
    'bonded_receipt_create',
    `קבלת סחורה למחסן ערובה (spec §Phase 5). Guide receiving goods into the bonded warehouse, and verify.

⚠️ SCREEN PROCEDURE (bonded ops are not OData-writable here). Receiving into the bonded holding
location keeps the goods OUT of inventory value until release (LBI2400656), and CLOSES the PO balance
even before release. Returns the step guidance + a read-back of the file's goods content.`,
    { impfnum: z.string().min(1).describe('IMPFNUM') },
    async (p) => {
      try {
        const file = await fileState(p.impfnum);
        return textResult({
          impfnum: p.impfnum,
          step: 'bonded receipt (קבלת סחורה למחסן ערובה)',
          procedure: 'UI-only',
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
    'bonded_fill_detail',
    `מילוי פירוט למחסן ערובה / תכולה במחסני ערובה (spec §Phase 5). Guide filling the bonded pallet/contents
detail, and verify.

⚠️ SCREEN PROCEDURE. After the bonded receipt, fill "מילוי פירוט למחסן ערובה" and record the pallet
number in "תכולה במחסני ערובה". Returns the step guidance + a read-back of the file's goods content.`,
    { impfnum: z.string().min(1).describe('IMPFNUM') },
    async (p) => {
      try {
        const file = await fileState(p.impfnum);
        return textResult({
          impfnum: p.impfnum,
          step: 'fill bonded detail (מילוי פירוט למחסן ערובה)',
          procedure: 'UI-only',
          instructions: [
            'Fill "מילוי פירוט למחסן ערובה" and record the pallet number in "תכולה במחסני ערובה".',
            'Next: close the file (impfile_close), then bonded_release_create to release against the declaration.',
          ],
          readback: goodsReadback(file.IMPFILEITEMS_SUBFORM),
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'bonded_release_create',
    `שחרור מהמחסן ערובה (קבלות סחורה ממחסן ערובה, spec §Phase 5). Guide releasing goods against a
declaration, and verify.

⚠️ SCREEN PROCEDURE. Release is done on the customs (מכס) part only, against a rishumon (declaration),
with released quantities (partial supported), the customs-broker invoice, the per-line import costs,
and the additional-costs %. The FILE MUST BE CLOSED before release. Returns guidance + read-back
(unreleased quantity remaining, and whether the file is closed).`,
    { impfnum: z.string().min(1).describe('IMPFNUM') },
    async (p) => {
      try {
        const file = await fileState(p.impfnum);
        return textResult({
          impfnum: p.impfnum,
          step: 'bonded release (קבלות סחורה ממחסן ערובה)',
          procedure: 'UI-only',
          ...fileClosedWarning(
            file,
            'File is not closed — close it (impfile_close) before releasing from the bonded warehouse.',
          ),
          instructions: [
            'In "קבלות סחורה ממחסן ערובה": select the file + rishumon (declaration) number + the customs-broker invoice (on the מכס part ONLY).',
            'Enter the released quantities (partial allowed), the per-line import costs, and the additional-costs %.',
            'Editing after a partial release: reopen the file (impfile_reopen) → add → close again.',
          ],
          readback: goodsReadback(file.IMPFILEITEMS_SUBFORM),
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'bonded_line_costs',
    `רישום עלויות ייבוא לשורה (spec §Phase 5). Guide registering import costs to a released line — the
FILE MUST BE CLOSED.

⚠️ SCREEN PROCEDURE. Checks the file is closed and returns the step guidance; per-line import costs
are registered only on a CLOSED file (LBI2400656). To add costs after a partial release: reopen →
add → close.`,
    { impfnum: z.string().min(1).describe('IMPFNUM') },
    async (p) => {
      try {
        const file = await fileState(p.impfnum, false); // only the closed flag is needed here
        return textResult({
          impfnum: p.impfnum,
          step: 'register import costs to line (רישום עלויות ייבוא לשורה)',
          procedure: 'UI-only',
          ...fileClosedWarning(
            file,
            'File is NOT closed — per-line import costs can only be registered on a CLOSED file (close it first).',
          ),
          instructions: [
            'On the closed file, register the per-line import costs in "רישום עלויות ייבוא לשורה".',
            'To add costs after a partial release: reopen the file (impfile_reopen) → add → close again.',
          ],
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
