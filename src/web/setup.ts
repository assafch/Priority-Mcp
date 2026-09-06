import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { hashPassword } from './auth.js';
import { webConfig } from './config.js';
import { WebStore } from './store.js';

async function hiddenPassword(): Promise<string> {
  process.stdout.write('Site password (16–128 characters; hidden): ');
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKey);
      process.stdout.write('\n');
    };
    const onKey = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        finish();
        reject(new Error('Setup cancelled'));
      } else if (key.name === 'return') {
        finish();
        resolve(password);
      } else if (key.name === 'backspace') password = password.slice(0, -1);
      else if (
        text &&
        !key.ctrl &&
        [...text].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)
      )
        password += text;
    };
    process.stdin.on('keypress', onKey);
  });
}

process.umask(0o077);
const config = webConfig();
const store = new WebStore(config.dbPath);
try {
  if (process.argv.includes('--generate')) {
    const username = 'instinct';
    const path = join(dirname(config.dbPath), 'agent-login.txt');
    if (store.agent(username) || existsSync(path))
      throw new Error('Agent already exists. Run interactive setup to rotate its password.');
    const password = randomBytes(24).toString('base64url');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const hash = await hashPassword(password);
    writeFileSync(
      path,
      `Local demo portal only\nURL: ${config.origin}/login\nUsername: ${username}\nPassword: ${password}\n\nImport into the browser vault locally. Do not paste this file into chat. Delete after importing.\n`,
      { mode: 0o600, flag: 'wx' },
    );
    try {
      // Another setup process may provision the account while the password hash is computed.
      store.provision(username, hash, { createOnly: true });
    } catch (error) {
      unlinkSync(path);
      throw error;
    }
    console.info(`Agent created. Import the credentials from the private local file: ${path}`);
  } else {
    if (!process.stdin.isTTY)
      throw new Error(
        'Use an interactive terminal, or --generate for a private local credential file.',
      );
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const username = (await prompt.question('Agent username [instinct]: ')).trim() || 'instinct';
    prompt.close();
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(username))
      throw new Error('Username must use 1–64 letters, digits, dot, underscore or hyphen.');
    const password = await hiddenPassword();
    store.provision(username, await hashPassword(password));
    console.info(
      'Agent saved; previous sessions revoked. Store the site credentials directly in the browser vault.',
    );
  }
} catch (error) {
  console.error(
    error instanceof Error && !('code' in error)
      ? error.message
      : 'Setup failed. Check local database/file permissions.',
  );
  process.exitCode = 1;
} finally {
  store.close();
}
