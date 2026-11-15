import { createHash, randomUUID } from 'node:crypto';
import {
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
} from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { PriorityClient } from './client/priority-client.js';
import type { Config } from './config.js';
import { isAuthorized, isLoopbackHost, isOriginAllowed } from './lib/http-auth.js';
import type { Logger } from './logger.js';
import { createServer } from './server.js';

export const SESSION_TTL_MS = 30 * 60_000;
export const MAX_SESSIONS = 100;
const backendPool = new Map<string, { client: PriorityClient; references: number }>();
function acquireBackend(config: Config, logger: Logger) {
  // Only backend configuration belongs in the identity; listening ports and HTTP tokens do not.
  // Hash credentials so pool keys cannot expose them in diagnostics.
  const backend = Object.fromEntries(
    Object.entries(config)
      .filter(([key]) => !key.startsWith('mcp') && key !== 'logLevel')
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const key = createHash('sha256').update(JSON.stringify(backend)).digest('hex');
  let shared = backendPool.get(key);
  if (!shared) {
    shared = { client: new PriorityClient(config, logger), references: 0 };
    backendPool.set(key, shared);
  }
  shared.references++;
  let released = false;
  return {
    client: shared.client,
    release: () => {
      if (released) return;
      released = true;
      if (--shared.references === 0) {
        backendPool.delete(key);
        shared.client.close();
      }
    },
  };
}
export interface HttpOptions {
  client?: PriorityClient;
  now?: () => number;
  createMcpServer?: (config: Config, logger: Logger, client: PriorityClient) => McpServer;
}
interface Session {
  transport: StreamableHTTPServerTransport;
  server?: McpServer;
  lastUsed: number;
  active: number;
  closing?: Promise<void>;
}
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
async function readJsonBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 4 * 1024 * 1024) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

/** Start a closeable, bounded HTTP runtime. No Priority request is made during startup. */
export async function startHttpServer(config: Config, logger: Logger, options: HttpOptions = {}) {
  if (!isLoopbackHost(config.mcpHttpHost) && !config.mcpHttpAuthToken) {
    throw new Error('Non-loopback HTTP binding requires MCP_HTTP_AUTH_TOKEN (bearer token).');
  }
  const shared = options.client
    ? { client: options.client, release: () => {} }
    : acquireBackend(config, logger);
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Session>();
  const records = new Set<Session>(); // Includes pending initializes so concurrent init cannot exceed the cap.
  const origins = new Set(config.mcpHttpAllowedOrigins ?? []);
  let stopping = false;
  function forget(record: Session) {
    records.delete(record);
    if (record.transport.sessionId) sessions.delete(record.transport.sessionId);
  }
  async function dispose(record: Session) {
    if (record.closing) return record.closing;
    forget(record);
    record.closing = (async () => {
      try {
        if (record.server) await record.server.close();
      } finally {
        await record.transport.close();
      }
    })();
    return record.closing;
  }
  async function cleanupSessions() {
    await Promise.all(
      [...records]
        .filter((record) => !record.active && now() - record.lastUsed >= SESSION_TTL_MS)
        .map(dispose),
    );
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (stopping) {
      sendJson(res, 503, { error: 'Server shutting down' });
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendJson(res, 400, { error: 'Bad request URL' });
      return;
    }
    if (pathname === '/health') {
      sendJson(res, 200, { status: 'ok', server: 'priority-mcp-server' });
      return;
    }
    if (pathname !== '/mcp') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    if (!isOriginAllowed(req.headers.origin, origins)) {
      sendJson(res, 403, { error: 'Forbidden origin' });
      return;
    }
    if (!isAuthorized(req.headers.authorization, config.mcpHttpAuthToken)) {
      sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    await cleanupSessions();
    const sid = req.headers['mcp-session-id'];
    const record = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (sid && !record) {
      sendJson(res, 404, { error: 'Unknown session id' });
      return;
    }
    if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '')) {
      sendJson(res, 405, { error: 'Method not allowed' }, { Allow: 'POST, GET, DELETE' });
      return;
    }
    let body: unknown;
    if (req.method === 'POST') {
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'Invalid or oversized JSON body' });
        return;
      }
    }
    if (record) {
      record.active++;
      record.lastUsed = now();
      try {
        await record.transport.handleRequest(req, res, body);
      } finally {
        record.active--;
        record.lastUsed = now();
        if (req.method === 'DELETE') await dispose(record);
      }
      return;
    }
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      sendJson(res, 400, { error: 'Send an initialize request without a session id first.' });
      return;
    }
    if (records.size >= MAX_SESSIONS) {
      sendJson(res, 503, { error: 'Session limit reached' }, { 'Retry-After': '60' });
      return;
    }
    const fresh: Session = {
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          sessions.set(sid, fresh);
        },
      }),
      lastUsed: now(),
      active: 1,
    };
    records.add(fresh);
    try {
      fresh.server = (options.createMcpServer ?? createServer)(config, logger, shared.client);
      await fresh.server.connect(fresh.transport);
      if (stopping) {
        await dispose(fresh);
        sendJson(res, 503, { error: 'Server shutting down' });
        return;
      }
      // Protocol.connect installs its own close handler: preserve it when adding ownership cleanup.
      const protocolClose = fresh.transport.onclose;
      fresh.transport.onclose = () => {
        forget(fresh);
        protocolClose?.();
      };
      await fresh.transport.handleRequest(req, res, body);
      if (!fresh.transport.sessionId || res.statusCode >= 400) await dispose(fresh);
    } catch (err) {
      await dispose(fresh);
      throw err;
    } finally {
      fresh.active--;
      fresh.lastUsed = now();
    }
  }
  const httpServer = createHttpServer((req, res) => {
    handle(req, res).catch(() => {
      // Deliberately exclude request/backend errors: their URLs or payloads may contain credentials.
      logger.error('Error handling HTTP request');
      sendJson(res, 500, { error: 'Internal server error' });
    });
  });
  const timer = setInterval(() => {
    cleanupSessions().catch(() => logger.error('Session cleanup failed'));
  }, 60_000);
  timer.unref();
  let closePromise: Promise<void> | undefined;
  function close() {
    if (closePromise) return closePromise;
    stopping = true;
    clearInterval(timer);
    closePromise = (async () => {
      try {
        await Promise.allSettled([...records].map(dispose));
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
          httpServer.closeAllConnections();
        });
      } finally {
        shared.release();
      }
    })();
    return closePromise;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(config.mcpHttpPort, config.mcpHttpHost, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
  } catch (err) {
    clearInterval(timer);
    shared.release();
    throw err;
  }
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('HTTP listener has no TCP address');
  const host = address.address.includes(':') ? `[${address.address}]` : address.address;
  const url = `http://${host}:${address.port}`;
  logger.info(
    {
      host: config.mcpHttpHost,
      port: address.port,
      authRequired: Boolean(config.mcpHttpAuthToken),
    },
    'Priority MCP server running on HTTP',
  );
  return {
    httpServer,
    url,
    close,
    cleanupSessions,
    get sessionCount() {
      return records.size;
    },
  };
}
