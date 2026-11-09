import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { WebSdkSession, deriveWebSdkLoginConfig, loadWebSdk } from '../client/web-sdk.js';
import type { Config } from '../config.js';
import { convertHtmlToPdf } from '../lib/html-to-pdf.js';
import {
  PRINT_FORMS,
  PRINT_FORM_NAMES,
  type PrintDeps,
  type PrintFormName,
  type PrintOutcome,
  printDocument,
} from '../lib/print-document.js';
import { textResult } from '../lib/write-guard.js';

const FORM_HELP = PRINT_FORM_NAMES.map(
  (name) =>
    `${name} → ${PRINT_FORMS[name].procedure} (key ${PRINT_FORMS[name].keyField}): ${PRINT_FORMS[name].title}`,
).join('\n');

const DESCRIPTION = `Return the official Priority print layout of ONE document as a PDF — the same document program Print uses in the Priority UI, not a reconstruction from OData fields.

Runs the form's standard document procedure through the Priority Web SDK (the same login, config and priority-web-sdk dependency as priority_close_invoice) and asks Priority for a PDF:

  procStart(procedure, 'P') → document number → documentOptions(pdf: 1, word: 0 or 1, mode: 'display')

mode is always 'display'. That is the on-screen original layout. It does not email the customer (automail), does not open Click2Sign, and does not use the send-option that sets the Printed flag. For tax invoices and delivery notes, Priority therefore shows copy (העתק) rather than original (מקור). A real UI Print/email is what stamps מקור and sets Printed; this tool never requests that.

This tool does NOT finalize anything. It never calls CLOSEANINVOICE, never writes FINAL, and never answers a prompt that would close, delete, send, or batch-print. A warning is cancelled unless its exact text is passed in acceptMessages. Errors, and any message about sending, closing, or finalizing, are never accepted even if listed. Drafts (temporary numbers T…, such as credit draft T16631) are printed as drafts and stay drafts. If FINAL, FNCNUM, IVNUM, STATDES, or the document key reads back differently afterwards, the result status is 'status-changed' (an error) and the PDF is still included — re-read the document in Priority before assuming it is untouched.

PRIORITY_READ_ONLY does not block this tool: it does not post a journal. It still needs the Web SDK configured (PRIORITY_PAT, or PRIORITY_USERNAME + PRIORITY_PASSWORD; optional PRIORITY_WEB_URL / PRIORITY_WEB_TABULAINI / PRIORITY_WEB_LANGUAGE / PRIORITY_WEB_APPNAME). A missing SDK or missing credentials is a clear error and does not fall back to OData. The document is confirmed with an OData read first: no row, or more than one row, and the procedure is not started.

listFormats=true walks as far as the format dialog, returns formats (id, title, selected) and word templates, then cancels. No file is downloaded. If that procedure has only one format and skips the dialog, it may already have created a temporary display file; that file is not downloaded and the result says so.

format is an id (-1, -4, …) or a title. Omit it to use the system format Priority marks as selected (else the first system format). A Word template is used only when format names that template; it is still requested as PDF.

Forms and procedures (standard Priority document programs — confirm in the form's Actions list if a tenant renamed one):
${FORM_HELP}

Success result: status, form, key, procedure, draft, format, pdfSource ('priority' when Priority itself returned PDF, 'html-converted' when Priority returned HTML and headless Chrome printed it), filename, mimeType 'application/pdf', byteLength, contentBase64, and sourceUrl. Set PRIORITY_PRINT_DIR to also write the PDF there (filePath). contentBase64 is omitted above PRIORITY_PRINT_MAX_BYTES (default 6000000); then PRIORITY_PRINT_DIR is required. If Priority returns HTML, install Google Chrome or set PRIORITY_CHROME_PATH — Priority's own PDF is requested first and is the preferred output.`;

function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function toToolResult(outcome: PrintOutcome) {
  if (outcome.status === 'failed') {
    return { ...textResult(outcome), isError: true as const };
  }
  if (outcome.status === 'formats') return textResult(outcome);
  // The shared text result truncates at 24k characters, which would corrupt PDF base64.
  // structuredContent tells the registry to keep this payload intact.
  const text = JSON.stringify(outcome, null, 2);
  return {
    content: [
      { type: 'text' as const, text },
      ...(outcome.contentBase64
        ? [
            {
              type: 'resource' as const,
              resource: {
                uri: `priority://print/${outcome.form}/${encodeURIComponent(outcome.key)}.pdf`,
                mimeType: 'application/pdf' as const,
                blob: outcome.contentBase64,
              },
            },
          ]
        : []),
    ],
    structuredContent: outcome,
    ...(outcome.status === 'status-changed' ? { isError: true as const } : {}),
  };
}

/**
 * priority_print_document — the official Priority print form, as PDF, via the Web SDK.
 * Read-only for business data: display mode, no CLOSEANINVOICE, no FINAL write.
 */
export function registerPrintDocumentTool(
  server: McpServer,
  client: PriorityClient,
  config: Config,
  deps: PrintDeps = {},
) {
  let session: WebSdkSession | undefined;
  const sessionFactory =
    deps.session ??
    (() => {
      session ??= new WebSdkSession(loadWebSdk(), deriveWebSdkLoginConfig(config));
      return session;
    });

  server.tool(
    'priority_print_document',
    DESCRIPTION,
    {
      form: z
        .enum(PRINT_FORM_NAMES as [PrintFormName, ...PrintFormName[]])
        .describe('Priority form that owns the document'),
      key: z
        .string()
        .min(1)
        .max(40)
        .describe(
          'Document number: ORDNAME, IVNUM, or DOCNO. Example SO26000419, IN264000407, T16631',
        ),
      format: z
        .string()
        .min(1)
        .max(120)
        .optional()
        .describe('Print format id (for example -1) or title. Omit for the selected system format'),
      listFormats: z
        .boolean()
        .default(false)
        .describe('true: return print formats and cancel before a file is generated'),
      acceptMessages: z
        .array(z.string().min(1).max(300))
        .max(5)
        .default([])
        .describe(
          'Exact warning texts (as Priority shows them) that may be answered OK. Errors and any message about sending, closing, or finalizing are never accepted.',
        ),
    },
    async (params) => {
      try {
        const outcome = await printDocument(
          client,
          {
            form: params.form,
            key: params.key,
            format: params.format,
            listFormats: params.listFormats,
            acceptMessages: params.acceptMessages,
          },
          {
            ...deps,
            session: sessionFactory,
            outputDir: deps.outputDir ?? (process.env.PRIORITY_PRINT_DIR || undefined),
            maxBytes: deps.maxBytes ?? envNumber('PRIORITY_PRINT_MAX_BYTES'),
            htmlToPdf:
              deps.htmlToPdf ??
              ((html, pageUrl) =>
                convertHtmlToPdf(
                  { html, pageUrl },
                  { chromePath: process.env.PRIORITY_CHROME_PATH },
                )),
          },
        );
        return toToolResult(outcome);
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
