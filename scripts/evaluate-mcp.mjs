#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
/** Frozen synthetic engine evaluation. Never loads .env, real ERP data or a model. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = resolve(root, 'tests/fixtures/evaluation');
const hash = (value) => createHash('sha256').update(value).digest('hex');
export async function loadEvaluationCases() {
  const manifest = JSON.parse(await readFile(resolve(fixtureRoot, 'manifest.json'), 'utf8'));
  const cases = [];
  for (const [name, expected] of Object.entries(manifest.files)) {
    if (!['development.json', 'held-out.json'].includes(name))
      throw new Error('Unexpected evaluation fixture path.');
    const raw = await readFile(resolve(fixtureRoot, name), 'utf8');
    if (hash(raw) !== expected)
      throw new Error(
        `Frozen fixture changed: ${name}. Version and independently review new expected outcomes.`,
      );
    cases.push(...JSON.parse(raw).cases);
  }
  const sourceIdentityManifest = JSON.parse(
    await readFile(resolve(fixtureRoot, 'source-identities-manifest.json'), 'utf8'),
  );
  if (
    sourceIdentityManifest.sidecarFile !== 'source-identities.json' ||
    JSON.stringify(sourceIdentityManifest.baseFixtureHashes) !== JSON.stringify(manifest.files)
  )
    throw new Error('Source identity protocol fixture does not match the frozen base inputs.');
  const identityRaw = await readFile(
    resolve(fixtureRoot, sourceIdentityManifest.sidecarFile),
    'utf8',
  );
  if (hash(identityRaw) !== sourceIdentityManifest.sha256)
    throw new Error('Source identity sidecar changed without a reviewed protocol version.');
  const sourceIdentities = JSON.parse(identityRaw);
  if (sourceIdentities.version !== sourceIdentityManifest.version)
    throw new Error('Source identity protocol versions differ.');
  return {
    cases,
    manifest,
    verifiedFrozenHashes: true,
    sourceIdentities,
    sourceIdentityHash: sourceIdentityManifest.sha256,
  };
}
async function defaultEngines() {
  const paths = [
    'lib/entity-resolver',
    'lib/entity-aliases',
    'lib/query-plan',
    'lib/schema-service',
    'runtime/operation-context',
    'client/errors',
    'client/priority-client',
    'logger',
    'lib/tool-result',
    'lib/write-guard',
    'services/customer-snapshot',
    'services/order-diagnosis',
    'services/import-diagnosis',
    'tools/sales-report',
    'tools/finance',
  ];
  return Object.assign(
    {},
    ...(await Promise.all(
      paths.map((path) => import(pathToFileURL(resolve(root, `dist/${path}.js`)).href)),
    )),
  );
}
const master = {
  CUSTOMERS: ['CUSTNAME', 'CUSTDES'],
  SUPPLIERS: ['SUPNAME', 'SUPDES'],
  LOGPART: ['PARTNAME', 'PARTDES'],
};
const invoiceFields = {
  IVNUM: 'Edm.String',
  DEBIT: 'Edm.String',
  IVTYPE: 'Edm.String',
  IVDATE: 'Edm.DateTimeOffset',
  DES: 'Edm.String',
  TOTAL: 'Edm.Decimal',
  CLOSED: 'Edm.Boolean',
  CODE: 'Edm.String',
};
const configFor = (backend) => ({
  priorityServiceRoot: 'https://fixture.invalid/odata/Priority/evaluation/demo',
  priorityPat: 'synthetic-evaluation-only',
  priorityReadOnly: true,
  priorityLanguage: 'EN',
  priorityCustomEntities: [],
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 1000000,
  requestTimeoutMs: 1000,
  logLevel: 'silent',
  mcpTransport: 'stdio',
  mcpHttpHost: '127.0.0.1',
  mcpHttpPort: 3000,
  priorityBlockedTools: backend.blockedTools ?? [],
});
function fixtureClient(test, engines, sourceIdentities) {
  const spec = test.backend ?? {};
  const forms = structuredClone(spec.forms ?? {});
  if (spec.documents) forms.DOCUMENTS_D = structuredClone(spec.documents);
  // A separately reviewed protocol sidecar declares source identity only. No fallback derives
  // keys from SKU, amount, quantity or array position. Collection order merely locates a
  // physical fixture row whose opaque key is a literal in the sidecar.
  const bindings = sourceIdentities?.cases?.[test.id];
  const protocolSchemas = bindings ? sourceIdentities.schemas : undefined;
  for (const binding of bindings ?? []) {
    const observations = (forms[binding.source] ?? []).filter((row) =>
      Object.entries(binding.parentIdentity).every(([key, value]) => row[key] === value),
    );
    if (!observations.length)
      throw new Error(`Source identity binding has no matching parent in ${test.id}.`);
    for (const row of observations) {
      const collection = row[binding.collection];
      if (!Array.isArray(collection) || collection.length !== binding.lineIdentities.length)
        throw new Error(
          `Physical source-line shape differs from reviewed identity binding in ${test.id}.`,
        );
      for (let position = 0; position < collection.length; position++) {
        const literalIdentity = binding.lineIdentities[position];
        for (const [key, value] of Object.entries(literalIdentity)) {
          if (key !== 'SYNTHETIC_LINE_ID' || typeof value !== 'string' || !value)
            throw new Error(
              'Source sidecar may declare only its explicit opaque synthetic line key.',
            );
          if (key in collection[position] && collection[position][key] !== value)
            throw new Error('Reviewed source identity cannot overwrite an existing identity.');
          collection[position][key] = value;
        }
      }
    }
  }
  // Explicit negative controls alter only protocol identity, never economic/source facts.
  if (spec.rawIdentityFault === 'line-key')
    for (const rows of Object.values(forms))
      for (const row of rows)
        for (const field of ['AINVOICEITEMS_SUBFORM', 'TRANSORDER_D_SUBFORM'])
          for (const line of row[field] ?? []) Reflect.deleteProperty(line, 'SYNTHETIC_LINE_ID');
  if (spec.rawIdentityFault === 'parent-key')
    for (const row of forms.AINVOICES ?? []) Reflect.deleteProperty(row, 'DEBIT');
  const stats = { metadataCalls: 0, dataCalls: 0, uncachedCandidateReads: 0, queries: [] };
  const failure = (status) =>
    new engines.PriorityError(
      status === 403 ? 'Denied' : status === 404 ? 'Missing' : 'Read timed out',
      status,
    );
  const checkId = (keys) => {
    const values = Object.values(keys);
    if (values.some((id) => spec.deniedIds?.includes(id))) throw failure(403);
    if (values.some((id) => spec.timeoutIds?.includes(id))) throw failure(408);
  };
  const metadata = (form) => {
    if (spec.brokenMetadata) return '<Schema />';
    const declared = protocolSchemas?.[form];
    const child = ['AINVOICEITEMS_SUBFORM', 'TRANSORDER_D_SUBFORM'].includes(form);
    if (declared || child) {
      const fields = declared?.fields ?? {
        PARTNAME: 'Edm.String',
        TQUANT: 'Edm.Decimal',
        QPRICE: 'Edm.Decimal',
        ...(form === 'TRANSORDER_D_SUBFORM' ? { IVNUM: 'Edm.String' } : {}),
      };
      const keys =
        spec.missingMetadataKeys || (child && spec.rawIdentityFault === 'line-schema')
          ? []
          : (declared?.key ?? []);
      return `<Schema><EntityType Name="${form}">${keys.length ? `<Key>${keys.map((key) => `<PropertyRef Name="${key}"/>`).join('')}</Key>` : ''}${Object.entries(
        fields,
      )
        .map(([name, type]) => `<Property Name="${name}" Type="${type}"/>`)
        .join('')}</EntityType></Schema>`;
    }

    const keys =
      form === 'AINVOICES'
        ? ['IVNUM', 'DEBIT', 'IVTYPE']
        : master[form]
          ? [master[form][0]]
          : ['ID'];
    const fields =
      form === 'AINVOICES'
        ? { ...invoiceFields }
        : Object.fromEntries((master[form] ?? ['ID', 'DES']).map((name) => [name, 'Edm.String']));
    if (form === 'LOGPART' && (forms.LOGPART ?? []).some((row) => 'BARCODE' in row))
      fields.BARCODE = 'Edm.String';
    if (spec.schemaDrift && stats.metadataCalls > 1) fields.ADDED = 'Edm.String';
    return `<Schema><EntityType Name="${form}">${spec.missingMetadataKeys ? '' : `<Key>${keys.map((key) => `<PropertyRef Name="${key}"/>`).join('')}</Key>`}${Object.entries(
      fields,
    )
      .map(([name, type]) => `<Property Name="${name}" Type="${type}"/>`)
      .join(
        '',
      )}<NavigationProperty Name="ITEMS" Type="Collection(Priority.ITEMS)"/></EntityType></Schema>`;
  };
  const projection = (row, query = '') => {
    const q = new URLSearchParams(query.replace(/^\?/, ''));
    const selected = q.get('$select');
    if (!selected) return structuredClone(row);
    const requested = new Set(selected.split(','));
    for (const name of (q.get('$expand') ?? '').split(',').map((value) => value.split('(')[0]))
      if (name) requested.add(name);
    return Object.fromEntries(
      Object.entries(row)
        .filter(([key]) => requested.has(key) || key.includes('@odata.nextLink'))
        .map(([key, value]) => [key, structuredClone(value)]),
    );
  };
  const exact = async (form, keys, query = '', options = {}) => {
    stats.dataCalls++;
    checkId(keys);
    if (options.cache === false) stats.uncachedCandidateReads++;
    const row = (forms[form] ?? []).find((item) =>
      Object.entries(keys).every(([key, value]) => item[key] === value),
    );
    if (!row) throw failure(404);
    return projection(row, query);
  };
  const list = async (form, query = '') => {
    stats.dataCalls++;
    stats.queries.push({ form, query });
    let rows = [...(forms[form] ?? [])];
    const q = new URLSearchParams(query.replace(/^\?/, ''));
    const filter = q.get('$filter') ?? '';
    const simple = filter.match(/^(\w+) eq '((?:''|[^'])*)'$/);
    if (simple) rows = rows.filter((row) => row[simple[1]] === simple[2].replace(/''/g, "'"));
    const status = filter.match(/STATDES eq '([^']+)'/);
    if (status) rows = rows.filter((row) => row.STATDES === status[1]);
    for (const match of filter.matchAll(
      /(IVDATE|CURDATE) (ge|gt|le|lt) (\d{4}-\d{2}-\d{2}T[^ )]+)/g,
    )) {
      const [, field, op, bound] = match;
      const time = Date.parse(bound);
      rows = rows.filter(
        (row) =>
          !row[field] ||
          {
            ge: Date.parse(row[field]) >= time,
            gt: Date.parse(row[field]) > time,
            le: Date.parse(row[field]) <= time,
            lt: Date.parse(row[field]) < time,
          }[op],
      );
    }
    const order = (q.get('$orderby') ?? '')
      .split(',')
      .filter(Boolean)
      .map((part) => part.trim().split(/\s+/));
    rows.sort((a, b) => {
      for (const [key, dir] of order) {
        const diff = String(a[key] ?? '').localeCompare(String(b[key] ?? ''));
        if (diff) return dir === 'desc' ? -diff : diff;
      }
      return 0;
    });
    const skip = Number(q.get('$skip') ?? 0);
    const take = Math.min(Number(q.get('$top') ?? 500), spec.serverPage ?? 100);
    const selected = rows.slice(skip, skip + take).map((row) => projection(row, query));
    // Nested requested-product filters are part of the fake server's OData boundary.
    const productMatches = [
      ...(q.get('$expand') ?? '').matchAll(/PARTNAME eq '((?:''|[^'])*)'/g),
    ].map((m) => m[1].replace(/''/g, "'"));
    if (productMatches.length)
      for (const row of selected)
        for (const field of ['AINVOICEITEMS_SUBFORM', 'TRANSORDER_D_SUBFORM'])
          if (Array.isArray(row[field]))
            row[field] = row[field].filter((line) => productMatches.includes(line.PARTNAME));
    return { value: selected };
  };
  const client = {
    scopeId: spec.scope ?? 'evaluation-scope',
    cacheGeneration: () => 0,
    request: async (path) => {
      stats.metadataCalls++;
      if (spec.metadataError) throw failure(spec.metadataError);
      if (path === '$metadata') throw new Error('Unapproved full metadata scan');
      return metadata(path.match(/entity='([^']+)'/)?.[1] ?? 'AINVOICES');
    },
    getComposite: exact,
    get: async (form, key, query, options) =>
      exact(
        form,
        typeof key === 'object'
          ? key
          : {
              [master[form]?.[0] ??
                (form === 'ORDERS' ? 'ORDNAME' : form === 'IMPFILES' ? 'IMPFNUM' : 'ID')]: key,
            },
        query,
        options,
      ),
    list,
    listNext: async () => {
      throw new Error('No continuation configured for this synthetic case.');
    },
  };
  return { client, stats, config: configFor(spec) };
}
function warningsIn(value) {
  if (!value || typeof value !== 'object') return [];
  const own = Array.isArray(value.warnings) ? value.warnings : [];
  return [
    ...own,
    ...Object.entries(value)
      .filter(([key]) => key !== 'warnings')
      .flatMap(([, child]) => warningsIn(child)),
  ];
}
async function callRegistered(register, client, name, input) {
  const handlers = new Map();
  register({ tool: (tool, _description, _schema, handler) => handlers.set(tool, handler) }, client);
  const handler = handlers.get(name);
  if (!handler) throw new Error(`Unregistered evaluation tool ${name}`);
  const result = await handler(input);
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}
async function execute(test, engines, sourceIdentities) {
  const { client, stats, config } = fixtureClient(test, engines, sourceIdentities);
  const input = structuredClone(test.input);
  const context = engines.createOperation(`evaluation:${test.id}`);
  if (input.expired) context.deadlineAt = Date.now() - 1;
  if (input.cancelled) {
    const controller = new AbortController();
    controller.abort();
    context.signal = controller.signal;
  }
  if (test.backend?.containsUnsupported)
    engines.knowledgeFor(client).capabilities.put(input.form, 'contains', 'unsupported');
  if (test.backend?.readDenied)
    engines.knowledgeFor(client).capabilities.put(input.form, 'read', 'denied');
  let payload;
  let error;
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    networkCalls++;
    throw new Error('Evaluation network firewall: no actual network requests are permitted.');
  };
  try {
    if (test.engine === 'resolver') {
      const kind = input.kind;
      const [form, id] =
        kind === 'customer'
          ? ['CUSTOMERS', 'CUSTNAME']
          : kind === 'supplier'
            ? ['SUPPLIERS', 'SUPNAME']
            : ['LOGPART', 'PARTNAME'];
      const aliases = new engines.ReviewedAliasStore(
        (test.backend?.aliases ?? []).map((row) => ({
          scope: row.scope ?? 'evaluation-scope',
          kind,
          alias: row.alias,
          identity: { form, keys: { [id]: row.id } },
          source: 'frozen synthetic reviewed mapping',
          reviewedAt: '2026-10-01T00:00:00Z',
        })),
      );
      let allowed = true;
      const resolver = new engines.EntityResolver(client, {
        aliases,
        authorize: () => allowed,
        scanCap: input.scanCap,
      });
      if (input.primeThenRevoke) {
        await resolver.resolveEntity(input, context);
        allowed = false;
      }
      payload = await resolver.resolveEntity(input, context);
    } else if (test.engine === 'query')
      payload = await engines.prepareReadQuery(input, { ...context, client });
    else if (['customer', 'order', 'import'].includes(test.engine)) {
      const fn = {
        customer: engines.customerSnapshot,
        order: engines.orderDiagnosis,
        import: engines.importDiagnosis,
      }[test.engine];
      payload = await fn(
        { ...input, budget: { maxRows: 100, maxPages: 8, deadlineAt: context.deadlineAt } },
        { ...context, client, config },
      );
    } else if (test.engine === 'sales')
      payload = await callRegistered(
        engines.registerSalesReportTools,
        client,
        'priority_product_sales_by_period',
        input,
      );
    else if (test.engine === 'cash')
      payload = await callRegistered(
        engines.registerFinanceTools,
        client,
        'priority_get_cash_position',
        input,
      );
    else if (test.engine === 'formatter') {
      const value = input.longHebrew
        ? {
            rows: Array.from({ length: 100 }, (_, i) => ({
              id: i,
              description: 'מידע בעברית '.repeat(100),
            })),
            meta: { complete: true },
          }
        : input.payload;
      const result = engines.textResult(value);
      payload = {
        ...result.structuredContent,
        textMatchesStructured:
          JSON.stringify(JSON.parse(result.content[0].text)) ===
          JSON.stringify(result.structuredContent),
        withinLegacyBudget: result.content[0].text.length <= 24000,
      };
    } else if (test.engine === 'write-guard') {
      const result = engines.previewOrBlock(config, input.dryRun, 'synthetic-test', {
        CUSTNAME: 'SYNTHETIC',
      });
      payload = { ...JSON.parse(result.content[0].text), isError: Boolean(result.isError) };
    } else if (test.engine === 'continuation-guard') {
      const actual = new engines.PriorityClient(config, engines.createLogger(config));
      try {
        await actual.listNext(input.link);
      } finally {
        actual.close();
      }
    } else throw new Error(`Unknown engine ${test.engine}`);
  } catch (thrown) {
    error = thrown instanceof Error ? thrown.message : String(thrown);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const params = payload?.query ? new URLSearchParams(payload.query) : undefined;
  const warnings = warningsIn(payload).join(' ');
  const facts = {
    ...payload,
    error,
    metadataCalls: stats.metadataCalls,
    dataCalls: stats.dataCalls,
    networkCalls,
    warningIncludes: warnings,
    ...(params
      ? {
          select: params.get('$select'),
          filter: params.get('$filter'),
          orderby: params.get('$orderby'),
          top: Number(params.get('$top')),
          expand: params.get('$expand'),
        }
      : {}),
    ...(test.engine === 'resolver' && payload?.candidates
      ? {
          ids: payload.candidates
            .map((candidate) => Object.values(candidate.identity.keys)[0])
            .sort(),
          displayName: payload.candidates[0]?.displayName,
        }
      : {}),
    complete: payload?.meta?.complete ?? payload?.scan?.complete,
    stopReason: payload?.meta?.stopReason,
    snapshotConsistent: payload?.meta?.snapshotConsistent,
    missingWindowReasons: [
      ...new Set((payload?.meta?.missingWindows ?? []).map((window) => window.reason)),
    ],
    ...(payload?.sections
      ? {
          sectionStatuses: Object.fromEntries(
            Object.entries(payload.sections).map(([key, value]) => [key, value.status]),
          ),
          balance: payload.sections.balance?.data?.balance,
          balanceCurrency: payload.sections.balance?.data?.currency,
          deliveryVerified: payload.sections.shipments?.data?.deliveryVerified,
          preflightOk: payload.sections.preflight?.data?.ok,
          invoiceCurrencies: payload.sections.invoices?.data?.rows?.map((row) => row.CODE).sort(),
          invoiceTotalsByCurrency:
            payload.sections.snapshot?.data?.derived?.invoiceTotalsByCurrency,
        }
      : {}),
  };
  const failures = [];
  for (const [key, expected] of Object.entries(test.expected)) {
    const actual = facts[key];
    if (key === 'errorIncludes' || key === 'warningIncludes') {
      const hay = key === 'errorIncludes' ? error : warnings;
      if (typeof hay !== 'string' || !hay.toLowerCase().includes(expected.toLowerCase()))
        failures.push(
          `${key}: expected text containing ${JSON.stringify(expected)}, got ${JSON.stringify(hay)}`,
        );
    } else if (key === 'sectionStatuses') {
      for (const [section, status] of Object.entries(expected))
        if (actual?.[section] !== status)
          failures.push(`sectionStatuses.${section}: expected ${status}, got ${actual?.[section]}`);
    } else if (
      JSON.stringify(key === 'ids' ? [...(actual ?? [])].sort() : actual) !==
      JSON.stringify(key === 'ids' ? [...expected].sort() : expected)
    )
      failures.push(`${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  if (error && !('errorIncludes' in test.expected))
    failures.push(`Unexpected engine error: ${error}`);
  if (networkCalls !== 0)
    failures.push(
      'Network firewall was reached; only injected synthetic backend operations are permitted.',
    );
  return {
    id: test.id,
    split: test.split,
    category: test.category,
    engine: test.engine,
    passed: failures.length === 0,
    failures,
    backendCalls: { metadata: stats.metadataCalls, data: stats.dataCalls },
    facts,
  };
}
export async function runEvaluation(options = {}) {
  const dataset = await loadEvaluationCases();
  const engines = options.engines ?? (await defaultEngines());
  const cases =
    options.cases ??
    dataset.cases.filter(
      (row) => !options.split || options.split === 'all' || row.split === options.split,
    );
  const results = [];
  for (const test of cases)
    results.push(
      await execute(
        test,
        engines,
        options.sourceIdentities === false ? undefined : dataset.sourceIdentities,
      ),
    );
  const summarize = (rows) => ({
    executed: rows.length,
    passed: rows.filter((row) => row.passed).length,
    failed: rows.filter((row) => !row.passed).length,
  });
  let revision = 'unavailable';
  let dirty = null;
  try {
    revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    dirty = Boolean(
      execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
    );
  } catch {}
  return {
    schemaVersion: 1,
    kind: 'synthetic-deterministic-offline-evaluation',
    observedAt: new Date().toISOString(),
    revision,
    dirty,
    node: process.version,
    config: {
      fixtureVersion: dataset.manifest.fixtureVersion,
      split: options.split ?? 'all',
      network: 'forbidden',
      source: 'injected synthetic records',
      fixtureHashes: dataset.manifest.files,
      sourceIdentityAdapter: {
        version: dataset.sourceIdentities.version,
        sha256: dataset.sourceIdentityHash,
        enabled: options.sourceIdentities !== false,
        effectiveInputsChanged: options.sourceIdentities !== false,
        appliedCaseIds:
          options.sourceIdentities === false
            ? []
            : cases
                .filter((test) => dataset.sourceIdentities.cases[test.id])
                .map((test) => test.id),
        scope:
          'Only declared opaque physical-line identities and targeted source metadata; frozen economic fields and expected outcomes remain unchanged.',
      },
    },
    livePriority: false,
    deterministic: {
      ...summarize(results),
      bySplit: Object.fromEntries(
        ['development', 'held-out'].map((split) => [
          split,
          summarize(results.filter((row) => row.split === split)),
        ]),
      ),
      byCategory: Object.fromEntries(
        ['entity', 'query', 'workflow-report', 'guard'].map((category) => [
          category,
          summarize(results.filter((row) => row.category === category)),
        ]),
      ),
    },
    hostModel: {
      status: 'not-run',
      targetChoiceAccuracy: null,
      assistantCallReduction: null,
      tokens: null,
      plannedProfiles: ['full', 'operations'],
      plannedRepetitionsPerHeldOutCase: 3,
      note: 'Deterministic engines receive explicit structured inputs. No host, model tool selection, assistant turns or token telemetry was exercised.',
    },
    results,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const split = option('split', 'all');
  if (!['all', 'development', 'held-out'].includes(split))
    throw new Error('split must be all, development or held-out');
  const report = await runEvaluation({ split });
  const output = resolve(option('output', resolve(root, 'artifacts/evaluation/offline.json')));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.info(
    `Synthetic offline evaluation: ${report.deterministic.passed}/${report.deterministic.executed} passed; host/model not run. ${output}`,
  );
  for (const row of report.results.filter((row) => !row.passed))
    console.error(`${row.id}: ${row.failures.join('; ')}`);
  process.exitCode = report.deterministic.failed ? 1 : 0;
}
