import pino from 'pino';
import type { Config } from '../src/config.js';
export const logger = pino({ level: 'silent' });
export const config = {
  priorityBaseUrl: 'https://example.test/odata/Priority/real.ini',
  priorityCompany: 'demo',
  priorityEnvironment: 'ignored.ini',
  priorityUsername: 'synthetic-legacy-PAT-secret',
  priorityPassword: 'PAT',
  priorityLanguage: 'EN',
  priorityCustomEntities: [],
  priorityReadOnly: true,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 120,
  requestTimeoutMs: 1000,
  logLevel: 'error',
  mcpTransport: 'http',
  mcpHttpPort: 3000,
  mcpHttpHost: '127.0.0.1',
  mcpHttpAuthToken: 'http-test-secret',
} as Config;
