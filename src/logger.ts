import pino, { type DestinationStream } from 'pino';
import type { Config } from './config.js';

export function createLogger(config: Config, destination?: DestinationStream) {
  const options: pino.LoggerOptions = {
    level: config.logLevel,
    transport: destination
      ? undefined
      : config.mcpTransport === 'http'
        ? { target: 'pino/file', options: { destination: 2 } } // stderr
        : { target: 'pino/file', options: { destination: 2 } }, // always stderr, stdout is MCP
    redact: {
      paths: [
        'url',
        'query',
        'filter',
        'body',
        'rawBody',
        'headers',
        'err',
        '*.url',
        '*.query',
        '*.filter',
        '*.body',
        '*.rawBody',
        '*.headers',
        '*.err',
        'priorityUsername',
        'mcpHttpAuthToken',
        'token',
        'accessToken',
        'refreshToken',
        'cookie',
        '*.authorization',
        'req.headers.cookie',
        'priorityPat',
        'priorityPassword',
        'password',
        'pat',
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
  };
  return destination ? pino(options, destination) : pino(options);
}

export type Logger = pino.Logger;
