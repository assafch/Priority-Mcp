import { createServer as nodeServer, request } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { PriorityClient } from '../src/client/priority-client.js';
import { RateLimiter } from '../src/client/rate-limit.js';
import { startHttpServer } from '../src/http.js';
import { createServer } from '../src/server.js';
import { config, logger } from './runtime-fixture.js';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(
    closers
      .splice(0)
      .reverse()
      .map((close) => close()),
  );
  vi.restoreAllMocks();
});
const headers = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  Authorization: 'Bearer http-test-secret',
};
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'offline-test', version: '1' },
  },
};
async function start(overrides = {}, options: Parameters<typeof startHttpServer>[2] = {}) {
  const runtime = await startHttpServer(
    { ...config, mcpHttpPort: 0, ...overrides },
    logger,
    options,
  );
  closers.push(() => runtime.close());
  return runtime;
}
async function init(runtime: Awaited<ReturnType<typeof start>>) {
  const response = await fetch(`${runtime.url}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(initialize),
  });
  await response.json();
  expect(response.status).toBe(200);
  const sid = response.headers.get('mcp-session-id');
  if (!sid) throw new Error('Missing initialized session id');
  return sid;
}
async function rpc(
  runtime: Awaited<ReturnType<typeof start>>,
  sid: string,
  method: string,
  params: unknown = {},
) {
  const response = await fetch(`${runtime.url}/mcp`, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
  });
  return { status: response.status, body: await response.json() };
}

describe('HTTP real listener lifecycle', () => {
  it('releases a server-owned client once and leaves a borrowed client to its owner', async () => {
    const close = vi.spyOn(PriorityClient.prototype, 'close');
    const owned = createServer(config, logger);
    await owned.close();
    await owned.close();
    expect(close).toHaveBeenCalledTimes(1);
    const borrowed = new PriorityClient(config, logger);
    const server = createServer(config, logger, borrowed);
    await server.close();
    expect(close).toHaveBeenCalledTimes(1);
    borrowed.close();
    expect(close).toHaveBeenCalledTimes(2);
  });
  it('initializes independent sessions, lists/calls tools and deletes with bearer and Origin gates', async () => {
    const fake = {
      list: vi.fn().mockResolvedValue({ value: [{ CUSTNAME: 'offline' }] }),
    } as unknown as PriorityClient;
    const runtime = await start({}, { client: fake });
    expect(
      (
        await fetch(`${runtime.url}/mcp`, {
          method: 'POST',
          headers: { ...headers, Authorization: 'Bearer wrong' },
          body: JSON.stringify(initialize),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${runtime.url}/mcp`, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://evil.example' },
          body: JSON.stringify(initialize),
        })
      ).status,
    ).toBe(403);
    const first = await init(runtime);
    const second = await init(runtime);
    expect(first).not.toBe(second);
    expect(runtime.sessionCount).toBe(2);
    expect((await rpc(runtime, first, 'tools/list')).body.result.tools.length).toBeGreaterThan(50);
    const result = await rpc(runtime, second, 'tools/call', {
      name: 'priority_query',
      arguments: { form: 'CUSTOMERS', top: 1 },
    });
    expect(result.body.result.isError).not.toBe(true);
    expect(JSON.stringify(result.body)).toContain('offline');
    const removed = await fetch(`${runtime.url}/mcp`, {
      method: 'DELETE',
      headers: { ...headers, 'mcp-session-id': first },
    });
    expect(removed.status).toBe(200);
    expect(runtime.sessionCount).toBe(1);
    expect((await rpc(runtime, first, 'tools/list')).status).toBe(404);
    await runtime.close();
    expect(runtime.sessionCount).toBe(0);
  });
  it('expires sessions at 30 minutes idle, refreshes activity and caps at 100', async () => {
    let now = 1;
    const runtime = await start({}, { now: () => now });
    const first = await init(runtime);
    now += 29 * 60_000;
    await rpc(runtime, first, 'tools/list');
    now += 2 * 60_000;
    await runtime.cleanupSessions();
    expect(runtime.sessionCount).toBe(1);
    now += 28 * 60_000;
    await runtime.cleanupSessions();
    expect(runtime.sessionCount).toBe(0);
    for (let i = 0; i < 100; i++) await init(runtime);
    const full = await fetch(`${runtime.url}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(initialize),
    });
    expect(full.status).toBe(503);
    expect(runtime.sessionCount).toBe(100);
  });
  it('cleans failed connect and invalid initialize attempts without consuming slots', async () => {
    const broken = {
      connect: vi.fn().mockRejectedValue(new Error('offline connect failure')),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = await start({}, { createMcpServer: () => broken as unknown as McpServer });
    const response = await fetch(`${runtime.url}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(initialize),
    });
    expect(response.status).toBe(500);
    expect(runtime.sessionCount).toBe(0);
    expect(broken.close).toHaveBeenCalledOnce();
  });
  it('rejects malformed initialize without leaking a session slot and accepts an allowlisted Origin', async () => {
    const runtime = await start({ mcpHttpAllowedOrigins: ['https://allowed.example'] });
    const invalid = await fetch(`${runtime.url}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...initialize, params: {} }),
    });
    expect(invalid.status).toBe(400);
    expect(runtime.sessionCount).toBe(0);
    const allowed = await fetch(`${runtime.url}/mcp`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://allowed.example' },
      body: JSON.stringify(initialize),
    });
    expect(allowed.status).toBe(200);
    await allowed.json();
    expect(runtime.sessionCount).toBe(1);
  });
  it('closes pending request sockets during shutdown', async () => {
    const runtime = await start();
    const arrived = new Promise<void>((resolve) =>
      runtime.httpServer.once('request', () => resolve()),
    );
    const stalled = request(`${runtime.url}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': '100000' },
    });
    stalled.on('error', () => {});
    stalled.write('{');
    await arrived;
    const result = await Promise.race([
      runtime.close().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('stalled'), 200)),
    ]);
    stalled.destroy();
    expect(result).toBe('closed');
  });
  it('refuses a non-loopback listener without a token', async () => {
    await expect(start({ mcpHttpHost: '0.0.0.0', mcpHttpAuthToken: undefined })).rejects.toThrow(
      /token/i,
    );
  });
  it('shares backend cache invalidation and one aggregate rate limiter across sessions/listeners', async () => {
    let value = 1;
    let reads = 0;
    const backend = nodeServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'GET') {
        reads++;
        res.end(JSON.stringify({ value }));
      } else {
        value = 2;
        res.end('{}');
      }
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => backend.close(() => resolve())));
    const address = backend.address() as { port: number };
    const limits: unknown[] = [];
    const acquire = RateLimiter.prototype.acquire;
    vi.spyOn(RateLimiter.prototype, 'acquire').mockImplementation(function (this: RateLimiter) {
      limits.push(this);
      return acquire.call(this);
    });
    const clients: PriorityClient[] = [];
    const createMcpServer = (_cfg: unknown, _logger: unknown, client: PriorityClient) => {
      clients.push(client);
      const server = new McpServer({ name: 'shared-test', version: '1' });
      server.tool('read', {}, async () => ({
        content: [{ type: 'text', text: JSON.stringify(await client.get('CUSTOMERS', 'a')) }],
      }));
      server.tool('write', { value: z.number() }, async (p) => {
        await client.update('CUSTOMERS', 'a', p);
        return { content: [{ type: 'text', text: 'ok' }] };
      });
      return server;
    };
    const cfg = {
      priorityServiceRoot: `http://127.0.0.1:${address.port}/tenant`,
      priorityReadOnly: false,
    };
    const firstRuntime = await start(cfg, { createMcpServer });
    const secondRuntime = await start(cfg, { createMcpServer });
    const first = await init(firstRuntime);
    const second = await init(secondRuntime);
    expect(clients[0]).toBe(clients[1]);
    await rpc(firstRuntime, first, 'tools/call', { name: 'read', arguments: {} });
    await rpc(secondRuntime, second, 'tools/call', { name: 'read', arguments: {} });
    expect(reads).toBe(1);
    await rpc(firstRuntime, first, 'tools/call', { name: 'write', arguments: { value: 2 } });
    const changed = await rpc(secondRuntime, second, 'tools/call', { name: 'read', arguments: {} });
    expect(JSON.stringify(changed.body)).toContain('2');
    expect(reads).toBe(2);
    expect(limits.length).toBe(3);
    expect(new Set(limits).size).toBe(1);
  });
  it('keeps different tenants separate and releases the last listener backend', async () => {
    const captured: PriorityClient[] = [];
    const createMcpServer = (_cfg: unknown, _logger: unknown, client: PriorityClient) => {
      captured.push(client);
      return new McpServer({ name: 'pool-test', version: '1' });
    };
    const a = await start({ priorityCompany: 'tenant-a' }, { createMcpServer });
    const b = await start({ priorityCompany: 'tenant-b' }, { createMcpServer });
    await init(a);
    await init(b);
    expect(captured[0]).not.toBe(captured[1]);
    await a.close();
    const replacement = await start({ priorityCompany: 'tenant-a' }, { createMcpServer });
    await init(replacement);
    expect(captured[0]).not.toBe(captured[2]);
  });
  it('closes an owned backend only after the last listener and leaves injected clients to their owner', async () => {
    const clients: PriorityClient[] = [];
    const createMcpServer = (_cfg: unknown, _logger: unknown, client: PriorityClient) => {
      clients.push(client);
      return new McpServer({ name: 'ownership-test', version: '1' });
    };
    const first = await start({}, { createMcpServer });
    const second = await start({}, { createMcpServer });
    await init(first);
    await init(second);
    const close = vi.spyOn(clients[0], 'close');
    await first.close();
    expect(close).not.toHaveBeenCalled();
    await second.close();
    await second.close();
    expect(close).toHaveBeenCalledTimes(1);
    const external = clients[0];
    const injected = await start({}, { client: external, createMcpServer });
    await injected.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('holds a second session backend request until the shared tenant rate window opens', async () => {
    let reads = 0;
    const backend = nodeServer((_req, res) => {
      reads++;
      res.setHeader('Content-Type', 'application/json');
      res.end('{}');
    });
    await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => backend.close(() => resolve())));
    const address = backend.address() as { port: number };
    const runtime = await start(
      {
        priorityServiceRoot: `http://127.0.0.1:${address.port}/rate-tenant`,
        rateLimitPerMinute: 1,
      },
      {
        createMcpServer: (_cfg, _logger, client) => {
          const server = new McpServer({ name: 'rate-test', version: '1' });
          server.tool('read', { key: z.string() }, async ({ key }) => ({
            content: [{ type: 'text', text: JSON.stringify(await client.get('CUSTOMERS', key)) }],
          }));
          return server;
        },
      },
    );
    const first = await init(runtime);
    const second = await init(runtime);
    let clock = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const realTimeout = globalThis.setTimeout;
    let openWindow: (() => void) | undefined;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay !== undefined && delay > 59_000 && delay <= 60_000) {
        openWindow = () => {
          clock += 60_000;
          callback(...args);
        };
        return realTimeout(() => {}, 0);
      }
      return realTimeout(callback, delay, ...args);
    });
    await rpc(runtime, first, 'tools/call', { name: 'read', arguments: { key: 'one' } });
    const pending = rpc(runtime, second, 'tools/call', { name: 'read', arguments: { key: 'two' } });
    try {
      for (let i = 0; i < 100 && !openWindow; i++)
        await new Promise((resolve) => realTimeout(resolve, 2));
      expect(openWindow).toBeTypeOf('function');
      expect(reads).toBe(1);
    } finally {
      openWindow?.();
    }
    expect((await pending).body.result.isError).not.toBe(true);
    expect(reads).toBe(2);
  });
});
