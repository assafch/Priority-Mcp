import pino from 'pino';
import type { Config } from './config.js';

export function createLogger(config: Config) {
  return pino({
    level: config.logLevel,
    transport:
      config.mcpTransport === 'http'
        ? { target: 'pino/file', options: { destination: 2 } } // stderr
        : { target: 'pino/file', options: { destination: 2 } }, // always stderr, stdout is MCP
    redact: {
      paths: [
        'priorityPassword',
        'password',
        'authorization',
        'req.headers.authorization',
        '*.phone',
        '*.email',
        '*.taxId',
        '*.PHONE',
        '*.EMAIL',
        '*.WTAXNUM',
      ],
      censor: '[REDACTED]',
    },
  });
}

export type Logger = pino.Logger;
