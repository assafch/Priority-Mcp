import { describe, expect, it } from 'vitest';
import { isAuthorized, isLoopbackHost, isOriginAllowed } from '../src/lib/http-auth.js';

describe('isLoopbackHost', () => {
  it('recognizes loopback hosts', () => {
    for (const h of ['127.0.0.1', '::1', 'localhost']) expect(isLoopbackHost(h)).toBe(true);
  });
  it('treats routable hosts as non-loopback', () => {
    for (const h of ['0.0.0.0', '192.168.1.10', 'example.com', '::']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe('isAuthorized', () => {
  it('allows any request when no token is configured (loopback-only mode)', () => {
    expect(isAuthorized(undefined, undefined)).toBe(true);
    expect(isAuthorized('Bearer whatever', undefined)).toBe(true);
  });

  it('requires an exact Bearer token match when a token is configured', () => {
    expect(isAuthorized('Bearer s3cret', 's3cret')).toBe(true);
    expect(isAuthorized('Bearer wrong', 's3cret')).toBe(false);
    expect(isAuthorized('Bearer s3cre', 's3cret')).toBe(false); // length mismatch, no throw
    expect(isAuthorized('s3cret', 's3cret')).toBe(false); // missing "Bearer " prefix
    expect(isAuthorized(undefined, 's3cret')).toBe(false); // missing header
    expect(isAuthorized('', 's3cret')).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  it('allows requests with no Origin (native MCP clients)', () => {
    expect(isOriginAllowed(undefined, new Set())).toBe(true);
  });
  it('blocks a browser Origin that is not allowlisted (DNS-rebinding defense)', () => {
    expect(isOriginAllowed('https://evil.example', new Set())).toBe(false);
    expect(isOriginAllowed('http://localhost:3000', new Set(['http://localhost:3000']))).toBe(true);
    expect(isOriginAllowed('https://evil.example', new Set(['http://localhost:3000']))).toBe(false);
  });
});
