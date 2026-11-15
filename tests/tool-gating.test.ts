import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { createServer } from '../src/server.js';

// Minimal valid Config for offline server construction. createServer only builds a PriorityClient
// (no network at construction) and registers tools/resources/prompts; listTools needs no backend.
const baseConfig = {
  priorityBaseUrl: 'https://example.test/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityPat: 'test-token',
  priorityEnvironment: 'tabula.ini',
  priorityLanguage: 'EN',
  priorityCustomEntities: [],
  priorityReadOnly: true,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 120,
  requestTimeoutMs: 120000,
  logLevel: 'error',
  mcpTransport: 'stdio',
  mcpHttpPort: 3000,
  mcpHttpHost: '127.0.0.1',
  priorityAllowedTools: undefined,
  priorityBlockedTools: undefined,
} as unknown as Config;

/** Build a server with the given gate config, connect an in-memory client, return the tool names. */
async function listToolNames(overrides: Partial<Config>): Promise<string[]> {
  const config = { ...baseConfig, ...overrides } as Config;
  const server = createServer(config, createLogger(config));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'gating-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('tool-registration gating', () => {
  it('registers all tools when no allow/block list is set', async () => {
    const names = await listToolNames({});
    expect(names).toContain('impfile_search');
    expect(names).toContain('priority_query');
    expect(names.length).toBeGreaterThan(50);
  });

  // Regression for the "empty effective tool set" bug: an allowlist whose names match no tool
  // (e.g. a typo) must still leave the server advertising the tools capability so tools/list
  // returns an empty array rather than a JSON-RPC "Method not found" error.
  it('an allowlist matching NO tool yields an empty tools/list, not an error', async () => {
    await expect(listToolNames({ priorityAllowedTools: ['__no_such_tool__'] })).resolves.toEqual(
      [],
    );
  });

  it('honors a non-empty allowlist (only listed tools are exposed)', async () => {
    const names = await listToolNames({ priorityAllowedTools: ['impfile_search', 'impfile_get'] });
    expect([...names].sort()).toEqual(['impfile_get', 'impfile_search']);
  });

  it('a blocklist hides the blocked tool but keeps the rest', async () => {
    const names = await listToolNames({ priorityBlockedTools: ['impfile_search'] });
    expect(names).not.toContain('impfile_search');
    expect(names).toContain('impfile_get');
  });
});
