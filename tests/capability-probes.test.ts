import { describe, expect, it } from 'vitest';
import { PriorityError } from '../src/client/errors.js';
import type { PriorityClient } from '../src/client/priority-client.js';
import type { Config } from '../src/config.js';
import { CapabilityCatalog } from '../src/lib/capabilities.js';
const config = { priorityReadOnly: true } as Config;
describe('capability probe evidence', () => {
  it('probes the invoice form before describing supplier-invoice capability as readable', async () => {
    const client = {
      request: async (form: string) => {
        if (form === 'PINVOICES') throw new PriorityError('forbidden', 403);
        return { value: [] };
      },
    } as unknown as PriorityClient;
    const catalog = new CapabilityCatalog(client, config);
    await catalog.refresh(catalog.list().filter((x) => x.name === 'pinvoice_create'));
    expect(catalog.list().find((x) => x.name === 'pinvoice_create')?.availability).toBe(
      'permission-denied',
    );
  });
  it('does not confuse authentication or network failure with an absent entity', async () => {
    for (const [error, expected] of [
      [new PriorityError('auth', 401), 'permission-denied'],
      [new Error('timeout'), 'unknown'],
    ] as const) {
      const catalog = new CapabilityCatalog(
        {
          request: async () => {
            throw error;
          },
        } as unknown as PriorityClient,
        config,
      );
      await catalog.refresh(catalog.list('invoices'));
      expect(
        catalog.list('invoices').find((x) => x.name === 'priority_list_invoices')?.availability,
      ).toBe(expected);
    }
  });
  it('keeps refresh concurrency bounded across simultaneous callers', async () => {
    let active = 0;
    let max = 0;
    const client = {
      request: async () => {
        active++;
        max = Math.max(max, active);
        await new Promise<void>((r) => setImmediate(r));
        active--;
        return { value: [] };
      },
    } as unknown as PriorityClient;
    const catalog = new CapabilityCatalog(client, config);
    await Promise.all([
      catalog.refresh(catalog.list()),
      catalog.refresh(catalog.list()),
      catalog.refresh(catalog.list()),
    ]);
    expect(max).toBeLessThanOrEqual(4);
  });
});
