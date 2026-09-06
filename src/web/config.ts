import { resolve } from 'node:path';
export function webConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.WEB_HOST && env.WEB_HOST !== '127.0.0.1')
    throw new Error('V1 only supports WEB_HOST=127.0.0.1');
  if (env.WEB_MODE && env.WEB_MODE !== 'demo') throw new Error('V1 only supports WEB_MODE=demo');
  const port = Number(env.WEB_PORT ?? '3210');
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('WEB_PORT must be 1024–65535');
  return {
    host: '127.0.0.1',
    port,
    origin: `http://127.0.0.1:${port}`,
    dbPath: resolve(env.WEB_DB_PATH ?? '.local-web/requests.sqlite'),
  };
}
