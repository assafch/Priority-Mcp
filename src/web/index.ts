import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createWebApp } from './app.js';
import { webConfig } from './config.js';
import { WebStore } from './store.js';

// Deliberately does not load .env, loadConfig(), createServer(), or any Priority/MCP client.
process.umask(0o077);
const config = webConfig();
const store = new WebStore(config.dbPath);
const app = createWebApp(store, config);
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  console.info(
    `Demo request portal: ${config.origin} — local database only; Priority writes blocked.`,
  );
  if (!store.db.prepare('SELECT id FROM users WHERE disabled=0 LIMIT 1').get()) {
    console.info('No agent account configured. Run npm run web:setup in a separate terminal.');
  }
}) as Server;
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.on('error', () => {
  console.error('Web server could not listen. Check that the local port is available.');
  store.close();
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
    server.closeIdleConnections();
  });
