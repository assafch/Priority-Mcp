import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('site codes', () => {
  it('uses placeholder defaults when the environment names no codes', async () => {
    vi.stubEnv('PRIORITY_BONDED_WAREHOUSE', '');
    vi.stubEnv('PRIORITY_RELEASE_WAREHOUSE', '');
    vi.resetModules();
    const codes = await import('../src/lib/site-codes.js');
    expect(codes.BONDED_WAREHOUSE).toBe('BONDED');
    expect(codes.DEFAULT_RELEASE_WAREHOUSE).toBe('Main');
  });

  it('takes the installation codes from the environment, trimmed', async () => {
    vi.stubEnv('PRIORITY_BONDED_WAREHOUSE', ' WH9 ');
    vi.stubEnv('PRIORITY_RELEASE_WAREHOUSE', 'STORE');
    vi.resetModules();
    const codes = await import('../src/lib/site-codes.js');
    expect(codes.BONDED_WAREHOUSE).toBe('WH9');
    expect(codes.DEFAULT_RELEASE_WAREHOUSE).toBe('STORE');
    const stage = await import('../src/lib/impfile-stage.js');
    expect(stage.BONDED_WAREHOUSE).toBe('WH9');
  });
});
