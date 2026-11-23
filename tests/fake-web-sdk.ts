import { vi } from 'vitest';
import {
  type WebSdkForm,
  type WebSdkLoginConfig,
  type WebSdkModule,
  type WebSdkProcStep,
  type WebSdkRow,
  type WebSdkServerMessage,
  WebSdkSession,
} from '../src/client/web-sdk.js';

/**
 * A scripted Priority Web SDK for tests: records every call in order and replays the given
 * procedure steps. Nothing here talks to a server. Shared by the form-activation tests and the
 * import-step tool tests.
 */
export const fakeLoginConfig: WebSdkLoginConfig = {
  url: 'https://p.test/wcf/service.svc',
  tabulaini: 'tabula.ini',
  language: 1,
  profile: { company: 'demo' },
  appname: 'test',
  devicename: 'test',
  appid: 'test',
  appkey: '',
  username: 'tok',
  password: 'PAT',
};

export interface FakeSdkOptions {
  /** Rows the form returns after the search filter, keyed '1', '2', … */
  rows?: Record<string, WebSdkRow>;
  /** Procedure steps: steps[0] answers activateStart, each proc.message() moves to the next. */
  steps?: WebSdkProcStep[];
  /** Pass `undefined` explicitly to model a form that exposes no activation list. */
  activations?: Record<string, { background: number; confirm: number }> | undefined;
  /** Delivered through the formStart callback as the real SDK does: ONE argument, form inside. */
  openMessages?: WebSdkServerMessage[];
  /** Called when activateStart runs (to change what the fake OData backend returns afterwards). */
  onActivate?: () => void;
  /** activateStart never settles. */
  hangActivate?: boolean;
  hangCancel?: boolean;
  /** Steps of a procedure started with procStart (the costing program): procSteps[0] answers it. */
  procSteps?: WebSdkProcStep[];
  /** Called when procStart runs. */
  onProcStart?: () => void;
  /** Called on every proc.message(ok), after the cursor moved (e.g. the run after the OK). */
  onProcMessage?: (ok: 0 | 1) => void;
}

export function fakeSdk(opts: FakeSdkOptions = {}) {
  const calls: string[] = [];
  const steps = opts.steps ?? [{ type: 'end' }];
  const rows: Record<string, WebSdkRow> = opts.rows ?? {};
  let cursor = 0;
  let active = steps;
  const proc = {
    message: vi.fn(async (ok: 0 | 1) => {
      calls.push(`message(${ok})`);
      cursor++;
      if (active !== steps) opts.onProcMessage?.(ok);
      return { ...active[cursor], proc } as WebSdkProcStep;
    }),
    cancel: vi.fn(async () => {
      calls.push('cancel');
      if (opts.hangCancel) await new Promise(() => {});
    }),
  };
  const sdk: WebSdkModule = {
    login: vi.fn(async () => {
      calls.push('login');
      return {};
    }),
    formStart: vi.fn(async (name, onMessage, _onUpdate, _profile, autoRetrieve) => {
      calls.push(`formStart(${name},${autoRetrieve})`);
      const form: WebSdkForm = {
        activations: opts.activations,
        warningConfirm: vi.fn((ok: 0 | 1) => {
          calls.push(`warningConfirm(${ok})`);
        }),
        infoMsgConfirm: vi.fn(() => {
          calls.push('infoMsgConfirm');
        }),
        setSearchFilter: vi.fn(async (f: unknown) => {
          calls.push(
            `setSearchFilter(${JSON.stringify((f as { QueryValues: unknown[] }).QueryValues)})`,
          );
        }),
        getRows: vi.fn(async () => {
          calls.push('getRows');
          return { [name]: rows };
        }),
        setActiveRow: vi.fn(async (i: number) => {
          calls.push(`setActiveRow(${i})`);
        }),
        activateStart: vi.fn(async (ename: string, type: string) => {
          calls.push(`activateStart(${ename},${type})`);
          if (opts.hangActivate) return new Promise<WebSdkProcStep>(() => {});
          opts.onActivate?.();
          cursor = 0;
          active = steps;
          return { ...steps[0], proc } as WebSdkProcStep;
        }),
        activateEnd: vi.fn(async () => {
          calls.push('activateEnd');
        }),
        endCurrentForm: vi.fn(async () => {
          calls.push('endCurrentForm');
        }),
      };
      for (const m of opts.openMessages ?? [])
        (onMessage as (msg: unknown) => void)({ ...m, form });
      return form;
    }),
    procStart: vi.fn(async (name: string, type: string) => {
      calls.push(`procStart(${name},${type})`);
      opts.onProcStart?.();
      cursor = 0;
      active = opts.procSteps ?? [{ type: 'end' }];
      return { ...active[0], proc } as WebSdkProcStep;
    }),
  };
  const session = new WebSdkSession(sdk, fakeLoginConfig);
  const count = (prefix: string) => calls.filter((c) => c.startsWith(prefix)).length;
  return { sdk, calls, proc, session, count };
}
