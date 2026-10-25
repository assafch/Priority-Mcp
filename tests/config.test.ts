import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseReadOnly } from '../src/config.js';

describe('parseReadOnly (PRIORITY_READ_ONLY fail-safe parsing)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enables writes ONLY on explicit recognized "off" tokens', () => {
    for (const v of ['false', '0', 'no', 'off', 'disabled']) {
      expect(parseReadOnly(v)).toBe(false); // false = writes enabled
    }
  });

  it('is case- and whitespace-insensitive for the off tokens', () => {
    for (const v of ['False', 'FALSE', ' false ', 'Off', 'NO']) {
      expect(parseReadOnly(v)).toBe(false);
    }
  });

  it('treats truthy variants as READ-ONLY (the fail-open bug: True/1/yes must NOT enable writes)', () => {
    for (const v of ['true', 'True', 'TRUE', '1', 'yes', 'on', 'enabled', ' true ']) {
      expect(parseReadOnly(v)).toBe(true); // true = read-only, writes disabled
    }
  });

  it('defaults an UNSET or empty value to read-only (safe default)', () => {
    expect(parseReadOnly(undefined)).toBe(true);
    expect(parseReadOnly('')).toBe(true);
    expect(parseReadOnly('   ')).toBe(true);
  });

  it('fails SAFE on an unrecognized value and warns on stderr', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(parseReadOnly('maybe')).toBe(true); // unknown ⇒ read-only
    expect(parseReadOnly('flase')).toBe(true); // typo of "false" must NOT enable writes
    expect(err).toHaveBeenCalledTimes(2);
  });
});

describe('connection URL credentials', () => {
  afterEach(() => vi.restoreAllMocks());
  it('rejects URL userinfo, query strings and fragments before resources or previews can expose them', async () => {
    const { loadConfig } = await import('../src/config.js');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('configuration rejected');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const field of ['PRIORITY_SERVICE_ROOT', 'PRIORITY_BASE_URL', 'PRIORITY_API_URL']) {
      for (const url of [
        'https://u:secret@example.test/odata',
        'https://example.test/odata?token=secret',
        'https://example.test/odata#secret',
      ]) {
        expect(() =>
          loadConfig({ [field]: url, PRIORITY_COMPANY: 'demo', PRIORITY_PAT: 'synthetic' }),
        ).toThrow('configuration rejected');
      }
    }
    expect(exit).toHaveBeenCalledTimes(9);
  });
  it('uses a caller-supplied config environment with fail-safe defaults', async () => {
    const { loadConfig } = await import('../src/config.js');
    const parsed = loadConfig({
      PRIORITY_SERVICE_ROOT: 'https://example.test/odata/Priority/test.ini/demo',
      PRIORITY_PAT: 'synthetic',
    });
    expect(parsed.priorityReadOnly).toBe(true);
    expect(parsed.mcpHttpHost).toBe('127.0.0.1');
  });
});
