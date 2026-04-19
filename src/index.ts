import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createServer } from './server.js';

const config = loadConfig();
const logger = createLogger(config);
const mcpServer = createServer(config, logger);

if (config.mcpTransport === 'stdio') {
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  logger.info('Priority MCP server running on stdio');
} else {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await mcpServer.connect(transport);

  const httpServer = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${config.mcpHttpPort}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', server: 'priority-mcp-server' }));
      return;
    }

    if (url.pathname === '/mcp') {
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  httpServer.listen(config.mcpHttpPort, () => {
    logger.info({ port: config.mcpHttpPort }, 'Priority MCP server running on HTTP');
  });
}
