import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { WebSdkSession, deriveWebSdkLoginConfig, loadWebSdk } from '../client/web-sdk.js';
import type { Config } from '../config.js';
import { textResult } from '../lib/write-guard.js';
import {
  type StepDeps,
  type StepOutcome,
  createBondedReceipt,
  createReleaseDraft,
  fillDetail,
  registerLineCosts,
  runLoadingCalc,
  setDeclaration,
} from '../services/import-steps.js';

/**
 * Executing tools for the reversible steps of Priority's official import-file procedure
 * (SOP LBI2400273 "תיקי יבוא", LBI2400656 "עבודה עם מחסן ערובה"). One tool per step; each
 * previews by default, refuses unless the earlier steps are proven, changes nothing on a repeat,
 * and reports "done" only from a re-read. None of them makes a document final.
 */
const OK_STATUSES = new Set(['preview', 'done', 'already-done']);

function toResult(outcome: StepOutcome) {
  const result = textResult(outcome);
  return OK_STATUSES.has(outcome.status) ? result : { ...result, isError: true as const };
}

const COMMON = `Common contract: dryRun=true (default) returns the plan and sends nothing. status is one of
preview | refused (a precondition is missing or could not be read) | blocked (PRIORITY_READ_ONLY) |
done (written AND confirmed by re-reading) | already-done (nothing sent) | incomplete (a draft exists
but is not complete; calling again continues it, never creates a second one) | unverified (sent, result
not visible or not provable; wait, re-read, do not resend) | cancelled (a Priority program asked
something unexpected and was cancelled unanswered) | failed (nothing written). A draft that already
carries quantities other than the requested ones is never overwritten: the tool refuses. "piloted": false means this tool
has not yet passed a supervised run on a real file — its first real run on each file type is done
with the owner watching.`;

const impfnum = z.string().min(1).max(40).describe("Import file number, e.g. 'IM99000001'");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');
const dryRun = z
  .boolean()
  .default(true)
  .describe('true = plan only, nothing sent (default); false = execute');

export function registerImpfileStepTools(
  server: McpServer,
  client: PriorityClient,
  config: Config,
  injected: StepDeps = {},
) {
  // The Web SDK is loaded and logged in only when a program tool actually needs it.
  let session: WebSdkSession | undefined;
  const deps: StepDeps = {
    ...injected,
    session:
      injected.session ??
      (() => {
        session ??= new WebSdkSession(loadWebSdk(), deriveWebSdkLoginConfig(config));
        return session;
      }),
  };
  const run = async (work: () => Promise<StepOutcome>) => {
    try {
      return toResult(await work());
    } catch (err) {
      throw toMcpError(err);
    }
  };

  server.tool(
    'pinvoice_set_declaration',
    `שלב 2 — הצהרת יבוא בכל שורת סחורה. Writes the import declaration number and date
(PINVOICEITEMS.CUSTOMSNUM / CUSTOMSDATE) on every PRODUCT line of a DRAFT goods invoice that is
linked to the import file. The field locks once the invoice is final, so this must run before the
invoice is closed. Skips the ${"מע'מ"} line and zero-quantity lines; writes only lines that differ.
Refuses when: the file is closed; the invoice is final, not linked to this file, or not from the
file's goods supplier; the file HEADER declaration is empty or different (set it first with
impfile_update). country (optional) is written only if it can be checked against Priority's
countries table; where that table is not exposed to the API the tool refuses the country and the
declaration can be written without it.
${COMMON}`,
    {
      impfnum,
      invoiceNumber: z
        .string()
        .min(1)
        .max(40)
        .describe("The draft goods invoice (temporary number), e.g. 'T1001'"),
      declaration: z
        .string()
        .min(1)
        .max(40)
        .describe('Import declaration (רשומון) number; must equal the file header declaration'),
      declarationDate: isoDate.describe('Declaration date, YYYY-MM-DD'),
      country: z
        .string()
        .min(1)
        .max(60)
        .optional()
        .describe('Country of origin (COUNTRYNAME) for every product line; omit to leave as is'),
      dryRun,
    },
    (params) => run(() => setDeclaration(client, config, params, deps)),
  );

  server.tool(
    'bonded_receipt',
    `שלב 4 — קבלת הסחורה למחסן הערובה, בטיוטה. Creates (or continues) a DRAFT goods receipt
(קבלות סחורה מספק, DOCUMENTS_P) of the file's final goods invoice into warehouse arov, location 0,
and sets every line to the invoice quantity. The header is created alone (date, supplier, arov/0,
invoice, currency); Priority pulls the lines from the invoice; the pulled lines must equal the
invoice's product lines part by part, otherwise the draft is left untouched and reported as
incomplete. The receipt STAYS A DRAFT: the owner makes it final in the screen.
Refuses when: the file is closed or its warehouse is not arov; a goods invoice is still temporary;
the existing receipts could not be read; the date is in the future; an earlier create is still
unconfirmed (180 s). An existing final receipt → already-done. An existing draft → continued.
A goods line without an import declaration is reported as a warning, not a refusal.
${COMMON}`,
    {
      impfnum,
      date: isoDate.describe('The real arrival date of the goods, YYYY-MM-DD (not in the future)'),
      invoiceNumber: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe('The final goods invoice (GI…); required only when the file has several'),
      dryRun,
    },
    (params) => run(() => createBondedReceipt(client, config, params, deps)),
  );

  const programParams = {
    impfnum,
    dryRun: z
      .boolean()
      .default(true)
      .describe('true = plan only, no Web SDK login (default); false = run the program once'),
    probe: z
      .boolean()
      .default(false)
      .describe('with dryRun: also log into the Web SDK and locate the row, read-only'),
    acceptPrompts: z
      .array(z.string().min(1).max(200))
      .max(5)
      .default([])
      .describe(
        'exact warning texts (as Priority shows them) that may be answered OK. Pass a text ONLY after the owner saw that exact warning and approved it; never on your own after a cancelled run. Default none — anything else cancels the program and is reported',
      ),
  };
  const PROGRAM_CONTRACT = `The program is Priority's own, started once through the Web SDK as a direct activation of the
import-file row; it is never retried. An information message is confirmed; a warning is answered
OK only if its exact text is in acceptPrompts; an input dialog or any other question CANCELS the
program and is returned in procedure.steps (status cancelled) — the tool never invents an answer.
After a run whose result is not confirmed (including a cancel Priority did not answer) the same
step waits 180 s. dryRun with probe=true logs in and locates the row without activating anything.
No program runs when PRIORITY_READ_ONLY=true.`;

  server.tool(
    'bonded_fill_detail',
    `שלב 5 — מילוי פירוט למחסן ערובה. Runs Priority's program "מילוי פירוט למחסן ערובה"
(FILL_IMPFILES), which fills the file's goods content from the bonded receipt, then zeroes the
${"מע'מ"} line the program copies from the broker invoice (it is not a product), and verifies that
the content equals the product lines of the goods invoice, part by part.
Refuses when: the file is closed; there is no FINAL receipt into arov; the content already holds
product lines that differ from the invoice (fix in the screen — the program is not run twice).
Content already equal → already-done. Products in place but the VAT line not yet zeroed → only
the zeroing is done.
${PROGRAM_CONTRACT}
${COMMON}`,
    programParams,
    (params) => run(() => fillDetail(client, config, params, deps)),
  );

  server.tool(
    'impfile_run_calc',
    `שלב 6 — חישוב העמסה. Runs Priority's program "חישוב העמסה" (IMPFILE2) on an OPEN import
file and verifies that the customs estimate then covers every product of the content, each with a
country of origin. Per the SOP it is repeated after every change to the file and before the close,
so a second run is allowed (never "already-done"). The result carries ranAt; impfile_close and
impfile_preflight show the last confirmed run as lastCalcViaTool.
Refuses when: the file is closed; an invoice is still temporary; there is no final receipt into
arov; the content is empty or still holds a non-zero ${"מע'מ"} line.
The close itself ("סגירת התיק") stays with the owner.
${PROGRAM_CONTRACT}
${COMMON}`,
    programParams,
    (params) => run(() => runLoadingCalc(client, config, params, deps)),
  );

  server.tool(
    'bonded_release_draft',
    `שלב 8 — תעודת שחרור ממחסן הערובה, בטיוטה. Creates (or continues) a DRAFT release
(קבלות סחורה ממחסן ערובה, DOCUMENTS_J) of a CLOSED import file from arov/0 into the receiving
warehouse, with the release's import declaration, and sets the quantities: the whole balance in
bond, or the parts and quantities listed in 'quantities' (partial release; unlisted parts stay 0).
The header is created alone; Priority pulls the lines from the file content; the pulled lines must
equal the balance in bond, otherwise the draft is left untouched and reported as incomplete.
The release STAYS A DRAFT. Next: bonded_line_costs on it, and only then the owner makes it final
(SOP LBI2400656, ד׳ 13–15). This tool never writes a status, a flag or a cost.
Refuses when: the file is not closed; nothing is left in bond; another open draft release exists
for the file (an open draft with the SAME declaration is continued); a linked invoice is still
temporary; no cost invoice is linked — unless allowWithoutCostInvoice=true on a PARTIAL release;
a quantity exceeds the balance; the releases could not be read; the date is in the future.
A declaration that differs from the file header is a warning (a partial release can have its own).
This is the only path through the server's release lock, and only for these two request shapes.
${COMMON}`,
    {
      impfnum,
      date: isoDate.describe('Release date, YYYY-MM-DD (not in the future)'),
      declaration: z
        .string()
        .min(1)
        .max(40)
        .describe('Import declaration (רשומון) issued for THIS release'),
      quantities: z
        .array(
          z.object({
            part: z.string().min(1).max(60).describe('PARTNAME'),
            qty: z.number().positive().describe('quantity to release, ≤ the balance in bond'),
          }),
        )
        .min(1)
        .max(200)
        .optional()
        .describe('Partial release: parts and quantities. Omit to release the whole balance.'),
      toWarehouse: z.string().min(1).max(20).default('Main').describe('Receiving warehouse'),
      toLocation: z.string().min(1).max(20).default('0').describe('Receiving location'),
      allowWithoutCostInvoice: z
        .boolean()
        .default(false)
        .describe(
          'allow a PARTIAL release before any cost invoice is linked to the file (default: refuse)',
        ),
      dryRun,
    },
    (params) => run(() => createReleaseDraft(client, config, params, deps)),
  );

  server.tool(
    'bonded_line_costs',
    `שלב 9 — רישום עלויות יבוא לשורה. Runs Priority's program "רישום עלויות יבוא לשורה"
(IMPORTCOSTPERLINE) on ONE release document of a CLOSED import file, then re-reads the release and
returns the cost Priority registered on every line: goods value, import costs and total, in ₪.
Per the SOP (LBI2400656, ד׳ 13–14) this runs while the release is still a DRAFT, and only after
the costs are checked does the owner make the release final. When the release takes the whole
balance in bond the result also carries 'reconciliation': import costs on the file's releases
against the file's cost invoices (counting this release as released).
Refuses when: the file is not closed; the release is not of this file, is cancelled or has no
lines; the release is already final — unless onFinalRelease=true (the repair path used for the
September 2026 releases). Every line already costed → already-done, unless rerun=true; a rerun
reports rerunEffect: changed | not-provable (rows identical before and after).
A line left without costs → unverified, naming the parts: do not make the release final.
${PROGRAM_CONTRACT}
${COMMON}`,
    {
      ...programParams,
      release: z
        .string()
        .min(1)
        .max(40)
        .describe("The release document (קבלות סחורה ממחסן ערובה), e.g. 'BD99000001'"),
      onFinalRelease: z
        .boolean()
        .default(false)
        .describe('repair path: run although the release is already final (default: refuse)'),
      rerun: z
        .boolean()
        .default(false)
        .describe('run although every line already carries costs (default: already-done)'),
    },
    (params) => run(() => registerLineCosts(client, config, params, deps)),
  );
}
