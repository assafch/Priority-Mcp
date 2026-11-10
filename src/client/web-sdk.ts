import { createRequire } from 'node:module';
import type { Config } from '../config.js';
import { PriorityClient } from './priority-client.js';

/**
 * Priority Web SDK (`priority-web-sdk`, the official Node client for Priority's WCF service).
 *
 * This is the only sanctioned way to run a Priority *procedure* or *direct activation* without a
 * browser — e.g. "סגירת חשבונית" (CLOSEANINVOICE), which posts the journal entry, assigns the final
 * document number and moves stock. OData cannot do that (this tenant's $metadata exposes no such
 * action), and writing the FINAL field directly is blocked everywhere in this server.
 *
 * The SDK is CommonJS, keeps one global session per process after login(), and is loaded lazily
 * so that merely registering tools never touches it. Every entry point here is injectable so the
 * close logic can be exercised against a scripted fake in tests; nothing in this module talks to
 * Priority on its own.
 */

export interface WebSdkLoginConfig {
  /** WCF endpoint, e.g. https://p.priority-connect.online/wcf/service.svc */
  url: string;
  /** System .ini, e.g. tabp008h.ini — the same segment as in the OData base URL. */
  tabulaini: string;
  /** 1 = Hebrew, 3 = American English. Messages from the server come back in this language. */
  language: number;
  profile: { company: string };
  appname: string;
  devicename: string;
  appid: string;
  appkey: string;
  username?: string;
  password?: string;
}

export interface WebSdkServerMessage {
  type?: string;
  code?: string;
  message?: string;
  fatal?: boolean;
}

export interface WebSdkProcStep {
  type?: string;
  messagetype?: string;
  message?: string;
  proc?: {
    message(ok: 0 | 1): Promise<WebSdkProcStep>;
    cancel(): Promise<unknown>;
  };
  [key: string]: unknown;
}

export type WebSdkRow = Record<string, unknown>;

export interface WebSdkForm {
  columns?: Record<string, unknown>;
  activations?: Record<string, { background?: number; confirm?: number } | undefined>;
  setSearchFilter(filter: unknown): Promise<unknown>;
  getRows(fromRow: number): Promise<Record<string, Record<string, WebSdkRow>>>;
  setActiveRow(row: number): Promise<unknown>;
  activateStart(
    ename: string,
    type: string,
    progress: (...args: unknown[]) => void,
  ): Promise<WebSdkProcStep>;
  activateEnd(): Promise<unknown>;
  endCurrentForm(): Promise<unknown>;
  warningConfirm?(ok: 0 | 1): void;
  infoMsgConfirm?(): void;
}

export interface WebSdkModule {
  login(config: WebSdkLoginConfig): Promise<unknown>;
  formStart(
    formName: string,
    onMessage: (form: WebSdkForm, message: WebSdkServerMessage) => void,
    onUpdate: null,
    profile: { company: string },
    autoRetrieve: number,
  ): Promise<WebSdkForm>;
  /**
   * Start a procedure by its internal name (type 'P'). Optional so callers that only open forms
   * (the close-invoice fake included) still satisfy this interface. `loadWebSdk` requires it.
   */
  procStart?(
    name: string,
    type: string,
    progress: ((...args: unknown[]) => void) | null,
    company?: string,
  ): Promise<WebSdkProcStep>;
}

/** Lazy CommonJS load; throws a clear message when the dependency is missing. */
/**
 * Cookies the SDK sets after login (PriUser, Environment, PriUserV2). In a browser they go to
 * document.cookie; under Node the SDK writes them to a private `{}` that nothing can read. The
 * netfiles URLs a print procedure returns need PriUserV2, so loadWebSdk hands the SDK a temporary
 * `window` whose document records cookie writes here. The SDK reads `window` only while loading.
 */
const sdkCookies = new Map<string, string>();

function cookieRecordingDocument(): object {
  const doc = {};
  Object.defineProperty(doc, 'cookie', {
    get: () => [...sdkCookies].map(([name, value]) => `${name}=${value}`).join('; '),
    set: (raw: unknown) => {
      const pair = String(raw).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) sdkCookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    },
  });
  return doc;
}

/** The SDK session's web cookie (PriUserV2 by default), or undefined before login. */
export function webSdkCookie(name = 'PriUserV2'): string | undefined {
  const value = sdkCookies.get(name);
  return value ? value : undefined;
}

export function loadWebSdk(): WebSdkModule {
  const require = createRequire(import.meta.url);
  let mod: { default?: WebSdkModule } & Partial<WebSdkModule>;
  const g = globalThis as { window?: unknown };
  const hadWindow = 'window' in g;
  try {
    if (!hadWindow) {
      g.window = {
        document: cookieRecordingDocument(),
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Array,
      };
    }
    mod = require('priority-web-sdk');
  } catch (err) {
    throw new Error(
      `priority-web-sdk is not installed (npm install priority-web-sdk@3.0.39): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    if (!hadWindow) Reflect.deleteProperty(g, 'window');
  }
  const sdk = (mod.default ?? mod) as WebSdkModule;
  if (
    typeof sdk.login !== 'function' ||
    typeof sdk.formStart !== 'function' ||
    typeof sdk.procStart !== 'function'
  ) {
    throw new Error('priority-web-sdk loaded but login/formStart/procStart are missing');
  }
  return sdk;
}

/**
 * Derive the Web SDK login from the OData configuration this server already has: same host, same
 * .ini, same company, same PAT (the SDK takes a PAT as username with the literal password 'PAT').
 * PRIORITY_WEB_URL / PRIORITY_WEB_TABULAINI / PRIORITY_WEB_LANGUAGE / PRIORITY_WEB_APPNAME override.
 */
export function deriveWebSdkLoginConfig(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): WebSdkLoginConfig {
  const root = new URL(PriorityClient.buildBaseUrl(config));
  const segments = root.pathname.split('/').filter(Boolean);
  const iniIndex = segments.findIndex((s) => /\.ini$/i.test(s));
  const tabulaini =
    env.PRIORITY_WEB_TABULAINI ||
    (iniIndex >= 0 ? segments[iniIndex] : undefined) ||
    config.priorityEnvironment;
  const company =
    config.priorityCompany ||
    (iniIndex >= 0 ? segments[iniIndex + 1] : undefined) ||
    segments[segments.length - 1];
  if (!tabulaini || !company) {
    throw new Error(
      'Cannot derive the Priority company/.ini for the Web SDK from the configuration',
    );
  }
  const identity = config.priorityPat
    ? { username: config.priorityPat, password: 'PAT' }
    : { username: config.priorityUsername, password: config.priorityPassword };
  if (!identity.username || !identity.password) {
    throw new Error('Web SDK login needs PRIORITY_PAT or PRIORITY_USERNAME + PRIORITY_PASSWORD');
  }
  const language = Number(env.PRIORITY_WEB_LANGUAGE ?? 1);
  return {
    url: env.PRIORITY_WEB_URL || `${root.origin}/wcf/service.svc`,
    tabulaini,
    language: Number.isFinite(language) && language > 0 ? language : 1,
    profile: { company },
    appname: env.PRIORITY_WEB_APPNAME || 'priority-mcp',
    devicename: 'priority-mcp',
    appid: config.priorityAppId || env.PRIORITY_WEB_APPID || 'priority-mcp',
    appkey: config.priorityAppKey || env.PRIORITY_WEB_APPKEY || '',
    ...identity,
  };
}

/** Reject after `ms`; the underlying SDK call keeps running but the caller stops waiting. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/** One login per process (the SDK session is global); a failed login is retried on the next call. */
export class WebSdkSession {
  private loginPromise: Promise<unknown> | undefined;

  constructor(
    readonly sdk: WebSdkModule,
    readonly loginConfig: WebSdkLoginConfig,
    private readonly loginTimeoutMs = 60_000,
  ) {}

  get company(): string {
    return this.loginConfig.profile.company;
  }

  async ensureLogin(): Promise<void> {
    if (!this.loginPromise) {
      this.loginPromise = withTimeout(
        this.sdk.login(this.loginConfig),
        this.loginTimeoutMs,
        'Web SDK login',
      ).catch((err) => {
        this.loginPromise = undefined;
        throw err;
      });
    }
    await this.loginPromise;
  }

  /** Forget the session so the next call logs in again (after a dead or expired SDK session). */
  reset(): void {
    this.loginPromise = undefined;
  }

  /** Describe the login without secrets (for previews and logs). */
  describe(): Record<string, unknown> {
    const { url, tabulaini, language, profile, appname, appid } = this.loginConfig;
    return {
      url,
      tabulaini,
      language,
      company: profile.company,
      appname,
      appid,
      identity: this.loginConfig.password === 'PAT' ? 'PAT' : 'user+password',
    };
  }
}
