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
