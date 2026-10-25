import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PriorityClient } from '../src/client/priority-client.js';
import { computeLandedCost, preflight } from '../src/lib/impfiles-logic.js';
import { createOperation } from '../src/runtime/operation-context.js';
import { customerSnapshot } from '../src/services/customer-snapshot.js';
import { importDiagnosis } from '../src/services/import-diagnosis.js';
import { IMPFILE_SUBFORMS, normalizeSnapshot } from '../src/services/import-read.js';
import { orderDiagnosis } from '../src/services/order-diagnosis.js';
import { registerReadWorkflowTools } from '../src/tools/workflows.js';
import { config } from './runtime-fixture.js';

const budget = () => ({ maxRows: 100, maxPages: 10, deadlineAt: Date.now() + 20000 });
const context = (client: PriorityClient, overrides = {}) => ({
  ...createOperation('priority_customer_snapshot'),
  client,
  config: { ...config, ...overrides },
});
function fakeClient() {
  const get = vi.fn(async (form: string, key: string) =>
    form === 'CUSTOMERS' ? { CUSTNAME: key, CUSTDES: 'Fixture customer' } : { ORDNAME: key },
  );
  const list = vi.fn(async () => ({ value: [] }));
  const request = vi.fn(
    async () =>
      '<Schema><EntityType Name="DOCUMENTS_D"><Key><PropertyRef Name="DOCNO"/><PropertyRef Name="TYPE"/></Key><Property Name="DOCNO" Type="Edm.String"/><Property Name="TYPE" Type="Edm.String"/><Property Name="ORDNAME" Type="Edm.String"/><Property Name="AIRWAYBILL" Type="Edm.String"/></EntityType></Schema>',
  );
  return { client: { get, list, request } as unknown as PriorityClient, get, list, request };
}
const importRecord = () => ({
  IMPFNUM: 'IM1',
  SUPNAME: 'S1',
  CLOSED: '',
  ...Object.fromEntries(IMPFILE_SUBFORMS.map(({ subform }) => [subform, []])),
  IMPFILEINV_SUBFORM: [
    {
      SUPNAME: 'S1',
      TOTPRICE: 100,
      DISPRICE: 100,
      DEBIT: 'D',
      STORNOFLAG: '',
      CODE: 'USD',
      FINAL: 'Y',
    },
  ],
  IMPFILEITEMS_SUBFORM: [{ PARTNAME: 'P1', TQUANT: 2, WEIGHT: 1 }],
  IMPFILECUSTOMS_SUBFORM: [
    {
      PARTNAME: 'P1',
      TQUANT: 2,
      PRICE: 100,
      CUSTOMS: 0,
      COUNTRYNAME: 'fixture',
      CUSTOMSITEMNAME: 'fixture',
    },
  ],
});
afterEach(() => vi.restoreAllMocks());

describe('evidence-backed bounded read workflows', () => {
  it('preserves component policy and never falls back to generic reads for blocked balance', async () => {
    const { client, get, list } = fakeClient();
    const result = await customerSnapshot(
      { customerId: 'C1', budget: budget() },
      context(client, { priorityBlockedTools: ['priority_get_customer_balance'] }),
    );
    expect(result.identity).toEqual({ form: 'CUSTOMERS', keys: { CUSTNAME: 'C1' } });
    expect(result.sections.balance.status).toBe('blocked');
    expect(result.sections.identity.status).toBe('available');
    expect(list.mock.calls.some((call) => call[0] === 'OBLIGO')).toBe(false);
    expect(get.mock.calls[0][3]).toMatchObject({ cache: false });
  });

  it('preserves a successful identity when invoices fail and records provenance for every section', async () => {
    const { client, list } = fakeClient();
    list.mockImplementation(async (form) => {
      if (form === 'AINVOICES') throw new Error('offline failure');
      return { value: [] };
    });
    const result = await customerSnapshot(
      { customerId: 'C1', sections: ['invoices'], budget: budget() },
      context(client),
    );
    expect(result.sections.identity.status).toBe('available');
    expect(result.sections.invoices.status).toBe('failed');
    expect(result.meta.complete).toBe(false);
    expect(result.sections.identity.meta).toMatchObject({
      source: 'Priority:CUSTOMERS',
      freshness: 'live',
      complete: true,
      nextCursor: null,
    });
    expect(result.sections.invoices.meta.observedAt).toBeNull();
    expect(result.sections.identity.meta.traceId).toBe(result.meta.traceId);
  });

  it('starts dependent reads only after exact identity verification and overlaps independent components', async () => {
    const { client, get, list } = fakeClient();
    let identityDone = false;
    let active = 0;
    let peak = 0;
    get.mockImplementation(async (_form, key) => {
      await new Promise((r) => setTimeout(r, 5));
      identityDone = true;
      return { CUSTNAME: key };
    });
    list.mockImplementation(async () => {
      expect(identityDone).toBe(true);
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return { value: [] };
    });
    await customerSnapshot({ customerId: 'C1', budget: budget() }, context(client));
    expect(peak).toBe(3);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('requires explicit identity and never selects a similar-name candidate or reads dependents after mismatch', async () => {
    const { client, get, list } = fakeClient();
    get.mockResolvedValue({ CUSTNAME: 'OTHER' });
    const result = await customerSnapshot({ customerId: 'C1', budget: budget() }, context(client));
    expect(result.identity).toBeNull();
    expect(result.sections.identity.status).toBe('failed');
    expect(list).not.toHaveBeenCalled();
    await expect(
      customerSnapshot({ customerId: '', budget: budget() }, context(client)),
    ).rejects.toThrow(/exact/i);
  });

  it('does not convert absent balance fields or ledger amounts into bank receipt evidence', async () => {
    const { client, list } = fakeClient();
    list.mockResolvedValue({ value: [{ CUSTNAME: 'C1', CREDIT: 20, CODE: 'ILS' }] });
    const result = await customerSnapshot(
      { customerId: 'C1', sections: ['balance'], budget: budget() },
      context(client),
    );
    expect(result.sections.balance.status).toBe('incomplete');
    expect(result.sections.balance.data).toMatchObject({
      balance: 20,
      creditLimit: null,
      availableCredit: null,
    });
    expect(result.sections.balance.meta.warnings.join(' ')).toMatch(/bank|clearing/i);
  });

  it('distinguishes a shipment label from delivery and missing shipment source from verified empty', async () => {
    const { client, list } = fakeClient();
    list.mockImplementation(async (_form, query) => ({
      value: query?.includes('$skip=')
        ? []
        : [{ ORDNAME: 'O1', DOCNO: 'D1', TYPE: 'D', AIRWAYBILL: 'LABEL1' }],
    }));
    const result = await orderDiagnosis({ orderNumber: 'O1', budget: budget() }, context(client));
    expect(result.sections.shipments.data).toMatchObject({
      deliveryVerified: false,
      erpDocuments: [{ AIRWAYBILL: 'LABEL1' }],
      directLinkCoverageComplete: true,
    });
    expect(result.sections.shipments.status).toBe('incomplete');
    expect(result.sections.shipments.meta.warnings.join(' ')).toMatch(/carrier|delivery/i);
    const missing = fakeClient();
    missing.request.mockRejectedValue(new Error('Source metadata unavailable'));
    const unknown = await orderDiagnosis(
      { orderNumber: 'O1', budget: budget() },
      context(missing.client),
    );
    expect(unknown.sections.shipments.status).toBe('incomplete');
    expect(unknown.sections.shipments.data).not.toHaveProperty('shipments');
  });

  it('loads one import snapshot for all checks and preserves existing complete-source calculations', async () => {
    const { client, get } = fakeClient();
    const raw = importRecord();
    get.mockResolvedValue(raw);
    const result = await importDiagnosis({ impfnum: 'IM1', budget: budget() }, context(client));
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][3]).toMatchObject({ cache: false });
    const normalized = normalizeSnapshot(raw);
    expect(result.sections.preflight.data).toEqual(preflight(normalized));
    expect(result.sections.landedCost.data).toEqual(computeLandedCost(normalized));
    expect(result.sections.snapshot.status).toBe('available');
  });

  it('enforces impfile_get AND per-calculation policy without issuing duplicate snapshots', async () => {
    const first = fakeClient();
    first.get.mockResolvedValue(importRecord());
    const result = await importDiagnosis(
      { impfnum: 'IM1', budget: budget() },
      context(first.client, { priorityBlockedTools: ['impfile_landed_cost'] }),
    );
    expect(result.sections.landedCost.status).toBe('blocked');
    expect(result.sections.preflight.status).toBe('available');
    expect(first.get).toHaveBeenCalledTimes(1);
    const blocked = fakeClient();
    const denied = await importDiagnosis(
      { impfnum: 'IM1', budget: budget() },
      context(blocked.client, { priorityBlockedTools: ['impfile_get'] }),
    );
    expect(denied.identity).toBeNull();
    expect(Object.values(denied.sections).every((section) => section.status === 'blocked')).toBe(
      true,
    );
    expect(blocked.get).not.toHaveBeenCalled();
  });

  it('never feeds unknown, missing or budget-truncated import subforms to financial calculators', async () => {
    const absent = fakeClient();
    absent.get.mockResolvedValue({ IMPFNUM: 'IM1', SUPNAME: 'S1' });
    const result = await importDiagnosis(
      { impfnum: 'IM1', budget: budget() },
      context(absent.client),
    );
    expect(result.sections.snapshot.data).toMatchObject({ derived: null });
    expect(result.sections.preflight.status).toBe('incomplete');
    expect(result.sections.preflight.data).toBeUndefined();
    expect(result.sections.landedCost.status).toBe('incomplete');
    const oversized = fakeClient();
    const raw = importRecord();
    raw.IMPFILEITEMS_SUBFORM = Array.from({ length: 20 }, () => ({ PARTNAME: 'P1', TQUANT: 1 }));
    oversized.get.mockResolvedValue(raw);
    const truncated = await importDiagnosis(
      { impfnum: 'IM1', budget: { ...budget(), maxRows: 10 } },
      context(oversized.client),
    );
    expect(truncated.sections.snapshot.status).toBe('incomplete');
    expect(truncated.sections.landedCost.data).toBeUndefined();
    expect(truncated.meta.complete).toBe(false);
  });

  it('keeps an unknown import valuation unavailable rather than turning a missing numeric field into zero', async () => {
    const { client, get } = fakeClient();
    const raw = importRecord();
    Reflect.deleteProperty(raw.IMPFILECUSTOMS_SUBFORM[0], 'PRICE');
    get.mockResolvedValue(raw);
    const result = await importDiagnosis({ impfnum: 'IM1', budget: budget() }, context(client));
    expect(result.sections.landedCost.status).toBe('incomplete');
    expect(result.sections.landedCost.data).toBeUndefined();
    expect(result.sections.landedCost.meta.warnings.join(' ')).toMatch(/field|valuation/i);
  });

  it('shares bounded row/page/deadline budgets across components without extra backend reads', async () => {
    const { client, get, list } = fakeClient();
    const result = await customerSnapshot(
      { customerId: 'C1', budget: { ...budget(), maxRows: 1, maxPages: 1 } },
      context(client),
    );
    expect(get).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(result.sections.orders.status).toBe('incomplete');
    expect(result.sections.invoices.status).toBe('incomplete');
    expect(result.meta.complete).toBe(false);
  });

  it('rejects null invoice status flags and unknown duplicate quantity contributions', async () => {
    const nullFlags = fakeClient();
    const raw = importRecord();
    Object.assign(raw.IMPFILEINV_SUBFORM[0], { DEBIT: null, STORNOFLAG: null });
    nullFlags.get.mockResolvedValue(raw);
    const status = await importDiagnosis(
      { impfnum: 'IM1', sections: ['preflight'], budget: budget() },
      context(nullFlags.client),
    );
    expect(status.sections.preflight.status).toBe('incomplete');
    expect(status.sections.preflight.data).toBeUndefined();
    const missingQty = fakeClient();
    const duplicate = importRecord();
    duplicate.IMPFILEITEMS_SUBFORM.push({ PARTNAME: 'P1' } as never);
    missingQty.get.mockResolvedValue(duplicate);
    const cost = await importDiagnosis(
      { impfnum: 'IM1', sections: ['landedCost'], budget: budget() },
      context(missingQty.client),
    );
    expect(cost.sections.landedCost.status).toBe('incomplete');
    expect(cost.sections.landedCost.data).toBeUndefined();
  });

  it('keeps missing invoice currency/value and customs duty unknown in snapshot derivations', async () => {
    const { client, get } = fakeClient();
    const raw = importRecord();
    Reflect.deleteProperty(raw.IMPFILEINV_SUBFORM[0], 'TOTPRICE');
    Reflect.deleteProperty(raw.IMPFILECUSTOMS_SUBFORM[0], 'CUSTOMS');
    get.mockResolvedValue(raw);
    const result = await importDiagnosis({ impfnum: 'IM1', budget: budget() }, context(client));
    expect(result.sections.snapshot.status).toBe('incomplete');
    expect(result.sections.snapshot.data).toMatchObject({ derived: null });
    expect(result.sections.preflight.status).toBe('incomplete');
  });

  it('does not infer tenant duty exemption from absent customs classification', async () => {
    const { client, get } = fakeClient();
    const raw = importRecord();
    Reflect.deleteProperty(raw.IMPFILECUSTOMS_SUBFORM[0], 'CUSTOMSITEMNAME');
    get.mockResolvedValue(raw);
    const result = await importDiagnosis(
      { impfnum: 'IM1', sections: ['preflight'], budget: budget() },
      context(client),
    );
    expect(result.sections.preflight.status).toBe('incomplete');
    expect(JSON.stringify(result)).not.toContain('All parts are duty-free');
    expect(result.sections.preflight.meta.warnings.join(' ')).toMatch(/classification|exemption/);
  });

  it('includes explicitly requested bounded order lines and preserves shipment-only defaults', async () => {
    const { client, get } = fakeClient();
    get.mockImplementation(async (_form, key, query) =>
      query?.includes('ORDERITEMS_SUBFORM')
        ? { ORDNAME: key, ORDERITEMS_SUBFORM: [{ PARTNAME: 'P1', TQUANT: 2 }] }
        : { ORDNAME: key },
    );
    const result = await orderDiagnosis(
      { orderNumber: 'O1', sections: ['lines', 'shipments'], budget: budget() },
      context(client),
    );
    expect(result.sections.lines.status).toBe('available');
    expect(result.sections.lines.data).toMatchObject({ rows: [{ PARTNAME: 'P1', TQUANT: 2 }] });
    expect(result.sections.lines.meta.source).toBe('Priority:ORDERS/ORDERITEMS_SUBFORM');
    const explicit = await orderDiagnosis(
      { orderNumber: 'O1', sections: ['shipments'], budget: budget() },
      context(client),
    );
    expect(explicit.sections).not.toHaveProperty('lines');
    const defaultSections = await orderDiagnosis(
      { orderNumber: 'O1', budget: budget() },
      context(client),
    );
    expect(defaultSections.sections).not.toHaveProperty('lines');
    expect(defaultSections.meta.complete).toBe(explicit.meta.complete);
    const absent = fakeClient();
    const missing = await orderDiagnosis(
      { orderNumber: 'O1', sections: ['lines'], budget: budget() },
      context(absent.client),
    );
    expect(missing.sections.lines.status).toBe('incomplete');
    expect(missing.sections.lines.data).toBeUndefined();
  });

  it('registers explicit-key workflows with bounded JSON summaries', async () => {
    const { client: backend } = fakeClient();
    const server = new McpServer({ name: 'workflow-test', version: '1' });
    registerReadWorkflowTools(server, backend, config);
    const client = new Client({ name: 'workflow-client', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const result = await client.callTool({
        name: 'priority_customer_snapshot',
        arguments: { customerId: 'C1', sections: ['orders'] },
      });
      expect(result.isError).not.toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text.length).toBeLessThanOrEqual(8000);
      expect(JSON.parse(text)).toEqual(result.structuredContent);
      expect(result.structuredContent).toHaveProperty('identity');
    } finally {
      await client.close();
      await server.close();
    }
  });
});
