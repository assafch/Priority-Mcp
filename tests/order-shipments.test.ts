import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { PriorityError } from '../src/client/errors.js';
import type { PriorityClient } from '../src/client/priority-client.js';
import { createOperation } from '../src/runtime/operation-context.js';
import { orderDiagnosis } from '../src/services/order-diagnosis.js';
import { registerOrderTools } from '../src/tools/orders.js';
import { config } from './runtime-fixture.js';

const budget = () => ({ maxRows: 10, maxPages: 5, deadlineAt: Date.now() + 20000 });
function fixture(
  options: { declared?: boolean; metadataFailure?: boolean; wrongOrder?: boolean } = {},
) {
  const dataCalls: string[] = [];
  const metadataCalls: string[] = [];
  const parent = `<Schema Namespace="Priority"><EntityType Name="ORDERS"><Key><PropertyRef Name="ORDNAME"/></Key><Property Name="ORDNAME" Type="Edm.String"/><Property Name="ORDSTATUSDES" Type="Edm.String"/><NavigationProperty Name="ORDERITEMS_SUBFORM" Type="Collection(Priority.ORDERITEMS)"/>${options.declared ? '<NavigationProperty Name="SHIPMENTS_SUBFORM" Type="Collection(Priority.ORDER_SHIPMENTS)"/>' : ''}</EntityType></Schema>`;
  const client = {
    request: async (path: string) => {
      metadataCalls.push(path);
      if (options.metadataFailure) throw new PriorityError('Unavailable metadata', 503);
      return parent;
    },
    get: async (_form: string, key: string, query = '') => {
      dataCalls.push(query);
      if (query.includes('SHIPMENTS_SUBFORM'))
        throw new PriorityError('Could not find property SHIPMENTS_SUBFORM', 400);
      return { ORDNAME: options.wrongOrder ? 'OTHER' : key, ORDSTATUSDES: 'Open' };
    },
  } as unknown as PriorityClient;
  return { client, dataCalls, metadataCalls };
}
const ctx = (client: PriorityClient, blocked: string[] = []) => ({
  ...createOperation('priority_order_diagnosis'),
  client,
  config: { ...config, priorityBlockedTools: blocked },
});
function legacy(client: PriorityClient, blocked: string[] = []) {
  const handlers = new Map<
    string,
    (params: { orderNumber: string }) => Promise<{ content: Array<{ text: string }> }>
  >();
  const server = {
    tool: (
      name: string,
      _description: string,
      _schema: unknown,
      handler: (params: { orderNumber: string }) => Promise<{ content: Array<{ text: string }> }>,
    ) => handlers.set(name, handler),
  } as unknown as McpServer;
  registerOrderTools(server, client, { ...config, priorityBlockedTools: blocked });
  return async () => {
    const handler = handlers.get('priority_get_order_shipment_status');
    if (!handler) throw new Error('Missing shipment handler');
    return JSON.parse((await handler({ orderNumber: 'O1' })).content[0].text);
  };
}
describe('metadata-verified order shipment sources', () => {
  it('does not expand an undeclared shipment source and returns unknown rather than an empty shipment list', async () => {
    const backend = fixture();
    const result = await orderDiagnosis(
      { orderNumber: 'O1', budget: budget() },
      ctx(backend.client),
    );
    expect(result.sections.identity.status).toBe('available');
    expect(result.sections.shipments.status).toBe('incomplete');
    expect(result.sections.shipments.data).toMatchObject({ deliveryVerified: false });
    expect(result.sections.shipments.data).not.toHaveProperty('shipments');
    expect(backend.dataCalls.some((query) => query.includes('SHIPMENTS_SUBFORM'))).toBe(false);
    expect(result.sections.shipments.meta.warnings.join(' ')).toMatch(/source|metadata|declared/i);
  });
  it('the legacy shipment tool shares the safe unknown-source behavior', async () => {
    const backend = fixture();
    const result = await legacy(backend.client)();
    expect(result.deliveryVerified).toBe(false);
    expect(result).not.toHaveProperty('shipments');
    expect(result.meta.complete).toBe(false);
    expect(backend.dataCalls.some((query) => query.includes('SHIPMENTS_SUBFORM'))).toBe(false);
  });
  it('a blocked shipment component performs no source metadata or shipment reads', async () => {
    const backend = fixture();
    const result = await orderDiagnosis(
      { orderNumber: 'O1', budget: budget() },
      ctx(backend.client, ['priority_get_order_shipment_status']),
    );
    expect(result.sections.shipments.status).toBe('blocked');
    expect(backend.metadataCalls).toHaveLength(0);
    expect(backend.dataCalls).toHaveLength(1);
    const standalone = fixture();
    const standaloneResult = await legacy(standalone.client, [
      'priority_get_order_shipment_status',
    ])();
    expect(standaloneResult.meta.complete).toBe(false);
    expect(standalone.dataCalls).toHaveLength(0);
    expect(standalone.metadataCalls).toHaveLength(0);
  });
  it('unavailable schema remains explicit unknown and never triggers a guessed expansion', async () => {
    const backend = fixture({ metadataFailure: true });
    const result = await orderDiagnosis(
      { orderNumber: 'O1', budget: budget() },
      ctx(backend.client),
    );
    expect(result.sections.shipments.status).toBe('incomplete');
    expect(result.sections.shipments.data).toMatchObject({ deliveryVerified: false });
    expect(backend.dataCalls).toHaveLength(1);
  });
  it('an unverified order identity prevents metadata and every dependent source read', async () => {
    const backend = fixture({ wrongOrder: true });
    const result = await orderDiagnosis(
      { orderNumber: 'O1', budget: budget() },
      ctx(backend.client),
    );
    expect(result.identity).toBeNull();
    expect(backend.metadataCalls).toHaveLength(0);
    expect(backend.dataCalls).toHaveLength(1);
  });
});

function documentFixture(
  options: {
    badOrder?: boolean;
    missingKey?: boolean;
    rows?: number;
    nextLoop?: boolean;
    orderNumber?: string;
  } = {},
) {
  const calls: Array<{ form: string; query: string }> = [];
  const metadataCalls: string[] = [];
  const rows = Array.from({ length: options.rows ?? 5 }, (_, i) => ({
    DOCNO: `D${i}`,
    TYPE: i === 1 ? 'R' : 'D',
    ORDNAME: options.badOrder && i === 0 ? 'OTHER' : (options.orderNumber ?? 'O1'),
    CURDATE: '2026-10-25T00:00:00Z',
    STATDES: 'סופית',
    AIRWAYBILL: `LABEL-${i}`,
    PRIVATE_NOTE: 'Unrelated source detail',
  }));
  if (options.missingKey) Reflect.deleteProperty(rows[0], 'TYPE');
  const metadata =
    '<Schema><EntityType Name="DOCUMENTS_D"><Key><PropertyRef Name="DOCNO"/><PropertyRef Name="TYPE"/></Key><Property Name="DOCNO" Type="Edm.String"/><Property Name="TYPE" Type="Edm.String"/><Property Name="ORDNAME" Type="Edm.String"/><Property Name="CURDATE" Type="Edm.DateTimeOffset"/><Property Name="STATDES" Type="Edm.String"/><Property Name="AIRWAYBILL" Type="Edm.String"/></EntityType></Schema>';
  const list = async (form: string, query = '') => {
    calls.push({ form, query: decodeURIComponent(query) });
    const params = new URLSearchParams(query.replace(/^\?/, ''));
    expect(form).toBe('DOCUMENTS_D');
    expect(params.get('$filter')).toBe(
      `ORDNAME eq '${(options.orderNumber ?? 'O1').replace(/'/g, "''")}'`,
    );
    const skip = Number(params.get('$skip') ?? 0);
    return {
      value: rows.slice(skip, skip + Math.min(2, Number(params.get('$top') ?? 500))),
      ...(options.nextLoop ? { '@odata.nextLink': 'DOCUMENTS_D?$skiptoken=repeat' } : {}),
    };
  };
  const client = {
    request: async (path: string) => {
      metadataCalls.push(path);
      if (path !== "GetMetadataFor(entity='DOCUMENTS_D')")
        throw new Error('Unnecessary or guessed metadata source');
      return metadata;
    },
    get: async (_form: string, key: string, query = '') => {
      if (query.includes('SHIPMENTS_SUBFORM')) throw new PriorityError('Unknown source', 400);
      return { ORDNAME: key, ORDSTATUSDES: 'Open' };
    },
    list,
    listNext: async (_link: string) => ({
      value: [rows[0]],
      '@odata.nextLink': 'DOCUMENTS_D?$skiptoken=repeat',
    }),
  } as unknown as PriorityClient;
  return { client, calls, metadataCalls };
}
it('reads metadata-verified direct order documents with full-key ordering, short pages and truthful ERP scope', async () => {
  const backend = documentFixture();
  const result = await orderDiagnosis({ orderNumber: 'O1', budget: budget() }, ctx(backend.client));
  const data = result.sections.shipments.data as {
    erpDocuments: unknown[];
    deliveryVerified: boolean;
    coverageScope: string;
  };
  expect(data.erpDocuments).toHaveLength(5);
  expect(data.deliveryVerified).toBe(false);
  expect(data.coverageScope).toMatch(/ORDNAME/);
  expect(result.sections.shipments.meta.warnings.join(' ')).toMatch(/carrier/);
  expect(result.sections.shipments.meta.warnings.join(' ')).toMatch(/multi.order|linked/i);
  expect(backend.metadataCalls).toEqual(["GetMetadataFor(entity='DOCUMENTS_D')"]);
  expect(backend.calls.map((call) => new URLSearchParams(call.query).get('$skip') ?? '0')).toEqual([
    '0',
    '2',
    '4',
    '5',
  ]);
  for (const call of backend.calls) {
    const query = new URLSearchParams(call.query);
    expect(query.get('$orderby')).toBe('DOCNO asc,TYPE asc');
    expect(query.get('$select')?.split(',')).toEqual(
      expect.arrayContaining(['DOCNO', 'TYPE', 'ORDNAME']),
    );
  }
});
it('a linked document with a different order or absent full key is suppressed and cannot establish completeness', async () => {
  for (const options of [{ badOrder: true }, { missingKey: true }]) {
    const backend = documentFixture(options);
    const result = await orderDiagnosis(
      { orderNumber: 'O1', budget: budget() },
      ctx(backend.client),
    );
    const data = result.sections.shipments.data as {
      erpDocuments: Array<{ ORDNAME: string; TYPE?: string }>;
    };
    expect(result.sections.shipments.status).toBe('incomplete');
    expect(data.erpDocuments).toHaveLength(4);
    expect(data.erpDocuments.every((row) => row.ORDNAME === 'O1' && row.TYPE !== undefined)).toBe(
      true,
    );
  }
});
it('shipment document row and page budgets are exact and never imply carrier delivery', async () => {
  const backend = documentFixture({ rows: 10 });
  const result = await orderDiagnosis(
    { orderNumber: 'O1', budget: { ...budget(), maxRows: 4 } },
    ctx(backend.client),
  );
  const data = result.sections.shipments.data as {
    erpDocuments: unknown[];
    deliveryVerified: boolean;
  };
  expect(data.erpDocuments).toHaveLength(3);
  expect(result.sections.shipments.status).toBe('incomplete');
  expect(data.deliveryVerified).toBe(false);
  const limited = documentFixture({ rows: 10 });
  const pages = await orderDiagnosis(
    { orderNumber: 'O1', budget: { ...budget(), maxPages: 2 } },
    ctx(limited.client),
  );
  expect(limited.calls).toHaveLength(1);
  expect(pages.sections.shipments.status).toBe('incomplete');
});
it('a direct-document continuation loop stays partial and never falls back to an unrelated source', async () => {
  const backend = documentFixture({ nextLoop: true });
  const result = await orderDiagnosis({ orderNumber: 'O1', budget: budget() }, ctx(backend.client));
  expect(result.sections.shipments.status).toBe('incomplete');
  expect(result.sections.shipments.meta.warnings.join(' ')).toMatch(/loop|continuation/i);
  expect(backend.calls.every((call) => call.form === 'DOCUMENTS_D')).toBe(true);
});

it('keeps date-shaped order identifiers quoted and suppresses fields outside the verified projection', async () => {
  const orderNumber = '2026-10-25T00:00:00Z';
  const backend = documentFixture({ orderNumber });
  const result = await orderDiagnosis({ orderNumber, budget: budget() }, ctx(backend.client));
  const data = result.sections.shipments.data as { erpDocuments: Array<Record<string, unknown>> };
  expect(data.erpDocuments).toHaveLength(5);
  expect(data.erpDocuments.every((row) => !('PRIVATE_NOTE' in row))).toBe(true);
  expect(new URLSearchParams(backend.calls[0].query).get('$filter')).toBe(
    "ORDNAME eq '2026-10-25T00:00:00Z'",
  );
});
it('an exhausted direct-order source remains a verified empty direct relation and an incomplete overall shipment history', async () => {
  const backend = documentFixture({ rows: 0 });
  const result = await orderDiagnosis({ orderNumber: 'O1', budget: budget() }, ctx(backend.client));
  expect(result.sections.shipments.status).toBe('incomplete');
  expect(result.sections.shipments.data).toMatchObject({
    erpDocuments: [],
    shipments: [],
    directLinkCoverageComplete: true,
    deliveryVerified: false,
  });
  expect(result.meta.complete).toBe(false);
});

it('never follows a continuation into another form even when a returned row could look order-related', async () => {
  const backend = documentFixture({ rows: 1 });
  const initial = backend.client.list.bind(backend.client);
  backend.client.list = async (form, query, options) => ({
    ...(await initial(form, query, options)),
    '@odata.nextLink': 'CUSTOMERS?$skiptoken=unrelated',
  });
  let unrelatedRead = false;
  backend.client.listNext = async () => {
    unrelatedRead = true;
    return { value: [] };
  };
  const result = await orderDiagnosis({ orderNumber: 'O1', budget: budget() }, ctx(backend.client));
  expect(unrelatedRead).toBe(false);
  expect(result.sections.shipments.status).toBe('incomplete');
  expect(result.sections.shipments.meta.warnings.join(' ')).toMatch(/source|continuation/i);
});
