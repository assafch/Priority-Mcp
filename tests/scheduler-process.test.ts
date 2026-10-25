import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'priority-scheduler-process-')));
  temporary.push(directory);
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  for (const name of ['request-scheduler', 'rate-limit', 'auth']) {
    const source = await readFile(resolve(`src/client/${name}.ts`), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        verbatimModuleSyntax: true,
      },
    }).outputText;
    await writeFile(join(directory, `${name}.js`), compiled);
  }
  return directory;
}
function processRun(directory: string, source: string) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 1500,
    env: { PATH: process.env.PATH },
  });
}
function schedulerSource(directory: string, body: string) {
  return `import {RequestScheduler} from ${JSON.stringify(pathToFileURL(join(directory, 'request-scheduler.js')).href)};
const ctx=(signal=new AbortController().signal,deadlineAt=Date.now()+60000)=>({traceId:'offline',toolName:'offline',workClass:'interactive',signal,deadlineAt});
${body}`;
}

describe('scheduler process lifetime without host keepalive', () => {
  it('waits for a paused admission before exiting, including an infinite shared-work deadline', async () => {
    const directory = await fixture();
    const result = processRun(
      directory,
      schedulerSource(
        directory,
        `const scheduler=new RequestScheduler();scheduler.pause(150);console.log('started');scheduler.acquire(ctx(undefined,Infinity)).then(release=>{release();console.log('completed');scheduler.close();},error=>{console.error(error.message);process.exitCode=1;});`,
      ),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['started', 'completed']);
  });
  it('keeps a capacity-blocked finite deadline alive until it rejects and releases its handles', async () => {
    const directory = await fixture();
    const result = processRun(
      directory,
      schedulerSource(
        directory,
        `const scheduler=new RequestScheduler({maxConcurrency:1});scheduler.acquire(ctx(undefined,Infinity)).then(held=>{console.log('started');scheduler.acquire(ctx(undefined,Date.now()+25)).then(()=>{console.log('unexpected');process.exitCode=1;},error=>{console.log(error.message);held();});});`,
      ),
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('started\nRequest deadline exceeded\n');
    expect(result.stdout).not.toContain('unexpected');
  });
  it.each(['abort', 'close'])('removes all long-lived timers after queued %s', async (action) => {
    const directory = await fixture();
    const result = processRun(
      directory,
      schedulerSource(
        directory,
        `const scheduler=new RequestScheduler();const controller=new AbortController();scheduler.pause(60000);scheduler.acquire(ctx(controller.signal)).then(()=>{console.log('unexpected');process.exitCode=1;},error=>console.log(error.message));setTimeout(()=>${action === 'abort' ? "controller.abort(new Error('cancelled'))" : 'scheduler.close()'},25);`,
      ),
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(action === 'abort' ? 'cancelled' : 'Scheduler closed');
  });
});

async function profilerFixture(failAt: number | null) {
  const directory = await fixture();
  // Compile the CLI's real runtime dependency graph locally: npm test runs before build in CI.
  // This also prevents stale dist from making the process regression silently pass.
  const seen = new Set<string>();
  const compile = async (relative: string): Promise<void> => {
    if (seen.has(relative)) return;
    seen.add(relative);
    if (relative.startsWith('../') || !relative.endsWith('.js'))
      throw new Error('Unexpected runtime import outside the source fixture');
    const source = await readFile(resolve('src', relative.replace(/\.js$/, '.ts')), 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ES2022,
        verbatimModuleSyntax: true,
      },
    }).outputText;
    const destination = join(directory, 'dist', relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, compiled);
    const ast = ts.createSourceFile(
      relative,
      compiled,
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.JS,
    );
    await Promise.all(
      ast.statements.flatMap((statement) => {
        const specifier =
          ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
            ? statement.moduleSpecifier
            : undefined;
        return specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')
          ? [compile(join(dirname(relative), specifier.text))]
          : [];
      }),
    );
  };
  await Promise.all(
    ['client/priority-client.js', 'config.js', 'logger.js', 'client/odata-builder.js'].map(compile),
  );
  await mkdir(join(directory, 'scripts'));
  await cp(
    resolve('scripts/profile-readonly.mjs'),
    join(directory, 'scripts/profile-readonly.mjs'),
  );
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
  await writeFile(
    join(directory, 'scenarios.json'),
    JSON.stringify([
      { form: 'CUSTOMERS', kind: 'list', fields: ['CUSTNAME'], top: 1, cache: 'cold', samples: 50 },
    ]),
  );
  await writeFile(
    join(directory, 'offline-preload.mjs'),
    `import {createRequire,syncBuiltinESMExports} from 'node:module';
const require=createRequire(import.meta.url);const timers=require('node:timers/promises');const originalDelay=timers.setTimeout;const originalTimeout=globalThis.setTimeout;const epoch=Date.now();const started=performance.now();const scale=100;
Date.now=()=>epoch+Math.floor((performance.now()-started)*scale);
globalThis.setTimeout=(callback,milliseconds,...args)=>originalTimeout(callback,Math.max(1,Number(milliseconds)/scale),...args);
timers.setTimeout=(milliseconds,value,options)=>originalDelay(Math.max(1,Number(milliseconds)/scale),value,options);syncBuiltinESMExports();
let calls=0;process.once('beforeExit',()=>process.stderr.write('fixture-before-exit:'+calls+'\\n'));globalThis.fetch=async(input,init)=>{if(new URL(String(input)).origin!=='https://profiler.fixture'||init?.method!=='GET')throw new Error('Nonfixture request forbidden');calls++;return calls===${JSON.stringify(failAt)}?new Response('{"error":{"message":"fixture failure"}}',{status:400,headers:{'content-type':'application/json'}}):Response.json({value:[{CUSTNAME:'synthetic'}]});};`,
  );
  return directory;
}
function runProfiler(directory: string) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      join(directory, 'offline-preload.mjs'),
      join(directory, 'scripts/profile-readonly.mjs'),
      '--live',
      '--scenario-file',
      join(directory, 'scenarios.json'),
      '--output',
      join(directory, 'result.json'),
    ],
    {
      cwd: resolve('.'),
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        PRIORITY_SERVICE_ROOT: 'https://profiler.fixture/odata/Priority/test.ini/demo',
        PRIORITY_PAT: 'synthetic-only',
        PRIORITY_READ_ONLY: 'true',
        RATE_LIMIT_PER_MINUTE: '30',
        LOG_LEVEL: 'error',
      },
    },
  );
}
describe('real read-only profiler CLI completion with an offline fetch boundary', () => {
  it('distinguishes a completed small requested run from insufficient p95 evidence', async () => {
    const directory = await profilerFixture(null);
    await writeFile(
      join(directory, 'scenarios.json'),
      JSON.stringify([
        {
          form: 'CUSTOMERS',
          kind: 'list',
          fields: ['CUSTNAME'],
          top: 1,
          cache: 'cold',
          samples: 3,
        },
      ]),
    );
    const result = runProfiler(directory);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    expect(report).toMatchObject({
      complete: true,
      p95Sufficient: false,
      results: [{ samples: 3, requestedSamples: 3, sufficient: false, p95Ms: null, failures: 0 }],
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: true, p95Sufficient: false });
  });
  it('survives the 30-per-minute queue and flushes all fifty sample results', async () => {
    const directory = await profilerFixture(null);
    const result = runProfiler(directory);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(
      await readFile(join(directory, 'result.json'), 'utf8').catch((error) => {
        throw new Error(`${result.stderr} ${error.message}`);
      }),
    );
    expect(report).toMatchObject({
      complete: true,
      backendAttempts: 50,
      results: [{ samples: 50, sufficient: true, failures: 0 }],
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: true, backendAttempts: 50 });
  });
  it('flushes partial evidence and exits unsuccessfully when one requested sample failed', async () => {
    const directory = await profilerFixture(2);
    const result = runProfiler(directory);
    expect(result.status, result.stderr).toBe(1);
    const report = JSON.parse(
      await readFile(join(directory, 'result.json'), 'utf8').catch((error) => {
        throw new Error(`${result.stderr} ${error.message}`);
      }),
    );
    expect(report).toMatchObject({
      complete: false,
      backendAttempts: 50,
      results: [{ samples: 49, sufficient: false, p95Ms: null, failures: 1 }],
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ complete: false, backendAttempts: 50 });
  });
});
