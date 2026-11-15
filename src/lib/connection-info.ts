import { readFileSync } from 'node:fs';
import { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';

/** Public identity reflects the root actually used; URLs and PAT usernames are never credentials output. */
export function connectionInfo(config: Config) {
  const root = new URL(PriorityClient.buildBaseUrl(config));
  root.username = '';
  root.password = '';
  root.search = '';
  root.hash = '';
  const parts = root.pathname.split('/').filter(Boolean);
  const authentication = config.priorityPat || config.priorityPassword === 'PAT' ? 'pat' : 'basic';
  return {
    serviceRoot: root.href.replace(/\/+$/, ''),
    environment: parts.at(-2),
    company: parts.at(-1),
    language: config.priorityLanguage,
    readOnly: config.priorityReadOnly,
    authentication,
    ...(authentication === 'basic' ? { username: config.priorityUsername } : {}),
  };
}

// Resolve relative to the module in both src/lib and dist/lib; the package ships package.json.
export const packageVersion: string = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;
