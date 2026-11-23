import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { dateRange } from '../lib/dates.js';
import { probeForm } from '../lib/forms.js';
import { computeOfficialSteps } from '../lib/impfile-official.js';
import { computeStage } from '../lib/impfile-stage.js';
import {
  VAT_DECLARATION_PART,
  brokerHasLines,
  buildBrokerInvoiceBody,
  buildGoodsInvoiceBody,
  buildGoodsInvoiceHeader,
  checkGoodsInvoice,
  computeLandedCost,
  matchThreeWay,
  planGoodsInvoice,
  preflight,
  reconcileGoodsLines,
} from '../lib/impfiles-logic.js';
import { DRAFT_FILE_STATUS } from '../lib/import-stage-guard.js';
import { getSchema } from '../lib/priority-schema.js';
import { blockProcedureOnlyField } from '../lib/procedure-only-fields.js';
import { escapeODataString, sanitizeODataValue } from '../lib/sanitize.js';
import { DEFAULT_STEP_LEDGER_PATH, lastDoneAt } from '../lib/step-ledger.js';
import { deleteRowVerified } from '../lib/subform-rows.js';
import {
  checkWriteAllowed,
  dryRunResult,
  previewOrBlock,
  textResult,
  unavailableHere,
} from '../lib/write-guard.js';
import {
  verifyLineCreate,
  verifyRecordCreate,
  verifyRecordUpdate,
  verifyWrite,
} from '../lib/write-verification.js';
import { loadFileFacts } from '../services/import-facts.js';
import { loadImportRecord, loadSnapshot, normalizeSnapshot } from '../services/import-read.js';
import { loadStageWithSnapshot } from '../services/import-stage.js';

const IMPFILES = getSchema('IMPFILES');

type Row = Record<string, unknown>;

/**
 * Shared [param key → Priority header field] map for impfile_open / impfile_update, so both write
 * the SAME body for the same logical field (a single source of truth). Applied when the value is
 * `!== undefined`, so an explicit empty string CLEARS a field on update, while unset optional params
 * are simply omitted.
 */
const IMPFILE_HEADER_FIELDS: ReadonlyArray<[string, string]> = [
  ['owner', 'OWNERLOGIN'],
  ['supplier', 'SUPNAME'],
  ['forwarder', 'SUPNAME2'],
  ['po', 'ORDNAME'],
  ['incoterms', 'IMPTERMNAME'],
  ['shipper', 'SHIPPERNAME'],
  ['declaration', 'CUSTOMSNUM'],
  ['declarationDate', 'CUSTOMSDATE'],
  ['warehouse', 'WARHSNAME'],
  ['details', 'DETAILS'],
];

function applyImpfileHeaderFields(body: Row, params: Record<string, unknown>): Row {
  for (const [key, field] of IMPFILE_HEADER_FIELDS) {
    if (params[key] !== undefined) body[field] = params[key];
  }
  return body;
}

/** Params shared by the three impfile_link_invoice routes. */
interface LinkParams {
  invoiceNumber: string;
  impfnum: string;
  debit: string;
  ivtype: string;
  line?: number;
  allowRelink: boolean;
  dryRun: boolean;
}

/**
 * route='line' — link ONE line of a supplier invoice to an import file.
 *
 * The per-line screen ("חשבוניות לתיקי יבוא ← פירוט") is the IMPFILEIV form's detail sub-form:
 * IMPFILEIV(IVNUM,DEBIT,TYPE)/IMPFILEIVS_SUBFORM(KLINE=n), whose IMPFNUM column is the per-line
 * file link (verified live 2026-07-29: the sub-form row is addressable and carries IMPFNUM).
 * With no 'line' argument this LISTS the lines instead of guessing which one to touch.
 */
async function linkInvoiceLine(client: PriorityClient, config: Config, p: LinkParams) {
  const keys = { IVNUM: p.invoiceNumber, DEBIT: p.debit, TYPE: p.ivtype };
  const qb = new ODataBuilder()
    .eq('IVNUM', sanitizeODataValue(p.invoiceNumber))
    .eq('DEBIT', sanitizeODataValue(p.debit))
    .eq('TYPE', sanitizeODataValue(p.ivtype))
    .expand('IMPFILEIVS_SUBFORM')
    .top(1);
  const found = await client.list<Row>('IMPFILEIV', qb.build());
  const inv = found.value[0];
  if (!inv) {
    return textResult({
      error: `No IMPFILEIV row for IVNUM='${p.invoiceNumber}', DEBIT='${p.debit}', TYPE='${p.ivtype}'.`,
      hint: "IMPFILEIV's key part is TYPE (not IVTYPE); a purchase invoice is TYPE='P'. Check the invoice exists with priority_query({ form: 'IMPFILEIV', filter: \"IVNUM eq '...'\" }).",
    });
  }
  const lines = ((inv.IMPFILEIVS_SUBFORM as Row[]) ?? []).map((l) => ({
    line: l.KLINE,
    part: l.PARTNAME,
    description: l.PDES,
    quantity: l.TQUANT,
    price: l.PRICE,
    lineTotal: l.QPRICE,
    currency: l.ICODE ?? l.CODE,
    linkedTo: l.IMPFNUM ?? null,
  }));

  // No line chosen → show the menu rather than picking one.
  if (p.line === undefined) {
    return textResult({
      route: 'line',
      invoice: { IVNUM: inv.IVNUM, supplier: inv.SUPDES, headerImpfnum: inv.IMPFNUM ?? null },
      lines,
      note: 'Pass `line` (the KLINE) to link one of these lines to an import file. Header-level linking is route="header".',
    });
  }

  const target = lines.find((l) => Number(l.line) === p.line);
  if (!target) {
    return textResult({
      error: `Invoice ${p.invoiceNumber} has no line KLINE=${p.line}.`,
      availableLines: lines.map((l) => l.line),
    });
  }
  const currentLink = target.linkedTo ? String(target.linkedTo) : null;
  if (currentLink && currentLink !== p.impfnum && !p.allowRelink) {
    return textResult({
      error: `Line ${p.line} of invoice ${p.invoiceNumber} is already linked to import file ${currentLink}. Pass allowRelink=true to move it to ${p.impfnum}.`,
    });
  }

  const body = { IMPFNUM: p.impfnum };
  const subKeys = { KLINE: p.line };
  const gate = previewOrBlock(config, p.dryRun, 'LINK INVOICE LINE TO IMPORT FILE (PATCH)', {
    method: 'PATCH',
    endpoint: client.resolveSubformRowUrl('IMPFILEIV', keys, 'IMPFILEIVS_SUBFORM', subKeys),
    keys,
    subform: 'IMPFILEIVS_SUBFORM',
    subKeys,
    body,
    line: target,
    currentlyLinkedTo: currentLink,
  });
  if (gate) return gate;
  const outcome = await verifyWrite(
    () => client.updateSubformRow('IMPFILEIV', keys, 'IMPFILEIVS_SUBFORM', subKeys, body),
    () =>
      client.getSubformRow(
        'IMPFILEIV',
        keys,
        'IMPFILEIVS_SUBFORM',
        subKeys,
        '?$select=KLINE,PARTNAME,IMPFNUM',
        { cache: false },
      ),
    body,
  );
  client.invalidateCache('IMPFILES');
  return textResult({
    linked: outcome.verified,
    route: 'line',
    invoice: p.invoiceNumber,
    line: p.line,
    impfnum: p.impfnum,
    verifiedAfterWrite: outcome.verification.observed ?? null,
    ...outcome,
  });
}

/**
 * route='final' — the finalized-invoice detail screen "עדכון פרטים לחשבוניות ספק" is form
 * PIVDETAILS (key IVNUM, DEBIT, TYPE; IMPFNUM = תיק יבוא). On this tenant PIVDETAILS exists but
 * its "Available for API" flag is off, so the form is probed at RUNTIME: if an admin enables it the
 * route starts working with no code change, and until then the caller is told exactly which form to
 * enable instead of getting an opaque 400.
 */
async function linkInvoiceFinal(client: PriorityClient, config: Config, p: LinkParams) {
  const probe = await probeForm(client, 'PIVDETAILS', '?$select=IVNUM,DEBIT,TYPE&$top=1');
  if (probe.status !== 'ok') {
    return unavailableHere(
      `route='final' uses the "עדכון פרטים לחשבוניות ספק" screen = form PIVDETAILS (key IVNUM, DEBIT, TYPE). ${
        probe.detail ?? `PIVDETAILS returned status '${probe.status}'.`
      }`,
      probe.status === 'api-flag-off'
        ? "Ask a Priority admin to tick \"Available for API\" for PIVDETAILS; this route then works unchanged. Meanwhile use route='header' (PINVOICES.IMPFNUM) or route='line' (IMPFILEIV/IMPFILEIVS_SUBFORM), both of which are exposed here."
        : "Use route='header' or route='line', both verified working on this installation.",
    );
  }

  const keys = { IVNUM: p.invoiceNumber, DEBIT: p.debit, TYPE: p.ivtype };
  const qb = new ODataBuilder()
    .eq('IVNUM', sanitizeODataValue(p.invoiceNumber))
    .eq('DEBIT', sanitizeODataValue(p.debit))
    .eq('TYPE', sanitizeODataValue(p.ivtype))
    .select('IVNUM', 'DEBIT', 'TYPE', 'SUPDES', 'IMPFNUM', 'STATDES', 'STORNOFLAG')
    .top(1);
  const found = await client.list<Row>('PIVDETAILS', qb.build());
  const inv = found.value[0];
  if (!inv) {
    return textResult({
      error: `No PIVDETAILS row for IVNUM='${p.invoiceNumber}', DEBIT='${p.debit}', TYPE='${p.ivtype}'.`,
    });
  }
  if (inv.STORNOFLAG === 'Y') {
    return textResult({
      error: `Invoice ${p.invoiceNumber} is cancelled (storno) — refusing to link it to a file.`,
    });
  }
  const currentLink = inv.IMPFNUM ? String(inv.IMPFNUM) : null;
  if (currentLink && currentLink !== p.impfnum && !p.allowRelink) {
    return textResult({
      error: `Invoice ${p.invoiceNumber} is already linked to import file ${currentLink}. Pass allowRelink=true to move it to ${p.impfnum}.`,
    });
  }
  const body = { IMPFNUM: p.impfnum };
  const gate = previewOrBlock(config, p.dryRun, 'LINK FINALIZED INVOICE TO IMPORT FILE (PATCH)', {
    method: 'PATCH',
    endpoint: client.resolveCompositeUrl('PIVDETAILS', keys),
    keys,
    body,
    currentlyLinkedTo: currentLink,
    invoiceStatus: inv.STATDES ?? null,
  });
  if (gate) return gate;
  const outcome = await verifyRecordUpdate(client, 'PIVDETAILS', keys, body);
  client.invalidateCache('IMPFILES');
  return textResult({
    linked: outcome.verified,
    route: 'final',
    invoice: p.invoiceNumber,
    ...outcome,
  });
}

/** Lines of a supplier invoice are keyed by KLINE (PINVOICEITEMS — read from its metadata). */
const PINVOICE_LINES = 'PINVOICEITEMS_SUBFORM';
const PINVOICE_LINE_KEY = ['KLINE'];

interface GoodsPoParams {
  supplier: string;
  invoiceNumber: string;
  invoiceDate: string;
  currency: string;
  impfnum: string;
  po: string;
  goodsLines: Array<{
    part: string;
    qty: number;
    price?: number;
    extra?: boolean;
    description?: string;
  }>;
  dryRun: boolean;
}

/** Non-cancelled supplier invoices that already carry this supplier's invoice number. */
async function existingInvoicesFor(client: PriorityClient, supplier: string, booknum: string) {
  const qb = new ODataBuilder()
    .eq('SUPNAME', sanitizeODataValue(supplier))
    .eq('BOOKNUM', sanitizeODataValue(booknum))
    .select('IVNUM', 'DEBIT', 'IVTYPE', 'STATDES', 'FINAL', 'STORNOFLAG', 'QPRICE', 'IMPFNUM')
    .top(10);
  const found = await client.list<Row>('PINVOICES', qb.build(), { cache: false });
  return found.value.filter((r) => r.STORNOFLAG !== 'Y');
}

/**
 * Goods invoice against a purchase order.
 *
 * Priority copies the order's lines into the invoice as soon as ORDNAME is on the header, so the
 * header is POSTed ALONE; the pulled lines are then set to the invoice's quantities/prices and
 * order lines that are not on the invoice are removed. The result is read back and checked:
 * exactly the lines sent, each linked to the order, total = Σ quantity × price.
 */
async function createGoodsInvoiceFromPo(client: PriorityClient, config: Config, p: GoodsPoParams) {
  const orders = await client.list<Row>(
    'PORDERS',
    new ODataBuilder()
      .eq('ORDNAME', sanitizeODataValue(p.po))
      .expand('PORDERITEMS_SUBFORM')
      .top(1)
      .build(),
    { cache: false },
  );
  const plan = planGoodsInvoice({
    supplier: p.supplier,
    currency: p.currency,
    po: p.po,
    order: orders.value[0],
    lines: p.goodsLines,
  });
  const duplicates = await existingInvoicesFor(client, p.supplier, p.invoiceNumber);
  const header = buildGoodsInvoiceHeader({
    supplier: p.supplier,
    invoiceNumber: p.invoiceNumber,
    invoiceDate: p.invoiceDate,
    currency: p.currency,
    impfnum: p.impfnum,
    po: p.po,
  });
  const planned = {
    purchaseOrder: p.po,
    expectedLines: plan.lines,
    expectedLineCount: plan.lines.length,
    expectedTotal: plan.expectedTotal,
    orderLinesThatWillBeRemoved: plan.orderLinesNotOnInvoice,
    warnings: plan.warnings,
  };
  const blockers = [
    ...plan.problems,
    ...duplicates.map(
      (d) =>
        `Supplier ${p.supplier} already has invoice ${d.IVNUM} (${d.STATDES ?? 'no status'}) with number "${p.invoiceNumber}". Fix that document instead of creating a second one.`,
    ),
  ];
  if (blockers.length) {
    return {
      ...textResult({
        status: 'refused',
        created: false,
        acknowledged: false,
        verified: false,
        verification: { reason: 'Checks before the write failed; nothing was sent.' },
        problems: blockers,
        existingInvoices: duplicates,
        ...planned,
      }),
      isError: true as const,
    };
  }
  if (p.dryRun) {
    return dryRunResult('CREATE GOODS SUPPLIER INVOICE FROM PURCHASE ORDER', {
      steps: [
        { step: 1, method: 'POST', form: 'PINVOICES', body: header },
        {
          step: 2,
          what: `Priority copies the open lines of ${p.po} into the draft; each is set to the invoice quantity/price, order lines that are not on the invoice are deleted, and extraLines are added as manual lines.`,
        },
        { step: 3, what: 'Read back: line count, order link on every line, total.' },
      ],
      ...planned,
    });
  }
  const guard = checkWriteAllowed(config);
  if (guard.blocked) return guard.result;

  let created: Row;
  try {
    created = await client.create<Row>('PINVOICES', header);
  } catch (error) {
    const code = (error as { statusCode?: number }).statusCode;
    const rejected = code !== undefined && code >= 400 && code < 500 && code !== 408;
    return {
      ...textResult({
        status: rejected ? 'failed' : 'unknown',
        created: false,
        acknowledged: false,
        verified: false,
        verification: {
          reason: rejected
            ? `Priority refused the invoice header; nothing was created: ${(error as Error).message}`
            : `The header POST did not finish cleanly: ${(error as Error).message}. Before trying again, check whether a draft with number "${p.invoiceNumber}" now exists for supplier ${p.supplier}.`,
        },
        ...planned,
      }),
      isError: true as const,
    };
  }
  client.invalidateCache('IMPFILES');
  const ivnum = created.IVNUM;
  if (typeof ivnum !== 'string' || !ivnum) {
    return {
      ...textResult({
        status: 'unknown',
        created: false,
        acknowledged: true,
        verified: false,
        verification: {
          reason: `Priority accepted the header but returned no IVNUM. Do NOT create it again: find the draft by supplier ${p.supplier} and number "${p.invoiceNumber}".`,
        },
        response: created,
      }),
      isError: true as const,
    };
  }
  const keys = { IVNUM: ivnum, DEBIT: 'D', IVTYPE: 'P' };
  const read = () =>
    client.get<Row>('PINVOICES', keys, `?$expand=${PINVOICE_LINES}`, { cache: false });
  /** A stop after the header exists: say exactly what is there and that it must not be re-created. */
  const incomplete = (reason: string, extra: Row = {}) => ({
    ...textResult({
      status: 'incomplete',
      created: false,
      acknowledged: true,
      verified: false,
      invoice: { IVNUM: ivnum, DEBIT: 'D', IVTYPE: 'P' },
      verification: { reason },
      doNotCreateAgain: `Draft ${ivnum} exists. Do NOT call pinvoice_create again for this invoice — finish this draft with priority_update_line / priority_delete_line, or ask the owner.`,
      ...planned,
      ...extra,
    }),
    isError: true as const,
  });

  const done: unknown[] = [];
  try {
    const draft = await read();
    const actual = (draft[PINVOICE_LINES] as Row[] | undefined) ?? [];
    const { steps, problems } = reconcileGoodsLines({
      po: p.po,
      requested: p.goodsLines,
      actual,
    });
    if (problems.length)
      return incomplete('The lines Priority pulled from the order do not cover the invoice.', {
        problems,
        linesOnDraft: actual,
        remainingSteps: steps,
      });
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const rowKeys = { KLINE: step.op === 'POST' ? 0 : step.kline };
      try {
        if (step.op === 'POST') {
          await client.addLine('PINVOICES', keys, PINVOICE_LINES, step.body);
        } else if (step.op === 'PATCH') {
          await client.updateSubformRow('PINVOICES', keys, PINVOICE_LINES, rowKeys, step.body);
        } else {
          const outcome = await deleteRowVerified(
            client,
            'PINVOICES',
            keys,
            PINVOICE_LINES,
            rowKeys,
            PINVOICE_LINE_KEY,
          );
          if (!outcome.verified) throw new Error(outcome.verification.reason);
        }
        done.push(step);
      } catch (error) {
        return incomplete(
          `${step.op} of line ${step.op === 'POST' ? '(new)' : step.kline} (${step.part}) failed: ${(error as Error).message}`,
          { stepsDone: done, remainingSteps: steps.slice(i) },
        );
      }
    }
    const final = await read();
    const check = checkGoodsInvoice({ po: p.po, requested: p.goodsLines, invoice: final });
    if (!check.verified)
      return incomplete('The read-back does not match the invoice that was sent.', {
        check,
        stepsDone: done,
        linesOnDraft: final[PINVOICE_LINES],
      });
    return textResult({
      status: 'verified',
      created: true,
      acknowledged: true,
      verified: true,
      invoice: {
        IVNUM: ivnum,
        DEBIT: 'D',
        IVTYPE: 'P',
        BOOKNUM: final.BOOKNUM,
        ORDNAME: final.ORDNAME,
        IMPFNUM: final.IMPFNUM,
        STATDES: final.STATDES,
        CODE: final.CODE,
        QPRICE: final.QPRICE,
        TOTPRICE: final.TOTPRICE,
      },
      lines: ((final[PINVOICE_LINES] as Row[] | undefined) ?? []).map((l) => ({
        KLINE: l.KLINE,
        PARTNAME: l.PARTNAME,
        TQUANT: l.TQUANT,
        PRICE: l.PRICE,
        QPRICE: l.QPRICE,
        ORDNAME: l.ORDNAME,
        PRSOURCENAME: l.PRSOURCENAME,
      })),
      verification: {
        reason:
          'Read back: exactly the lines sent, each goods line linked to the order, total matches.',
        ...check,
      },
      stepsDone: done,
      warnings: plan.warnings,
    });
  } catch (error) {
    return incomplete(`Reading the new draft failed: ${(error as Error).message}`, {
      stepsDone: done,
    });
  }
}

export function registerImpfileTools(
  server: McpServer,
  client: PriorityClient,
  config: Config,
  deps: { stepLedgerPath?: string } = {},
) {
  /** Last confirmed run of "חישוב העמסה" through impfile_run_calc (information only). */
  const lastCalcViaTool = (impfnum: string) =>
    lastDoneAt(deps.stepLedgerPath ?? DEFAULT_STEP_LEDGER_PATH, impfnum, 'calc');
  // --------------------------------------------------------------------- Read

  server.tool(
    'impfile_search',
    `חיפוש תיקי יבוא (IMPFILES) לפי סטטוס / ספק / הזמנה / הצהרת יבוא / טווח תאריכים.

Search import files. All filters optional; results sorted by open date (CURDATE) descending and
projected to key columns. Use impfile_get for a single file's full detail.`,
    {
      status: z.string().optional().describe("STATDES, e.g. 'טיוטא' (draft) or 'סופי' (final)"),
      closed: z
        .boolean()
        .optional()
        .describe('true → only closed files (CLOSED=Y); false → only open files'),
      supplier: z.string().optional().describe('Match SUPNAME or SUPDES (goods supplier)'),
      poNumber: z.string().optional().describe('Linked purchase order (ORDNAME)'),
      declaration: z
        .string()
        .optional()
        .describe(
          'Import declaration number — matches the file HEADER field (CUSTOMSNUM), which is often blank here because declarations are usually recorded per invoice/line rather than on the file header.',
        ),
      dateFrom: z.string().optional().describe('Open-date lower bound (YYYY-MM-DD)'),
      dateTo: z.string().optional().describe('Open-date upper bound (YYYY-MM-DD)'),
      top: z.number().int().min(1).max(500).default(50),
      skip: z.number().int().min(0).default(0),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().top(params.top).skip(params.skip).orderBy('CURDATE', 'desc');
        if (params.status) qb.eq('STATDES', sanitizeODataValue(params.status));
        if (params.closed === true) qb.eq('CLOSED', 'Y');
        // Open files: CLOSED is null on this install and `ne 'Y'` matches those nulls here. Do NOT
        // use `CLOSED eq null` — it returns HTTP 500 on this Priority install (verified 2026-07-18).
        if (params.closed === false) qb.filter("CLOSED ne 'Y'");
        if (params.supplier) {
          const s = escapeODataString(params.supplier);
          // Parenthesized OR group so it composes correctly with the other AND filters
          // (OData binds `and` tighter than `or`; an un-parenthesized OR would escape the group).
          qb.orGroup(`SUPNAME eq '${s}'`, `SUPDES eq '${s}'`);
        }
        if (params.poNumber) qb.eq('ORDNAME', sanitizeODataValue(params.poNumber));
        if (params.declaration) qb.eq('CUSTOMSNUM', sanitizeODataValue(params.declaration));
        const range = dateRange(params.dateFrom, params.dateTo);
        if (range.from) qb.ge('CURDATE', range.from);
        if (range.to) {
          if (range.upperOperator === 'lt') qb.lt('CURDATE', range.to);
          else qb.le('CURDATE', range.to);
        }
        if (IMPFILES?.defaultSelect) qb.select(...IMPFILES.defaultSelect);

        const result = await client.list<Row>('IMPFILES', qb.build());
        return textResult({
          importFiles: result.value,
          pagination: { returned: result.value.length, top: params.top, skip: params.skip },
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_get',
    `תמונת מצב מלאה של תיק יבוא. Full snapshot of one import file.

Expands and aggregates ALL load-bearing sub-forms into a normalized shape:
  header, invoices (חשבוניות ספק), manualCostAllocations (העמסות ידניות לעלויות),
  extraProductLines (שורות מוצרים נוספות), expectedCosts (עלויות צפויות),
  customsEstimate (אומדן מכס), goodsContent (תכולה), linkedPoLines (שורות הזמנת רכש),
  plus a derived summary. Line-level linked costs/items do NOT appear inside the invoices
  sub-form — this tool surfaces them from their own sub-forms.`,
    {
      impfnum: z.string().min(1).describe("Import file number (IMPFNUM), e.g. 'IM99075592'"),
      raw: z
        .boolean()
        .default(false)
        .describe('true → return the raw Priority record instead of the normalized snapshot'),
    },
    async (params) => {
      try {
        const record = await loadImportRecord(client, params.impfnum);
        return textResult(params.raw ? record : normalizeSnapshot(record));
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  // -------------------------------------------------------------------- Write
  // Every write defaults to dryRun=true (a non-mutating preview of the exact body). The server also
  // stays PRIORITY_READ_ONLY, so nothing reaches Priority during this build — payloads are validated
  // by dry-run only, per the "dry-run-only on live" decision.

  server.tool(
    'impfile_open',
    `פתיחת תיק יבוא חדש (POST IMPFILES). Open a new import file.

Mandatory in Priority: open date, currency, handler (OWNERLOGIN). The file is always opened as a draft
(טיוטא); IMPFNUM is auto-generated.
WARHSNAME defaults to your bonded warehouse ('BONDED') when omitted here — pass it explicitly to be sure.

⚠️ WRITE. dryRun=true (default) previews the exact POST body.`,
    {
      date: z.string().min(1).describe('Open date CURDATE (YYYY-MM-DD)'),
      currency: z.string().min(1).describe('File currency CODE (e.g. EUR, $, ש"ח)'),
      owner: z
        .string()
        .optional()
        .describe('Handler OWNERLOGIN (mandatory in Priority; provide if the create errors)'),
      supplier: z.string().optional().describe('Goods supplier SUPNAME'),
      forwarder: z.string().optional().describe('Forwarder/broker SUPNAME2'),
      po: z.string().optional().describe('Linked purchase order ORDNAME'),
      incoterms: z.string().optional().describe('IMPTERMNAME (EXW/FOB/C&F...)'),
      shipper: z.string().optional().describe('SHIPPERNAME'),
      declaration: z.string().optional().describe('Import declaration CUSTOMSNUM'),
      declarationDate: z.string().optional().describe('CUSTOMSDATE (YYYY-MM-DD)'),
      warehouse: z.string().optional().describe("Bonded warehouse WARHSNAME (e.g. 'BONDED')"),
      details: z.string().optional().describe('Free-text DETAILS'),
      dryRun: z.boolean().default(true),
    },
    async (p) => {
      try {
        const body = applyImpfileHeaderFields(
          { CURDATE: p.date, CODE: p.currency, STATDES: DRAFT_FILE_STATUS },
          p,
        );
        const gate = previewOrBlock(config, p.dryRun, 'OPEN IMPORT FILE', body);
        if (gate) return gate;
        const outcome = await verifyRecordCreate(client, 'IMPFILES', body);
        return textResult({ opened: outcome.verified, importFile: outcome.result, ...outcome });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_update',
    `עדכון כותרת של תיק יבוא (PATCH IMPFILES). Update an import file's header fields. The status
cannot be changed here: closing and reopening are screen procedures (see impfile_close).

Only the fields you pass are changed. NOTE: country-of-origin is PER-LINE in the customs estimate
(IMPFILECUSTOMS_SUBFORM), not a header field — Priority defaults it to the supplier's country.

⚠️ WRITE. dryRun=true (default) previews the exact PATCH body.`,
    {
      impfnum: z.string().min(1).describe('IMPFNUM to update'),
      owner: z.string().optional().describe('OWNERLOGIN'),
      supplier: z.string().optional().describe('SUPNAME'),
      forwarder: z.string().optional().describe('SUPNAME2'),
      po: z.string().optional().describe('ORDNAME'),
      incoterms: z.string().optional().describe('IMPTERMNAME'),
      shipper: z.string().optional().describe('SHIPPERNAME'),
      declaration: z.string().optional().describe('CUSTOMSNUM'),
      declarationDate: z.string().optional().describe('CUSTOMSDATE'),
      warehouse: z.string().optional().describe('WARHSNAME'),
      details: z.string().optional().describe('DETAILS'),
      dryRun: z.boolean().default(true),
    },
    async (p) => {
      try {
        const body: Row = {};
        applyImpfileHeaderFields(body, p);
        if (Object.keys(body).length === 0) {
          return textResult({ error: 'No fields to update — pass at least one header field.' });
        }
        const gate = previewOrBlock(config, p.dryRun, `UPDATE IMPORT FILE ${p.impfnum}`, body);
        if (gate) return gate;
        const outcome = await verifyRecordUpdate(client, 'IMPFILES', p.impfnum, body);
        return textResult({ updated: outcome.verified, importFile: outcome.result, ...outcome });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'pinvoice_create',
    `רישום חשבונית ספק לתיק יבוא (POST PINVOICES). Record a supplier invoice linked to an import file.

invoiceNumber is the number PRINTED ON THE SUPPLIER'S INVOICE (the document titled Invoice /
Tax Invoice, often prefixed e.g. "RI", "INV"). It is NOT the supplier's sales-order /
order-confirmation number (often prefixed "SO"), not our PO number and not a delivery-note number. If the document in hand shows only an order number, it is not the
invoice — find the invoice before recording anything.

Two modes:
  • goods  — foreign supplier + currency; one line per purchased SKU (price optional → from the order).
    With 'po': Priority copies the order's lines into the invoice by itself, so the tool sends the
    header ALONE, then sets each pulled line to the invoice quantity/price and deletes order lines
    that are not on this invoice. It then re-reads the draft and reports verified only if it holds
    exactly the lines sent, each linked to the order, with total = Σ quantity × price. Every part
    must be on exactly one open line of the order, and the supplier must not already have an
    invoice with this number — otherwise nothing is sent. A charge that is printed on the
    supplier's invoice but is NOT on the order (carriage, pallets, a surcharge) goes in
    'extraLines'; it is added as a manual line and counted in the total. If the result says status "incomplete",
    a draft EXISTS: do not call this tool again for the same invoice; fix that draft.
  • broker — forwarder/customs-broker invoice: cost lines on cost parts, an optional C-loaded customs
    (מכס) line, and one VAT-from-declaration line per declaration on the '${VAT_DECLARATION_PART}' system
    part (VATFLAG=Y, carrying the declaration). Amounts stay in the source currency — Priority applies FX.
Links to the file via header IMPFNUM + OTYPE='P'; DEBIT='D'.

⚠️ WRITE. dryRun=true (default) previews the exact body; for goods + po it also reads the order
(read-only) and shows the lines and total the invoice will end with.`,
    {
      mode: z.enum(['goods', 'broker']),
      supplier: z.string().min(1).describe('SUPNAME (goods supplier or forwarder)'),
      invoiceNumber: z
        .string()
        .min(1)
        .describe(
          "The invoice number printed on the supplier's invoice → BOOKNUM. Never the supplier's sales-order (SO) number, an order confirmation or our PO number.",
        ),
      invoiceDate: z.string().min(1).describe('IVDATE (YYYY-MM-DD)'),
      currency: z.string().min(1).describe('CODE (foreign for goods; ILS for broker)'),
      impfnum: z.string().min(1).describe('IMPFNUM to link'),
      po: z.string().optional().describe('goods: linked PO (ORDNAME)'),
      goodsLines: z
        .array(
          z.object({
            part: z.string().min(1),
            qty: z.number().positive(),
            price: z.number().optional(),
          }),
        )
        .optional()
        .describe('goods mode: purchased SKU lines (with po: parts that are on the order)'),
      extraLines: z
        .array(
          z.object({
            part: z
              .string()
              .min(1)
              .describe("PARTNAME of the charge (e.g. the generic part '000')"),
            qty: z.number().positive().default(1),
            price: z.number().describe('unit price, invoice currency'),
            description: z.string().max(100).optional().describe('line description → PDES'),
          }),
        )
        .optional()
        .describe(
          "goods mode with po: charges on the supplier's invoice that are NOT on the purchase order (carriage, pallets, surcharge)",
        ),
      costLines: z
        .array(
          z.object({
            part: z.string().min(1).describe('cost PARTNAME (e.g. COST048 freight)'),
            amount: z.number(),
            vat: z.boolean().default(false),
          }),
        )
        .optional()
        .describe('broker mode: ancillary cost lines'),
      declarationVat: z
        .array(
          z.object({
            amount: z.number().describe('import VAT amount from the declaration'),
            declaration: z.string().optional(),
            declarationDate: z.string().optional(),
          }),
        )
        .optional()
        .describe('broker mode: one line per declaration on the VAT system part'),
      customsDuty: z
        .array(
          z.object({
            part: z.string().min(1).describe('the C-loaded customs (duty) part'),
            amount: z.number(),
            declaration: z.string().optional(),
            declarationDate: z.string().optional(),
            vat: z.boolean().default(false),
          }),
        )
        .optional()
        .describe('broker mode: customs duty (usually empty)'),
      vatDeclarationPart: z
        .string()
        .min(1)
        .optional()
        .describe(`override the VAT-from-declaration part (default '${VAT_DECLARATION_PART}')`),
      dryRun: z.boolean().default(true),
    },
    async (p) => {
      try {
        const baseHeader = {
          supplier: p.supplier,
          invoiceNumber: p.invoiceNumber,
          invoiceDate: p.invoiceDate,
          currency: p.currency,
          impfnum: p.impfnum,
        };
        let body: Row;
        if (p.mode === 'goods') {
          if (!p.goodsLines?.length) {
            return textResult({ error: 'goods mode requires goodsLines (at least one SKU line).' });
          }
          // Reject broker-only inputs in goods mode so mis-placed lines are never silently dropped.
          if (p.costLines?.length || p.declarationVat?.length || p.customsDuty?.length) {
            return textResult({
              error:
                'goods mode ignores costLines/declarationVat/customsDuty — use mode="broker" for those.',
            });
          }
          // A priceless line with no PO gives Priority no order to source the price from.
          if (!p.po && p.goodsLines.some((l) => l.price === undefined)) {
            return textResult({
              error:
                'goods lines without a price require a `po` so Priority can source the price from the order.',
            });
          }
          if (p.po) {
            return await createGoodsInvoiceFromPo(client, config, {
              ...baseHeader,
              po: p.po,
              goodsLines: [
                ...p.goodsLines,
                ...(p.extraLines ?? []).map((l) => ({ ...l, extra: true })),
              ],
              dryRun: p.dryRun,
            });
          }
          if (p.extraLines?.length) {
            return textResult({
              error:
                'extraLines is for goods invoices with a po; without one, put every line in goodsLines.',
            });
          }
          body = buildGoodsInvoiceBody({ header: baseHeader, lines: p.goodsLines });
        } else {
          if (!brokerHasLines(p)) {
            return textResult({
              error:
                'broker mode requires at least one of costLines / declarationVat / customsDuty.',
            });
          }
          // Reject goods lines in broker mode (a forwarder invoice has no purchased SKUs / PO).
          if (p.goodsLines?.length || p.extraLines?.length) {
            return textResult({
              error:
                'broker mode ignores goodsLines/extraLines — use mode="goods" for purchased SKUs.',
            });
          }
          body = buildBrokerInvoiceBody({
            header: baseHeader, // no ORDNAME on a broker/forwarder invoice
            costLines: p.costLines,
            declarationVat: p.declarationVat,
            customsDuty: p.customsDuty,
            vatDeclarationPart: p.vatDeclarationPart,
          });
        }
        const gate = previewOrBlock(
          config,
          p.dryRun,
          `CREATE ${p.mode.toUpperCase()} SUPPLIER INVOICE`,
          body,
        );
        if (gate) return gate;
        const outcome = await verifyRecordCreate(client, 'PINVOICES', body);
        client.invalidateCache('IMPFILES'); // the new invoice shows up in the file's snapshot
        return textResult({ created: outcome.verified, invoice: outcome.result, ...outcome });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_link_invoice',
    `קישור חשבונית קיימת לתיק יבוא. Link an EXISTING supplier invoice to an import file.

Routes (all three are implemented against real entities on this install):
  • header (default) — PATCH the invoice header: IMPFNUM + OTYPE='P' on PINVOICES. Whole-invoice link.
  • line — link ONE INVOICE LINE ("חשבוניות לתיקי יבוא ← פירוט"): PATCHes IMPFNUM on
    IMPFILEIV(IVNUM,DEBIT,TYPE)/IMPFILEIVS_SUBFORM(KLINE=n). Use when a single forwarder invoice
    covers several files and each cost line belongs to a different one. Omit 'line' to LIST the
    invoice's lines (part, amount, current IMPFNUM) so you can pick the right KLINE first.
  • final — the finalized-invoice screen "עדכון פרטים לחשבוניות ספק" = form PIVDETAILS
    (key IVNUM,DEBIT,TYPE). Its "Available for API" flag is off on this tenant, so this route
    probes the form at runtime and, if it is still blocked, names it and says who can enable it.

Entity map (verified live 2026-07-29, company demo):
  PINVOICES  — supplier invoice header, key (IVNUM, DEBIT, IVTYPE)
  IMPFILEIV  — invoice↔import-file view, key (IVNUM, DEBIT, TYPE), lines in IMPFILEIVS_SUBFORM (key KLINE)
  IMPFILES/IMPFILEINV_SUBFORM — the same invoices as seen from the file
  PIVDETAILS — finalized-invoice detail update, key (IVNUM, DEBIT, TYPE)  [API flag off here]

Safety: these forms have COMPOSITE keys, so the invoice is resolved by IVNUM + debit + type to hit
exactly the intended row. Refuses to link a cancelled (storno) invoice, and refuses to MOVE an
invoice already linked to a different file unless allowRelink=true.

⚠️ WRITE. dryRun=true (default) previews the exact PATCH.`,
    {
      route: z.enum(['header', 'line', 'final']).default('header'),
      invoiceNumber: z.string().min(1).describe('IVNUM of the invoice to link'),
      impfnum: z.string().min(1).describe('IMPFNUM to link it to'),
      debit: z.string().default('D').describe('DEBIT key part (D=חיוב debit, C=זכוי credit)'),
      ivtype: z
        .string()
        .default('P')
        .describe("IVTYPE/TYPE key part (P=purchase invoice) — 'TYPE' on IMPFILEIV/PIVDETAILS"),
      line: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("route='line': the KLINE of the invoice line to link (omit to list the lines)"),
      allowRelink: z
        .boolean()
        .default(false)
        .describe('allow moving an invoice already linked to a DIFFERENT import file'),
      dryRun: z.boolean().default(true),
    },
    async (p) => {
      try {
        if (p.route === 'line') return await linkInvoiceLine(client, config, p);
        if (p.route === 'final') return await linkInvoiceFinal(client, config, p);
        // Resolve by the FULL composite key: an IVNUM can have both a debit and a credit/storno row,
        // so filtering on IVNUM alone could PATCH the wrong invoice.
        const qb = new ODataBuilder()
          .eq('IVNUM', sanitizeODataValue(p.invoiceNumber))
          .eq('DEBIT', sanitizeODataValue(p.debit))
          .eq('IVTYPE', sanitizeODataValue(p.ivtype))
          .select('IVNUM', 'DEBIT', 'IVTYPE', 'SUPDES', 'IMPFNUM', 'STORNOFLAG')
          .top(1);
        const found = await client.list<Row>('PINVOICES', qb.build());
        const inv = found.value[0];
        if (!inv) {
          return textResult({
            error: `No PINVOICES invoice found with IVNUM='${p.invoiceNumber}', DEBIT='${p.debit}', IVTYPE='${p.ivtype}'.`,
          });
        }
        // Guard the same composite-key/storno corruption that void_invoice was disabled for.
        if (inv.STORNOFLAG === 'Y') {
          return textResult({
            error: `Invoice ${p.invoiceNumber} is cancelled (storno) — refusing to link it to a file.`,
          });
        }
        const currentLink = inv.IMPFNUM ? String(inv.IMPFNUM) : null;
        if (currentLink && currentLink !== p.impfnum && !p.allowRelink) {
          return textResult({
            error: `Invoice ${p.invoiceNumber} is already linked to import file ${currentLink}. Pass allowRelink=true to move it to ${p.impfnum}.`,
          });
        }
        const keys = {
          IVNUM: String(inv.IVNUM),
          DEBIT: String(inv.DEBIT),
          IVTYPE: String(inv.IVTYPE),
        };
        const body = { IMPFNUM: p.impfnum, OTYPE: 'P' };
        const gate = previewOrBlock(config, p.dryRun, 'LINK INVOICE TO IMPORT FILE (PATCH)', {
          endpoint: client.resolveCompositeUrl('PINVOICES', keys),
          keys,
          body,
          currentlyLinkedTo: currentLink,
          relink: Boolean(currentLink && currentLink !== p.impfnum),
        });
        if (gate) return gate;
        const outcome = await verifyRecordUpdate(client, 'PINVOICES', keys, body);
        client.invalidateCache('IMPFILES'); // the relink shows up in the file's snapshot
        return textResult({ linked: outcome.verified, invoice: outcome.result, ...outcome });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_manual_alloc',
    `העמסה ידנית לתיק יבוא (POST sub-form). Add a manual allocation line to an import file.

target='cost' → MANIVDUTIES_SUBFORM (a cost from an invoice, allocated by ratio);
target='item' → MANIVPARTS2_SUBFORM (a manually added product line).
⚠️ This company has never used these sub-forms (no file so far), so their exact line-field names are
UNVERIFIED. Pass 'fields' as the raw line object and confirm the field names against a real
allocation (or the form's $metadata) before a real write.

⚠️ WRITE. dryRun=true (default) previews the exact POST.`,
    {
      impfnum: z.string().min(1),
      target: z.enum(['cost', 'item']),
      fields: z.record(z.string(), z.unknown()).describe('Raw line fields (unverified — see note)'),
      dryRun: z.boolean().default(true),
    },
    async (p) => {
      try {
        const subform = p.target === 'cost' ? 'MANIVDUTIES_SUBFORM' : 'MANIVPARTS2_SUBFORM';
        const endpoint = client.resolveSubformUrl('IMPFILES', p.impfnum, subform);
        const blocked = blockProcedureOnlyField('POST', endpoint, p.fields);
        if (blocked) return blocked;
        const gate = previewOrBlock(config, p.dryRun, `ADD MANUAL ALLOCATION → ${subform}`, {
          method: 'POST',
          endpoint,
          body: p.fields,
        });
        if (gate) return gate;
        const outcome = await verifyLineCreate(client, 'IMPFILES', p.impfnum, subform, p.fields);
        return textResult({ added: outcome.verified, subform, ...outcome });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_expected_costs',
    `רישום עלויות צפויות לתיק (POST EXPIVDUTIES_SUBFORM). Record expected costs that feed the
expected/actual loading report.
⚠️ Unused on this company (no file so far) → line-field names UNVERIFIED; pass 'fields' raw and confirm
before a real write.

⚠️ WRITE. dryRun=true (default) previews the exact POST.`,
    {
      impfnum: z.string().min(1),
      fields: z
        .record(z.string(), z.unknown())
        .describe('Raw expected-cost line fields (unverified — see note)'),
      dryRun: z.boolean().default(true),
    },
    async (p) => {
      try {
        const endpoint = client.resolveSubformUrl('IMPFILES', p.impfnum, 'EXPIVDUTIES_SUBFORM');
        const blocked = blockProcedureOnlyField('POST', endpoint, p.fields);
        if (blocked) return blocked;
        const gate = previewOrBlock(config, p.dryRun, 'ADD EXPECTED COST → EXPIVDUTIES_SUBFORM', {
          method: 'POST',
          endpoint,
          body: p.fields,
        });
        if (gate) return gate;
        const outcome = await verifyLineCreate(
          client,
          'IMPFILES',
          p.impfnum,
          'EXPIVDUTIES_SUBFORM',
          p.fields,
        );
        return textResult({ added: outcome.verified, ...outcome });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  // -------------------------------------------------- Match / preflight / close

  server.tool(
    'po_match',
    `התאמה תלת-כיוונית להזמנת רכש. Three-way match for a purchase order: ordered ↔ received ↔ invoiced.

Joins the PO's PORDERITEMS (ordered), PORDERTRANS (קבלות סחורה מספק = received) and PORDERIV
(חש. ספק מרכזות = invoiced) sub-forms by part. Per-line verdict:
matched / qty-gap / ordered-not-arrived / arrived-not-ordered / received-not-invoiced.
Bonded note: a receipt into the bonded warehouse closes the PO balance even before release.`,
    {
      poNumber: z.string().min(1).describe('Purchase order ORDNAME (e.g. PO99028078)'),
    },
    async (p) => {
      try {
        const qb = new ODataBuilder().expand(
          'PORDERITEMS_SUBFORM',
          'PORDERTRANS_SUBFORM',
          'PORDERIV_SUBFORM',
        );
        const po = await client.get<Row>('PORDERS', p.poNumber, qb.build());
        const match = matchThreeWay(
          (po.PORDERITEMS_SUBFORM as Row[]) ?? [],
          (po.PORDERTRANS_SUBFORM as Row[]) ?? [],
          (po.PORDERIV_SUBFORM as Row[]) ?? [],
        );
        return textResult({
          po: p.poNumber,
          supplier: po.CDES ?? po.SUPNAME,
          closed: po.CLOSEDBOOL === 'Y',
          partiallyClosed: po.BOOLPCLOSED === 'Y',
          importFile: po.IMPFNUM ?? null,
          ...match,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_preflight',
    `אבחון לפני סגירת תיק יבוא (spec §3.7). Pre-close diagnostics for an import file.

Returns { ok, blocking[], advisory[], info[], stage, official }. 'stage' says which steps before
the close are proven (invoices final → receipt into BONDED → detail → loading calc → release); a
missing or unreadable step is added to 'blocking'. 'official' is the whole process as Priority's
SOPs define it (LBI2400273 + LBI2400656), twelve steps from opening the file to the landed cost per
product, with 'currentStep' = the first step not yet done, 'nextAction', and 'violations' = things
already done in an order the SOP does not allow. Some checks are ADVISORY because their data isn't
API-readable here (loading method per cost part; last-calc timestamp).`,
    {
      impfnum: z.string().min(1).describe('IMPFNUM to diagnose'),
    },
    async (p) => {
      try {
        const { facts, snapshot, receipts } = await loadFileFacts(client, p.impfnum);
        const stage = computeStage({
          snapshot,
          receipts,
          releases:
            facts.releases === null
              ? null
              : facts.releases.map((r) => ({ DOCNO: r.docno, STATDES: r.status })),
        });
        const pf = preflight(snapshot);
        return textResult({
          impfnum: p.impfnum,
          ok: pf.ok && stage.closeBlocking.length === 0,
          blocking: [...pf.blocking, ...stage.closeBlocking],
          advisory: [...pf.advisory, ...stage.advisory],
          info: pf.info,
          lastCalcViaTool: lastCalcViaTool(p.impfnum),
          stage,
          official: computeOfficialSteps(facts),
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_landed_cost',
    `עלות נחיתה משוערת למק"ט (spec §3.5 fallback). Estimated landed cost per SKU.

Value-weighted estimate: each part's ILS goods value (from the customs estimate) plus a pro-rata share
of the ancillary costs (pre-VAT; import VAT excluded as recoverable). Priority's own calc spreads each
cost by its part's loading method, so treat this as an estimate — the authoritative figure is the
product cost after תמחיר.`,
    {
      impfnum: z.string().min(1).describe('IMPFNUM'),
    },
    async (p) => {
      try {
        const snapshot = await loadSnapshot(client, p.impfnum);
        return textResult({ impfnum: p.impfnum, ...computeLandedCost(snapshot) });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'po_close_lines',
    `סגירת הזמנת רכש / יתרות. Close a purchase order (force-close its remaining balance).

⚠️ PROCEDURE-GATED: closing a PO may be a screen procedure rather than a field write. Previews the
intended PATCH (CLOSEDBOOL='Y'); on a real run verify with po_match. Line-level close needs the PO
line key and is best done in the screen.

⚠️ WRITE. dryRun=true (default) previews the PATCH.`,
    {
      poNumber: z.string().min(1).describe('Purchase order key ORDNAME to close'),
      dryRun: z.boolean().default(true),
    },
    async (p) => {
      try {
        const body = { CLOSEDBOOL: 'Y' };
        const gate = previewOrBlock(config, p.dryRun, `CLOSE PURCHASE ORDER ${p.poNumber}`, {
          method: 'PATCH',
          endpoint: client.resolveEntityUrl('PORDERS', p.poNumber),
          body,
          note: 'Procedure-gated: if Priority rejects the field write, run "close order" in the PO screen, then verify with po_match.',
        });
        if (gate) return gate;
        const outcome = await verifyRecordUpdate(client, 'PORDERS', p.poNumber, body);
        client.invalidateCache('IMPFILES');
        return textResult({ closed: outcome.verified, po: p.poNumber, ...outcome });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_run_calc_guide',
    `הרצת חישוב העמסה (spec §0/§3.7). READ-ONLY GUIDE — does NOT run the loading calculation.

The calc ("חישוב העמסה") is Priority's program IMPFILE2; it is run by impfile_run_calc (a direct
activation through the Web SDK), not by an OData write. This guide reports the file's current
customs-estimate state; after a run, re-check with impfile_preflight / impfile_close.
Results carry "mutates": false.`,
    {
      impfnum: z.string().min(1).describe('IMPFNUM'),
    },
    async (p) => {
      try {
        // Only the customs estimate is needed for the status read — avoid the full 7-subform expand.
        const qb = new ODataBuilder().expand('IMPFILECUSTOMS_SUBFORM');
        const rec = await client.get<Row>('IMPFILES', p.impfnum, qb.build());
        const customs = (rec.IMPFILECUSTOMS_SUBFORM as Row[]) ?? [];
        return textResult({
          mutates: false,
          impfnum: p.impfnum,
          action: 'RUN LOADING CALC (חישוב העמסה)',
          tool: 'impfile_run_calc',
          instruction:
            'Run impfile_run_calc ("חישוב העמסה", program IMPFILE2), then re-check impfile_preflight / impfile_close.',
          lastCalcViaTool: lastCalcViaTool(p.impfnum),
          currentCustomsEstimateLines: customs.length,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_close',
    `בדיקת מוכנות לסגירת תיק יבוא. Is this import file ready to be closed?

CHECK ONLY — never changes the file. Closing is done by the owner in the screen ("סגירת התיק"); this tool
reports which steps of the mandatory order are proven (invoices final → receipt into BONDED → detail →
loading calc) and what is missing. The server blocks every field write of an import file's status.
Results carry "mutates": false.`,
    {
      impfnum: z.string().min(1),
      override: z.boolean().optional().describe('ignored — this tool never writes'),
      dryRun: z.boolean().optional().describe('ignored — this tool never writes'),
    },
    async (p) => {
      try {
        const { snapshot, stage } = await loadStageWithSnapshot(client, p.impfnum);
        const pf = preflight(snapshot);
        const blocking = [...pf.blocking, ...stage.closeBlocking];
        const readyToClose = !stage.closed && blocking.length === 0;
        const nextStep = stage.closed
          ? 'התיק כבר סגור.'
          : readyToClose
            ? 'impfile_run_calc (חישוב העמסה), ואז הבעלים: "סגירת התיק" במסך תיקי יבוא.'
            : blocking[0];
        return textResult({
          mutates: false,
          impfnum: p.impfnum,
          closed: stage.closed,
          readyToClose,
          nextStep,
          lastCalcViaTool: lastCalcViaTool(p.impfnum),
          blocking,
          stage,
          preflight: pf,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_reopen',
    `בדיקה לפני ביטול סגירת תיק יבוא. What reopening this import file involves.

CHECK ONLY — never changes the file. Reopening is done by the owner in the screen ("ביטול סגירה של התיק");
this tool reports whether the file is closed, whether goods were already released, and the sequence
to repeat afterwards. Results carry "mutates": false.`,
    {
      impfnum: z.string().min(1),
      dryRun: z.boolean().optional().describe('ignored — this tool never writes'),
    },
    async (p) => {
      try {
        const { stage } = await loadStageWithSnapshot(client, p.impfnum);
        return textResult({
          mutates: false,
          impfnum: p.impfnum,
          closed: stage.closed,
          nextStep: stage.closed
            ? 'הבעלים: "ביטול סגירה של התיק" במסך. אחרי התיקון: חישוב העמסה → סגירת התיק → לכל תעודת שחרור סופית של התיק: "פתיחת תעודה סופית לעריכה", סימון "לבצע חישוב חוזר" בכל שורה במסך "עלויות יבוא לשורה", והחזרה לסופית → תמחיר (SOP LBI2400656, שלב ה׳).'
            : 'התיק פתוח — אין מה לבטל.',
          stage,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
