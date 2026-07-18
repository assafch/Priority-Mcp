import type { Config } from '../config.js';

/**
 * Build the HTTP Basic auth header value.
 *
 * Priority exposes the SAME Basic scheme for both installation styles:
 *   - PAT (token) installs:  username = the Personal Access Token, password = literal "PAT"
 *   - Classic on-prem:       username = API user name,             password = Priority password
 * Both collapse to `Authorization: Basic base64(user:pass)`, so no branching is needed —
 * the distinction lives entirely in which values you put in PRIORITY_USERNAME / PRIORITY_PASSWORD.
 */
export function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/**
 * Build the full set of auth/licensing headers sent on every Priority request:
 * the Basic Authorization header plus the optional per-application licensing headers
 * X-App-Id / X-App-Key (Priority 18.3+), included only when configured.
 *
 * Credential precedence: a PAT (sent as base64(<PAT>:PAT)) if PRIORITY_PAT is set,
 * otherwise the PRIORITY_USERNAME/PRIORITY_PASSWORD pair.
 */
export function buildAuthHeaders(config: Config): Record<string, string> {
  const authorization = config.priorityPat
    ? basicAuthHeader(config.priorityPat, 'PAT')
    : basicAuthHeader(config.priorityUsername ?? '', config.priorityPassword ?? '');
  const headers: Record<string, string> = { Authorization: authorization };
  if (config.priorityAppId) headers['X-App-Id'] = config.priorityAppId;
  if (config.priorityAppKey) headers['X-App-Key'] = config.priorityAppKey;
  return headers;
}
