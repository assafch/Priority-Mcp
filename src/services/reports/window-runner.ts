import type { OperationContext } from '../../runtime/types.js';
export interface WindowProgress {
  completed: number;
  total: number;
}
export interface WindowResults<W, T> {
  results: Array<{ window: W; value: T }>;
  missing: Array<{ window: W; reason: 'cancelled' | 'deadline' }>;
}
/** Only completed windows count as progress; notifications never estimate completed rows. */
export async function runWindows<W, T>(
  windows: W[],
  options: {
    concurrency: number;
    ctx: OperationContext;
    onProgress?: (progress: WindowProgress) => void | Promise<void>;
  },
  reader: (window: W) => Promise<T>,
): Promise<WindowResults<W, T>> {
  const concurrency = Math.max(1, Math.min(2, options.concurrency));
  let index = 0;
  let completed = 0;
  let lastNotified = Number.NEGATIVE_INFINITY;
  const results: Array<{ window: W; value: T } | undefined> = Array(windows.length);
  const missing: WindowResults<W, T>['missing'] = [];
  const worker = async () => {
    for (;;) {
      const next = index++;
      if (next >= windows.length) return;
      const window = windows[next];
      if (options.ctx.signal.aborted || Date.now() >= options.ctx.deadlineAt) {
        missing.push({
          window,
          reason:
            options.ctx.signal.aborted && Date.now() < options.ctx.deadlineAt
              ? 'cancelled'
              : 'deadline',
        });
        continue;
      }
      const value = await reader(window);
      results[next] = { window, value };
      completed++;
      if (
        options.onProgress &&
        !options.ctx.signal.aborted &&
        Date.now() < options.ctx.deadlineAt &&
        Date.now() - lastNotified >= 2000
      ) {
        lastNotified = Date.now();
        await options.onProgress({ completed, total: windows.length });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, windows.length) }, worker));
  return {
    results: results.filter((value): value is { window: W; value: T } => value !== undefined),
    missing,
  };
}
