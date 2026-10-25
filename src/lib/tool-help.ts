import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
const descriptions = new WeakMap<McpServer, Map<string, string>>();
export function rememberToolHelp(server: McpServer, name: string, text: string): void {
  let entries = descriptions.get(server);
  if (!entries) {
    entries = new Map();
    descriptions.set(server, entries);
  }
  entries.set(name, text);
}
export function toolHelp(server: McpServer, name: string): string | undefined {
  const target =
    (server as unknown as Record<symbol, McpServer>)[Symbol.for('priority.registry.server')] ??
    server;
  return descriptions.get(target)?.get(name);
}
