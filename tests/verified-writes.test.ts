import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { registerDocumentTools } from '../src/tools/documents.js';
import { registerGenericTools } from '../src/tools/generic.js';
import { registerImpfileTools } from '../src/tools/impfiles.js';
import { registerInvoiceTools } from '../src/tools/invoices.js';
import { registerOrderTools } from '../src/tools/orders.js';
import { registerPurchaseOrderTools } from '../src/tools/purchase-orders.js';
const config = {
  priorityBaseUrl: 'https://p.test/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityPat: 'x',
  priorityReadOnly: false,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 10000,
  requestTimeoutMs: 500,
  logLevel: 'error',
} as Config;
const logger = createLogger(config);
const root = 'https://p.test/odata/Priority/tabula.ini/demo';
function harness(register = registerGenericTools) {
  const client = new PriorityClient(config, logger);
  type Handler = (p: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
  const handlers = new Map<string, Handler>();
  const server = {
    tool: (name: string, _desc: string, schema: z.ZodRawShape, fn: Handler) =>
      handlers.set(name, (p) => fn(z.object(schema).parse(p))),
  } as unknown as McpServer;
  register(server, client, config);
  return {
    client,
    call: async (name: string, p: unknown) => {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`Tool missing: ${name}`);
      return JSON.parse((await handler(p)).content[0].text);
    },
  };
}
function respond(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
afterEach(() => vi.unstubAllGlobals());
describe('verified writes', () => {
  it('does not report a silently ignored PATCH as updated', async () => {
    const h = harness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        init.method === 'PATCH' ? respond(null, 204) : respond({ PHONE: 'old' }),
      ),
    );
    const r = await h.call('priority_update_record', {
      form: 'CUSTOMERS',
      key: 'C1',
      data: { PHONE: 'new' },
      confirm: true,
    });
    expect(r).toMatchObject({
      updated: false,
      status: 'unverified',
      acknowledged: true,
      verified: false,
    });
  });
  it('retains write acknowledgment if the readback times out', async () => {
    const h = harness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init.method === 'PATCH') return respond(null, 204);
        throw new DOMException('timeout', 'TimeoutError');
      }),
    );
    expect(
      await h.call('priority_update_record', {
        form: 'CUSTOMERS',
        key: 'C1',
        data: { PHONE: 'new' },
        confirm: true,
      }),
    ).toMatchObject({ updated: false, status: 'unverified', acknowledged: true, verified: false });
  });
  it('preserves unknown commit state on a lost write response without retry', async () => {
    const h = harness();
    const fetch = vi.fn(async () => {
      throw new TypeError('connection lost');
    });
    vi.stubGlobal('fetch', fetch);
    expect(
      await h.call('priority_update_record', {
        form: 'CUSTOMERS',
        key: 'C1',
        data: { PHONE: 'new' },
        confirm: true,
      }),
    ).toMatchObject({ status: 'unknown', acknowledged: false, verified: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not claim order cancellation after a no-op', async () => {
    const h = harness(registerOrderTools);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        init.method === 'PATCH' ? respond(null, 204) : respond({ BOOLCLOSED: '', DETAILS: 'old' }),
      ),
    );
    expect(
      await h.call('priority_cancel_order', { orderNumber: 'O1', reason: 'cancel', dryRun: false }),
    ).toMatchObject({ cancelled: false, status: 'unverified' });
  });
  it('retains acknowledgment on import-file reopen read failure', async () => {
    const h = harness(registerImpfileTools);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init.method === 'PATCH') return respond(null, 204);
        throw new DOMException('timeout', 'TimeoutError');
      }),
    );
    expect(await h.call('impfile_reopen', { impfnum: 'I1', dryRun: false })).toMatchObject({
      reopened: false,
      status: 'unverified',
      acknowledged: true,
    });
  });
  it('does not claim import-file header or PO close success after a no-op', async () => {
    const h = harness(registerImpfileTools);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        init.method === 'PATCH' ? respond(null, 204) : respond({ STATDES: 'old', CLOSEDBOOL: '' }),
      ),
    );
    expect(
      await h.call('impfile_update', { impfnum: 'I1', status: 'new', dryRun: false }),
    ).toMatchObject({ updated: false, status: 'unverified' });
    expect(await h.call('po_close_lines', { poNumber: 'P1', dryRun: false })).toMatchObject({
      closed: false,
      status: 'unverified',
    });
  });
  it('supports a composite read and rejects ambiguous/missing/unexpected keys before fetching', async () => {
    const h = harness();
    const fetch = vi.fn(async () => respond({ IVNUM: '1' }));
    vi.stubGlobal('fetch', fetch);
    await h.call('priority_get_record', {
      form: 'PINVOICES',
      keys: { IVNUM: '1', DEBIT: 'D', IVTYPE: 'P' },
    });
    expect(fetch.mock.calls[0][0]).toBe(`${root}/PINVOICES(IVNUM='1',DEBIT='D',IVTYPE='P')`);
    for (const p of [
      { key: '1', keys: { IVNUM: '1' } },
      { keys: {} },
      { keys: { IVNUM: '1', DEBIT: 'D', EVIL: 'P' } },
      {},
    ])
      await expect(h.call('priority_get_record', { form: 'PINVOICES', ...p })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('previews a composite add-line without sending and exposes line PATCH', async () => {
    const h = harness();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const r = await h.call('priority_add_line', {
      form: 'PINVOICES',
      keys: { IVNUM: '1', DEBIT: 'D', IVTYPE: 'P' },
      subform: 'PINVOICEITEMS_SUBFORM',
      data: { PARTNAME: 'A' },
    });
    expect(r.dryRun).toBe(true);
    expect(r.wouldSend.endpoint).toContain("IVTYPE='P')/PINVOICEITEMS_SUBFORM");
    const patch = await h.call('priority_update_line', {
      form: 'PINVOICES',
      keys: { IVNUM: '1', DEBIT: 'D', IVTYPE: 'P' },
      subform: 'PINVOICEITEMS_SUBFORM',
      lineKeys: { KLINE: 1 },
      data: { PRICE: 4 },
    });
    expect(patch.wouldSend.method).toBe('PATCH');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('lists composite attachments using full keys', async () => {
    const h = harness(registerDocumentTools);
    const fetch = vi.fn(async () => respond({ value: [] }));
    vi.stubGlobal('fetch', fetch);
    await h.call('priority_list_attachments', {
      entityType: 'PINVOICES',
      keys: { IVNUM: '1', DEBIT: 'D', IVTYPE: 'P' },
      subform: 'EXTFILES_SUBFORM',
    });
    expect(fetch.mock.calls[0][0]).toContain("IVTYPE='P')/EXTFILES_SUBFORM");
  });
  it('requires an uncached matching readback for success', async () => {
    const h = harness();
    let state = 'old';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init.method === 'PATCH') {
          state = 'new';
          return respond(null, 204);
        }
        return respond({ PHONE: state });
      }),
    );
    await h.client.get('CUSTOMERS', 'C1');
    expect(
      await h.call('priority_update_record', {
        form: 'CUSTOMERS',
        key: 'C1',
        data: { PHONE: 'new' },
        confirm: true,
      }),
    ).toMatchObject({ updated: true, status: 'verified', verified: true });
  });
});
describe('safe client URLs', () => {
  it('rejects empty, injected key names and non-finite numeric keys', () => {
    const { client } = harness();
    for (const keys of [{}, { 'K)/../X': 1 }, { K: Number.POSITIVE_INFINITY }])
      expect(() => client.resolveCompositeUrl('X', keys)).toThrow();
  });
  it('follows safe continuation GETs and rejects origin/company/traversal/credentials/fragments', async () => {
    const { client } = harness();
    const fetch = vi.fn(async () => respond({ value: [] }));
    vi.stubGlobal('fetch', fetch);
    await client.listNext(`${root}/CUSTOMERS?$skiptoken=x`);
    expect(fetch).toHaveBeenCalledTimes(1);
    for (const link of [
      'https://evil.test/x',
      `${root}2/X`,
      `${root}/../other/X`,
      `${root}/%2e%2e/other/X`,
      `${root}/X#frag`,
      'https://u:p@p.test/odata/Priority/tabula.ini/demo/X',
      `${root}/%252e%252e/other/X`,
    ])
      await expect(client.listNext(link)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('write evidence edge cases', () => {
  it('rejects empty generic PATCH and unsafe entity/query inputs locally', async () => {
    const h = harness();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      h.call('priority_update_record', { form: 'CUSTOMERS', key: 'C1', data: {}, confirm: true }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects repeated encoded entity traversal', () => {
    const h = harness();
    expect(() => h.client.resolveEntityUrl('%252e%252e/other/CUSTOMERS')).toThrow();
  });
  it('rejects path injection through the query slot', () => {
    const h = harness();
    expect(() => h.client.resolveEntityUrl('CUSTOMERS', undefined, '/../../other/X')).toThrow();
  });
  it('preserves generated create identifiers even when verification cannot read', async () => {
    const h = harness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        if (init.method === 'POST') return respond({ CUSTNAME: 'C2' });
        throw new DOMException('timeout', 'TimeoutError');
      }),
    );
    expect(
      await h.call('priority_create_record', {
        form: 'CUSTOMERS',
        data: { CUSTDES: 'new' },
        confirm: true,
      }),
    ).toMatchObject({
      created: false,
      acknowledged: true,
      status: 'unverified',
      result: { CUSTNAME: 'C2' },
    });
  });
  it('does not verify an attachment using a pre-existing description alone', async () => {
    const h = harness(registerDocumentTools);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        init.method === 'POST'
          ? respond(null, 204)
          : respond({ value: [{ EXTFILEDES: 'same.pdf', EXTFILENAME: 'old.pdf' }] }),
      ),
    );
    expect(
      await h.call('priority_upload_attachment', {
        entityType: 'IMPFILES',
        entityKey: 'I1',
        subform: 'EXTFILES_SUBFORM',
        filePath: 'new.pdf',
        description: 'same.pdf',
        dryRun: false,
      }),
    ).toMatchObject({ attached: false, acknowledged: true, status: 'unverified' });
  });
  it('does not claim line insert success from a 204 without returned row identity', async () => {
    const h = harness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(null, 204)),
    );
    expect(
      await h.call('priority_add_line', {
        form: 'ORDERS',
        key: 'O1',
        subform: 'ORDERITEMS_SUBFORM',
        data: { PARTNAME: 'A' },
        confirm: true,
      }),
    ).toMatchObject({ added: false, acknowledged: true, status: 'unverified' });
  });
});

describe('named key schema checks at client boundary', () => {
  it('rejects incomplete and unexpected known keys in direct client previews', () => {
    const { client } = harness();
    expect(() => client.resolveCompositeUrl('PINVOICES', { IVNUM: '1' })).toThrow(
      /Expected exactly/,
    );
    expect(() => client.resolveEntityUrl('CUSTOMERS', { WRONG: '1' })).toThrow(/Expected exactly/);
  });
  it('does not execute unknown-form named-key writes without parsed key metadata', async () => {
    const h = harness();
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        methods.push(init.method);
        return respond({ not: 'metadata' });
      }),
    );
    await expect(
      h.call('priority_update_record', {
        form: 'UNKNOWN',
        keys: { K: '1' },
        data: { F: 'new' },
        confirm: true,
      }),
    ).rejects.toThrow(/Cannot validate key/);
    expect(methods).toEqual(['GET']);
  });
  it('validates discovered sub-form row keys before PATCH and verifies readback', async () => {
    const h = harness();
    const methods: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        methods.push(init.method);
        if (url.includes('GetMetadataFor'))
          return respond({
            $Version: '4.0',
            'Priority.OData': {
              ORDERITEMS_SUBFORM: {
                $Kind: 'EntityType',
                $Key: ['KLINE'],
                KLINE: { $Type: 'Edm.Int32' },
              },
            },
          });
        return init.method === 'PATCH' ? respond(null, 204) : respond({ PRICE: 5 });
      }),
    );
    expect(
      await h.call('priority_update_line', {
        form: 'ORDERS',
        key: 'O1',
        subform: 'ORDERITEMS_SUBFORM',
        lineKeys: { KLINE: 1 },
        data: { PRICE: 5 },
        confirm: true,
      }),
    ).toMatchObject({ updated: true, verified: true });
    expect(methods).toEqual(['GET', 'PATCH', 'GET']);
  });
});

describe('create verification', () => {
  it('expands the known requested line sub-form on a deep-insert readback', async () => {
    const h = harness(registerOrderTools);
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init) => {
        if (init.method === 'POST') return respond({ ORDNAME: 'O2' });
        urls.push(url);
        return respond({
          ORDNAME: 'O2',
          CUSTNAME: 'C1',
          ORDERITEMS_SUBFORM: [{ PARTNAME: 'A', TQUANT: 1 }],
        });
      }),
    );
    expect(
      await h.call('priority_create_order', {
        customerId: 'C1',
        items: [{ productId: 'A', quantity: 1 }],
        dryRun: false,
      }),
    ).toMatchObject({ created: true, verified: true, order: { ORDNAME: 'O2' } });
    expect(urls[0]).toContain('$expand=ORDERITEMS_SUBFORM');
  });
});

describe('remaining create outcomes and generic continuation', () => {
  it('preserves invoice acknowledgment and identity on failed verification', async () => {
    const h = harness(registerInvoiceTools);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        init.method === 'POST'
          ? respond({ IVNUM: 'I2', DEBIT: 'D', IVTYPE: 'A' })
          : respond({ CUSTNAME: 'old' }),
      ),
    );
    expect(
      await h.call('priority_create_invoice', {
        customerId: 'C1',
        items: [{ productId: 'A', quantity: 1, price: 2 }],
        dryRun: false,
      }),
    ).toMatchObject({
      created: false,
      acknowledged: true,
      status: 'unverified',
      invoice: { IVNUM: 'I2' },
    });
  });
  it('preserves purchase order identity on failed verification', async () => {
    const h = harness(registerPurchaseOrderTools);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) =>
        init.method === 'POST' ? respond({ ORDNAME: 'P2' }) : respond({ SUPNAME: 'old' }),
      ),
    );
    expect(
      await h.call('priority_create_purchase_order', {
        supplierId: 'S1',
        items: [{ productId: 'A', quantity: 1, price: 2 }],
        dryRun: false,
      }),
    ).toMatchObject({
      created: false,
      acknowledged: true,
      status: 'unverified',
      purchaseOrder: { ORDNAME: 'P2' },
    });
  });
  it('retains a short-page continuation instead of reporting hasMore false', async () => {
    const h = harness();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond({
          value: [{ CUSTNAME: 'C1' }],
          '@odata.nextLink': `${root}/CUSTOMERS?$skiptoken=next`,
        }),
      ),
    );
    expect(await h.call('priority_query', { form: 'CUSTOMERS', top: 50 })).toMatchObject({
      hasMore: true,
      nextLink: `${root}/CUSTOMERS?$skiptoken=next`,
    });
  });
});
