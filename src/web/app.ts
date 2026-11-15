import { randomBytes, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { WebAuth, equalSecret } from './auth.js';
import { WebError, kinds, parseSubmission, submissionKeySchema } from './domain.js';
import type { RequestKind } from './domain.js';
import { blockAgentApproval, blockPriorityExecution } from './policy.js';
import type { Session, WebStore } from './store.js';
import { styles } from './styles.js';
import * as views from './views.js';

export interface WebOptions {
  origin: string;
}
export function createWebApp(store: WebStore, options: WebOptions) {
  const origin = new URL(options.origin);
  // V1 is intentionally restricted to local HTTP. No environment switch enables public binding.
  if (
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    origin.origin !== options.origin
  ) {
    throw new Error('Web demo origin must be http://127.0.0.1:<port>');
  }
  const auth = new WebAuth(store);
  const app = new Hono<{ Variables: { session: Session; form: Record<string, string> } }>();
  const cookieOptions = { httpOnly: true, sameSite: 'Strict' as const, path: '/', secure: false };

  app.use('*', async (c, next) => {
    c.header(
      'Content-Security-Policy',
      "default-src 'none'; style-src 'self'; img-src 'self'; script-src 'none'; connect-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    // Keep the Origin on ordinary same-origin form POSTs, including browser-vault logins.
    c.header('Referrer-Policy', 'same-origin');
    c.header('Cache-Control', 'no-store');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (
      new URL(c.req.url).host !== origin.host ||
      (c.req.header('host') && c.req.header('host') !== origin.host)
    ) {
      throw new WebError(403, 'כתובת האתר אינה מורשית.');
    }
    await next();
  });
  app.use(
    '*',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: () => {
        throw new WebError(413, 'הטופס גדול מדי.');
      },
    }),
  );
  app.use('*', async (c, next) => {
    let form: Record<string, string> | undefined;
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      if (c.req.method !== 'POST') throw new WebError(403, 'פעולה זו אינה מורשית.');
      if (
        c.req.header('origin') !== origin.origin ||
        c.req.header('sec-fetch-site') === 'cross-site'
      ) {
        throw new WebError(403, 'השליחה חסומה. יש לפתוח את הטופס באתר ולנסות שוב.');
      }
      if (
        c.req.header('content-type')?.split(';')[0].trim() !== 'application/x-www-form-urlencoded'
      ) {
        throw new WebError(400, 'יש לשלוח בקשה באמצעות טופס האתר.');
      }
      form = Object.create(null) as Record<string, string>;
      for (const [key, value] of new URLSearchParams(await c.req.text())) {
        if (Object.hasOwn(form, key)) throw new WebError(400, 'שדה כפול בטופס.');
        form[key] = value;
      }
      c.set('form', form);
    }
    // Reading the body yields: logout, password rotation or expiry may have happened meanwhile.
    const session = store.session(getCookie(c, 'web_session') ?? '');
    if (session) c.set('session', session);
    if (form) {
      const csrf = c.req.path === '/login' ? getCookie(c, 'web_login_csrf') : session?.csrf;
      if (!csrf || !form.csrf || !equalSecret(form.csrf, csrf)) {
        throw new WebError(403, 'תוקף הטופס פג או שהשליחה אינה מורשית. יש לפתוח את הטופס מחדש.');
      }
    }
    await next();
  });
  app.get('/assets/app.css', (c) =>
    c.body(styles, 200, { 'Content-Type': 'text/css; charset=utf-8' }),
  );
  app.get('/favicon.ico', (c) => c.body(null, 204));
  app.get('/health', (c) => c.json({ status: 'ok', mode: 'demo', priorityWrites: false }));
  app.get('/login', (c) => {
    if (c.get('session')) return c.redirect('/');
    const csrf = randomBytes(32).toString('base64url');
    setCookie(c, 'web_login_csrf', csrf, { ...cookieOptions, maxAge: 600 });
    return c.html(views.login(csrf));
  });
  app.post('/login', async (c) => {
    const form = c.get('form');
    if (
      Object.keys(form).some((k) => !['csrf', 'username', 'password'].includes(k)) ||
      !/^[a-zA-Z0-9_.-]{1,64}$/.test(form.username ?? '') ||
      !form.password ||
      form.password.length > 128
    ) {
      throw new WebError(400, 'פרטי ההתחברות אינם תקינים.');
    }
    try {
      const token = await auth.login(form.username, form.password);
      store.logout(getCookie(c, 'web_session') ?? '');
      setCookie(c, 'web_session', token, { ...cookieOptions, maxAge: 8 * 60 * 60 });
      deleteCookie(c, 'web_login_csrf', cookieOptions);
      return c.redirect('/', 303);
    } catch (error) {
      if (!(error instanceof WebError) || ![401, 429].includes(error.status)) throw error;
      if (error.status === 429) c.header('Retry-After', '900');
      return c.html(views.login(form.csrf, error.message), error.status);
    }
  });
  app.use('*', async (c, next) => {
    if (!c.get('session')) {
      const path = c.req.path;
      if (
        path === '/' ||
        path === '/requests' ||
        path.startsWith('/requests/') ||
        path === '/logout'
      )
        return c.redirect('/login', 303);
      // Missing browser assets must not fetch /login and replace the displayed form's CSRF cookie.
      return c.notFound();
    }
    await next();
  });
  app.post('/logout', (c) => {
    store.logout(getCookie(c, 'web_session') ?? '');
    deleteCookie(c, 'web_session', cookieOptions);
    return c.redirect('/login', 303);
  });
  app.get('/', (c) =>
    c.html(views.dashboard(store.list(c.get('session').userId).requests, c.get('session'))),
  );
  app.get('/requests/new/:kind', (c) => {
    const kind = c.req.param('kind');
    if (!Object.hasOwn(kinds, kind)) throw new WebError(404, 'סוג הבקשה אינו קיים.');
    return c.html(views.requestForm(kind as RequestKind, c.get('session'), randomUUID()));
  });
  app.post('/requests', (c) => {
    const session = c.get('session');
    const form = c.get('form');
    const { csrf: _csrf, submissionKey, demoAcknowledged, ...input } = form;
    if (!submissionKeySchema.safeParse(submissionKey).success)
      throw new WebError(400, 'מזהה שליחה אינו תקין. יש לפתוח טופס חדש.');
    try {
      if (demoAcknowledged !== 'yes')
        throw new WebError(400, 'יש לאשר שהטופס מכיל נתוני דמה בלבד.');
      const payload = parseSubmission(input);
      const result = store.submit(session.userId, submissionKey, payload);
      return c.redirect(
        `/requests/${result.request.id}${result.duplicate ? '?duplicate=1' : ''}`,
        303,
      );
    } catch (error) {
      if (!(error instanceof WebError)) throw error;
      store.audit(
        session.userId,
        null,
        error.status === 409 ? 'submission_conflict' : 'submission_rejected',
      );
      if (Object.hasOwn(kinds, input.kind ?? '') && [400, 409].includes(error.status)) {
        return c.html(
          views.requestForm(input.kind as RequestKind, session, submissionKey, form, error.message),
          error.status,
        );
      }
      throw error;
    }
  });
  app.get('/requests', (c) => {
    const reference = (c.req.query('reference') ?? '').trim();
    const rawPage = c.req.query('page') ?? '0';
    if (reference.length > 80 || !/^\d{1,6}$/.test(rawPage))
      throw new WebError(400, 'פרטי החיפוש אינם תקינים.');
    const page = Number(rawPage);
    const session = c.get('session');
    const result = store.list(session.userId, reference, page);
    return c.html(views.requestList(result.requests, session, reference, page, result.hasMore));
  });
  app.get('/requests/:id', (c) => {
    const session = c.get('session');
    const request = store.get(session.userId, c.req.param('id'));
    store.audit(session.userId, request.id, 'request_viewed');
    return c.html(
      views.detail(
        request,
        session,
        c.req.query('duplicate') === '1',
        store.events(session.userId, request.id),
      ),
    );
  });
  app.post('/requests/:id/approve', (c) => {
    const session = c.get('session');
    const request = store.get(session.userId, c.req.param('id'));
    store.audit(session.userId, request.id, 'approval_blocked');
    blockAgentApproval();
  });
  app.post('/requests/:id/execute', (c) => {
    const session = c.get('session');
    const request = store.get(session.userId, c.req.param('id'));
    store.audit(session.userId, request.id, 'execution_blocked');
    blockPriorityExecution();
  });
  app.notFound((c) => c.html(views.errorPage('העמוד המבוקש אינו קיים.', c.get('session')), 404));
  app.onError((error, c) => {
    if (error instanceof WebError)
      return c.html(views.errorPage(error.message, c.get('session')), error.status);
    // Never render/log raw errors, request bodies, cookies, environment or MCP output.
    return c.html(
      views.errorPage(
        'אירעה תקלה. בדקו ברשימת הבקשות אם הבקשה נשמרה לפני שליחה נוספת.',
        c.get('session'),
      ),
      503,
    );
  });
  return app;
}
