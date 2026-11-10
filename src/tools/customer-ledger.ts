import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { WebSdkSession, deriveWebSdkLoginConfig, loadWebSdk } from '../client/web-sdk.js';
import type { Config } from '../config.js';
import {
  LEDGER_FORM,
  LEDGER_SUBFORM,
  LedgerFailure,
  type LedgerStatement,
  assertRange,
  buildStatement,
  ledgerFilename,
  readCustomer,
  readLedgerLines,
  renderLedgerHtml,
  writeLedgerPdf,
} from '../lib/customer-ledger.js';
import { convertHtmlToPdf } from '../lib/html-to-pdf.js';
import { textResult } from '../lib/write-guard.js';

const DESCRIPTION = `Produce a customer ledger statement (כרטסת לקוח) for a date range as a Hebrew PDF ready to send, plus the lines as data.

Source: Priority's receivable account screen (${LEDGER_FORM}, sub-form ${LEDGER_SUBFORM} = all journal lines of the account since its first entry, with Priority's running balance), opened through the Web SDK — the same login as priority_print_document. ${LEDGER_FORM} is not enabled for OData on this tenant, so there is no OData fallback. The customer's account number is its CUSTNAME.

Range: dateFrom and dateTo are required (YYYY-MM-DD), filtered on value date (BALDATE). Opening balance = Priority's running balance after the last line before dateFrom (0 if none). Closing = opening + debits − credits in range; a warning is returned if that differs from Priority's running balance on the last line in range. Positive balance = the customer owes us.

Read-only: opens the form, filters, reads rows, closes. Never updates a field, saves a row or starts an activation. PRIORITY_READ_ONLY does not block it.

The PDF is rendered from HTML by headless Chrome (install Google Chrome or set PRIORITY_CHROME_PATH). The header lines come from PRIORITY_LEDGER_TITLE and PRIORITY_LEDGER_DETAILS. Set PRIORITY_PRINT_DIR to also write the PDF there (filePath). Result: customer, account, range, opening, totalDebit, totalCredit, closing, lineCount, lines (up to maxLines in the text), warnings, filename, contentBase64 (application/pdf).`;

export interface LedgerToolDeps {
  session?: () => WebSdkSession;
  htmlToPdf?: (html: string) => Promise<Buffer>;
  outputDir?: string;
  now?: () => Date;
}

/** priority_customer_ledger — כרטסת לקוח for a date range, as PDF + data. */
export function registerCustomerLedgerTool(
  server: McpServer,
  client: PriorityClient,
  config: Config,
  deps: LedgerToolDeps = {},
) {
  let session: WebSdkSession | undefined;
  const sessionFactory =
    deps.session ??
    (() => {
      session ??= new WebSdkSession(loadWebSdk(), deriveWebSdkLoginConfig(config));
      return session;
    });

  server.tool(
    'priority_customer_ledger',
    DESCRIPTION,
    {
      customerId: z.string().min(1).max(20).describe('Exact CUSTNAME, e.g. 11105'),
      dateFrom: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('First value date, YYYY-MM-DD'),
      dateTo: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .describe('Last value date, YYYY-MM-DD'),
      pdf: z.boolean().default(true).describe('false: data only, no PDF'),
      maxLines: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .default(200)
        .describe('Lines to include in the text result (the PDF always has all of them)'),
    },
    async (params) => {
      try {
        assertRange(params.dateFrom, params.dateTo);
        const custname = params.customerId.trim();
        const customer = await readCustomer(client, custname);
        const { lines: all } = await readLedgerLines(sessionFactory(), customer.custname);
        const cut = buildStatement(all, params.dateFrom, params.dateTo);
        const statement: LedgerStatement = {
          customer,
          account: customer.custname,
          dateFrom: params.dateFrom,
          dateTo: params.dateTo,
          linesRead: all.length,
          ...cut,
        };
        const summary = {
          status: 'ok' as const,
          customer,
          account: statement.account,
          dateFrom: statement.dateFrom,
          dateTo: statement.dateTo,
          opening: statement.opening,
          totalDebit: statement.totalDebit,
          totalCredit: statement.totalCredit,
          closing: statement.closing,
          lineCount: statement.lines.length,
          linesRead: statement.linesRead,
          lines: statement.lines.slice(0, params.maxLines),
          linesTruncated: statement.lines.length > params.maxLines,
          warnings: statement.warnings,
        };
        if (!params.pdf) return textResult(summary);

        const html = renderLedgerHtml(
          statement,
          {
            title: process.env.PRIORITY_LEDGER_TITLE,
            details: process.env.PRIORITY_LEDGER_DETAILS,
          },
          deps.now?.() ?? new Date(),
        );
        const pdf = await (
          deps.htmlToPdf ??
          ((page: string) =>
            convertHtmlToPdf(
              { html: Buffer.from(page, 'utf8') },
              { chromePath: process.env.PRIORITY_CHROME_PATH },
            ))
        )(html);
        const filename = ledgerFilename(custname, params.dateFrom, params.dateTo);
        const dir = deps.outputDir ?? (process.env.PRIORITY_PRINT_DIR || undefined);
        const filePath = dir ? await writeLedgerPdf(dir, filename, pdf) : undefined;
        const contentBase64 = pdf.toString('base64');
        const result = {
          ...summary,
          filename,
          mimeType: 'application/pdf' as const,
          byteLength: pdf.length,
          ...(filePath ? { filePath } : {}),
        };
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(result, null, 2) },
            {
              type: 'resource' as const,
              resource: {
                uri: `priority://ledger/${encodeURIComponent(custname)}/${filename}`,
                mimeType: 'application/pdf' as const,
                blob: contentBase64,
              },
            },
          ],
          structuredContent: { ...result, contentBase64 },
        };
      } catch (err) {
        if (err instanceof LedgerFailure) {
          return {
            ...textResult({ status: 'failed', reason: err.reason, detail: err.message }),
            isError: true as const,
          };
        }
        throw toMcpError(err);
      }
    },
  );
}
