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

const configSchema = z
  .object({
    // --- Priority connection ---
    // The OData service root is resolved with this precedence (see priority-client.ts):
    //   1. PRIORITY_SERVICE_ROOT (full root verbatim), else
    //   2. PRIORITY_BASE_URL + '/' + PRIORITY_COMPANY  (BASE_URL already includes the .ini), else
    //   3. PRIORITY_API_URL + '/' + PRIORITY_ENVIRONMENT + '/' + PRIORITY_COMPANY
    priorityServiceRoot: z.string().url('PRIORITY_SERVICE_ROOT must be a valid URL').optional(),
    // Base up to and INCLUDING the system .ini segment, e.g.
    //   https://p.priority-connect.online/odata/Priority/tabp008h.ini
    priorityBaseUrl: z.string().url('PRIORITY_BASE_URL must be a valid URL').optional(),
    priorityApiUrl: z.string().url('PRIORITY_API_URL must be a valid URL').optional(),
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
    priorityAllowedTools: z.string().optional().transform(parseToolList),
    priorityBlockedTools: z.string().optional().transform(parseToolList),
    cacheTtlSeconds: z.coerce.number().int().positive().default(60),
    rateLimitPerMinute: z.coerce.number().int().positive().default(120),
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

export function loadConfig(): Config {
  const result = configSchema.safeParse({
    priorityServiceRoot: process.env.PRIORITY_SERVICE_ROOT,
    priorityBaseUrl: process.env.PRIORITY_BASE_URL,
    priorityApiUrl: process.env.PRIORITY_API_URL,
    priorityEnvironment: process.env.PRIORITY_ENVIRONMENT,
    priorityCompany: process.env.PRIORITY_COMPANY,
    priorityPat: process.env.PRIORITY_PAT,
    priorityUsername: process.env.PRIORITY_USERNAME,
    priorityPassword: process.env.PRIORITY_PASSWORD,
    priorityAppId: process.env.PRIORITY_APP_ID,
    priorityAppKey: process.env.PRIORITY_APP_KEY,
    priorityLanguage: process.env.PRIORITY_LANGUAGE,
    priorityCustomPrefix: process.env.PRIORITY_CUSTOM_PREFIX,
    priorityCustomEntities: process.env.PRIORITY_CUSTOM_ENTITIES,
    priorityReadOnly: process.env.PRIORITY_READ_ONLY,
    priorityAllowedTools: process.env.PRIORITY_ALLOWED_TOOLS,
    priorityBlockedTools: process.env.PRIORITY_BLOCKED_TOOLS,
    cacheTtlSeconds: process.env.CACHE_TTL_SECONDS,
    rateLimitPerMinute: process.env.RATE_LIMIT_PER_MINUTE,
    requestTimeoutMs: process.env.REQUEST_TIMEOUT_MS,
    logLevel: process.env.LOG_LEVEL,
    mcpTransport: process.env.MCP_TRANSPORT,
    mcpHttpPort: process.env.MCP_HTTP_PORT,
    mcpHttpHost: process.env.MCP_HTTP_HOST,
    mcpHttpAuthToken: process.env.MCP_HTTP_AUTH_TOKEN,
    mcpHttpAllowedOrigins: process.env.MCP_HTTP_ALLOWED_ORIGINS,
  });

  if (!result.success) {
    const errors = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    console.error(`Configuration error:\n${errors.join('\n')}`);
    process.exit(1);
  }

  return result.data;
}
