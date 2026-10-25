#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { startHttpServer } from './http.js';
import { createLogger } from './logger.js';
import { createServer } from './server.js';

const config = loadConfig();
const logger = createLogger(config);
let close: () => Promise<void>;
if (config.mcpTransport === 'stdio') {
  const server = createServer(config, logger);
  await server.connect(new StdioServerTransport());
  close = () => server.close();
  logger.info('Priority MCP server running on stdio');
} else {
  try {
    const runtime = await startHttpServer(config, logger);
    close = runtime.close;
  } catch {
    logger.error('HTTP startup failed. Check bind address, port and bearer token configuration.');
    process.exit(1);
  }
}
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await close();
  } catch {
    logger.error('Server shutdown failed');
    process.exitCode = 1;
  }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
