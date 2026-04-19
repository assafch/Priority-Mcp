import { z } from 'zod';

const configSchema = z.object({
  priorityApiUrl: z
    .string({ message: 'PRIORITY_API_URL is required' })
    .url('PRIORITY_API_URL must be a valid URL'),
  priorityEnvironment: z.string({ message: 'PRIORITY_ENVIRONMENT is required' }).min(1),
  priorityCompany: z.string({ message: 'PRIORITY_COMPANY is required' }).min(1),
  priorityUsername: z.string({ message: 'PRIORITY_USERNAME is required' }).min(1),
  priorityPassword: z.string({ message: 'PRIORITY_PASSWORD is required' }).min(1),
  priorityLanguage: z.enum(['EN', 'HE']).default('EN'),
  priorityCustomPrefix: z.string().optional(),
  priorityCustomEntities: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : [])),
  priorityReadOnly: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  priorityAllowedTools: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined)),
  priorityBlockedTools: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').map((s) => s.trim()) : undefined)),
  cacheTtlSeconds: z.coerce.number().int().positive().default(60),
  rateLimitPerMinute: z.coerce.number().int().positive().default(120),
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  mcpTransport: z.enum(['stdio', 'http']).default('stdio'),
  mcpHttpPort: z.coerce.number().int().positive().default(3000),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const result = configSchema.safeParse({
    priorityApiUrl: process.env.PRIORITY_API_URL,
    priorityEnvironment: process.env.PRIORITY_ENVIRONMENT,
    priorityCompany: process.env.PRIORITY_COMPANY,
    priorityUsername: process.env.PRIORITY_USERNAME,
    priorityPassword: process.env.PRIORITY_PASSWORD,
    priorityLanguage: process.env.PRIORITY_LANGUAGE,
    priorityCustomPrefix: process.env.PRIORITY_CUSTOM_PREFIX,
    priorityCustomEntities: process.env.PRIORITY_CUSTOM_ENTITIES,
    priorityReadOnly: process.env.PRIORITY_READ_ONLY,
    priorityAllowedTools: process.env.PRIORITY_ALLOWED_TOOLS,
    priorityBlockedTools: process.env.PRIORITY_BLOCKED_TOOLS,
    cacheTtlSeconds: process.env.CACHE_TTL_SECONDS,
    rateLimitPerMinute: process.env.RATE_LIMIT_PER_MINUTE,
    logLevel: process.env.LOG_LEVEL,
    mcpTransport: process.env.MCP_TRANSPORT,
    mcpHttpPort: process.env.MCP_HTTP_PORT,
  });

  if (!result.success) {
    const errors = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    console.error(`Configuration error:\n${errors.join('\n')}`);
    process.exit(1);
  }

  return result.data;
}
