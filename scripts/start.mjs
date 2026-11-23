#!/usr/bin/env node
/**
 * Start the server on a host where `dist` may be missing or out of date.
 *
 * `dist` and `node_modules` are git-ignored, so a host that resets ignored files (or a fresh
 * clone, or a `git pull`) leaves the server unable to start, or running old code. This entry
 * point checks first:
 *
 *   - dependencies missing            → `npm ci --ignore-scripts` (from the lockfile)
 *   - dist/index.js missing, or older than src/, package.json or tsconfig.json → build
 *
 * and then loads dist/index.js in this same process, so the MCP stdio stream is untouched.
 *
 * Rules that keep it safe:
 *   - stdout belongs to the MCP protocol: every message here and every child process writes to
 *     stderr only.
 *   - a failed install or build stops the start with exit code 1. It never falls back to an old
 *     dist — old code is exactly what a pull was meant to replace.
 *   - one build at a time: a lock directory makes a second process wait instead of building
 *     into the same folder.
 *
 * Use it directly (`node scripts/start.mjs`). Do NOT start a stdio server through `npm start`:
 * npm prints its own banner to stdout.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** stdin closed, stdout and stderr of the child both go to our stderr. */
export const CHILD_STDIO = ['ignore', 2, 2];

const LOCK_NAME = '.build.lock';
/** A lock older than this belongs to a process that died mid-build. */
const STALE_LOCK_MS = 10 * 60_000;
const WAIT_LIMIT_MS = 5 * 60_000;

const mtime = (path) => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** Newest modification time of any file under `dir`, 0 when the folder is absent. */
function newestUnder(dir) {
  let newest = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestUnder(full) : mtime(full));
  }
  return newest;
}

/**
 * What has to happen before dist/index.js can be loaded.
 * @param {string} root project root
 * @returns {{ install: boolean, build: boolean, reason: string }}
 */
export function decideStart(root) {
  const entry = join(root, 'dist', 'index.js');
  const install =
    !existsSync(join(root, 'node_modules', 'typescript', 'bin', 'tsc')) ||
    !existsSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'));
  if (install) return { install: true, build: true, reason: 'dependencies are missing' };
  if (!existsSync(entry))
    return { install: false, build: true, reason: 'dist/index.js is missing' };
  const built = mtime(entry);
  const source = Math.max(
    newestUnder(join(root, 'src')),
    mtime(join(root, 'package.json')),
    mtime(join(root, 'tsconfig.json')),
  );
  if (source > built) {
    return { install: false, build: true, reason: 'the source is newer than dist' };
  }
  return { install: false, build: false, reason: 'dist is up to date' };
}

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: CHILD_STDIO });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Take the build lock, waiting for another process's build to finish. */
async function acquireLock(root, log, pollMs) {
  const lock = join(root, LOCK_NAME);
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      return lock;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
    if (Date.now() - mtime(lock) > STALE_LOCK_MS) {
      log('removing a stale build lock');
      rmSync(lock, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - started > WAIT_LIMIT_MS) {
      throw new Error(`another build has held ${LOCK_NAME} for too long; remove it and retry`);
    }
    await sleep(pollMs);
  }
}

/**
 * Install and build when needed. Throws when the server must not be started.
 * @param {string} root project root
 * @param {{ run?: (command: string, args: string[], cwd: string) => number,
 *           log?: (message: string) => void, pollMs?: number }} [options]
 */
export async function ensureBuilt(root, options = {}) {
  const run = options.run ?? runCommand;
  const log = options.log ?? ((message) => process.stderr.write(`[start] ${message}\n`));
  if (!decideStart(root).build) return;

  const lock = await acquireLock(root, log, options.pollMs ?? 500);
  try {
    // Another process may have finished the same work while we waited for the lock.
    const plan = decideStart(root);
    if (!plan.build) return;
    log(`${plan.reason} — preparing the server`);
    if (plan.install) {
      log('installing dependencies from the lockfile (npm ci --ignore-scripts)');
      const code = run('npm', ['ci', '--ignore-scripts'], root);
      if (code !== 0) throw new Error(`Install failed (npm ci exited with ${code}).`);
    }
    log('building (tsc)');
    const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    const code = run(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')], root);
    if (code !== 0) {
      throw new Error(`Build failed (tsc exited with ${code}); the server was not started.`);
    }
    if (!existsSync(join(root, 'dist', 'index.js'))) {
      throw new Error('The build finished but dist/index.js does not exist.');
    }
    log('build finished');
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    await ensureBuilt(root);
  } catch (err) {
    process.stderr.write(`[start] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
  await import(pathToFileURL(join(root, 'dist', 'index.js')).href);
}
