import { describe, expect, it, vi } from 'vitest';
import { runComposite } from '../scripts/composite-write.mjs';
import { runFinalize } from '../scripts/finalize-docs.mjs';
import { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import type { Logger } from '../src/logger.js';
const cfg = {
  priorityBaseUrl: 'https://p.test/odata/Priority/tabula.ini',
  priorityCompany: 'demo',
  priorityReadOnly: true,
  cacheTtlSeconds: 60,
  rateLimitPerMinute: 100,
  requestTimeoutMs: 100,
  priorityPat: 'x',
};
const logger = { debug: vi.fn(), warn: vi.fn() };
describe('portable guarded helpers', () => {
  it('defaults patch/addline/patchline to preview without any backend call', async () => {
    const client = new PriorityClient(cfg as unknown as Config, logger as unknown as Logger);
    const update = vi.spyOn(client, 'updateComposite');
    const add = vi.spyOn(client, 'addLine');
    for (const args of [
      ['patch', 'X', '{"K":"1"}', '{"F":2}'],
      ['addline', 'X', '{"K":"1"}', 'S_SUBFORM', '{"F":2}'],
      ['patchline', 'X', '{"K":"1"}', 'S_SUBFORM', '{"KLINE":1}', '{"F":2}'],
    ])
      expect(await runComposite(args, cfg, client)).toMatchObject({
        status: 'preview',
        verified: false,
      });
    expect(update).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(cfg.priorityReadOnly).toBe(true);
  });
  it('honors read-only even with explicit confirmation', async () => {
    const client = new PriorityClient(cfg as unknown as Config, logger as unknown as Logger);
    expect(
      await runComposite(['patch', 'X', '{"K":"1"}', '{"F":2}', '--confirm'], cfg, client),
    ).toMatchObject({ status: 'blocked' });
  });
  it('does not infer document finalization from a status description', async () => {
    const client = new PriorityClient(cfg as unknown as Config, logger as unknown as Logger);
    expect(await runFinalize(['PINVOICES', 'GI1'], cfg, client)).toMatchObject({
      status: 'preview',
      available: false,
    });
    expect(
      await runFinalize(
        ['PINVOICES', 'GI1', '--confirm'],
        { ...cfg, priorityReadOnly: false },
        client,
      ),
    ).toMatchObject({ status: 'blocked', available: false });
  });
});
