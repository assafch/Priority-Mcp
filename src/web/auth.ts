import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { WebError } from './domain.js';
import type { WebStore } from './store.js';

// Fixed parameters; a stored string cannot choose arbitrarily expensive KDF settings.
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password: string) {
  if (password.length < 16 || password.length > 128)
    throw new WebError(400, 'הסיסמה חייבת להכיל 16–128 תווים.');
  const salt = randomBytes(16).toString('hex');
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });
  return `scrypt-v1$${salt}$${key.toString('hex')}`;
}
export function equalSecret(actual: string, expected: string) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function verifyPassword(password: string, encoded: string) {
  const [scheme, salt, hash] = encoded.split('$');
  if (
    scheme !== 'scrypt-v1' ||
    !/^[a-f0-9]{32}$/.test(salt ?? '') ||
    !/^[a-f0-9]{128}$/.test(hash ?? '')
  )
    return false;
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, options, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
export class WebAuth {
  private dummy = hashPassword(randomBytes(32).toString('base64url'));
  constructor(private store: WebStore) {}
  async login(username: string, password: string) {
    if (!this.store.chargeLogin(username)) {
      this.store.audit(null, null, 'login_rate_limited');
      throw new WebError(429, 'יותר מדי ניסיונות כניסה. אפשר לנסות שוב בעוד 15 דקות.');
    }
    const agent = this.store.agent(username);
    const verified = await verifyPassword(password, agent?.passwordHash ?? (await this.dummy));
    if (!verified || !agent || agent.disabled) {
      this.store.audit(null, null, 'login_failed');
      throw new WebError(401, 'שם המשתמש או הסיסמה אינם נכונים.');
    }
    try {
      return this.store.newSession(agent);
    } catch (error) {
      if (error instanceof WebError && error.status === 401)
        this.store.audit(null, null, 'login_failed');
      throw error;
    }
  }
}
