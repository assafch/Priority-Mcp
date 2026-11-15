import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { dependenciesAllowed, effectiveTools } from '../src/lib/tool-profiles.js';
import { createServer } from '../src/server.js';
import legacyNames from './fixtures/legacy-tool-names.json';
import { config, logger } from './runtime-fixture.js';
async function manifest(profile: 'full' | 'operations') {
  const server = createServer({ ...config, priorityToolProfile: profile }, logger);
  const client = new Client({ name: 'profile', version: '1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    return await client.listTools();
  } finally {
    await client.close();
    await server.close();
  }
}
describe('stable compact discovery', () => {
  it('retains legacy names and limits opt-in operations manifest', async () => {
    const full = await manifest('full');
    const ops = await manifest('operations');
    expect(full.tools.length).toBeGreaterThanOrEqual(105);
    for (const name of legacyNames) expect(full.tools.map((t) => t.name)).toContain(name);
    expect(ops.tools.length).toBeLessThanOrEqual(25);
    expect(ops.tools.length).toBeGreaterThanOrEqual(20);
    expect(Buffer.byteLength(JSON.stringify(ops))).toBeLessThanOrEqual(40000);
    expect(ops.tools.map((t) => t.name)).toEqual(
      (await manifest('operations')).tools.map((t) => t.name),
    );
    for (const t of ops.tools) expect(full.tools.map((t) => t.name)).toContain(t.name);
  });
  it('intersects visibility with policy without making profile a security boundary', () => {
    expect(
      effectiveTools('operations', { ...config, priorityBlockedTools: ['priority_get_customer'] }),
    ).not.toContain('priority_get_customer');
    expect(
      dependenciesAllowed({ ...config, priorityToolProfile: 'operations' }, [
        'priority_get_customer_contacts',
      ]),
    ).toBe(true);
    expect(
      dependenciesAllowed({ ...config, priorityAllowedTools: ['priority_customer_snapshot'] }, [
        'priority_get_customer',
      ]),
    ).toBe(false);
    expect(
      dependenciesAllowed(
        {
          ...config,
          priorityAllowedTools: ['priority_customer_snapshot', 'priority_get_customer'],
        },
        ['priority_get_customer'],
      ),
    ).toBe(true);
  });
});
