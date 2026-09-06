import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { toMcpError } from '../client/errors.js';
import { ODataBuilder } from '../client/odata-builder.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { parseCsdl } from '../lib/csdl.js';
import { filterForms, listExposedForms } from '../lib/forms.js';
import { checkWriteAllowed, dryRunRequest, textResult } from '../lib/write-guard.js';

/**
 * Generic, form-agnostic building-block tools that work against ANY Priority form.
 * These mirror the raw OData surface (discover -> read -> write) and are the right
 * choice whenever the curated domain tools (priority_list_customers, etc.) don't fit.
 */
export function registerGenericTools(server: McpServer, client: PriorityClient, config: Config) {
  // ----------------------------------------------------------------- Discovery

  server.tool(
    'priority_list_forms',
    `List the Priority forms (OData entity sets) on this installation, filtered at the source.

This installation publishes ~1371 forms, so ALWAYS narrow with 'prefix' or 'contains' — an
unfiltered list is truncated to fit the result budget and tells you nothing about the tail.
To answer "is form X exposed?", call it as { contains: "X" } (or prefix) — that is the
authoritative check, and it costs one call instead of probing X blind.

Matching is case-insensitive. Returns each form's name (use it as the 'form' argument
elsewhere), kind, and relative url, plus how many forms matched vs. exist in total.

CAVEAT: appearing here means the form is an entity set on this service; it does NOT guarantee
the form's "Available for API" flag is on. A flag-off form still answers 400
"לא ניתן להפעיל API למסך זה" (verified here for e.g. COMPANIES, PARTBAL, TODOLIST) — that is a
Priority-side setting an admin must tick, not something this server can change.`,
    {
      prefix: z
        .string()
        .optional()
        .describe('Only forms whose name starts with this (case-insensitive), e.g. "IMPF"'),
      contains: z
        .string()
        .optional()
        .describe('Only forms whose name contains this (case-insensitive), e.g. "BANK"'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Max forms to return (default 100)'),
    },
    async (params) => {
      try {
        const forms = await listExposedForms(client);
        const { matches, total, matched, truncated } = filterForms(forms, params);
        return textResult({
          forms: matches,
          returned: matches.length,
          matched,
          totalFormsOnInstallation: total,
          filter: { prefix: params.prefix ?? null, contains: params.contains ?? null },
          ...(truncated
            ? {
                truncated: `${matched} forms matched; showing ${matches.length}. Raise 'limit' or narrow 'prefix'/'contains'.`,
              }
            : {}),
          ...(matched === 0
            ? {
                note: 'No form matched. Try a shorter fragment via contains — Priority form names are UPPERCASE and often abbreviated (e.g. warehouse balances are WARHSBALREP, not WARHSBAL).',
              }
            : {}),
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_entity_metadata',
    `Get the field-level metadata for a Priority form via GetMetadataFor(entity='X') (Priority 25.0+).

Returns field (column) names, data types, display titles, and which fields are MANDATORY,
plus the form's sub-forms (navigation properties). This is the authoritative way to learn:
  - the exact UPPERCASE field names to put in a $filter / $select / write body,
  - the exact sub-form name to $expand or to append lines to (e.g. AINVOICEITEMS_SUBFORM),
  - which fields you must supply when creating a record.

Always confirm form and field names here (or via priority_describe_form) BEFORE writing —
do not guess them. If this errors (older Priority that lacks GetMetadataFor), fall back to
priority_describe_form.`,
    {
      entity: z.string().min(1).describe("Form/entity name, e.g. 'CUSTOMERS', 'AINVOICES'"),
    },
    async (params) => {
      try {
        const metadata = await client.getMetadataFor<unknown>(params.entity);
        // Priority returns CSDL — XML normally, JSON on some responses. Parse either into clean
        // JSON (fields with type/title/mandatory, key, sub-forms); fall back to raw on a miss.
        const parsed = parseCsdl(metadata, params.entity);
        if (parsed) return textResult(parsed);
        return textResult({
          entity: params.entity,
          note: 'Returned metadata could not be parsed into fields; raw CSDL follows (truncated).',
          raw: typeof metadata === 'string' ? metadata.slice(0, 4000) : metadata,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_describe_form',
    `Universal fallback for discovering a form's fields: fetches ONE sample record ({form}?$top=1)
and reports the field names and value types present on it.

Works on every Priority version (no GetMetadataFor needed). Use this when
priority_get_entity_metadata is unavailable, or to see real example values. Note: fields that
are null/empty on the sampled record will not appear, and mandatory flags are not available
here — prefer priority_get_entity_metadata when you need those.`,
    {
      form: z.string().min(1).describe("Form/entity name, e.g. 'CUSTOMERS'"),
    },
    async (params) => {
      try {
        const result = await client.list<Record<string, unknown>>(params.form, '?$top=1');
        const row = result.value?.[0];
        if (!row) {
          return textResult({
            form: params.form,
            fields: [],
            note: 'Form is reachable but returned no rows to sample.',
          });
        }
        const fields = Object.entries(row).map(([name, value]) => ({
          name,
          type: Array.isArray(value) ? 'subform[]' : value === null ? 'null' : typeof value,
        }));
        return textResult({ form: params.form, fieldCount: fields.length, fields, sample: row });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  // --------------------------------------------------------------------- Read

  server.tool(
    'priority_query',
    `Query any Priority form with structured OData options.

OData value rules (important):
  - String values go in SINGLE QUOTES; double any embedded quote: name eq 'O''Brien'.
  - Hebrew and spaces are fine inside quotes — this server percent-encodes values for you.
  - Numbers are bare and use a '.' decimal separator: TOTPRICE gt 1000.50  (never a comma).
  - Dates/datetimes are UNQUOTED ISO 8601: IVDATE ge 2026-05-01T00:00:00Z
    (a date alone like 2026-05-01 also works). NOTE: the date field name varies by form —
    AINVOICES uses IVDATE, ORDERS/PORDERS use CURDATE. Confirm with priority_describe_form.
  - Combine conditions with 'and'/'or'. WARNING: some installations do NOT support OData string
    functions and reject contains()/startswith() with HTTP 501. Prefer eq/ge/le; for fuzzy name
    search use priority_search_customers / priority_search_products (they fall back automatically).
Use 'expand' to pull a record's sub-forms (line items) inline, e.g. expand=['AINVOICEITEMS_SUBFORM'].
Discover exact field/sub-form names with priority_get_entity_metadata or priority_describe_form first.
For large forms, pass 'select' to project only the fields you need — unprojected rows can be large.`,
    {
      form: z.string().min(1).describe("Form/entity name, e.g. 'AINVOICES'"),
      filter: z
        .string()
        .optional()
        .describe(
          'Raw OData $filter expression, e.g. "CUSTNAME eq \'C1001\' and CURDATE ge 2026-05-01T00:00:00Z"',
        ),
      select: z.array(z.string()).optional().describe('Field names to return (omit for all)'),
      expand: z
        .array(z.string())
        .optional()
        .describe("Sub-forms to expand inline, e.g. ['AINVOICEITEMS_SUBFORM']"),
      orderby: z
        .string()
        .optional()
        .describe("Sort spec, e.g. 'CURDATE desc' or 'CURDATE desc,IVNUM asc'"),
      top: z.number().int().min(1).max(1000).default(50).describe('Max rows to return (1-1000)'),
      skip: z.number().int().min(0).optional().describe('Rows to skip (pagination)'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder();
        if (params.filter) qb.filter(params.filter);
        if (params.select?.length) qb.select(...params.select);
        if (params.expand?.length) qb.expand(...params.expand);
        if (params.orderby) {
          for (const part of params.orderby.split(',')) {
            const [field, dir] = part.trim().split(/\s+/);
            if (field) qb.orderBy(field, dir?.toLowerCase() === 'desc' ? 'desc' : 'asc');
          }
        }
        qb.top(params.top);
        if (params.skip !== undefined) qb.skip(params.skip);

        const result = await client.list(params.form, qb.build());
        const rows = result?.value ?? [];
        return textResult({
          form: params.form,
          count: rows.length,
          value: rows,
          hasMore: rows.length === params.top,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_get_record',
    `Fetch a single record from a form by its key value.

The key is the value of the form's key field (usually a string, e.g. CUSTNAME 'C1001',
IVNUM '12345', ORDNAME 'SO24000001'). Optionally $select specific fields or $expand sub-forms.
For forms with COMPOSITE keys, use priority_query with a $filter on the key fields instead.`,
    {
      form: z.string().min(1).describe("Form/entity name, e.g. 'CUSTOMERS'"),
      key: z.string().min(1).describe("Key value of the record, e.g. 'C1001'"),
      select: z.array(z.string()).optional().describe('Field names to return (omit for all)'),
      expand: z.array(z.string()).optional().describe('Sub-forms to expand inline'),
    },
    async (params) => {
      try {
        const qb = new ODataBuilder();
        if (params.select?.length) qb.select(...params.select);
        if (params.expand?.length) qb.expand(...params.expand);
        const query = qb.build();
        const record = await client.get(params.form, params.key, query || undefined);
        return textResult(record);
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  // -------------------------------------------------------------------- Write
  // Every write is a NO-OP unless confirm=true. With confirm=false (the default) the tool
  // returns a DRY-RUN preview of the exact HTTP method, endpoint URL, and JSON body that
  // WOULD be sent — nothing is transmitted to Priority.

  server.tool(
    'priority_create_record',
    `Create a record on any form. Supports OData DEEP-INSERT: include sub-form lines as an array
under the sub-form's navigation-property name, and the header + all lines are created in ONE call.

Example data (creating an invoice header with two lines in one POST):
  {
    "CUSTNAME": "C1001",
    "AINVOICEITEMS_SUBFORM": [
      { "PARTNAME": "P-100", "TQUANT": 2 },
      { "PARTNAME": "P-200", "TQUANT": 1 }
    ]
  }
Field names are UPPERCASE; confirm exact field + sub-form names with priority_get_entity_metadata
first. Priority auto-generates document numbers and returns them in the response.

SAFETY: confirm defaults to false -> you get a dry-run preview of the exact POST endpoint + body.
Set confirm=true to actually create (also blocked entirely when PRIORITY_READ_ONLY=true).`,
    {
      form: z.string().min(1).describe("Form/entity name, e.g. 'AINVOICES'"),
      data: z
        .record(z.unknown())
        .describe('Header fields, plus optional sub-form arrays for deep-insert (see example).'),
      confirm: z
        .boolean()
        .default(false)
        .describe('false = dry-run preview (default); true = actually POST'),
    },
    async (params) => {
      const endpoint = client.resolveEntityUrl(params.form);
      if (!params.confirm) return dryRunRequest('POST', endpoint, params.data);
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const result = await client.create(params.form, params.data);
        return textResult({ created: true, form: params.form, result });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_update_record',
    `Update (PATCH) fields on an existing record. Include ONLY the fields you want to change;
omitted fields are left untouched. Some Priority fields are read-only and silently ignored.

SAFETY: confirm defaults to false -> dry-run preview of the exact PATCH endpoint + body.
Set confirm=true to actually update (also blocked when PRIORITY_READ_ONLY=true).`,
    {
      form: z.string().min(1).describe("Form/entity name, e.g. 'CUSTOMERS'"),
      key: z.string().min(1).describe("Key value of the record to update, e.g. 'C1001'"),
      data: z
        .record(z.unknown())
        .describe('Object of fields to change, e.g. { "PHONE": "03-1234567" }'),
      confirm: z
        .boolean()
        .default(false)
        .describe('false = dry-run preview (default); true = actually PATCH'),
    },
    async (params) => {
      const endpoint = client.resolveEntityUrl(params.form, params.key);
      if (!params.confirm) return dryRunRequest('PATCH', endpoint, params.data);
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const result = await client.update(params.form, params.key, params.data);
        return textResult({ updated: true, form: params.form, key: params.key, result });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );

  server.tool(
    'priority_add_line',
    `Append a single line to an existing record's sub-form (a POST to the navigation property),
e.g. add an order line to ORDERS('SO24000001')/ORDERITEMS_SUBFORM, or an invoice line to
AINVOICES('12345')/AINVOICEITEMS_SUBFORM. Use this to add lines AFTER a document already exists;
to create a header and its lines together in one call, use priority_create_record (deep-insert).

Confirm the sub-form's exact navigation-property name with priority_get_entity_metadata first.

SAFETY: confirm defaults to false -> dry-run preview of the exact POST endpoint + body.
Set confirm=true to actually add the line (also blocked when PRIORITY_READ_ONLY=true).`,
    {
      form: z.string().min(1).describe("Parent form/entity name, e.g. 'ORDERS'"),
      key: z.string().min(1).describe("Key of the parent record, e.g. 'SO24000001'"),
      subform: z
        .string()
        .min(1)
        .describe("Sub-form navigation property, e.g. 'ORDERITEMS_SUBFORM'"),
      data: z
        .record(z.unknown())
        .describe('The line fields, e.g. { "PARTNAME": "P-100", "TQUANT": 3 }'),
      confirm: z
        .boolean()
        .default(false)
        .describe('false = dry-run preview (default); true = actually POST'),
    },
    async (params) => {
      const endpoint = client.resolveSubformUrl(params.form, params.key, params.subform);
      if (!params.confirm) return dryRunRequest('POST', endpoint, params.data);
      const guard = checkWriteAllowed(config);
      if (guard.blocked) return guard.result;
      try {
        const result = await client.addLine(params.form, params.key, params.subform, params.data);
        return textResult({
          added: true,
          form: params.form,
          key: params.key,
          subform: params.subform,
          result,
        });
      } catch (err) {
        throw toMcpError(err);
      }
    },
  );
}
