import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { config, logger } from './runtime-fixture.js';

describe('effective public connection identity', () => {
  it('never emits a legacy PAT and uses effective root/environment/company and release version', async () => {
    const cfg = {
      ...config,
      priorityServiceRoot:
        'https://user:embedded-secret@example.test/odata/Priority/live.ini,3/actual?token=query-secret#secret',
      priorityCompany: 'ignored',
    };
    const server = createServer(cfg, logger);
    const client = new Client({ name: 'identity-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      for (const uri of ['priority://user/profile', 'priority://company/info']) {
        const result = await client.readResource({ uri });
        const serialized = JSON.stringify(result);
        for (const secret of ['synthetic-legacy-PAT-secret', 'embedded-secret', 'query-secret'])
          expect(serialized).not.toContain(secret);
        const info = JSON.parse((result.contents[0] as { text: string }).text);
        expect(info.company).toBe('actual');
        expect(info.environment).toBe('live.ini,3');
        expect(info.serviceRoot).toBe('https://example.test/odata/Priority/live.ini,3/actual');
      }
      expect(client.getServerVersion()?.version).toBe(
        JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
      );
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('reports base-url precedence and explicit PAT identity without unused username', async () => {
    const { connectionInfo } = await import('../src/lib/connection-info.js');
    expect(
      connectionInfo({
        ...config,
        priorityPat: 'explicit-secret',
        priorityUsername: 'unused-user',
      }),
    ).toMatchObject({ company: 'demo', environment: 'real.ini', authentication: 'pat' });
    expect(
      JSON.stringify(
        connectionInfo({
          ...config,
          priorityPat: 'explicit-secret',
          priorityUsername: 'unused-user',
        }),
      ),
    ).not.toContain('unused-user');
    expect(
      connectionInfo({
        ...config,
        priorityBaseUrl: undefined,
        priorityApiUrl: 'https://example.test/odata/Priority',
        priorityEnvironment: 'api.ini',
        priorityUsername: 'classic-user',
        priorityPassword: 'classic-secret',
      }),
    ).toMatchObject({ environment: 'api.ini', username: 'classic-user', authentication: 'basic' });
  });
});
