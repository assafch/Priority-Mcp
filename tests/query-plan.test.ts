import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PriorityClient } from '../src/client/priority-client.js';
import { prepareReadQuery } from '../src/lib/query-plan.js';
import { knowledgeFor } from '../src/lib/schema-service.js';
import { createOperation } from '../src/runtime/operation-context.js';
import { registerQueryPlanningTools } from '../src/tools/query-planning.js';

const schema = (extra = '') =>
  `<Schema><EntityType Name="AINVOICES"><Key><PropertyRef Name="IVNUM"/><PropertyRef Name="DEBIT"/><PropertyRef Name="IVTYPE"/></Key><Property Name="IVNUM" Type="Edm.String"/><Property Name="DEBIT" Type="Edm.String"/><Property Name="IVTYPE" Type="Edm.String"/><Property Name="DES" Type="Edm.String"/><Property Name="TOTAL" Type="Edm.Decimal"/><Property Name="CLOSED" Type="Edm.Boolean"/><Property Name="IVDATE" Type="Edm.DateTimeOffset"/><NavigationProperty Name="ITEMS" Type="Collection(Priority.ITEMS)"/>${extra}</EntityType></Schema>`;
const fixture = (request = vi.fn().mockResolvedValue(schema())) => {
  const client = { request } as unknown as PriorityClient;
  return { client, request, ctx: { ...createOperation('priority_prepare_query'), client } };
};
const input = { form: 'AINVOICES', fields: ['DES'], filters: [] };
afterEach(() => vi.restoreAllMocks());

describe('schema-aware read query preview', () => {
  it('refreshes at most once on unknown fields, stops before data reads and never scans all metadata', async () => {
    const { ctx, request } = fixture();
    await expect(prepareReadQuery({ ...input, fields: ['UNKNOWN'] }, ctx)).rejects.toThrow(
      /unknown.*field/i,
    );
    expect(request.mock.calls.map((c) => c[0])).toEqual([
      "GetMetadataFor(entity='AINVOICES')",
      "GetMetadataFor(entity='AINVOICES')",
    ]);
  });

  it('recovers schema drift once, validates the rebuilt projection and keeps all composite sort keys', async () => {
    const { ctx, request } = fixture(
      vi
        .fn()
        .mockResolvedValueOnce(schema())
        .mockResolvedValue(schema('<Property Name="ADDED" Type="Edm.String"/>')),
    );
    const plan = await prepareReadQuery({ ...input, fields: ['ADDED'] }, ctx);
    const params = new URLSearchParams(plan.query);
    expect(params.get('$select')).toBe('ADDED,IVNUM,DEBIT,IVTYPE');
    expect(params.get('$orderby')).toBe('IVNUM asc,DEBIT asc,IVTYPE asc');
    expect(params.get('$top')).toBe('50');
    expect(plan.meta.complete).toBe(true);
    expect(plan.meta.traceId).toBe(ctx.traceId);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('suggests a resolver when contains is unsupported and never attempts the query', async () => {
    const { client, ctx, request } = fixture();
    knowledgeFor(client).capabilities.put('AINVOICES', 'contains', 'unsupported');
    await expect(
      prepareReadQuery(
        { ...input, filters: [{ field: 'DES', op: 'contains', value: 'name' }] },
        ctx,
      ),
    ).rejects.toThrow(/priority_resolve_entity/);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid dates and uses exclusive next-day bounds including fractional seconds', async () => {
    const { ctx, request } = fixture();
    await expect(prepareReadQuery({ ...input, dates: { to: '2026-02-30' } }, ctx)).rejects.toThrow(
      /date/i,
    );
    expect(request).not.toHaveBeenCalled();
    const plan = await prepareReadQuery(
      { ...input, dates: { from: '2026-02-28', to: '2026-02-28' } },
      ctx,
    );
    expect(new URLSearchParams(plan.query).get('$filter')).toBe(
      'IVDATE ge 2026-02-28T00:00:00Z and IVDATE lt 2026-03-01T00:00:00Z',
    );
  });

  it('keeps Hebrew quotes and filter-shaped strings within one typed literal', async () => {
    const { ctx } = fixture();
    const value = "לקוח' or TOTAL gt 0 or DES eq 'א";
    const plan = await prepareReadQuery(
      { ...input, filters: [{ field: 'DES', op: 'eq', value }] },
      ctx,
    );
    expect(new URLSearchParams(plan.query).get('$filter')).toBe(
      "DES eq 'לקוח'' or TOTAL gt 0 or DES eq ''א'",
    );
    const dateLookingString = await prepareReadQuery(
      { ...input, filters: [{ field: 'DES', op: 'eq', value: '2026-01-01T00:00:00Z' }] },
      ctx,
    );
    expect(new URLSearchParams(dateLookingString.query).get('$filter')).toBe(
      "DES eq '2026-01-01T00:00:00Z'",
    );
  });

  it('rejects source/field injection and unbounded expansion before metadata access', async () => {
    const { ctx, request } = fixture();
    for (const bad of [
      { ...input, form: 'AINVOICES?$filter=true' },
      { ...input, fields: ['DES,$expand=ITEMS'] },
      { ...input, expand: ['*'] },
      { ...input, expand: ['ITEMS/INNER'] },
      { ...input, expand: ['A', 'B', 'C'] },
    ])
      await expect(prepareReadQuery(bad, ctx)).rejects.toThrow(/form|field|expand/i);
    expect(request).not.toHaveBeenCalled();
  });

  it('bounds expansions and rejects mismatched scalar types and limits', async () => {
    const { ctx } = fixture();
    const plan = await prepareReadQuery({ ...input, top: 500, expand: ['ITEMS'] }, ctx);
    expect(new URLSearchParams(plan.query).get('$expand')).toBe('ITEMS($top=50)');
    expect(plan.costClass).toBe('heavy');
    expect(plan.reasons.join(' ')).toMatch(/50/);
    await expect(prepareReadQuery({ ...input, top: 501 }, ctx)).rejects.toThrow(/500/);
    await expect(
      prepareReadQuery({ ...input, filters: [{ field: 'TOTAL', op: 'gt', value: '100' }] }, ctx),
    ).rejects.toThrow(/number/i);
    await expect(
      prepareReadQuery({ ...input, filters: [{ field: 'CLOSED', op: 'gt', value: true }] }, ctx),
    ).rejects.toThrow(/operator/i);
  });

  it('does not refresh unknown forms or exceed an expired operation budget', async () => {
    const { ctx, request } = fixture(vi.fn().mockRejectedValue(new Error('Unknown form')));
    await expect(prepareReadQuery(input, ctx)).rejects.toThrow('Unknown form');
    expect(request).toHaveBeenCalledTimes(1);
    const expired = fixture();
    await expect(
      prepareReadQuery(input, { ...expired.ctx, deadlineAt: Date.now() - 1 }),
    ).rejects.toThrow(/deadline/i);
    expect(expired.request).not.toHaveBeenCalled();
  });

  it('never guesses between multiple date fields or silently uses a denied form', async () => {
    const otherSchema = schema('<Property Name="OTHERDATE" Type="Edm.DateTimeOffset"/>')
      .replaceAll('AINVOICES', 'OTHER_FORM')
      .replaceAll('IVDATE', 'FIRSTDATE');
    const { ctx, request } = fixture(vi.fn().mockResolvedValue(otherSchema));
    await expect(
      prepareReadQuery({ ...input, form: 'OTHER_FORM', dates: { from: '2026-01-01' } }, ctx),
    ).rejects.toThrow(/ambiguous/);
    expect(request).toHaveBeenCalledTimes(1);
    const denied = fixture();
    knowledgeFor(denied.client).capabilities.put('AINVOICES', 'read', 'denied');
    await expect(prepareReadQuery(input, denied.ctx)).rejects.toThrow(/capability/);
    expect(denied.request).not.toHaveBeenCalled();
  });

  it('does not spend another metadata request after its single shared deadline expires', async () => {
    const { ctx, request } = fixture();
    request.mockImplementation(async () => {
      ctx.deadlineAt = Date.now() - 1;
      return schema();
    });
    await expect(prepareReadQuery({ ...input, fields: ['UNKNOWN'] }, ctx)).rejects.toThrow(
      /deadline/,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized prepared query before a formatter could silently shorten executable syntax', async () => {
    const { ctx } = fixture();
    await expect(
      prepareReadQuery(
        { ...input, filters: [{ field: 'DES', op: 'eq', value: 'x'.repeat(9000) }] },
        ctx,
      ),
    ).rejects.toThrow(/query.*8000|narrow/i);
  });

  it('registers a JSON-safe read-only preview without executing backend data queries', async () => {
    const { client: backend, request } = fixture();
    const server = new McpServer({ name: 'query-plan-test', version: '1' });
    registerQueryPlanningTools(server, backend);
    const client = new Client({ name: 'query-plan-client', version: '1' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const result = await client.callTool({ name: 'priority_prepare_query', arguments: input });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        source: 'AINVOICES',
        costClass: 'scan',
        preview: true,
      });
      expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
        result.structuredContent,
      );
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
