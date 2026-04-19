import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import { PriorityClient } from './client/priority-client.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import { registerAllPrompts } from './prompts/index.js';

export function createServer(config: Config, logger: Logger): McpServer {
  const server = new McpServer({
    name: 'priority-mcp-server',
    version: '0.1.0',
  });

  const client = new PriorityClient(config, logger);

  registerAllTools(server, client, config);
  registerAllResources(server, client, config);
  registerAllPrompts(server);

  logger.info('MCP server initialized with Priority ERP backend');

  return server;
}
