import { randomUUID } from 'node:crypto';
import {
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
} from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import { loadConfig } from './config.js';
import { isAuthorized, isLoopbackHost, isOriginAllowed } from './lib/http-auth.js';
import type { Logger } from './logger.js';
import { createLogger } from './logger.js';
import { createServer } from './server.js';

const config = loadConfig();
const logger = createLogger(config);

if (config.mcpTransport === 'stdio') {
  const transport = new StdioServerTransport();
  await createServer(config, logger).connect(transport);
  logger.info('Priority MCP server running on stdio');
} else {
  startHttpServer(config, logger);
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

/** Read and JSON-parse a request body, capping size so a huge body can't exhaust memory. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const MAX_BODY_BYTES = 4 * 1024 * 1024; // 4 MB
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('Request body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

function startHttpServer(cfg: Config, log: Logger) {
  const host = cfg.mcpHttpHost;
  const token = cfg.mcpHttpAuthToken;
  const allowedOrigins = new Set(cfg.mcpHttpAllowedOrigins ?? []);

  // Fail SAFE: never expose a live-ERP proxy on a routable interface without a bearer token.
  if (!isLoopbackHost(host) && !token) {
    log.error(
      { host },
      'Refusing to start: HTTP transport bound to a non-loopback host without MCP_HTTP_AUTH_TOKEN. Set MCP_HTTP_AUTH_TOKEN to require a bearer token, or bind to 127.0.0.1 via MCP_HTTP_HOST.',
    );
    process.exit(1);
  }
  if (!token) {
    log.warn(
      { host },
      'HTTP transport has no MCP_HTTP_AUTH_TOKEN — every tool is reachable without credentials (bound to loopback only). Set a token before exposing the port.',
    );
  }

  // One transport (and its own MCP server) per session id — a single shared transport only ever
  // serves the first client and leaks streams across clients.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createHttpServer((req, res) => {
    // A throw inside an async handler would otherwise become an unhandled rejection and crash
    // the process (a one-packet remote DoS). Catch everything and answer with a 500.
    handleRequest(req, res).catch((err) => {
      log.error({ err }, 'Error handling HTTP request');
      sendJson(res, 500, { error: 'Internal server error' });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', `http://${host}:${cfg.mcpHttpPort}`).pathname;
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

    // DNS-rebinding defense: reject any browser Origin that is not explicitly allowlisted.
    if (!isOriginAllowed(req.headers.origin, allowedOrigins)) {
      sendJson(res, 403, { error: 'Forbidden origin' });
      return;
    }
    // Bearer-token gate for every /mcp request.
    if (!isAuthorized(req.headers.authorization, token)) {
      sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;

    if (req.method === 'POST') {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendJson(res, 400, { error: 'Invalid or oversized JSON body' });
        return;
      }

      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }
      if (!sessionId && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        await createServer(cfg, log).connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      sendJson(res, 400, {
        error: 'No valid session. Send an initialize request (without a session id) first.',
      });
      return;
    }

    // GET (SSE stream) and DELETE (session teardown) act on an existing session.
    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!existing) {
        sendJson(res, 404, { error: 'Unknown or missing session id' });
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  }

  httpServer.listen(cfg.mcpHttpPort, host, () => {
    log.info(
      { host, port: cfg.mcpHttpPort, authRequired: Boolean(token) },
      'Priority MCP server running on HTTP',
    );
  });
}
