import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { dateRange } from '../lib/dates.js';
import { probeForm } from '../lib/forms.js';
import {
  type ImpfileSnapshot,
  VAT_DECLARATION_PART,
  brokerHasLines,
  buildBrokerInvoiceBody,
  buildGoodsInvoiceBody,
  classifyInvoices,
  computeLandedCost,
  matchThreeWay,
  preflight,
} from '../lib/impfiles-logic.js';
import { getSchema } from '../lib/priority-schema.js';
import { escapeODataString, sanitizeODataValue } from '../lib/sanitize.js';
import { previewOrBlock, textResult, unavailableHere } from '../lib/write-guard.js';
import {
  verifyLineCreate,
  verifyRecordCreate,
  verifyRecordUpdate,
  verifyWrite,
} from '../lib/write-verification.js';

const IMPFILES = getSchema('IMPFILES');

/**
 * The seven load-bearing sub-forms of an import file, mapped to friendly snapshot keys.
 * Line-level linked costs/items do NOT appear inside the invoices sub-form, so impfile_get
 * MUST expand all of these to give a complete picture (mapping doc §2).
 */
const IMPFILE_SUBFORMS: ReadonlyArray<{ subform: string; key: string }> = [
  { subform: 'IMPFILEINV_SUBFORM', key: 'invoices' },
  { subform: 'MANIVDUTIES_SUBFORM', key: 'manualCostAllocations' },
  { subform: 'MANIVPARTS2_SUBFORM', key: 'extraProductLines' },
  { subform: 'EXPIVDUTIES_SUBFORM', key: 'expectedCosts' },
  { subform: 'IMPFILECUSTOMS_SUBFORM', key: 'customsEstimate' },
  { subform: 'IMPFILEITEMS_SUBFORM', key: 'goodsContent' },
  { subform: 'IMPFILEPORDI_SUBFORM', key: 'linkedPoLines' },
];

type Row = Record<string, unknown>;

/** Sum a numeric field across rows, bucketed by a currency field. */
function sumByCurrency(
  rows: Row[],
  amountField: string,
  codeField = 'CODE',
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const r of rows) {
    const amt = Number(r[amountField]);
    if (!Number.isFinite(amt)) continue;
    const code = String(r[codeField] ?? '?');
    totals[code] = (totals[code] ?? 0) + amt;
  }
  return totals;
}

/**
 * Build a normalized, decision-ready snapshot from a raw IMPFILES record whose sub-forms were
 * expanded. Splits header from sub-forms, renames sub-forms to friendly keys, and adds a `derived`
 * summary (per-currency invoice totals, goods-vs-cost invoice split, customs-estimate flags).
 */
function normalizeSnapshot(record: Row): Row {
  const header: Row = {};
  const sections: Row = {};
  const bySubform = new Map(IMPFILE_SUBFORMS.map((s) => [s.subform, s.key]));

  for (const [k, v] of Object.entries(record)) {
    const friendly = bySubform.get(k);
    if (friendly) {
      sections[friendly] = Array.isArray(v) ? v : [];
    } else if (!k.endsWith('_SUBFORM')) {
      header[k] = v;
    }
    // Unmapped *_SUBFORM keys (notes, attachments, versions…) are intentionally dropped from
    // the snapshot to keep it focused; fetch them via priority_query if needed.
  }

  const invoices = (sections.invoices as Row[]) ?? [];
  // Goods invoices come from the file's own supplier; broker/forwarder invoices from others.
  // Shared with preflight / computeLandedCost so all three classify identically (and safely when
  // the header supplier is blank — an undefined supplier would otherwise bucket every invoice as cost).
  const { goods, cost, supplierKnown } = classifyInvoices(invoices, header.SUPNAME);
  const customs = (sections.customsEstimate as Row[]) ?? [];

  const derived = {
    invoiceCount: invoices.length,
    supplierKnown,
    goodsInvoices: supplierKnown ? goods.length : null,
    costInvoices: supplierKnown ? cost.length : null,
    invoiceTotalsByCurrency: sumByCurrency(invoices, 'TOTPRICE'),
    hasManualCostAllocations: ((sections.manualCostAllocations as Row[]) ?? []).length > 0,
    hasExpectedCosts: ((sections.expectedCosts as Row[]) ?? []).length > 0,
    goodsLineCount: ((sections.goodsContent as Row[]) ?? []).length,
    customsEstimate: {
      lineCount: customs.length,
      totalDuty: customs.reduce((s, c) => s + (Number(c.CUSTOMS) || 0), 0),
      partsWithoutCustomsItem: customs.filter((c) => !c.CUSTOMSITEMNAME).length,
    },
  };

  return { header, ...sections, derived };
}

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

/** Fetch an import file with all sub-forms and return the normalized snapshot (for preflight /
 * landed-cost / close, which reason over the same aggregate impfile_get produces). */
async function loadSnapshot(client: PriorityClient, impfnum: string): Promise<ImpfileSnapshot> {
  const qb = new ODataBuilder().expand(...IMPFILE_SUBFORMS.map((s) => s.subform));
  const record = await client.get<Row>('IMPFILES', impfnum, qb.build());
  return normalizeSnapshot(record) as unknown as ImpfileSnapshot;
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

export function registerImpfileTools(server: McpServer, client: PriorityClient, config: Config) {
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
      impfnum: z.string().min(1).describe("Import file number (IMPFNUM), e.g. 'IM25000009'"),
      raw: z
        .boolean()
        .default(false)
        .describe('true → return the raw Priority record instead of the normalized snapshot'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder().expand(...IMPFILE_SUBFORMS.map((s) => s.subform));
        const record = await client.get<Row>('IMPFILES', params.impfnum, qb.build());
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

Mandatory in Priority: open date, currency, handler (OWNERLOGIN), status. IMPFNUM is auto-generated.
WARHSNAME defaults to your bonded warehouse ('arov') when omitted here — pass it explicitly to be sure.

⚠️ WRITE. dryRun=true (default) previews the exact POST body.`,
    {
      date: z.string().min(1).describe('Open date CURDATE (YYYY-MM-DD)'),
      currency: z.string().min(1).describe('File currency CODE (e.g. EUR, $, ש"ח)'),
      owner: z
        .string()
        .optional()
        .describe('Handler OWNERLOGIN (mandatory in Priority; provide if the create errors)'),
      status: z.string().default('טיוטא').describe('STATDES (default draft)'),
      supplier: z.string().optional().describe('Goods supplier SUPNAME'),
      forwarder: z.string().optional().describe('Forwarder/broker SUPNAME2'),
      po: z.string().optional().describe('Linked purchase order ORDNAME'),
      incoterms: z.string().optional().describe('IMPTERMNAME (EXW/FOB/C&F...)'),
      shipper: z.string().optional().describe('SHIPPERNAME'),
      declaration: z.string().optional().describe('Import declaration CUSTOMSNUM'),
      declarationDate: z.string().optional().describe('CUSTOMSDATE (YYYY-MM-DD)'),
      warehouse: z.string().optional().describe("Bonded warehouse WARHSNAME (e.g. 'arov')"),
      details: z.string().optional().describe('Free-text DETAILS'),
      dryRun: z.boolean().default(true),
    },
    async (p) => {
      try {
        const body = applyImpfileHeaderFields(
          { CURDATE: p.date, CODE: p.currency, STATDES: p.status },
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
    `עדכון כותרת / סטטוס של תיק יבוא (PATCH IMPFILES). Update an import file's header fields.

Only the fields you pass are changed. NOTE: country-of-origin is PER-LINE in the customs estimate
(IMPFILECUSTOMS_SUBFORM), not a header field — Priority defaults it to the supplier's country.

⚠️ WRITE. dryRun=true (default) previews the exact PATCH body.`,
    {
      impfnum: z.string().min(1).describe('IMPFNUM to update'),
      status: z.string().optional().describe('STATDES'),
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
        if (p.status !== undefined) body.STATDES = p.status;
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

Two modes:
  • goods  — foreign supplier + currency; one line per purchased SKU (price optional → from the order).
  • broker — forwarder/customs-broker invoice: cost lines on cost parts, an optional C-loaded customs
    (מכס) line, and one VAT-from-declaration line per declaration on the '${VAT_DECLARATION_PART}' system
    part (VATFLAG=Y, carrying the declaration). Amounts stay in the source currency — Priority applies FX.
Links to the file via header IMPFNUM + OTYPE='P'; DEBIT='D'.

⚠️ WRITE. dryRun=true (default) previews the exact deep-insert body.`,
    {
      mode: z.enum(['goods', 'broker']),
      supplier: z.string().min(1).describe('SUPNAME (goods supplier or forwarder)'),
      invoiceNumber: z.string().min(1).describe("Supplier's printed invoice number (BOOKNUM)"),
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
        .describe('goods mode: purchased SKU lines'),
      costLines: z
        .array(
          z.object({
            part: z.string().min(1).describe('cost PARTNAME (e.g. AVI001 freight)'),
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
        .describe('broker mode: customs duty (usually empty — imports are duty-free here)'),
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
          body = buildGoodsInvoiceBody({
            header: { ...baseHeader, po: p.po },
            lines: p.goodsLines,
          });
        } else {
          if (!brokerHasLines(p)) {
            return textResult({
              error:
                'broker mode requires at least one of costLines / declarationVat / customsDuty.',
            });
          }
          // Reject goods lines in broker mode (a forwarder invoice has no purchased SKUs / PO).
          if (p.goodsLines?.length) {
            return textResult({
              error: 'broker mode ignores goodsLines — use mode="goods" for purchased SKUs.',
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

Entity map (verified live 2026-07-29, company a051014):
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
⚠️ This company has never used these sub-forms (0/114 files), so their exact line-field names are
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
        const gate = previewOrBlock(config, p.dryRun, `ADD MANUAL ALLOCATION → ${subform}`, {
          method: 'POST',
          endpoint: client.resolveSubformUrl('IMPFILES', p.impfnum, subform),
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
⚠️ Unused on this company (0/114 files) → line-field names UNVERIFIED; pass 'fields' raw and confirm
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
        const gate = previewOrBlock(config, p.dryRun, 'ADD EXPECTED COST → EXPIVDUTIES_SUBFORM', {
          method: 'POST',
          endpoint: client.resolveSubformUrl('IMPFILES', p.impfnum, 'EXPIVDUTIES_SUBFORM'),
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
      poNumber: z.string().min(1).describe('Purchase order ORDNAME (e.g. PO25000003)'),
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

Returns { ok, blocking[], advisory[], info[] }. impfile_close refuses while 'blocking' is non-empty
(unless overridden). Some checks are ADVISORY because their data isn't API-readable here (loading
method per cost part; last-calc timestamp).`,
    {
      impfnum: z.string().min(1).describe('IMPFNUM to diagnose'),
    },
    async (p) => {
      try {
        const snapshot = await loadSnapshot(client, p.impfnum);
        return textResult({ impfnum: p.impfnum, ...preflight(snapshot) });
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

⚠️ The calc ("חישוב העמסה") is a Priority SCREEN PROCEDURE, not an OData action on this install, so
no tool here can trigger it. This one reports the file's current customs-estimate state and the exact
step to run in the screen; afterwards re-call impfile_landed_cost / impfile_preflight to verify.
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
          exposedAsApi: false,
          instruction:
            'Run "חישוב העמסה" in the import-file screen, then re-check impfile_landed_cost / impfile_preflight.',
          currentCustomsEstimateLines: customs.length,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_close',
    `סגירת תיק יבוא. Close an import file — only after a clean preflight.

Runs impfile_preflight first and refuses to close while blocking issues remain, unless override=true.
⚠️ PROCEDURE-GATED: closing may be a screen procedure rather than a field write. On a real run this
tool RE-READS the file after the PATCH and reports whether CLOSED='Y' / STATDES='סופי' actually took —
a silent no-op on a close is dangerous, so the result's 'closed' flag reflects the re-read, not the
PATCH's success.

⚠️ WRITE. dryRun=true (default) previews the PATCH.`,
    {
      impfnum: z.string().min(1),
      override: z.boolean().default(false).describe('close despite blocking preflight issues'),
      dryRun: z.boolean().default(true),
    },
    async (p) => {
      try {
        const snapshot = await loadSnapshot(client, p.impfnum);
        const pf = preflight(snapshot);
        if (!pf.ok && !p.override) {
          return textResult({
            error: 'Preflight has blocking issues — resolve them or pass override=true.',
            preflight: pf,
          });
        }
        const body = { CLOSED: 'Y', STATDES: 'סופי' };
        const gate = previewOrBlock(config, p.dryRun, `CLOSE IMPORT FILE ${p.impfnum}`, {
          method: 'PATCH',
          endpoint: client.resolveEntityUrl('IMPFILES', p.impfnum),
          body,
          preflight: pf,
          note: 'Procedure-gated: if Priority rejects the field write, run "סגירת תיק" in the import-file screen, then verify CLOSED=Y via impfile_get.',
        });
        if (gate) return gate;
        const outcome = await verifyRecordUpdate(client, 'IMPFILES', p.impfnum, body);
        return textResult({
          closed: outcome.verified,
          impfnum: p.impfnum,
          verifiedAfterWrite: outcome.verification.observed ?? null,
          expected: outcome.verification.expected,
          ...outcome,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'impfile_reopen',
    `ביטול סגירת תיק יבוא. Reopen a closed import file for corrections.

⚠️ PROCEDURE-GATED like close. Previews the PATCH (CLOSED='', STATDES='טיוטא'). After reopening, follow
the guided sequence: fix → run calc → close → re-run תמחיר if it already ran (spec §3.6).

⚠️ WRITE. dryRun=true (default) previews the PATCH.`,
    {
      impfnum: z.string().min(1),
      dryRun: z.boolean().default(true),
    },
    async (p) => {
      try {
        const body = { CLOSED: '', STATDES: 'טיוטא' };
        const gate = previewOrBlock(config, p.dryRun, `REOPEN IMPORT FILE ${p.impfnum}`, {
          method: 'PATCH',
          endpoint: client.resolveEntityUrl('IMPFILES', p.impfnum),
          body,
          note: 'Procedure-gated: if Priority rejects the field write, run "ביטול סגירת תיק" in the screen. Then: fix → recalc → reclose → re-run תמחיר if needed.',
        });
        if (gate) return gate;
        const outcome = await verifyRecordUpdate(client, 'IMPFILES', p.impfnum, body);
        return textResult({
          reopened: outcome.verified,
          impfnum: p.impfnum,
          verifiedAfterWrite: outcome.verification.observed ?? null,
          expected: outcome.verification.expected,
          ...outcome,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
