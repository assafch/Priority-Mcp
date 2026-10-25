import { afterEach, describe, expect, it, vi } from 'vitest';
import { PriorityError } from '../src/client/errors.js';
import type { PriorityClient } from '../src/client/priority-client.js';
import { parseCsdl } from '../src/lib/csdl.js';
import { SchemaService } from '../src/lib/schema-service.js';
import { createOperation } from '../src/runtime/operation-context.js';
const parent =
  '<EntityType Name="ORDERS"><Key><PropertyRef Name="ORDNAME"/></Key><Property Name="ORDNAME" Type="Edm.String"/><NavigationProperty Name="ORDERITEMS_SUBFORM" Type="Collection(Priority.OData.ORDERITEMS)"/><NavigationProperty Name="ORDDOC_H_SUBFORM" Type="Collection(Priority.OData.ORDERDOCS)"/></EntityType>';
const child =
  '<EntityType Name="ORDERITEMS"><Key><PropertyRef Name="KLINE"/><PropertyRef Name="TYPE"/></Key><Property Name="KLINE" Type="Edm.Int64"/><Property Name="TYPE" Type="Edm.String"/></EntityType>';
const documents =
  '<EntityType Name="ORDERDOCS"><Key><PropertyRef Name="DOCNO"/></Key><Property Name="DOCNO" Type="Edm.String"/></EntityType>';
const full = `<Schema>${parent}${child}${documents}</Schema>`;
const backend = (
  handler: (path: string) => Promise<unknown> = async (path) =>
    path === '$metadata' ? full : `<Schema>${parent}</Schema>`,
) => {
  const request = vi.fn(handler);
  return { request, service: new SchemaService({ request } as unknown as PriorityClient) };
};
afterEach(() => vi.useRealTimers());
describe('declared navigation schema through supported Priority metadata', () => {
  it('resolves navigation type aliases in both CSDL representations', () => {
    const xml = parseCsdl(`<Schema>${parent}</Schema>`, 'ORDERS');
    const json = parseCsdl(
      {
        $Version: '4.0',
        'Priority.OData': {
          ORDERS: {
            $Kind: 'EntityType',
            $Key: ['ORDNAME'],
            ORDNAME: {},
            ORDERITEMS_SUBFORM: {
              $Kind: 'NavigationProperty',
              $Type: 'Priority.OData.ORDERITEMS',
              $Collection: true,
            },
          },
        },
      },
      'ORDERS',
    );
    expect(xml?.subformTypes?.ORDERITEMS_SUBFORM).toBe('ORDERITEMS');
    expect(json?.subformTypes?.ORDERITEMS_SUBFORM).toBe('ORDERITEMS');
  });
  it('fetches full schema once for declared children instead of unsupported targeted subform metadata', async () => {
    const { service, request } = backend();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.getSubform('ORDERS', 'ORDERITEMS_SUBFORM', {
          purpose: 'write',
          allowFullScan: true,
        }),
      ),
    );
    expect(results.every((r) => r.schema.key.join(',') === 'KLINE,TYPE')).toBe(true);
    expect(results[0].schema.entity).toBe('ORDERITEMS');
    const second = await service.getSubform('ORDERS', 'ORDDOC_H_SUBFORM', {
      purpose: 'read',
      allowFullScan: true,
    });
    expect(second.schema.key).toEqual(['DOCNO']);
    expect(second.evidence.freshness).toBe('cached');
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      "GetMetadataFor(entity='ORDERS')",
      '$metadata',
    ]);
  });
  it('requires explicit permission for the expensive metadata read and never guesses undeclared navigation', async () => {
    const { service, request } = backend();
    await expect(
      service.getSubform('ORDERS', 'ORDERITEMS_SUBFORM', { purpose: 'read' }),
    ).rejects.toThrow(/full.*metadata|opt.in/i);
    await expect(
      service.getSubform('ORDERS', 'SHIPMENTS_SUBFORM', { purpose: 'read', allowFullScan: true }),
    ).rejects.toThrow(/declared|navigation/i);
    expect(request.mock.calls.some((c) => c[0] === '$metadata')).toBe(false);
  });
  it('does not bypass denied parent metadata or accept a keyed unrelated entity', async () => {
    const denied = backend(async () => {
      throw new PriorityError('denied', 403);
    });
    await expect(
      denied.service.getSubform('ORDERS', 'ORDERITEMS_SUBFORM', {
        purpose: 'write',
        allowFullScan: true,
      }),
    ).rejects.toThrow('denied');
    expect(denied.request).toHaveBeenCalledTimes(1);
    const wrong = backend(async (path) =>
      path === '$metadata' ? `<Schema>${documents}</Schema>` : `<Schema>${parent}</Schema>`,
    );
    await expect(
      wrong.service.getSubform('ORDERS', 'ORDERITEMS_SUBFORM', {
        purpose: 'write',
        allowFullScan: true,
      }),
    ).rejects.toThrow(/schema|target|navigation/i);
  });
  it('isolates subscriber cancellation for a shared full metadata read', async () => {
    let finish!: (v: unknown) => void;
    const { service, request } = backend(async (path) =>
      path === '$metadata'
        ? new Promise((r) => {
            finish = r;
          })
        : `<Schema>${parent}</Schema>`,
    );
    await service.get('ORDERS', { purpose: 'read' });
    const abort = new AbortController();
    const a = service.getSubform(
      'ORDERS',
      'ORDERITEMS_SUBFORM',
      { purpose: 'write', allowFullScan: true },
      createOperation('first', { signal: abort.signal }),
    );
    const rejected = expect(a).rejects.toThrow('cancelled');
    const b = service.getSubform(
      'ORDERS',
      'ORDDOC_H_SUBFORM',
      { purpose: 'write', allowFullScan: true },
      createOperation('second'),
    );
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    abort.abort(new Error('cancelled'));
    finish(full);
    await rejected;
    expect((await b).schema.key).toEqual(['DOCNO']);
    expect(request.mock.calls.filter((c) => c[0] === '$metadata')).toHaveLength(1);
  });
  it('refreshes expired identity evidence and rejects cancelled warm requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const { service, request } = backend();
    await service.getSubform('ORDERS', 'ORDERITEMS_SUBFORM', {
      purpose: 'write',
      allowFullScan: true,
    });
    await expect(
      service.getSubform(
        'ORDERS',
        'ORDERITEMS_SUBFORM',
        { purpose: 'read', allowFullScan: true },
        createOperation('cancelled', { signal: AbortSignal.abort(new Error('cancelled')) }),
      ),
    ).rejects.toThrow('cancelled');
    vi.advanceTimersByTime(3600001);
    request.mockImplementation(async () => {
      throw new PriorityError('unavailable', 503);
    });
    await expect(
      service.getSubform('ORDERS', 'ORDERITEMS_SUBFORM', { purpose: 'write', allowFullScan: true }),
    ).rejects.toThrow('unavailable');
  });
});
