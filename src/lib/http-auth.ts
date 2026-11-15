import { timingSafeEqual } from 'node:crypto';

/**
 * HTTP-transport access controls. These back the /mcp endpoint's defenses against the audit's
 * critical finding (an unauthenticated ERP proxy bound to all interfaces):
 *  - loopback-by-default binding + a fail-safe refusal to bind a public interface without a token,
 *  - a constant-time bearer-token check,
 *  - an Origin allowlist so a browser (DNS-rebinding) can't drive the endpoint.
 */

/** True for loopback hosts — the only interfaces safe to bind without an auth token. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * Constant-time bearer-token check. When no token is configured (`expected` empty) the server
 * is loopback-only and every request is allowed. Otherwise the Authorization header must be
 * exactly `Bearer <token>`.
 */
export function isAuthorized(
  authHeader: string | undefined,
  expected: string | undefined,
): boolean {
  if (!expected) return true;
  const prefix = 'Bearer ';
  if (!authHeader || !authHeader.startsWith(prefix)) return false;
  const provided = Buffer.from(authHeader.slice(prefix.length));
  const want = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so guard length first (a length leak is harmless).
  if (provided.length !== want.length) return false;
  return timingSafeEqual(provided, want);
}

/**
 * DNS-rebinding defense: a request with no Origin header (native MCP clients like Claude Desktop)
 * is allowed; a request carrying a browser Origin is allowed only if it is in the allowlist.
 */
export function isOriginAllowed(origin: string | undefined, allowed: ReadonlySet<string>): boolean {
  if (!origin) return true;
  return allowed.has(origin);
}
