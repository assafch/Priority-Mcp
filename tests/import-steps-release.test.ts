import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config.js';
import { registerGenericTools } from '../src/tools/generic.js';
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
 * bonded_release_draft opens a DRAFT release from the bonded warehouse and sets the quantities.
 * It is the only caller allowed through the stage lock, and only for a draft header and line
 * quantities: no request it sends ever carries a status.
 */
afterEach(() => vi.unstubAllGlobals());

/** A closed file with the whole quantity still in bond and no release yet. */
function closedWorld(): World {
  const world = openWorld();
  world.file.CLOSED = 'Y';
  world.file.STATDES = 'סופי';
  world.file.IMPFILEITEMS_SUBFORM = [
    { KLINE: 1, PARTNAME: 'P1', TQUANT: 10, TBALANCE: 10 },
    { KLINE: 2, PARTNAME: 'P2', TQUANT: 5, TBALANCE: 5 },
  ];
  world.file.IMPFILECUSTOMS_SUBFORM = [
    { PARTNAME: 'P1', COUNTRYNAME: 'DE' },
    { PARTNAME: 'P2', COUNTRYNAME: 'DE' },
  ];
  world.receipts.push({
    DOCNO: 'GR1',
    STATDES: 'סופית',
    TOWARHSNAME: 'BONDED',
    IVNUM: 'GI1',
    TRANSORDER_P_SUBFORM: [],
  });
  return world;
}
const draftRelease = (over: Row = {}): Row => ({
  DOCNO: 'BD7',
  TYPE: 'J',
  IMPFNUM: 'IM1',
  STATDES: 'טיוטא',
  CURDATE: '2026-01-20T00:00:00Z',
  UDATE: '2026-01-20T10:00:00Z',
  DOCREF: 'D1',
  IVNUM: null,
  TOWARHSNAME: 'Main',
  TOLOCNAME: '0',
  TRANSORDER_J_SUBFORM: [
    { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10 },
    { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 0 },
  ],
  ...over,
});

function setup(world: World, config: Config = testConfig) {
  serve(world);
  const ledgerPath = tempLedger();
  const h = toolHarness((s, c, cfg) => {
    registerImpfileStepTools(s, c, cfg, { ledgerPath });
    registerGenericTools(s, c, cfg);
  }, config);
  return { ...h, ledgerPath };
}
const RELEASE = { impfnum: 'IM1', date: '2026-01-20', declaration: 'D1' };
const RUN = { ...RELEASE, dryRun: false };
const posts = (world: World) => world.writes.filter((w) => w.method === 'POST');
const patches = (world: World) => world.writes.filter((w) => w.method === 'PATCH');
const LINE = (docno: string, kline: number) =>
  `DOCUMENTS_J(DOCNO='${docno}',TYPE='J')/TRANSORDER_J_SUBFORM(KLINE=${kline},TYPE='J')`;

describe('bonded_release_draft', () => {
  it('previews by default and sends nothing', async () => {
    const world = closedWorld();
    const r = await setup(world).call('bonded_release_draft', RELEASE);
    expect(r).toMatchObject({ status: 'preview', piloted: true });
    expect(r.wouldSend[0]).toMatchObject({ method: 'POST', body: { IMPFNUM: 'IM1' } });
    expect(world.writes).toEqual([]);
  });

  it('full release: one header with exactly seven fields, then every line quantity', async () => {
    const world = closedWorld();
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r).toMatchObject({
      status: 'done',
      verified: true,
      docno: 'BD1',
      documentStatus: 'טיוטא',
    });
    expect(r.nextStep).toMatch(/bonded_line_costs/);
    expect(posts(world)).toEqual([
      {
        method: 'POST',
        path: 'DOCUMENTS_J',
        body: {
          CURDATE: '2026-01-20',
          IMPFNUM: 'IM1',
          WARHSNAME: 'BONDED',
          LOCNAME: '0',
          TOWARHSNAME: 'Main',
          TOLOCNAME: '0',
          DOCREF: 'D1',
        },
      },
    ]);
    expect(patches(world).map((w) => [w.path, w.body])).toEqual([
      [LINE('BD1', 1), { TQUANT: 10 }],
      [LINE('BD1', 2), { TQUANT: 5 }],
    ]);
    expect(world.releases[0].STATDES).toBe('טיוטא');
  });

  it('partial release: only the listed parts get a quantity', async () => {
    const world = closedWorld();
    const r = await setup(world).call('bonded_release_draft', {
      ...RUN,
      quantities: [{ part: 'P1', qty: 4 }],
    });
    expect(r.status).toBe('done');
    expect(patches(world).map((w) => [w.path, w.body])).toEqual([[LINE('BD1', 1), { TQUANT: 4 }]]);
    expect(r.lines).toEqual([
      { part: 'P1', qty: 4, available: 10 },
      { part: 'P2', qty: 0, available: 5 },
    ]);
  });

  it('refuses a quantity above the balance, an unknown part and a duplicate', async () => {
    const world = closedWorld();
    const t = setup(world);
    const over = await t.call('bonded_release_draft', {
      ...RUN,
      quantities: [{ part: 'P1', qty: 11 }],
    });
    expect(over.status).toBe('refused');
    expect(over.reasons.join(' ')).toMatch(/P1.*11.*10/);
    const unknown = await t.call('bonded_release_draft', {
      ...RUN,
      quantities: [{ part: 'P9', qty: 1 }],
    });
    expect(unknown.reasons.join(' ')).toMatch(/P9/);
    const twice = await t.call('bonded_release_draft', {
      ...RUN,
      quantities: [
        { part: 'P1', qty: 1 },
        { part: 'P1', qty: 2 },
      ],
    });
    expect(twice.status).toBe('refused');
    expect(world.writes).toEqual([]);
  });

  it('refuses a file that is not closed', async () => {
    const world = closedWorld();
    world.file.CLOSED = null;
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/התיק אינו סגור/);
    expect(world.writes).toEqual([]);
  });

  it('continues an existing draft with the same declaration instead of a second one', async () => {
    const world = closedWorld();
    world.releases.push(draftRelease());
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r).toMatchObject({ status: 'done', docno: 'BD7' });
    expect(posts(world)).toEqual([]);
    expect(patches(world).map((w) => [w.path, w.body])).toEqual([[LINE('BD7', 2), { TQUANT: 5 }]]);
  });

  it('reports already-done when the draft already holds the requested quantities', async () => {
    const world = closedWorld();
    const full = draftRelease();
    (full.TRANSORDER_J_SUBFORM as Row[])[1].TQUANT = 5;
    world.releases.push(full);
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r).toMatchObject({ status: 'already-done', docno: 'BD7' });
    expect(world.writes).toEqual([]);
  });

  it('refuses when a draft with another declaration exists', async () => {
    const world = closedWorld();
    world.releases.push(draftRelease({ DOCREF: 'D9' }));
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/BD7/);
    expect(world.writes).toEqual([]);
  });

  it('after a failed line write the next call continues the same draft', async () => {
    const world = closedWorld();
    world.intercept = (method, path) =>
      method === 'PATCH' && path.includes('KLINE=2') ? priorityError(500, 'boom') : undefined;
    const t = setup(world);
    const first = await t.call('bonded_release_draft', RUN);
    expect(first).toMatchObject({ status: 'incomplete', docno: 'BD1', verified: false });
    world.intercept = undefined;
    const second = await t.call('bonded_release_draft', RUN);
    expect(second).toMatchObject({ status: 'done', docno: 'BD1' });
    expect(posts(world)).toHaveLength(1);
    expect(world.releases).toHaveLength(1);
  });

  it('refuses without a cost invoice, unless it is a partial release the caller allows', async () => {
    const world = closedWorld();
    (world.file.IMPFILEINV_SUBFORM as Row[]).pop(); // no cost invoice linked
    const t = setup(world);
    const refused = await t.call('bonded_release_draft', RUN);
    expect(refused.status).toBe('refused');
    expect(refused.reasons.join(' ')).toMatch(/חשבונית עלויות/);
    const fullAllowed = await t.call('bonded_release_draft', {
      ...RUN,
      allowWithoutCostInvoice: true,
    });
    expect(fullAllowed.status).toBe('refused');
    expect(fullAllowed.reasons.join(' ')).toMatch(/חלקי/);
    expect(world.writes).toEqual([]);
    const partial = await t.call('bonded_release_draft', {
      ...RUN,
      allowWithoutCostInvoice: true,
      quantities: [{ part: 'P1', qty: 4 }],
    });
    expect(partial.status).toBe('done');
  });

  it('reports unverified, never "no document", when the create gets no answer', async () => {
    const world = closedWorld();
    world.hang = (method, path) => method === 'POST' && path === 'DOCUMENTS_J';
    const t = setup(world);
    const first = await t.call('bonded_release_draft', RUN);
    expect(first.status).toBe('unverified');
    expect(first.verification.reason).not.toMatch(/לא נוצר מסמך/);
    world.hang = undefined;
    const second = await t.call('bonded_release_draft', RUN);
    expect(second.status).toBe('refused');
    expect(posts(world)).toHaveLength(1);
  });

  it('does not turn a draft with other quantities into the requested ones', async () => {
    const world = closedWorld();
    const partial = draftRelease();
    (partial.TRANSORDER_J_SUBFORM as Row[])[0].TQUANT = 4; // someone released only 4 of P1
    world.releases.push(partial);
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/BD7.*P1.*4/);
    expect(world.writes).toEqual([]);
  });

  it('does not continue a draft into another warehouse', async () => {
    const world = closedWorld();
    world.releases.push(draftRelease({ TOWARHSNAME: 'Other', TOLOCNAME: '0' }));
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/Other/);
    expect(world.writes).toEqual([]);
  });

  it('refuses a partial quantity for a part on several content lines before creating', async () => {
    const world = closedWorld();
    (world.file.IMPFILEITEMS_SUBFORM as Row[]).push({
      KLINE: 3,
      PARTNAME: 'P1',
      TQUANT: 2,
      TBALANCE: 2,
    });
    const r = await setup(world).call('bonded_release_draft', {
      ...RUN,
      quantities: [{ part: 'P1', qty: 4 }],
    });
    expect(r.status).toBe('refused');
    expect(r.reasons.join(' ')).toMatch(/P1.*שורות/);
    expect(world.writes).toEqual([]);
  });

  it('does not say done when the document does not carry what was asked', async () => {
    const world = closedWorld();
    world.intercept = (method, path, body) => {
      if (method !== 'POST' || path !== 'DOCUMENTS_J') return undefined;
      world.writes.push({ method, path, body: body ?? {} });
      world.releases.push(
        draftRelease({
          DOCNO: 'BD1',
          DOCREF: 'D-OTHER',
          TOWARHSNAME: 'Main',
          TOLOCNAME: '0',
          TRANSORDER_J_SUBFORM: [
            { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 0 },
            { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 0 },
          ],
        }),
      );
      return new Response(JSON.stringify({ DOCNO: 'BD1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r.status).toBe('incomplete');
    expect(r.verification.reason).toMatch(/D-OTHER/);
  });

  it('continues a release that appeared between the check and the create', async () => {
    const world = closedWorld();
    let listReads = 0;
    world.intercept = (method, path) => {
      const isList =
        method === 'GET' && path.startsWith('DOCUMENTS_J') && path.includes("IMPFNUM eq 'IM1'");
      if (isList && ++listReads === 2) {
        world.releases.push(
          draftRelease({
            DOCNO: 'BD9',
            TOWARHSNAME: 'Main',
            TOLOCNAME: '0',
            TRANSORDER_J_SUBFORM: [
              { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 0 },
              { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 0 },
            ],
          }),
        );
      }
      return undefined;
    };
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r).toMatchObject({ status: 'done', docno: 'BD9' });
    expect(posts(world)).toEqual([]);
    expect(world.releases).toHaveLength(1);
  });

  it('warns when the declaration differs from the file header, and still proceeds', async () => {
    const world = closedWorld();
    const r = await setup(world).call('bonded_release_draft', { ...RUN, declaration: 'D2' });
    expect(r.status).toBe('done');
    expect(r.warnings.join(' ')).toMatch(/D2.*D1|D1.*D2/);
    expect(posts(world)[0].body.DOCREF).toBe('D2');
  });

  it('stops as incomplete when the pulled lines are not the balance in bond', async () => {
    const world = closedWorld();
    world.intercept = (method, path, body) => {
      if (method !== 'POST' || path !== 'DOCUMENTS_J') return undefined;
      world.writes.push({ method, path, body: body ?? {} });
      world.releases.push(
        draftRelease({
          DOCNO: 'BD1',
          TRANSORDER_J_SUBFORM: [{ KLINE: 1, PARTNAME: 'P1', PQUANT: 7, TQUANT: 0 }],
        }),
      );
      return new Response(JSON.stringify({ DOCNO: 'BD1' }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    };
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r).toMatchObject({ status: 'incomplete', docno: 'BD1' });
    expect(r.verification.reason).toMatch(/P1|P2/);
    expect(patches(world)).toEqual([]);
  });

  it('ignores an empty VAT line Priority pulls from the content, with a warning (first pilot)', async () => {
    const world = closedWorld();
    (world.file.IMPFILEITEMS_SUBFORM as Row[]).push({
      KLINE: 3,
      PARTNAME: "מע'מ",
      TQUANT: 0,
      TBALANCE: 0,
    });
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r).toMatchObject({ status: 'done', verified: true, docno: 'BD1' });
    // The fake pulled the VAT line like Priority did; no quantity is written to it.
    expect((world.releases[0].TRANSORDER_J_SUBFORM as Row[]).map((l) => l.PARTNAME)).toEqual([
      'P1',
      'P2',
      "מע'מ",
    ]);
    expect(patches(world).map((w) => [w.path, w.body])).toEqual([
      [LINE('BD1', 1), { TQUANT: 10 }],
      [LINE('BD1', 2), { TQUANT: 5 }],
    ]);
    expect(r.warnings.join(' ')).toMatch(/מע'מ בכמות 0/);
  });

  it('a VAT line with a quantity still stops the release before any quantity is written', async () => {
    const world = closedWorld();
    (world.file.IMPFILEITEMS_SUBFORM as Row[]).push({
      KLINE: 3,
      PARTNAME: "מע'מ",
      TQUANT: 1,
      TBALANCE: 0,
    });
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r).toMatchObject({ status: 'incomplete', docno: 'BD1' });
    expect(r.verification.reason).toMatch(/מע'מ/);
    expect(patches(world)).toEqual([]);
  });

  it('a draft that holds the quantities and an empty VAT line is already done', async () => {
    const world = closedWorld();
    world.releases.push(
      draftRelease({
        TRANSORDER_J_SUBFORM: [
          { KLINE: 1, PARTNAME: 'P1', PQUANT: 10, TQUANT: 10 },
          { KLINE: 2, PARTNAME: 'P2', PQUANT: 5, TQUANT: 5 },
          { KLINE: 3, PARTNAME: "מע'מ", PQUANT: 0, TQUANT: 0 },
        ],
      }),
    );
    const r = await setup(world).call('bonded_release_draft', RUN);
    expect(r).toMatchObject({ status: 'already-done', docno: 'BD7' });
    expect(r.warnings.join(' ')).toMatch(/מע'מ/);
    expect(world.writes).toEqual([]);
  });

  it('creates nothing when the releases form answers with no rows at all', async () => {
    const world = closedWorld();
    world.releases.push(draftRelease());
    world.blind = ['DOCUMENTS_J']; // the draft exists, but every read comes back empty
    const t = setup(world);
    const r = await t.call('bonded_release_draft', RUN);
    expect(r.status).toBe('blocked');
    expect(r.reasons.join(' ')).toMatch(/DOCUMENTS_J/);
    expect(world.writes).toEqual([]);
    expect(world.releases).toHaveLength(1);
    // nothing was sent, so no cooldown: once reads work again the same draft is continued
    world.blind = undefined;
    const again = await t.call('bonded_release_draft', RUN);
    expect(again).toMatchObject({ status: 'done', docno: 'BD7' });
    expect(posts(world)).toEqual([]);
  });

  it('a blocked create leaves no cooldown: the next call creates the release', async () => {
    const world = closedWorld();
    world.blind = ['DOCUMENTS_J'];
    const t = setup(world);
    const r = await t.call('bonded_release_draft', RUN);
    expect(r.status).toBe('blocked');
    expect(world.writes).toEqual([]);
    world.blind = undefined;
    const again = await t.call('bonded_release_draft', RUN);
    expect(again).toMatchObject({ status: 'done', docno: 'BD1' });
    expect(posts(world)).toHaveLength(1);
  });

  it('refuses when the releases cannot be read, and sends nothing in read-only mode', async () => {
    const down = closedWorld();
    down.intercept = (method, path) =>
      method === 'GET' && path.startsWith('DOCUMENTS_J') ? priorityError(500, 'down') : undefined;
    const r = await setup(down).call('bonded_release_draft', RUN);
    expect(r.status).toBe('refused');
    expect(down.writes).toEqual([]);
    const world = closedWorld();
    const ro = await setup(world, { ...testConfig, priorityReadOnly: true } as Config).call(
      'bonded_release_draft',
      RUN,
    );
    expect(ro.status).toBe('blocked');
    expect(world.writes).toEqual([]);
  });

  it('never sends a status, a flag or a line with the header', async () => {
    const world = closedWorld();
    const t = setup(world);
    await t.call('bonded_release_draft', { ...RUN, quantities: [{ part: 'P2', qty: 5 }] });
    await t.call('bonded_release_draft', RUN);
    expect(world.writes.length).toBeGreaterThan(0);
    for (const w of world.writes) {
      const keys = Object.keys(w.body);
      expect(keys).not.toContain('STATDES');
      expect(keys).not.toContain('SETFLAG');
      expect(keys).not.toContain('FINAL');
      expect(keys.some((k) => k.endsWith('_SUBFORM'))).toBe(false);
    }
  });

  it('leaves the stage lock closed for everyone else', async () => {
    const world = closedWorld();
    const t = setup(world);
    const blocked = await t.call('priority_create_record', {
      form: 'DOCUMENTS_J',
      data: {
        CURDATE: '2026-01-20',
        IMPFNUM: 'IM1',
        WARHSNAME: 'BONDED',
        LOCNAME: '0',
        TOWARHSNAME: 'Main',
        TOLOCNAME: '0',
        DOCREF: 'D1',
      },
      confirm: true,
    });
    expect(blocked).toMatchObject({ status: 'blocked', rule: 'bonded-release' });
    expect(world.writes).toEqual([]);
    // …and it is still closed after the tool used its opening
    await t.call('bonded_release_draft', RUN);
    const after = await t.call('priority_create_record', {
      form: 'DOCUMENTS_J',
      data: { IMPFNUM: 'IM1' },
      confirm: true,
    });
    expect(after.status).toBe('blocked');
  });
});
