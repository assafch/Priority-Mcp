import { z } from 'zod';

/**
 * Parse PRIORITY_READ_ONLY, failing SAFE. Writes are enabled ONLY when the value is an
 * explicit, recognized "off" token (false / 0 / no / off / disabled, case- and space-insensitive).
 * A typo, an unrecognized value, or an UNSET variable all leave the server READ-ONLY (writes
 * disabled) — so a misconfiguration can never silently expose writes to a live ERP. This is the
 * opposite of a naive `v === 'true'`, under which 'True'/'TRUE'/'1'/'yes' (values meant to ENABLE
 * protection) silently turned it OFF.
 */
export function parseReadOnly(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  const WRITES_ENABLED = new Set(['false', '0', 'no', 'off', 'disabled']);
  const READ_ONLY = new Set(['true', '1', 'yes', 'on', 'enabled', '']); // '' = unset ⇒ safe default
  if (WRITES_ENABLED.has(v)) return false;
  if (READ_ONLY.has(v)) return true;
  // Unrecognized non-empty value: fail safe and make the misconfiguration visible on stderr
  // (stderr is safe for the stdio MCP transport; only stdout must stay clean).
  console.error(
    `[config] PRIORITY_READ_ONLY="${raw}" is not a recognized value; defaulting to READ-ONLY (writes disabled). Set PRIORITY_READ_ONLY=false to enable writes.`,
  );
  return true;
}

/** Parse a comma-separated tool list; an empty/whitespace-only value becomes undefined
 *  (NOT an empty array — an empty allowlist would otherwise de-register every tool). */
function parseToolList(v?: string): string[] | undefined {
  if (!v) return undefined;
  const list = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? list : undefined;
}

function connectionUrl(name: string) {
  return z
    .string()
    .url(`${name} must be a valid URL`)
    .refine((value) => {
      try {
        const url = new URL(value);
        return (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, `${name} must use HTTP(S) without credentials, query strings or fragments`);
}

const configSchema = z
  .object({
    // --- Priority connection ---
    // The OData service root is resolved with this precedence (see priority-client.ts):
    //   1. PRIORITY_SERVICE_ROOT (full root verbatim), else
    //   2. PRIORITY_BASE_URL + '/' + PRIORITY_COMPANY  (BASE_URL already includes the .ini), else
    //   3. PRIORITY_API_URL + '/' + PRIORITY_ENVIRONMENT + '/' + PRIORITY_COMPANY
    priorityServiceRoot: connectionUrl('PRIORITY_SERVICE_ROOT').optional(),
    // Base up to and INCLUDING the system .ini segment, e.g.
    //   https://p.priority-connect.online/odata/Priority/tabp008h.ini
    priorityBaseUrl: connectionUrl('PRIORITY_BASE_URL').optional(),
    priorityApiUrl: connectionUrl('PRIORITY_API_URL').optional(),
    // The system-database / .ini segment between `/odata/Priority/` and the company, used
    // only with PRIORITY_API_URL. Often `tabula.ini`, but installation-specific (e.g.
    // `tabp008h.ini`). Prefer folding it into PRIORITY_BASE_URL.
    priorityEnvironment: z.string().min(1).default('tabula.ini'),
    priorityCompany: z.string().min(1).optional(),
    // Auth (HTTP Basic). Preferred: PRIORITY_PAT — a Personal Access Token sent as
    // base64(<PAT>:PAT). Alternative: PRIORITY_USERNAME + PRIORITY_PASSWORD (classic on-prem,
    // or the manual PAT form USERNAME=<token> PASSWORD=PAT).
    priorityPat: z.string().min(1).optional(),
    priorityUsername: z.string().min(1).optional(),
    priorityPassword: z.string().min(1).optional(),
    // Optional per-application licensing headers (Priority 18.3+).
    priorityAppId: z.string().optional(),
    priorityAppKey: z.string().optional(),
    priorityLanguage: z.enum(['EN', 'HE']).default('EN'),
    priorityCustomPrefix: z.string().optional(),
    priorityCustomEntities: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(',').map((s) => s.trim()) : [])),
    priorityReadOnly: z.string().optional().transform(parseReadOnly),
    priorityCoalesceReads: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    priorityReportConcurrency: z.coerce.number().int().min(1).max(2).default(2),
    priorityToolProfile: z.enum(['full', 'operations']).default('full'),
    priorityAllowedTools: z.string().optional().transform(parseToolList),
    priorityBlockedTools: z.string().optional().transform(parseToolList),
    cacheTtlSeconds: z.coerce.number().int().positive().default(60),
    cacheMaxBytes: z.coerce
      .number()
      .int()
      .positive()
      .default(32 * 1024 * 1024),
    priorityRateScope: z.string().min(1).optional(),
    priorityMaxConcurrency: z.coerce.number().int().positive().default(4),
    priorityMaxPending: z.coerce.number().int().positive().default(100),
    priorityMaxReadBodyBytes: z.coerce
      .number()
      .int()
      .positive()
      .default(16 * 1024 * 1024),
    priorityMaxMetadataBodyBytes: z.coerce
      .number()
      .int()
      .positive()
      .default(32 * 1024 * 1024),
    rateLimitPerMinute: z.coerce.number().int().positive().default(90),
    // Per-request timeout (ms). Bounds a hung Priority endpoint (undici would otherwise wait
    // ~5 min per attempt). Generous by default so heavy $expand windows still complete.
    requestTimeoutMs: z.coerce.number().int().positive().default(120000),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    mcpTransport: z.enum(['stdio', 'http']).default('stdio'),
    mcpHttpPort: z.coerce.number().int().positive().default(3000),
    // HTTP transport hardening. Default host is loopback so the server is NOT exposed to the
    // network unless the operator opts in. A bearer token (if set) is required on every /mcp
    // request; browser Origins must be allowlisted (DNS-rebinding defense).
    mcpHttpHost: z.string().min(1).default('127.0.0.1'),
    mcpHttpAuthToken: z.string().min(1).optional(),
    mcpHttpAllowedOrigins: z.string().optional().transform(parseToolList),
  })
  .superRefine((cfg, ctx) => {
    // Need a way to build the service root.
    if (!cfg.priorityServiceRoot && !cfg.priorityBaseUrl && !cfg.priorityApiUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['priorityBaseUrl'],
        message:
          'Provide PRIORITY_BASE_URL (+ PRIORITY_COMPANY), or PRIORITY_API_URL (+ PRIORITY_COMPANY), or PRIORITY_SERVICE_ROOT',
      });
    }
    // Company is required unless the full service root is given explicitly.
    if (!cfg.priorityServiceRoot && !cfg.priorityCompany) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['priorityCompany'],
        message: 'PRIORITY_COMPANY is required unless PRIORITY_SERVICE_ROOT is set',
      });
    }
    // Need credentials: a PAT, or a username+password pair.
    if (!cfg.priorityPat && !(cfg.priorityUsername && cfg.priorityPassword)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['priorityPat'],
        message: 'Provide PRIORITY_PAT, or PRIORITY_USERNAME + PRIORITY_PASSWORD',
      });
    }
  });

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse({
    priorityServiceRoot: env.PRIORITY_SERVICE_ROOT,
    priorityBaseUrl: env.PRIORITY_BASE_URL,
    priorityApiUrl: env.PRIORITY_API_URL,
    priorityEnvironment: env.PRIORITY_ENVIRONMENT,
    priorityCompany: env.PRIORITY_COMPANY,
    priorityPat: env.PRIORITY_PAT,
    priorityUsername: env.PRIORITY_USERNAME,
    priorityPassword: env.PRIORITY_PASSWORD,
    priorityAppId: env.PRIORITY_APP_ID,
    priorityAppKey: env.PRIORITY_APP_KEY,
    priorityLanguage: env.PRIORITY_LANGUAGE,
    priorityCustomPrefix: env.PRIORITY_CUSTOM_PREFIX,
    priorityCustomEntities: env.PRIORITY_CUSTOM_ENTITIES,
    priorityReadOnly: env.PRIORITY_READ_ONLY,
    priorityCoalesceReads: env.PRIORITY_COALESCE_READS,
    priorityReportConcurrency: env.PRIORITY_REPORT_CONCURRENCY,
    priorityToolProfile: env.PRIORITY_TOOL_PROFILE,
    priorityAllowedTools: env.PRIORITY_ALLOWED_TOOLS,
    priorityBlockedTools: env.PRIORITY_BLOCKED_TOOLS,
    cacheTtlSeconds: env.CACHE_TTL_SECONDS,
    cacheMaxBytes: env.CACHE_MAX_BYTES,
    priorityRateScope: env.PRIORITY_RATE_SCOPE,
    priorityMaxConcurrency: env.PRIORITY_MAX_CONCURRENCY,
    priorityMaxPending: env.PRIORITY_MAX_PENDING,
    priorityMaxReadBodyBytes: env.PRIORITY_MAX_READ_BODY_BYTES,
    priorityMaxMetadataBodyBytes: env.PRIORITY_MAX_METADATA_BODY_BYTES,
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    logLevel: env.LOG_LEVEL,
    mcpTransport: env.MCP_TRANSPORT,
    mcpHttpPort: env.MCP_HTTP_PORT,
    mcpHttpHost: env.MCP_HTTP_HOST,
    mcpHttpAuthToken: env.MCP_HTTP_AUTH_TOKEN,
    mcpHttpAllowedOrigins: env.MCP_HTTP_ALLOWED_ORIGINS,
  });

  if (!result.success) {
    const errors = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    console.error(`Configuration error:\n${errors.join('\n')}`);
    process.exit(1);
  }

  if (result.data.rateLimitPerMinute > 90)
    console.error(
      '[config] RATE_LIMIT_PER_MINUTE exceeds the conservative process-local default; confirm the account limit and budget other integrations separately.',
    );
  return result.data;
}
