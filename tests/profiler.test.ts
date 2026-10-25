import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
// Script is deliberately usable before build/configuration, so offline validation cannot connect.
// @ts-expect-error standalone JavaScript command
import { summarizeSamples, validateScenarios } from '../scripts/profile-readonly.mjs';
const sample = {
  form: 'CUSTOMERS',
  kind: 'record',
  keys: { CUSTNAME: '0012' },
  fields: ['CUSTNAME'],
  cache: 'cold',
  samples: 50,
};
describe('explicit read-only pilot bounds', () => {
  it('rejects discovery, raw query injection and over-budget plans', () => {
    expect(validateScenarios([sample])).toHaveLength(1);
    expect(() => validateScenarios([{ ...sample, form: '$metadata' }])).toThrow();
    expect(() => validateScenarios([{ ...sample, fields: ['CUSTNAME&$expand=X'] }])).toThrow();
    expect(() =>
      validateScenarios(Array.from({ length: 4 }, () => ({ ...sample, cache: 'warm' }))),
    ).toThrow();
  });
  it('does not fabricate p95 with too few successful samples', () => {
    expect(summarizeSamples([1, 2, 3]).p95Ms).toBeNull();
    expect(summarizeSamples(Array.from({ length: 50 }, (_, i) => i)).p95Ms).toBe(47);
  });
  it('can print help offline and rejects execution without live flag before config', () => {
    expect(
      execFileSync(process.execPath, ['scripts/profile-readonly.mjs', '--help'], {
        encoding: 'utf8',
      }),
    ).toContain('--live');
    expect(() =>
      execFileSync(process.execPath, ['scripts/profile-readonly.mjs'], { stdio: 'pipe' }),
    ).toThrow();
  });
});
