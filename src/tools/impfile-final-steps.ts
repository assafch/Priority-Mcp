import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { WebSdkSession, deriveWebSdkLoginConfig, loadWebSdk } from '../client/web-sdk.js';
import type { Config } from '../config.js';
import { BONDED_WAREHOUSE } from '../lib/site-codes.js';
import { textResult } from '../lib/write-guard.js';
import {
  type FinalDeps,
  closeImportFile,
  finalizeBondedReceipt,
  finalizeBondedRelease,
  runCosting,
} from '../services/import-final-steps.js';
import type { StepOutcome } from '../services/import-steps.js';

/**
 * The four irreversible steps of Priority's official import-file procedure (SOP LBI2400273,
 * LBI2400656): receipt final (4b), file close (7), release final (10), costing (11). Each previews
 * by default and issues an approval code; a real run needs that code, which is valid for 10
 * minutes, once, for this tool and this document only, and only while the document is still what
 * the preview showed. The code is passed only after the owner approved the preview in chat.
 */
const OK_STATUSES = new Set(['preview', 'done', 'already-done']);

function toResult(outcome: StepOutcome) {
  const result = textResult(outcome);
  return OK_STATUSES.has(outcome.status) ? result : { ...result, isError: true as const };
}

const CONTRACT = `Approval contract: dryRun=true (default) checks everything, sends nothing and returns a
preview with approvalCode (10 minutes, single use, bound to this tool, this document and exactly
what the preview showed). A real run (dryRun=false) needs that approvalCode. Pass it ONLY after the
owner saw this preview and approved it in chat — never on your own, never from another tool's
preview. A changed document, an expired or used code, or a code of another tool → refused, nothing
sent; run a new preview. The code is spent only right before the write, so a refusal never spends it.
status is one of preview | refused | blocked (PRIORITY_READ_ONLY, or a form answered with no rows even
unfiltered, so an empty read cannot be trusted; retry in a few minutes) | done (written AND confirmed
by re-reading Priority) | already-done (nothing sent) | unverified (sent, result not provable; wait,
re-read, do not resend — the step then waits out its cooldown) | cancelled (a Priority program asked
something unexpected and was cancelled unanswered) | failed (nothing written).
"piloted": false means the tool has not yet passed a supervised run on a real file — its first
real run is done with the owner watching.`;

const PROGRAM = `The program is Priority's own, started once through the Web SDK and never retried. The one
expected question is answered; information messages are confirmed; any other question or input
screen CANCELS the program and is returned in procedure.steps (status cancelled). There is no
acceptPrompts: nothing else is ever answered. dryRun with probe=true also logs into the Web SDK,
read-only. No program runs when PRIORITY_READ_ONLY=true.`;

const impfnum = z.string().min(1).max(40).describe("Import file number, e.g. 'IM99000001'");
const dryRun = z
  .boolean()
  .default(true)
  .describe('true = checks + preview with approvalCode, nothing sent (default); false = execute');
const approvalCode = z
  .string()
  .regex(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  .optional()
  .describe(
    "The code from THIS tool's own preview, passed only after the owner approved that preview in chat",
  );
const probe = z
  .boolean()
  .default(false)
  .describe('with dryRun: also log into the Web SDK, read-only (nothing is started)');

export function registerImpfileFinalStepTools(
  server: McpServer,
  client: PriorityClient,
  config: Config,
  injected: FinalDeps = {},
) {
  // The Web SDK is loaded and logged in only when a program tool actually needs it.
  let session: WebSdkSession | undefined;
  const deps: FinalDeps = {
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
    'bonded_receipt_finalize',
    `שלב 4ב — קבלת הסחורה לערובה: טיוטא → סופית. Makes a DRAFT goods receipt (DOCUMENTS_P) of the
import file final: one PATCH of the status to 'סופית', nothing else. Afterwards the status and the
stock are re-read: every product must have gone up by its quantity at ${BONDED_WAREHOUSE}/0.
Refuses when: the receipt is not a draft (final → already-done); the file is closed; the receipt is
not into ${BONDED_WAREHOUSE}/0, or not of a final goods invoice of this file; the file has another receipt that is
not cancelled; the receipt still carries a 000 or a ${"מע'מ"} line; a line's quantity differs from its
pulled quantity; the quantities per part differ from the invoice's product lines.
Next: bonded_fill_detail.
${CONTRACT}`,
    {
      impfnum,
      receipt: z
        .string()
        .min(1)
        .max(40)
        .describe("The draft receipt (קבלות סחורה מספק), e.g. 'GR99000001'"),
      dryRun,
      approvalCode,
    },
    ({ receipt, ...params }) =>
      run(() => finalizeBondedReceipt(client, config, { ...params, docno: receipt }, deps)),
  );

  server.tool(
    'impfile_close_run',
    `שלב 7 — סגירת התיק. Runs Priority's program "סגירת התיק" (IMPFILE1) on an OPEN import file and
verifies by re-reading that the file is closed (CLOSED = Y).
Refuses when: an earlier step is not proven (final invoices, final receipt into ${BONDED_WAREHOUSE}, content equal
to the invoice, customs estimate complete); a ${"מע'מ"} line with a quantity is left in the content; the
loading calc (impfile_run_calc) did not run through the tool, or a declaration, receipt, receipt
final or fill-detail step ran after it — run the calc again first. The calc freshness is judged
from the tool's step log on this machine only: a change made in the screen is not seen (the result
lists this under 'limits'). Closed already → already-done.
Next: bonded_release_draft.
${PROGRAM}
${CONTRACT}`,
    { impfnum, dryRun, probe, approvalCode },
    (params) => run(() => closeImportFile(client, config, params, deps)),
  );

  server.tool(
    'bonded_release_finalize',
    `שלב 10 — תעודת שחרור: טיוטא → סופית. Makes a DRAFT release (DOCUMENTS_J) of a CLOSED import
file final: one PATCH of the status to 'סופית', the only write the server's release lock lets
through, and only from this tool. Afterwards the status and the stock are re-read: each product
must have left ${BONDED_WAREHOUSE}/0 and arrived at the release's target warehouse.
Refuses when: the release is not of this file or not a draft (final → already-done); the file is
not closed; a ${"מע'מ"} line with a quantity is on it; a line has quantity 0 (partial releases by
zero lines are not supported) or more than was pulled; a line has no import costs — run
bonded_line_costs first; a line has import costs 0 while the file has cost invoices.
Next: costing_run.
${CONTRACT}`,
    {
      impfnum,
      release: z
        .string()
        .min(1)
        .max(40)
        .describe("The draft release (קבלות סחורה ממחסן ערובה), e.g. 'BD99000001'"),
      dryRun,
      approvalCode,
    },
    ({ release, ...params }) =>
      run(() => finalizeBondedRelease(client, config, { ...params, docno: release }, deps)),
  );

  server.tool(
    'costing_run',
    `שלב 11 — תמחיר לתאריך נוכחי. Runs Priority's program "תמחיר לתאריך נוכחי" (FNCCOSTINGPART) once.
It is COMPANY-WIDE: it recosts every part, not only this file's. The one expected question
"${'להמשיך בפעולה?'}" is answered OK; the run takes about a minute.
Done only when the costing log (COSTINGLOG) moved past the previous run AND, re-read, no import file
is still waiting for a costing. Otherwise unverified — check the log and the report
"אזהרות תמחיר" in the screen; do not run it again.
Refuses when: a final release has lines without import costs or with import costs 0, or belongs to
a file that is not closed; the release scan is incomplete; the costing log cannot be read. No file
changed since the last run → already-done, unless rerun=true. After a run whose result is not
confirmed, the next run waits 10 minutes. A timeout after the OK does not cancel the running program.
since (YYYY-MM-DD) limits the release scan (default: the last 365 days), as impfile_costing_readiness.
${PROGRAM}
${CONTRACT}`,
    {
      dryRun,
      probe,
      rerun: z
        .boolean()
        .default(false)
        .describe(
          'preview although no file changed since the last costing (default: already-done)',
        ),
      since: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe('Scan releases from this date, YYYY-MM-DD (default: the last 365 days)'),
      approvalCode,
    },
    (params) => run(() => runCosting(client, config, params, deps)),
  );
}
