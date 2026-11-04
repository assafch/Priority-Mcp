import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { WebSdkSession, deriveWebSdkLoginConfig, loadWebSdk } from '../client/web-sdk.js';
import type { Config } from '../config.js';
import { CLOSABLE_FORM_NAMES, type CloseDeps, closeInvoice } from '../lib/invoice-close.js';
import { textResult } from '../lib/write-guard.js';

/**
 * priority_close_invoice — the sanctioned way to finalize an invoice draft: Priority's own
 * "סגירת חשבונית" (CLOSEANINVOICE) direct activation, run through the Web SDK.
 */
export function registerCloseInvoiceTool(
  server: McpServer,
  client: PriorityClient,
  config: Config,
  deps: CloseDeps = {},
) {
  let session: WebSdkSession | undefined;
  const sessionFactory =
    deps.session ??
    (() => {
      session ??= new WebSdkSession(loadWebSdk(), deriveWebSdkLoginConfig(config));
      return session;
    });

  server.tool(
    'priority_close_invoice',
    `סגירת חשבונית — finalize ONE invoice draft the way Priority does it: the direct activation
CLOSEANINVOICE ("סגירת חשבונית") on the invoice form, through the Priority Web SDK. The procedure
assigns the final number (OV…/IN…/GI…), posts the journal entry (FNCNUM) and moves stock.
This is the ONLY correct way to make a document final. Never write FINAL through the API: that
flips the flag with no journal and locks the draft (T164, T173 — ticket SCI26096671); every write
path of this server refuses it.

Forms: ${CLOSABLE_FORM_NAMES.join(', ')} (EINVOICES = חשבונית מס קבלה, AINVOICES = חשבונית מס,
PINVOICES = חשבונית ספק מרכזת).

You must give the draft's FULL identity — temporary number (T…), BOOKNUM, customer/supplier code
and TOTPRICE — and the tool refuses on any difference. Before anything runs it reads the live
documents over OData and refuses unless the row is a clean draft (STATDES טיוטא, FINAL and FNCNUM
empty), no final document already carries the BOOKNUM (for customer invoices: under ANY customer)
and no other open draft shares it (allowSiblingDrafts=true overrides that last check knowingly).
A draft that already carries FINAL='Y' without a journal is reported as 'half-state' — only
Priority support can fix that. Closes are serialized per document and per order (BOOKNUM; for supplier invoices BOOKNUM+supplier) across processes
(claim files); a dispatched close whose result is not yet visible blocks a second dispatch of the
same document for 180 s.

dryRun=true (default) returns the preflight result and the exact plan without logging into the
SDK; probeSdk=true additionally logs in and locates the row read-only (no activation).
dryRun=false runs the activation once — never retried — accepting only information messages and
the exact prompt texts listed in acceptPrompts (anything else cancels and is reported), then
verifies over OData: draft gone, one final document with the same internal IV, FINAL=Y, FNCNUM
set, FNCTRANS entry final. Result status: closed | unverified (procedure ended, close not visible
yet) | unknown (dispatched, did not finish cleanly) | failed (nothing dispatched) | refused. Every
attempt is appended to a ledger file before and after the activation.
No activation runs when PRIORITY_READ_ONLY=true (dry-run previews and probeSdk still work).`,
    {
      form: z
        .enum(CLOSABLE_FORM_NAMES as [string, ...string[]])
        .describe('EINVOICES | AINVOICES | PINVOICES'),
      ivnum: z
        .string()
        .regex(/^T\d+$/)
        .describe("The draft's temporary number, e.g. 'T173'"),
      booknum: z
        .string()
        .min(1)
        .max(100)
        .describe('BOOKNUM exactly as on the draft, e.g. WC-38435'),
      party: z
        .string()
        .min(1)
        .max(100)
        .describe('CUSTNAME (EINVOICES/AINVOICES) or SUPNAME (PINVOICES) exactly as on the draft'),
      totprice: z.number().finite().describe('TOTPRICE exactly as on the draft, e.g. 98.7'),
      dryRun: z
        .boolean()
        .default(true)
        .describe('true = preflight + plan only (default); false = run CLOSEANINVOICE once'),
      probeSdk: z
        .boolean()
        .default(false)
        .describe(
          'with dryRun: also log into the Web SDK and locate the row read-only (no activation)',
        ),
      allowSiblingDrafts: z
        .boolean()
        .default(false)
        .describe(
          'close although other OPEN drafts share the BOOKNUM (default: refuse — two drafts for one order are two invoices waiting to happen)',
        ),
      acceptPrompts: z
        .array(z.string().min(1).max(200))
        .max(5)
        .default([])
        .describe(
          'exact prompt texts (as Priority shows them) that may be answered OK during the close; default none — an unlisted prompt cancels and is reported so it can be reviewed',
        ),
    },
    async (params) => {
      try {
        const outcome = await closeInvoice(
          client,
          { ...params, form: params.form as (typeof CLOSABLE_FORM_NAMES)[number] },
          config.priorityReadOnly,
          { ...deps, session: sessionFactory },
        );
        // acknowledged = Priority completed the procedure (not merely: we sent something).
        const acknowledged =
          outcome.status === 'closed' ||
          (outcome.status === 'unverified' && outcome.procedure.outcome === 'end');
        const reason = (() => {
          switch (outcome.status) {
            case 'closed':
              return 'Draft gone, one final document with the same internal IV, journal entry final.';
            case 'preview':
              return 'Preview only; no activation was run.';
            case 'unverified':
            case 'unknown':
              return `${
                outcome.status === 'unknown'
                  ? 'The activation was dispatched but did not finish cleanly; '
                  : 'The procedure ended but '
              }OData does not show the close yet: ${
                outcome.verification.verified ? '' : outcome.verification.reason
              } Do not dispatch again before ${outcome.cooldownUntil}; re-read the document instead.`;
            case 'failed':
              return `${outcome.error} Nothing was dispatched; the draft is unchanged.`;
            default:
              return outcome.detail;
          }
        })();
        const body = {
          ...outcome,
          acknowledged,
          verified: outcome.status === 'closed',
          verification: { reason },
        };
        const result = textResult(body);
        return outcome.status === 'closed' || outcome.status === 'preview'
          ? result
          : { ...result, isError: true as const };
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
