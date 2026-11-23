import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CHILD_STDIO, decideStart, ensureBuilt } from '../scripts/start.mjs';

/**
 * scripts/start.mjs starts the server even when `dist` was wiped (a host that resets ignored
 * files) or is older than the source (after a pull): it installs and builds first. The build must
 * never write to stdout, which belongs to the MCP stdio protocol.
 */
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function project(opts: { dist?: boolean; deps?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'start-script-'));
  roots.push(root);
  mkdirSync(join(root, 'src', 'lib'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), 'export {};');
  writeFileSync(join(root, 'src', 'lib', 'a.ts'), 'export {};');
  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  const old = new Date(Date.now() - 60_000);
  for (const f of ['src/index.ts', 'src/lib/a.ts', 'package.json', 'tsconfig.json']) {
    utimesSync(join(root, f), old, old);
  }
  if (opts.deps !== false) {
    mkdirSync(join(root, 'node_modules', 'typescript', 'bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '');
    mkdirSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '@modelcontextprotocol', 'sdk', 'package.json'), '{}');
  }
  if (opts.dist) {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'index.js'), '');
  }
  return root;
}
const touchNow = (root: string, file: string) => {
  const soon = new Date(Date.now() + 5_000);
  utimesSync(join(root, file), soon, soon);
};

describe('decideStart', () => {
  it('builds when dist/index.js is missing', () => {
    expect(decideStart(project())).toMatchObject({ install: false, build: true });
  });

  it('does nothing when dist is newer than the source', () => {
    expect(decideStart(project({ dist: true }))).toEqual({
      install: false,
      build: false,
      reason: 'dist is up to date',
    });
  });

  it('rebuilds when a source file, package.json or tsconfig.json is newer than dist', () => {
    for (const file of ['src/lib/a.ts', 'package.json', 'tsconfig.json']) {
      const root = project({ dist: true });
      touchNow(root, file);
      const d = decideStart(root);
      expect(d.build).toBe(true);
      expect(d.reason).toContain('newer');
    }
  });

  it('installs when the dependencies are gone, and builds after an install', () => {
    expect(decideStart(project({ deps: false }))).toMatchObject({ install: true, build: true });
    expect(decideStart(project({ deps: false, dist: true }))).toMatchObject({
      install: true,
      build: true,
    });
  });
});

describe('ensureBuilt', () => {
  const recorder = (root: string, exit = 0) => {
    const calls: string[] = [];
    const run = (command: string, args: string[]) => {
      calls.push(
        [command.endsWith('node') || command === process.execPath ? 'node' : command, ...args].join(
          ' ',
        ),
      );
      if (exit === 0 && args.some((a) => a.endsWith('tsc'))) {
        mkdirSync(join(root, 'dist'), { recursive: true });
        writeFileSync(join(root, 'dist', 'index.js'), '');
      }
      return exit;
    };
    return { calls, run };
  };

  it('runs nothing when dist is up to date', async () => {
    const root = project({ dist: true });
    const { calls, run } = recorder(root);
    await ensureBuilt(root, { run, log: () => {} });
    expect(calls).toEqual([]);
  });

  it('builds a missing dist with the local TypeScript compiler', async () => {
    const root = project();
    const { calls, run } = recorder(root);
    await ensureBuilt(root, { run, log: () => {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(join('node_modules', 'typescript', 'bin', 'tsc'));
    expect(existsSync(join(root, 'dist', 'index.js'))).toBe(true);
    expect(existsSync(join(root, '.build.lock'))).toBe(false);
  });

  it('installs from the lockfile first when the dependencies are gone', async () => {
    const root = project({ deps: false });
    const { calls, run } = recorder(root);
    await ensureBuilt(root, { run, log: () => {} });
    expect(calls[0]).toBe('npm ci --ignore-scripts');
    expect(calls[1]).toContain('tsc');
  });

  it('fails loudly and releases the lock when the build fails', async () => {
    const root = project();
    const { run } = recorder(root, 2);
    await expect(ensureBuilt(root, { run, log: () => {} })).rejects.toThrow(/build failed/i);
    expect(existsSync(join(root, '.build.lock'))).toBe(false);
  });

  it('refuses to start on a build that left no dist/index.js', async () => {
    const root = project();
    const run = () => 0; // "succeeds" but writes nothing
    await expect(ensureBuilt(root, { run, log: () => {} })).rejects.toThrow(/dist\/index\.js/);
  });

  it('waits for a build another process is running instead of building twice', async () => {
    const root = project();
    mkdirSync(join(root, '.build.lock'));
    const { calls, run } = recorder(root);
    setTimeout(() => {
      mkdirSync(join(root, 'dist'), { recursive: true });
      writeFileSync(join(root, 'dist', 'index.js'), '');
      rmSync(join(root, '.build.lock'), { recursive: true });
    }, 150);
    await ensureBuilt(root, { run, log: () => {}, pollMs: 25 });
    expect(calls).toEqual([]);
  });

  it('never lets a child process write to stdout', () => {
    expect(CHILD_STDIO).toEqual(['ignore', 2, 2]);
  });
});
