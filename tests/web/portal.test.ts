import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApp } from '../../src/web/app.js';
import { WebAuth, hashPassword } from '../../src/web/auth.js';
import { webConfig } from '../../src/web/config.js';
import { canonical, contentHash, parseSubmission } from '../../src/web/domain.js';
import {
  approvalMatches,
  blockPriorityExecution,
  requiresReconciliation,
} from '../../src/web/policy.js';
import type { OwnerApproval } from '../../src/web/policy.js';
import { WebStore } from '../../src/web/store.js';

const origin = 'http://127.0.0.1:3210';
const password = randomBytes(24).toString('base64url');
let passwordHash: string;
beforeAll(async () => {
  passwordHash = await hashPassword(password);
});
let store: WebStore;
let app: ReturnType<typeof createWebApp>;
let now: number;
let network: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  now = 1_800_000_000_000;
  store = new WebStore(':memory:', () => now);
  store.provision('instinct', passwordHash);
  app = createWebApp(store, { origin });
  // Every test fails if this local portal attempts to contact Priority, MCP, Telegram or any network.
  network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('External network forbidden in web tests'));
});
afterEach(() => {
  expect(network).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  store.close();
});

const invoice = (reference = 'DEMO-001') => ({
  kind: 'invoice_receipt',
  reference,
  customer: 'demo-customer',
  date: '2026-09-06',
  payment: 'transfer',
  paymentReference: 'DEMO-PAY-001',
  product: 'demo-product',
  quantity: '2',
  unitPrice: '12.35',
  notes: '',
});
function hidden(html: string, name: string) {
  const value = html.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1];
  if (!value) throw new Error(`Missing form field ${name}`);
  return value;
}
const cookie = (r: Response, name: string) =>
  r.headers
    .getSetCookie()
    .find((s) => s.startsWith(`${name}=`))
    ?.split(';')[0] ?? '';
function post(
  path: string,
  form: Record<string, string>,
  cookies = '',
  extra: Record<string, string> = {},
) {
  return app.request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      origin,
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookies,
      ...extra,
    },
    body: new URLSearchParams(form),
  });
}
async function signIn() {
  const login = await app.request(`${origin}/login`);
  const csrf = hidden(await login.text(), 'csrf');
  const response = await post(
    '/login',
    { username: 'instinct', password, csrf },
    cookie(login, 'web_login_csrf'),
  );
  expect(response.status).toBe(303);
  const cookies = cookie(response, 'web_session');
  const dashboard = await app.request(`${origin}/`, { headers: { cookie: cookies } });
  return { cookies, csrf: hidden(await dashboard.text(), 'csrf'), response };
}
function localSession(username = 'instinct') {
  const agent = store.agent(username);
  if (!agent) throw new Error('Test account missing');
  const token = store.newSession(agent);
  const session = store.session(token);
  if (!session) throw new Error('Session missing');
  return { ...session, cookies: `web_session=${token}` };
}
async function submit(session = localSession(), payload = invoice(), submissionKey = randomUUID()) {
  const response = await post(
    '/requests',
    { ...payload, submissionKey, csrf: session.csrf, demoAcknowledged: 'yes' },
    session.cookies,
  );
  return {
    response,
    session,
    id: response.headers.get('location')?.split('?')[0].split('/').pop() ?? '',
  };
}

describe('form login and restricted browser session', () => {
  it('does not redirect favicon or unknown public asset requests to login or replace its CSRF cookie', async () => {
    const login = await app.request(`${origin}/login`);
    const cookies = cookie(login, 'web_login_csrf');
    for (const [path, status] of [
      ['/favicon.ico', 204],
      ['/assets/missing.css', 404],
      ['/unknown-public-path', 404],
    ] as const) {
      const response = await app.request(`${origin}${path}`, { headers: { cookie: cookies } });
      expect(response.status).toBe(status);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.getSetCookie()).toHaveLength(0);
    }
  });
  it('requires authentication, supports vault-compatible fields, and keeps secrets server-side', async () => {
    expect((await app.request(`${origin}/requests`)).headers.get('location')).toBe('/login');
    const response = await app.request(`${origin}/login`);
    const html = await response.text();
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('lang="he" dir="rtl"');
    expect(html).not.toContain(password);
    expect(html).not.toContain(passwordHash);
    const login = await signIn();
    expect(cookie(login.response, 'web_session')).not.toBe('');
    expect(login.response.headers.getSetCookie().join(' ')).toContain('HttpOnly');
    expect(login.response.headers.getSetCookie().join(' ')).toContain('SameSite=Strict');
    const token = login.cookies.split('=')[1];
    const stored = store.db.prepare('SELECT token_hash FROM sessions').get();
    expect(stored?.token_hash).not.toBe(token);
  });
  it('rejects wrong password with a generic error without echoing it', async () => {
    const page = await app.request(`${origin}/login`);
    const csrf = hidden(await page.text(), 'csrf');
    const r = await post(
      '/login',
      { csrf, username: 'instinct', password: 'deliberately-wrong-test' },
      cookie(page, 'web_login_csrf'),
    );
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain('deliberately-wrong-test');
    expect(cookie(r, 'web_session')).toBe('');
  });
  it('rejects login CSRF and cross-origin login', async () => {
    const page = await app.request(`${origin}/login`);
    const csrf = hidden(await page.text(), 'csrf');
    expect((await post('/login', { username: 'instinct', password, csrf })).status).toBe(403);
    expect(
      (
        await post(
          '/login',
          { username: 'instinct', password, csrf },
          cookie(page, 'web_login_csrf'),
          { origin: 'http://evil.test' },
        )
      ).status,
    ).toBe(403);
  });
  it('persists login rate limits and enforces both per-account and global limits', async () => {
    for (let i = 0; i < 10; i++) expect(store.chargeLogin('instinct')).toBe(true);
    const page = await app.request(`${origin}/login`);
    const r = await post(
      '/login',
      { username: 'instinct', password, csrf: hidden(await page.text(), 'csrf') },
      cookie(page, 'web_login_csrf'),
    );
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('900');
    for (let i = 0; i < 90; i++) expect(store.chargeLogin(`account-${i}`)).toBe(true);
    expect(store.chargeLogin('new-account')).toBe(false);
    now += 15 * 60_000;
    expect(store.chargeLogin('instinct')).toBe(true);
  });
  it('expires sessions server-side and invalidates them on logout and password rotation', async () => {
    const session = localSession();
    now += 8 * 60 * 60_000;
    expect(
      (await app.request(`${origin}/`, { headers: { cookie: session.cookies } })).headers.get(
        'location',
      ),
    ).toBe('/login');
    const current = localSession();
    expect((await post('/logout', { csrf: current.csrf }, current.cookies)).status).toBe(303);
    expect(store.session(current.cookies.split('=')[1])).toBeUndefined();
    const rotated = localSession();
    store.provision('instinct', passwordHash);
    expect(store.session(rotated.cookies.split('=')[1])).toBeUndefined();
  });
  it('rejects disabled users on every request', async () => {
    const session = localSession();
    store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(session.userId);
    expect(
      (
        await app.request(`${origin}/requests`, { headers: { cookie: session.cookies } })
      ).headers.get('location'),
    ).toBe('/login');
  });
  it('does not issue a session when credentials change during password verification', async () => {
    const rotatedHash = await hashPassword(randomBytes(24).toString('base64url'));
    const auth = new WebAuth(store);
    const pending = auth.login('instinct', password);
    store.provision('instinct', rotatedHash);
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(store.db.prepare('SELECT * FROM sessions').all()).toHaveLength(0);
  });
  it('does not issue a session when the account is disabled during password verification', async () => {
    const auth = new WebAuth(store);
    const pending = auth.login('instinct', password);
    store.db.prepare('UPDATE users SET disabled=1 WHERE username=?').run('instinct');
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(store.db.prepare('SELECT * FROM sessions').all()).toHaveLength(0);
  });
  it('keeps an existing account and session intact when generated setup races another setup', () => {
    const session = localSession();
    expect(() => store.provision('instinct', 'must-not-replace', { createOnly: true })).toThrow(
      'Agent already exists',
    );
    expect(store.agent('instinct')?.passwordHash).toBe(passwordHash);
    expect(store.session(session.cookies.split('=')[1])?.userId).toBe(session.userId);
  });
  it.each(['logout', 'password rotation', 'expiry'])(
    'rechecks the session after a delayed request body and rejects %s',
    async (change) => {
      const session = localSession();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      });
      const pending = app.request(
        new Request(`${origin}/requests`, {
          method: 'POST',
          headers: {
            origin,
            cookie: session.cookies,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body,
          duplex: 'half',
        } as RequestInit & { duplex: 'half' }),
      );
      if (change === 'logout') store.logout(session.cookies.split('=')[1]);
      else if (change === 'password rotation') store.provision('instinct', passwordHash);
      else now += 8 * 60 * 60_000;
      controller?.enqueue(
        new TextEncoder().encode(
          new URLSearchParams({
            ...invoice(),
            csrf: session.csrf,
            submissionKey: randomUUID(),
            demoAcknowledged: 'yes',
          }).toString(),
        ),
      );
      controller?.close();
      expect((await pending).status).toBe(403);
      expect(store.list(session.userId).requests).toHaveLength(0);
    },
  );
});

describe('complete request workflows and durable idempotency', () => {
  it('signs in, renders a form, submits, follows the redirect and reads an honest persisted result', async () => {
    const session = await signIn();
    const form = await app.request(`${origin}/requests/new/invoice_receipt`, {
      headers: { cookie: session.cookies },
    });
    const html = await form.text();
    const result = await post(
      '/requests',
      {
        ...invoice(),
        csrf: session.csrf,
        demoAcknowledged: 'yes',
        submissionKey: hidden(html, 'submissionKey'),
      },
      session.cookies,
    );
    expect(result.status).toBe(303);
    const detail = await app.request(`${origin}${result.headers.get('location')}`, {
      headers: { cookie: session.cookies },
    });
    const text = await detail.text();
    expect(text).toContain('הבקשה נשמרה באתר');
    expect(text).toContain('לא נוצרו רשומות ב־Priority');
    expect(text).toContain('24.70 ₪');
    const records = store.db.prepare('SELECT * FROM created_records').all();
    expect(records).toHaveLength(0);
    const row = store.db.prepare('SELECT result FROM requests').get();
    expect(JSON.parse(String(row?.result))).toMatchObject({
      mode: 'demo',
      priorityVerified: false,
      createdRecords: [],
    });
  });
  it('saves a new supplier and a combined new supplier/purchase order request', async () => {
    const session = localSession();
    const fields = {
      supplierName: 'ספק דמה',
      registrationNumber: '000000000',
      contactName: 'ישראל לדוגמה',
      email: 'demo@example.test',
    };
    const supplier = await post(
      '/requests',
      {
        kind: 'supplier',
        reference: 'DEMO-SUP',
        ...fields,
        csrf: session.csrf,
        demoAcknowledged: 'yes',
        submissionKey: randomUUID(),
      },
      session.cookies,
    );
    expect(supplier.status).toBe(303);
    const po = await post(
      '/requests',
      {
        kind: 'purchase_order',
        reference: 'DEMO-PO',
        supplier: 'new',
        ...fields,
        date: '2026-09-06',
        product: 'demo-product',
        quantity: '1',
        unitPrice: '10.00',
        csrf: session.csrf,
        demoAcknowledged: 'yes',
        submissionKey: randomUUID(),
      },
      session.cookies,
    );
    expect(po.status).toBe(303);
    expect(store.list(session.userId).requests).toHaveLength(2);
  });
  it('saves a purchase order for a demo supplier without new-supplier details', async () => {
    const session = localSession();
    const response = await post(
      '/requests',
      {
        kind: 'purchase_order',
        reference: 'DEMO-PO-EXISTING',
        supplier: 'demo-supplier',
        date: '2026-09-06',
        product: 'demo-service',
        quantity: '1',
        unitPrice: '1',
        csrf: session.csrf,
        demoAcknowledged: 'yes',
        submissionKey: randomUUID(),
      },
      session.cookies,
    );
    expect(response.status).toBe(303);
  });
  it('returns the same UUID for double-clicks, concurrent delivery and new form keys with the same reference', async () => {
    const session = localSession();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => submit(session, invoice(), key)),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect((await submit(session, invoice(), randomUUID())).id).toBe(results[0].id);
    expect(store.list(session.userId).requests).toHaveLength(1);
    expect(
      store.db
        .prepare("SELECT count(*) AS n FROM audit_events WHERE action='duplicate_prevented'")
        .get()?.n,
    ).toBe(5);
  });
  it('rejects a reused key/reference with changed contents and preserves the original result', async () => {
    const session = localSession();
    const key = randomUUID();
    const first = await submit(session, invoice(), key);
    expect((await submit(session, { ...invoice(), quantity: '3' }, key)).response.status).toBe(409);
    expect(
      (await submit(session, { ...invoice(), unitPrice: '50' }, randomUUID())).response.status,
    ).toBe(409);
    expect(store.get(session.userId, first.id).payload).toMatchObject({
      quantity: 2,
      unitPrice: 1235,
    });
  });
  it('binds every duplicate submission key to its original request', async () => {
    const session = localSession();
    const first = await submit(session);
    const retryKey = randomUUID();
    expect((await submit(session, invoice(), retryKey)).id).toBe(first.id);
    expect((await submit(session, invoice('DEMO-002'), retryKey)).response.status).toBe(409);
    expect(store.list(session.userId).requests).toHaveLength(1);
  });
  it('finds a saved result by reference after a lost response, without creating another request', async () => {
    const session = localSession();
    await submit(session);
    const response = await app.request(`${origin}/requests?reference=DEMO-001`, {
      headers: { cookie: session.cookies },
    });
    expect(await response.text()).toContain('DEMO-001');
    expect(store.list(session.userId).requests).toHaveLength(1);
  });
  it('keeps request IDs, deduplication and results across database reopen and multiple connections', () => {
    const directory = mkdtempSync(join(tmpdir(), 'priority-web-test-'));
    const path = join(directory, 'web.sqlite');
    let persistent = new WebStore(path);
    try {
      persistent.provision('test', passwordHash);
      const agent = persistent.agent('test');
      if (!agent) throw new Error('Missing account');
      const key = randomUUID();
      const payload = parseSubmission(invoice());
      const first = persistent.submit(agent.id, key, payload);
      const retryKey = randomUUID();
      persistent.submit(agent.id, retryKey, payload);
      persistent.close();
      persistent = new WebStore(path);
      const secondConnection = new WebStore(path);
      try {
        const retry = secondConnection.submit(agent.id, key, payload);
        expect(retry.request.id).toBe(first.request.id);
        expect(retry.duplicate).toBe(true);
        expect(secondConnection.submit(agent.id, retryKey, payload).request.id).toBe(
          first.request.id,
        );
        expect(() =>
          secondConnection.submit(agent.id, retryKey, parseSubmission(invoice('DEMO-002'))),
        ).toThrow('כבר שימשו');
        expect(persistent.get(agent.id, first.request.id).result.priorityVerified).toBe(false);
        expect(statSync(path).mode & 0o777).toBe(0o600);
      } finally {
        secondConnection.close();
      }
    } finally {
      persistent.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('backfills submission keys when opening an existing V1 database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'priority-web-migration-'));
    const path = join(directory, 'web.sqlite');
    let persistent = new WebStore(path);
    try {
      persistent.provision('test', passwordHash);
      const agent = persistent.agent('test');
      if (!agent) throw new Error('Missing account');
      const key = randomUUID();
      const payload = parseSubmission(invoice());
      const first = persistent.submit(agent.id, key, payload);
      // Reproduce the original schema, which stored only the first key on the request itself.
      persistent.db.exec('DROP TABLE submission_keys');
      persistent.close();
      persistent = new WebStore(path);
      expect(persistent.submit(agent.id, key, payload).request.id).toBe(first.request.id);
      expect(() => persistent.submit(agent.id, key, parseSubmission(invoice('DEMO-002')))).toThrow(
        'כבר שימשו',
      );
      expect(persistent.agent('test')?.id).toBe(agent.id);
    } finally {
      persistent.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it('rolls back request and submission-key writes when saving the audit event fails', () => {
    const session = localSession();
    const key = randomUUID();
    const payload = parseSubmission(invoice());
    const audit = vi.spyOn(store, 'audit').mockImplementationOnce(() => {
      throw new Error('Simulated local storage failure');
    });
    expect(() => store.submit(session.userId, key, payload)).toThrow('local storage failure');
    expect(store.list(session.userId).requests).toHaveLength(0);
    expect(store.db.prepare('SELECT * FROM submission_keys').all()).toHaveLength(0);
    audit.mockRestore();
    expect(store.submit(session.userId, key, payload).duplicate).toBe(false);
  });
  it('enforces immutable submitted contents and append-only audit in the database', async () => {
    const { id } = await submit();
    expect(() => store.db.prepare('UPDATE requests SET version=2 WHERE id=?').run(id)).toThrow(
      'immutable',
    );
    expect(() => store.db.exec('DELETE FROM audit_events')).toThrow('append-only');
  });
});

describe('server-enforced authorization, validation and isolation', () => {
  it('scopes request lists and detail to the authenticated account, including direct URL attempts', async () => {
    const first = await submit();
    store.provision('other', passwordHash);
    const other = localSession('other');
    const response = await app.request(`${origin}/requests/${first.id}`, {
      headers: { cookie: other.cookies },
    });
    expect(response.status).toBe(404);
    expect(store.list(other.userId).requests).toHaveLength(0);
    expect(
      (await post(`/requests/${first.id}/execute`, { csrf: other.csrf }, other.cookies)).status,
    ).toBe(404);
  });
  it('denies forged owner approval and execution even with valid agent CSRF and writes-enabled environment', async () => {
    vi.stubEnv('PRIORITY_READ_ONLY', 'false');
    vi.stubEnv('WEB_ALLOW_WRITES', 'true');
    const { id, session } = await submit();
    for (const action of ['approve', 'execute']) {
      const response = await post(
        `/requests/${id}/${action}`,
        {
          csrf: session.csrf,
          role: 'owner',
          approved: 'true',
          authenticatedOwner: 'true',
          confirm: 'true',
          dryRun: 'false',
        },
        session.cookies,
      );
      expect(response.status).toBe(403);
    }
    expect(store.db.prepare('SELECT * FROM execution_attempts').all()).toHaveLength(0);
    expect(store.db.prepare('SELECT * FROM created_records').all()).toHaveLength(0);
  });
  it('does not expose MCP, generic API, SQL, shell, files or Telegram endpoints', async () => {
    const session = localSession();
    for (const path of [
      '/mcp',
      '/api',
      '/sql',
      '/execute',
      '/.env',
      '/.local-web/agent-login.txt',
      '/telegram/webhook',
      '/src/config.ts',
    ]) {
      expect(
        (await app.request(`${origin}${path}`, { headers: { cookie: session.cookies } })).status,
      ).toBe(404);
      expect((await post(path, { csrf: session.csrf }, session.cookies)).status).toBe(404);
    }
  });
  it('rejects user-supplied permissions, endpoints, payloads, result IDs and extra fields', async () => {
    const session = localSession();
    for (const injected of [
      { role: 'owner' },
      { actorId: 'other' },
      { status: 'approved' },
      { version: '2' },
      { api: '/anything' },
      { documentNumber: 'FAKE-1' },
    ]) {
      const r = await post(
        '/requests',
        {
          ...invoice(),
          ...injected,
          csrf: session.csrf,
          submissionKey: randomUUID(),
          demoAcknowledged: 'yes',
        },
        session.cookies,
      );
      expect(r.status).toBe(400);
    }
    expect(store.list(session.userId).requests).toHaveLength(0);
  });
  it('rejects missing CSRF, foreign origins, JSON and duplicate form fields', async () => {
    const session = localSession();
    expect((await post('/requests', invoice(), session.cookies)).status).toBe(403);
    expect(
      (await post('/requests', { csrf: session.csrf }, session.cookies, { origin: 'null' })).status,
    ).toBe(403);
    expect(
      (
        await post('/requests', { csrf: session.csrf }, session.cookies, {
          'content-type': 'application/json',
        })
      ).status,
    ).toBe(400);
    const r = await app.request(`${origin}/requests`, {
      method: 'POST',
      headers: {
        origin,
        cookie: session.cookies,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `csrf=${session.csrf}&kind=supplier&kind=invoice_receipt`,
    });
    expect(r.status).toBe(400);
  });
  it('bounds input size and rejects invalid dates, unknown demo records and negative amounts', async () => {
    const session = localSession();
    for (const changed of [
      { date: '2026-02-30' },
      { customer: 'actual-customer' },
      { quantity: '-1' },
      { unitPrice: '1.234' },
      { unitPrice: '1e4' },
      { quantity: '1001' },
    ]) {
      const r = await submit(session, { ...invoice(), ...changed });
      expect(r.response.status).toBe(400);
    }
    const large = await post(
      '/requests',
      { notes: 'x'.repeat(17_000), csrf: session.csrf },
      session.cookies,
    );
    expect(large.status).toBe(413);
    expect(store.list(session.userId).requests).toHaveLength(0);
  });
  it('escapes stored text and serves a strict CSP without scripts or cacheable sensitive pages', async () => {
    const { id, session } = await submit(localSession(), {
      ...invoice(),
      notes: '<script>alert(1)</script>',
    });
    const response = await app.request(`${origin}/requests/${id}`, {
      headers: { cookie: session.cookies },
    });
    const html = await response.text();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(response.headers.get('content-security-policy')).toContain("script-src 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('never renders environment secrets or raw database errors', async () => {
    vi.stubEnv('PRIORITY_PAT', 'TEST-SECRET-MARKER');
    vi.spyOn(store, 'submit').mockImplementation(() => {
      throw new Error('TEST-SECRET-MARKER database details');
    });
    const { response } = await submit();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('TEST-SECRET-MARKER');
  });
  it('rejects public configuration and foreign Host headers', async () => {
    expect(() => webConfig({ WEB_HOST: '0.0.0.0' })).toThrow();
    expect(() => webConfig({ WEB_MODE: 'production' })).toThrow();
    expect(() => webConfig({ WEB_PORT: '0' })).toThrow();
    expect(() => createWebApp(store, { origin: 'https://example.com' })).toThrow();
    expect((await app.request(`${origin}/login`, { headers: { host: 'evil.test' } })).status).toBe(
      403,
    );
  });
});

describe('future approval/execution policy contract (no bot or active approval transport)', () => {
  const request = {
    id: 'request',
    actorId: 'agent',
    version: 1,
    contentHash: 'hash',
    target: 'verified-test-company',
  };
  const approval: OwnerApproval = {
    ownerId: 'owner',
    requesterId: 'agent',
    requestId: 'request',
    version: 1,
    contentHash: 'hash',
    target: 'verified-test-company',
    verifiedChannel: 'telegram',
    authenticatedOwner: true,
    issuedAt: 100,
    expiresAt: 600_100,
    consumedAt: null,
  };
  it('requires the expected independently authenticated owner and exact request, version, hash and company', () => {
    expect(approvalMatches(request, approval, 'owner', 101)).toBe(true);
    for (const changed of [
      { ownerId: 'agent' },
      { ownerId: 'unknown' },
      { authenticatedOwner: false },
      { version: 2 },
      { contentHash: 'changed' },
      { requestId: 'another' },
      { requesterId: 'other' },
      { target: 'production-company' },
      { verifiedChannel: 'browser' },
    ]) {
      expect(
        approvalMatches(request, { ...approval, ...changed } as OwnerApproval, 'owner', 101),
      ).toBe(false);
    }
  });
  it('rejects expired, overlong, future and already consumed approvals', () => {
    expect(approvalMatches(request, approval, 'owner', approval.expiresAt)).toBe(false);
    expect(approvalMatches(request, { ...approval, expiresAt: 900_000 }, 'owner', 101)).toBe(false);
    expect(approvalMatches(request, approval, 'owner', 99)).toBe(false);
    expect(approvalMatches(request, { ...approval, consumedAt: 101 }, 'owner', 102)).toBe(false);
  });
  it('requires reconciliation after a timeout/crash and always blocks the V1 executor', () => {
    expect(requiresReconciliation('uncertain')).toBe(true);
    expect(requiresReconciliation('in_progress')).toBe(true);
    expect(() => blockPriorityExecution()).toThrow('חסום');
  });
  it('hashes canonical content including actor and version without relying on JSON property order', () => {
    const payload = parseSubmission(invoice());
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    expect(contentHash('agent', 1, payload)).not.toBe(contentHash('agent', 2, payload));
    expect(contentHash('agent', 1, payload)).not.toBe(contentHash('other', 1, payload));
    expect(contentHash('agent', 1, payload)).not.toBe(
      contentHash('agent', 1, { ...payload, notes: 'different' }),
    );
  });
});
