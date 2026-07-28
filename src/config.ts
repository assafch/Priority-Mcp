import { z } from 'zod';

const configSchema = z.object({
  priorityServiceRoot: z.string().url('PRIORITY_SERVICE_ROOT must be a valid URL').optional(),
  priorityApiUrl: z.string().url('PRIORITY_API_URL must be a valid URL').optional(),
  priorityEnvironment: z.string().min(1).optional(),
  priorityCompany: z.string().min(1).optional(),
  priorityUsername: z.string({ message: 'PRIORITY_USERNAME is required' }).min(1),
  priorityPassword: z.string().min(1).optional(),
  priorityAuthType: z.enum(['basic', 'pat']).default('basic'),
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
}).superRefine((config, ctx) => {
  if (!config.priorityServiceRoot) {
    for (const [field, value] of [
      ['priorityApiUrl', config.priorityApiUrl],
      ['priorityEnvironment', config.priorityEnvironment],
      ['priorityCompany', config.priorityCompany],
    ] as const) {
      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: 'Required when PRIORITY_SERVICE_ROOT is not set',
        });
      }
    }
  }

  if (config.priorityAuthType === 'basic' && !config.priorityPassword) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['priorityPassword'],
      message: 'PRIORITY_PASSWORD is required when PRIORITY_AUTH_TYPE is basic',
    });
  }
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(env: NodeJS.ProcessEnv): Config {
  const result = configSchema.safeParse({
    priorityServiceRoot: env.PRIORITY_SERVICE_ROOT,
    priorityApiUrl: env.PRIORITY_API_URL,
    priorityEnvironment: env.PRIORITY_ENVIRONMENT,
    priorityCompany: env.PRIORITY_COMPANY,
    priorityUsername: env.PRIORITY_USERNAME,
    priorityPassword: env.PRIORITY_PASSWORD,
    priorityAuthType: env.PRIORITY_AUTH_TYPE,
    priorityLanguage: env.PRIORITY_LANGUAGE,
    priorityCustomPrefix: env.PRIORITY_CUSTOM_PREFIX,
    priorityCustomEntities: env.PRIORITY_CUSTOM_ENTITIES,
    priorityReadOnly: env.PRIORITY_READ_ONLY,
    priorityAllowedTools: env.PRIORITY_ALLOWED_TOOLS,
    priorityBlockedTools: env.PRIORITY_BLOCKED_TOOLS,
    cacheTtlSeconds: env.CACHE_TTL_SECONDS,
    rateLimitPerMinute: env.RATE_LIMIT_PER_MINUTE,
    logLevel: env.LOG_LEVEL,
    mcpTransport: env.MCP_TRANSPORT,
    mcpHttpPort: env.MCP_HTTP_PORT,
  });

  if (!result.success) {
    throw result.error;
  }

  return result.data;
}

export function loadConfig(): Config {
  try {
    return parseConfig(process.env);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errors = error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
      console.error(`Configuration error:\n${errors.join('\n')}`);
      process.exit(1);
    }
    throw error;
  }
}
