import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { claimStep, recordStep } from '../src/lib/step-ledger.js';
import { toolRegistry } from '../src/lib/tool-registry.js';
import { textResult } from '../src/lib/tool-result.js';
import { currentOperation } from '../src/runtime/operation-context.js';
import { registerImpfileStepTools } from '../src/tools/impfile-steps.js';
import {
  type Row,
  type World,
  openWorld,
  priorityError,
  serve,
  tempLedger,
  testConfig,
  toolHarness,
} from './import-world.js';

/**
 * pinvoice_set_declaration and bonded_receipt write ordinary rows over OData and leave drafts.
 * These tests pin what they send (and that a preview, a refusal and a repeat send nothing), that
 * a half-finished document is continued instead of duplicated, and that a failed read refuses.
 */
afterEach(() => vi.unstubAllGlobals());

function setup(world: World, config: Config = testConfig) {
  serve(world);
  const ledgerPath = tempLedger();
  const h = toolHarness((s, c, cfg) => registerImpfileStepTools(s, c, cfg, { ledgerPath }), config);
  const ledger = () =>
    readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Row);
  return { ...h, ledgerPath, ledger };
}
const readOnly = { ...testConfig, priorityReadOnly: true } as Config;
const linked = (world: World) => world.file.IMPFILEINV_SUBFORM as Row[];
const invoiceLines = (world: World) => world.pinvoices[0].PINVOICEITEMS_SUBFORM as Row[];

// ---------------------------------------------------------------- declaration

/** The goods invoice is still a draft (T1) and line 1 has no declaration yet. */
function draftInvoiceWorld(): World {
  const world = openWorld();
  linked(world)[0].IVNUM = 'T1';
  world.pinvoices = [
    {
      IVNUM: 'T1',
      DEBIT: 'D',
      IVTYPE: 'P',
      SUPNAME: 'S1',
      STATDES: 'טיוטא',
      IMPFNUM: 'IM1',
      CODE: 'EUR',
      TOTPRICE: 150,
      PINVOICEITEMS_SUBFORM: [
        { KLINE: 1, PARTNAME: 'P1', TQUANT: 10, CUSTOMSNUM: null, CUSTOMSDATE: null },
        {
          KLINE: 2,
          PARTNAME: 'P2',
          TQUANT: 5,
          CUSTOMSNUM: 'D1',
          CUSTOMSDATE: '2026-01-05T00:00:00Z',
        },
        // not products: the VAT-from-declaration line and a duplicate that was zeroed
        { KLINE: 3, PARTNAME: "מע'מ", TQUANT: 1, CUSTOMSNUM: null, CUSTOMSDATE: null },
        { KLINE: 4, PARTNAME: 'P1', TQUANT: 0, CUSTOMSNUM: null, CUSTOMSDATE: null },
      ],
    },
  ];
  return world;
}
const DECL = {
  impfnum: 'IM1',
  invoiceNumber: 'T1',
  declaration: 'D1',
  declarationDate: '2026-01-05',
};
const LINE1 = "PINVOICES(IVNUM='T1',DEBIT='D',IVTYPE='P')/PINVOICEITEMS_SUBFORM(KLINE=1)";

describe('pinvoice_set_declaration', () => {
  it('previews by default: sends nothing and lists the exact writes', async () => {
    const world = draftInvoiceWorld();
    const r = await setup(world).call('pinvoice_set_declaration', DECL);
    expect(r.status).toBe('preview');
    expect(world.writes).toEqual([]);
    expect(r.wouldSend).toEqual([
      {
        method: 'PATCH',
        endpoint: expect.stringContaining(LINE1),
        body: { CUSTOMSNUM: 'D1', CUSTOMSDATE: '2026-01-05' },
      },
    ]);
  });

  it('writes only the product lines that differ, then verifies by re-reading', async () => {
    const world = draftInvoiceWorld();
    const r = await setup(world).call('pinvoice_set_declaration', { ...DECL, dryRun: false });
    expect(r).toMatchObject({ status: 'done', verified: true });
    expect(world.writes).toEqual([
      { method: 'PATCH', path: LINE1, body: { CUSTOMSNUM: 'D1', CUSTOMSDATE: '2026-01-05' } },
    ]);
    expect(invoiceLines(world)[2].CUSTOMSNUM).toBeNull(); // the VAT line was not touched
    expect(invoiceLines(world)[3].CUSTOMSNUM).toBeNull(); // nor the zeroed duplicate
  });

  it('changes nothing on a second call', async () => {
    const world = draftInvoiceWorld();
    const t = setup(world);
    await t.call('pinvoice_set_declaration', { ...DECL, dryRun: false });
    world.writes.length = 0;
    const again = await t.call('pinvoice_set_declaration', { ...DECL, dryRun: false });
    expect(again.status).toBe('already-done');
    expect(world.writes).toEqual([]);
  });

  it('refuses when the file header carries another declaration, or none', async () => {
    const world = draftInvoiceWorld();
    const other = await setup(world).call('pinvoice_set_declaration', {
      ...DECL,
      declaration: 'D9',
      dryRun: false,
    });
    expect(other.status).toBe('refused');
    expect(other.reasons.join(' ')).toMatch(/impfile_update/);
    world.file.CUSTOMSNUM = null;
    const none = await setup(world).call('pinvoice_set_declaration', { ...DECL, dryRun: false });
    expect(none.status).toBe('refused');
    expect(world.writes).toEqual([]);
  });

  it('refuses an invoice that is already final', async () => {
    const world = openWorld();
    invoiceLines(world)[0].CUSTOMSNUM = null;
    const r = await setup(world).call('pinvoice_set_declaration', {
      ...DECL,
      invoiceNumber: 'GI1',
      dryRun: false,
    });
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/אינה טיוטה/);
    expect(world.writes).toEqual([]);
  });

  it('refuses an invoice that is not linked to the file, and a cost invoice', async () => {
    const world = draftInvoiceWorld();
    const t = setup(world);
    const unlinked = await t.call('pinvoice_set_declaration', {
      ...DECL,
      invoiceNumber: 'T9',
      dryRun: false,
    });
    expect(unlinked.status).toBe('refused');
    expect(unlinked.reasons.join(' ')).toMatch(/אינה מקושרת/);
    const costInvoice = await t.call('pinvoice_set_declaration', {
      ...DECL,
      invoiceNumber: 'GI2',
      dryRun: false,
    });
    expect(costInvoice.status).toBe('refused');
    expect(costInvoice.reasons.join(' ')).toMatch(/ספק הסחורה/);
    expect(world.writes).toEqual([]);
  });

  it('refuses a country it cannot check against the countries table', async () => {
    const world = draftInvoiceWorld();
    const r = await setup(world).call('pinvoice_set_declaration', {
      ...DECL,
      country: 'Germany',
      dryRun: false,
    });
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/ארץ המוצא/);
    expect(world.writes).toEqual([]);
  });

  it('writes a country that exists, on the file-view lines of the same products', async () => {
    const world = draftInvoiceWorld();
    world.countries = [{ COUNTRYNAME: 'Germany' }];
    const r = await setup(world).call('pinvoice_set_declaration', {
      ...DECL,
      country: 'Germany',
      dryRun: false,
    });
    expect(r.status).toBe('done');
    const countryWrites = world.writes.filter((w) => w.path.startsWith('IMPFILEIV('));
    expect(countryWrites.map((w) => [w.path, w.body])).toEqual([
      [
        "IMPFILEIV(IVNUM='T1',DEBIT='D',TYPE='P')/IMPFILEIVS_SUBFORM(KLINE=1)",
        { COUNTRYNAME: 'Germany' },
      ],
      [
        "IMPFILEIV(IVNUM='T1',DEBIT='D',TYPE='P')/IMPFILEIVS_SUBFORM(KLINE=2)",
        { COUNTRYNAME: 'Germany' },
      ],
    ]);
  });

  it('reports incomplete when a line write fails, and continues on the next call', async () => {
    const world = draftInvoiceWorld();
    invoiceLines(world)[1].CUSTOMSNUM = null; // two lines to write
    world.intercept = (method, path) =>
      method === 'PATCH' && path.includes('KLINE=2') ? priorityError(500, 'boom') : undefined;
    const t = setup(world);
    const first = await t.call('pinvoice_set_declaration', { ...DECL, dryRun: false });
    expect(first.status).toBe('incomplete');
    expect(first.verified).toBe(false);
    world.intercept = undefined;
    world.writes.length = 0;
    const second = await t.call('pinvoice_set_declaration', { ...DECL, dryRun: false });
    expect(second.status).toBe('done');
    expect(world.writes.map((w) => w.path)).toEqual([LINE1.replace('KLINE=1', 'KLINE=2')]);
  });

  it('refuses the country when the file-view lines of the invoice cannot be found', async () => {
    const world = draftInvoiceWorld();
    world.countries = [{ COUNTRYNAME: 'Germany' }];
    world.intercept = (method, path) =>
      method === 'GET' && path.startsWith('IMPFILEIV')
        ? new Response(JSON.stringify({ value: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : undefined;
    const r = await setup(world).call('pinvoice_set_declaration', {
      ...DECL,
      country: 'Germany',
      dryRun: false,
    });
    expect(r.status).toBe('refused');
    expect(world.writes).toEqual([]);
  });

  it('sends nothing when the attempt ledger cannot be written', async () => {
    const world = draftInvoiceWorld();
    serve(world);
    const file = join(mkdtempSync(join(tmpdir(), 'import-steps-')), 'a-file');
    writeFileSync(file, 'x');
    const h = toolHarness((s, c, cfg) =>
      registerImpfileStepTools(s, c, cfg, { ledgerPath: join(file, 'steps.jsonl') }),
    );
    const r = await h.call('pinvoice_set_declaration', { ...DECL, dryRun: false });
    expect(r.status).toBe('failed');
    expect(r.verification.reason).toMatch(/יומן/);
    expect(world.writes).toEqual([]);
  });

  it('sends nothing in read-only mode', async () => {
    const world = draftInvoiceWorld();
    const r = await setup(world, readOnly).call('pinvoice_set_declaration', {
      ...DECL,
      dryRun: false,
    });
    expect(r.status).toBe('blocked');
    expect(world.writes).toEqual([]);
  });

  it('refuses when the file cannot be read', async () => {
    const world = draftInvoiceWorld();
    world.intercept = (method, path) =>
      method === 'GET' && path.startsWith('IMPFILES') ? priorityError(500, 'down') : undefined;
    const r = await setup(world).call('pinvoice_set_declaration', { ...DECL, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/לא ניתן היה לקרוא/);
    expect(world.writes).toEqual([]);
  });

  it('says blocked, not "not found", when the invoices form answers with no rows', async () => {
    const world = draftInvoiceWorld();
    world.blind = ['PINVOICES'];
    const r = await setup(world).call('pinvoice_set_declaration', DECL);
    expect(r.status).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/PINVOICES/);
    expect(r.reasons.join(' ')).not.toMatch(/לא נמצאה/);
    expect(world.writes).toEqual([]);
  });

  it('still says "not found" when the form answers but the invoice is missing', async () => {
    const world = draftInvoiceWorld();
    world.pinvoices = [];
    const r = await setup(world).call('pinvoice_set_declaration', DECL);
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/לא נמצאה/);
  });

  it('is marked as piloted; the steps not yet piloted are not', async () => {
    const world = draftInvoiceWorld();
    const r = await setup(world).call('pinvoice_set_declaration', DECL);
    expect(r.piloted).toBe(true);
    const receipt = await setup(openWorld()).call('bonded_receipt', {
      impfnum: 'IM1',
      date: '2026-01-10',
    });
    expect(receipt.piloted).toBe(false);
  });
});

// -------------------------------------------------------------------- receipt

const RECEIPT = { impfnum: 'IM1', date: '2026-01-10' };
const posts = (world: World) => world.writes.filter((w) => w.method === 'POST');
const patches = (world: World) => world.writes.filter((w) => w.method === 'PATCH');
const NOW = Date.parse('2026-01-12T08:00:00Z');

describe('bonded_receipt', () => {
  it('previews by default and sends nothing', async () => {
    const world = openWorld();
    const r = await setup(world).call('bonded_receipt', RECEIPT);
    expect(r.status).toBe('preview');
    expect(world.writes).toEqual([]);
    expect(r.wouldSend[0]).toMatchObject({ method: 'POST', body: { IVNUM: 'GI1' } });
  });

  it('creates one draft header with exactly six fields, then sets each line quantity', async () => {
    const world = openWorld();
    const t = setup(world);
    const r = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r).toMatchObject({
      status: 'done',
      verified: true,
      docno: 'GR1',
      documentStatus: 'טיוטא',
      piloted: false,
    });
    expect(r.nextStep).toMatch(/סופית/);
    expect(posts(world)).toEqual([
      {
        method: 'POST',
        path: 'DOCUMENTS_P',
        body: {
          CURDATE: '2026-01-10',
          SUPNAME: 'S1',
          TOWARHSNAME: 'BONDED',
          TOLOCNAME: '0',
          IVNUM: 'GI1',
          CODE: 'EUR',
        },
      },
    ]);
    expect(patches(world).map((w) => [w.path, w.body])).toEqual([
      ["DOCUMENTS_P(DOCNO='GR1',TYPE='P')/TRANSORDER_P_SUBFORM(KLINE=1,TYPE='P')", { TQUANT: 10 }],
      ["DOCUMENTS_P(DOCNO='GR1',TYPE='P')/TRANSORDER_P_SUBFORM(KLINE=2,TYPE='P')", { TQUANT: 5 }],
    ]);
    expect(world.receipts[0].STATDES).toBe('טיוטא');
    expect(t.ledger().map((l) => l.phase)).toEqual(['in_flight', 'done']);
  });

  it('stops as incomplete when Priority pulled other lines than the invoice has', async () => {
    const world = openWorld({
      pulledReceiptLines: [{ KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 0 }],
    });
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r).toMatchObject({ status: 'incomplete', docno: 'GR1', verified: false });
    expect(r.verification.reason).toMatch(/P2/);
    expect(patches(world)).toEqual([]);
  });

  it('continues an existing draft receipt instead of creating a second one', async () => {
    const world = openWorld();
    world.receipts.push({
      DOCNO: 'GR7',
      TYPE: 'P',
      STATDES: 'טיוטא',
      TOWARHSNAME: 'BONDED',
      IVNUM: 'GI1',
      TOTPRICE: 150,
      TRANSORDER_P_SUBFORM: [
        { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10 },
        { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 0 },
      ],
    });
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r).toMatchObject({ status: 'done', docno: 'GR7' });
    expect(posts(world)).toEqual([]);
    expect(patches(world).map((w) => w.body)).toEqual([{ TQUANT: 5 }]);
  });

  it('reports a final receipt as already done and sends nothing', async () => {
    const world = openWorld();
    world.receipts.push({
      DOCNO: 'GR7',
      STATDES: 'סופית',
      TOWARHSNAME: 'BONDED',
      IVNUM: 'GI1',
      TOTPRICE: 150,
      TRANSORDER_P_SUBFORM: [],
    });
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r).toMatchObject({ status: 'already-done', docno: 'GR7' });
    expect(world.writes).toEqual([]);
  });

  it('after a failed line write the next call continues the same draft', async () => {
    const world = openWorld();
    world.intercept = (method, path) =>
      method === 'PATCH' && path.includes('KLINE=2') ? priorityError(500, 'boom') : undefined;
    const t = setup(world);
    const first = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(first).toMatchObject({ status: 'incomplete', docno: 'GR1' });
    world.intercept = undefined;
    const second = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(second).toMatchObject({ status: 'done', docno: 'GR1' });
    expect(posts(world)).toHaveLength(1);
    expect(world.receipts).toHaveLength(1);
  });

  it('reports unverified, never "no document", when the create gets no answer', async () => {
    const world = openWorld();
    world.hang = (method, path) => method === 'POST' && path === 'DOCUMENTS_P';
    const t = setup(world);
    const first = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(first.status).toBe('unverified');
    expect(first.verification.reason).not.toMatch(/לא נוצר מסמך/);
    expect(t.ledger().map((l) => l.phase)).toEqual(['in_flight', 'unverified']);
    world.hang = undefined;
    const second = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(second.status).toBe('refused');
    expect(posts(world)).toHaveLength(1);
  });

  it('does not overwrite a quantity that someone entered on an existing draft', async () => {
    const world = openWorld();
    world.receipts.push({
      DOCNO: 'GR7',
      TYPE: 'P',
      STATDES: 'טיוטא',
      TOWARHSNAME: 'BONDED',
      IVNUM: 'GI1',
      TOTPRICE: 150,
      TRANSORDER_P_SUBFORM: [
        { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 7 }, // a counted short shipment
        { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 0 },
      ],
    });
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/GR7.*P1.*7/);
    expect(world.writes).toEqual([]);
  });

  it('continues a receipt that appeared between the check and the create', async () => {
    const world = openWorld();
    let detailReads = 0;
    world.intercept = (method, path) => {
      const isDetailRead =
        method === 'GET' && path.startsWith('DOCUMENTS_P') && path.includes('TRANSORDER_P_SUBFORM');
      if (isDetailRead && ++detailReads === 2) {
        // another server created the draft after our first look
        world.receipts.push({
          DOCNO: 'GR9',
          TYPE: 'P',
          STATDES: 'טיוטא',
          TOWARHSNAME: 'BONDED',
          IVNUM: 'GI1',
          TOTPRICE: 150,
          TRANSORDER_P_SUBFORM: [
            { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 0 },
            { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 0 },
          ],
        });
      }
      return undefined;
    };
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r).toMatchObject({ status: 'done', docno: 'GR9' });
    expect(posts(world)).toEqual([]);
    expect(world.receipts).toHaveLength(1);
  });

  it('of two simultaneous calls only one creates the receipt', async () => {
    const world = openWorld();
    const t = setup(world);
    const results = await Promise.all([
      t.call('bonded_receipt', { ...RECEIPT, dryRun: false }),
      t.call('bonded_receipt', { ...RECEIPT, dryRun: false }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['done', 'refused']);
    expect(posts(world)).toHaveLength(1);
    expect(world.receipts).toHaveLength(1);
  });

  it('refuses while another process holds the claim for this step', async () => {
    const world = openWorld();
    const t = setup(world);
    expect(claimStep(t.ledgerPath, 'IM1', 'receipt').ok).toBe(true);
    const r = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('refused');
    expect(world.writes).toEqual([]);
  });

  it('does not say done when the new receipt is not a draft in BONDED', async () => {
    const world = openWorld();
    world.intercept = (method, path, body) => {
      if (method !== 'POST' || path !== 'DOCUMENTS_P') return undefined;
      world.writes.push({ method, path, body: body ?? {} });
      world.receipts.push({
        DOCNO: 'GR1',
        TYPE: 'P',
        STATDES: 'סופית',
        TOWARHSNAME: 'BONDED',
        IVNUM: 'GI1',
        TOTPRICE: 150,
        TRANSORDER_P_SUBFORM: [
          { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10 },
          { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 5 },
        ],
      });
      return new Response(JSON.stringify({ DOCNO: 'GR1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('incomplete');
    expect(r.verification.reason).toMatch(/סופית/);
  });

  it('keeps the outcome when the ledger fails after the create', async () => {
    const world = openWorld();
    const t = setup(world);
    world.intercept = (method, path) => {
      if (method === 'POST' && path === 'DOCUMENTS_P') {
        rmSync(t.ledgerPath, { force: true });
        mkdirSync(t.ledgerPath); // the ledger can no longer be appended to
      }
      return undefined;
    };
    const r = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r).toMatchObject({ status: 'done', docno: 'GR1' });
    expect(r.ledgerError).toBeTruthy();
  });

  it('refuses a file whose warehouse is not BONDED', async () => {
    const world = openWorld();
    world.file.WARHSNAME = 'Main';
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('refused');
    expect(world.writes).toEqual([]);
  });

  it('rejects a date in the future', async () => {
    const world = openWorld();
    serve(world);
    const h = toolHarness((s, c, cfg) =>
      registerImpfileStepTools(s, c, cfg, { ledgerPath: tempLedger(), now: () => NOW }),
    );
    const r = await h.call('bonded_receipt', { impfnum: 'IM1', date: '2026-01-14', dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/עתידי/);
    expect(world.writes).toEqual([]);
  });

  it('compares product lines only when the invoice also carries a carriage line', async () => {
    const world = openWorld();
    // part 000 is carriage billed on the goods invoice; Priority does not pull it into a receipt
    invoiceLines(world).push({ KLINE: 3, PARTNAME: '000', TQUANT: 1 });
    world.pinvoices[0].TOTPRICE = 180;
    world.intercept = (method, path, body) => {
      if (method !== 'POST' || path !== 'DOCUMENTS_P') return undefined;
      world.writes.push({ method, path, body: body ?? {} });
      world.receipts.push({
        DOCNO: 'GR1',
        TYPE: 'P',
        STATDES: 'טיוטא',
        TOWARHSNAME: 'BONDED',
        IVNUM: 'GI1',
        TOTPRICE: 150,
        TRANSORDER_P_SUBFORM: [
          { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 0 },
          { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 0 },
        ],
      });
      return new Response(JSON.stringify({ DOCNO: 'GR1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('done');
    expect(r.warnings.join(' ')).toMatch(/000/);
  });

  it('stops as incomplete when the receipt total differs from the invoice total', async () => {
    const world = openWorld();
    world.pinvoices[0].TOTPRICE = 150;
    world.receipts.push({
      DOCNO: 'GR7',
      TYPE: 'P',
      STATDES: 'טיוטא',
      TOWARHSNAME: 'BONDED',
      IVNUM: 'GI1',
      TOTPRICE: 140,
      TRANSORDER_P_SUBFORM: [
        { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10 },
        { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 5 },
      ],
    });
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r).toMatchObject({ status: 'incomplete', docno: 'GR7' });
    expect(r.verification.reason).toMatch(/140.*150|150.*140/);
  });

  it('creates nothing when the receipts form answers with no rows at all', async () => {
    const world = openWorld();
    world.receipts.push({
      DOCNO: 'GR7',
      TYPE: 'P',
      STATDES: 'טיוטא',
      TOWARHSNAME: 'BONDED',
      IVNUM: 'GI1',
      TOTPRICE: 150,
      TRANSORDER_P_SUBFORM: [
        { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10 },
        { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 0 },
      ],
    });
    world.blind = ['DOCUMENTS_P']; // the draft exists, but every read comes back empty
    const t = setup(world);
    const r = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/DOCUMENTS_P/);
    expect(world.writes).toEqual([]);
    expect(world.receipts).toHaveLength(1);
    // nothing was sent, so no cooldown: once reads work again the same draft is continued
    world.blind = undefined;
    const again = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(again).toMatchObject({ status: 'done', docno: 'GR7' });
    expect(posts(world)).toEqual([]);
  });

  it('a blocked create leaves no cooldown: the next call creates the receipt', async () => {
    const world = openWorld();
    world.blind = ['DOCUMENTS_P'];
    const t = setup(world);
    const r = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('blocked');
    expect(world.writes).toEqual([]);
    expect(t.ledger().map((l) => l.phase)).toEqual(['in_flight', 'failed']);
    world.blind = undefined;
    const again = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(again).toMatchObject({ status: 'done', docno: 'GR1' });
    expect(posts(world)).toHaveLength(1);
  });

  it('says blocked, not "not found", when the invoices form answers with no rows', async () => {
    const world = openWorld();
    world.blind = ['PINVOICES'];
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/PINVOICES/);
    expect(world.writes).toEqual([]);
  });

  it('refuses when the existing receipts cannot be read', async () => {
    const world = openWorld();
    world.intercept = (method, path) =>
      method === 'GET' && path.startsWith('DOCUMENTS_P') ? priorityError(500, 'down') : undefined;
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('refused');
    expect(world.writes).toEqual([]);
  });

  it('refuses when the file cannot be read, and sends nothing in read-only mode', async () => {
    const down = openWorld();
    down.intercept = (method, path) =>
      method === 'GET' && path.startsWith('IMPFILES') ? priorityError(500, 'down') : undefined;
    expect((await setup(down).call('bonded_receipt', { ...RECEIPT, dryRun: false })).status).toBe(
      'refused',
    );
    const world = openWorld();
    const r = await setup(world, readOnly).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('blocked');
    expect(world.writes).toEqual([]);
  });

  it('does not create a second receipt while an earlier create is unconfirmed', async () => {
    const world = openWorld();
    const t = setup(world);
    recordStep(t.ledgerPath, { impfnum: 'IM1', step: 'receipt', phase: 'in_flight' });
    const r = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/לא שולחים שוב/);
    expect(world.writes).toEqual([]);
  });

  it('reports unverified when the create fails ambiguously, and then waits', async () => {
    const world = openWorld();
    world.intercept = (method, path) =>
      method === 'POST' && path === 'DOCUMENTS_P' ? priorityError(500, 'gateway') : undefined;
    const t = setup(world);
    const first = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(first.status).toBe('unverified');
    world.intercept = undefined;
    const second = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(second.status).toBe('refused');
    expect(world.receipts).toEqual([]);
  });

  it('needs the invoice number when the file has two final goods invoices', async () => {
    const world = openWorld();
    linked(world).push({
      IVNUM: 'GI3',
      SUPNAME: 'S1',
      DEBIT: 'D',
      TYPE: 'P',
      IMPFILEIVS_SUBFORM: [{ KLINE: 1, PARTNAME: 'P3', TQUANT: 2, QPRICE: 20, CODE: 'EUR' }],
    });
    world.pinvoices.push({
      IVNUM: 'GI3',
      DEBIT: 'D',
      IVTYPE: 'P',
      SUPNAME: 'S1',
      STATDES: 'סופית',
      IMPFNUM: 'IM1',
      CODE: 'EUR',
      TOTPRICE: 20,
      PINVOICEITEMS_SUBFORM: [
        { KLINE: 1, PARTNAME: 'P3', TQUANT: 2, CUSTOMSNUM: 'D1', CUSTOMSDATE: null },
      ],
    });
    const t = setup(world);
    const ambiguous = await t.call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(ambiguous.status).toBe('refused');
    expect(ambiguous.reasons.join(' ')).toMatch(/GI1.*GI3/);
    const chosen = await t.call('bonded_receipt', {
      ...RECEIPT,
      invoiceNumber: 'GI3',
      dryRun: false,
    });
    expect(chosen).toMatchObject({ status: 'done', docno: 'GR1' });
    expect(posts(world)[0].body.IVNUM).toBe('GI3');
  });

  it('warns about goods lines without an import declaration but still receives', async () => {
    const world = openWorld();
    invoiceLines(world)[0].CUSTOMSNUM = null;
    const r = await setup(world).call('bonded_receipt', { ...RECEIPT, dryRun: false });
    expect(r.status).toBe('done');
    expect(r.warnings.join(' ')).toMatch(/הצהרת יבוא/);
  });
});

describe('time budget of the step tools', () => {
  it('gives a step tool three minutes instead of the interactive twenty seconds', async () => {
    const remaining = async (name: string) => {
      const server = new McpServer({ name: 'budget', version: '1' });
      toolRegistry(server, testConfig).tool(name, 'probe', {}, async () =>
        textResult({ remaining: (currentOperation()?.deadlineAt ?? 0) - Date.now() }),
      );
      const client = new Client({ name: 'budget-test', version: '1' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      await client.connect(ct);
      try {
        const result = await client.callTool({ name, arguments: {} });
        return (result.structuredContent as { remaining: number }).remaining;
      } finally {
        await client.close();
        await server.close();
      }
    };
    for (const tool of [
      'pinvoice_set_declaration',
      'bonded_receipt',
      'bonded_fill_detail',
      'impfile_run_calc',
      'bonded_release_draft',
      'bonded_line_costs',
    ]) {
      expect(await remaining(tool)).toBeGreaterThan(170_000);
    }
    expect(await remaining('impfile_get')).toBeLessThan(21_000);
  });
});
