import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PriorityClient } from './client/priority-client.js';
import type { Config } from './config.js';
import { packageVersion } from './lib/connection-info.js';
import type { Logger } from './logger.js';
import { registerAllPrompts } from './prompts/index.js';
import { registerAllResources } from './resources/index.js';
import { registerAllTools } from './tools/index.js';

export function createServer(
  config: Config,
  logger: Logger,
  sharedClient?: PriorityClient,
): McpServer {
  const server = new McpServer({
    name: 'priority-mcp-server',
    version: packageVersion,
  });

  const client = sharedClient ?? new PriorityClient(config, logger);

  registerAllTools(server, client, config);
  registerAllResources(server, client, config);
  registerAllPrompts(server);

  logger.info('MCP server initialized with Priority ERP backend');

  return server;
}
