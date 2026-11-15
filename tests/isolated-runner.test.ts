import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('isolated runner records a crash before suites start', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bor-czuwa-runner-crash-'));
  try {
    await mkdir(path.join(directory, 'scripts/ci'), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(directory, 'scripts/test-isolated.mjs'),
      await readFile(path.join(root, 'scripts/test-isolated.mjs')));
    for (const helper of ['redact.mjs', 'check-in-gate.mjs']) await writeFile(path.join(directory, 'scripts/ci', helper), await readFile(path.join(root, 'scripts/ci', helper)));
    await writeFile(path.join(directory, 'scripts/generate-workloads.mjs'), 'process.exit(7);');
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
    const env = { ...process.env };
    delete env.ISOLATED_REPORT_PATH;
    const run = spawnSync(process.execPath, ['scripts/test-isolated.mjs'], { cwd: directory, env, encoding: 'utf8' });
    assert.equal(run.status, 1, run.stderr);
    const evidence = JSON.parse(await readFile(path.join(directory, '.scratch/faza-2/evidence/01-isolated-baseline.json'), 'utf8'));
    assert.deepEqual(evidence.runs, []);
    assert.deepEqual(evidence.failures, [{ stage: 'setup', error: 'Workload generation failed with exit 7' }]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const captureExit of [0, 9]) test(`failed startup retains redacted service logs before cleanup when capture exits ${captureExit}`, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bor-czuwa-startup-evidence-'));
  try {
    const bin = path.join(directory, 'bin'), calls = path.join(directory, 'calls.jsonl');
    for (const entry of ['bin', 'scripts/ci', 'data/fixtures', 'data/rule-sets', 'tests/golden']) await mkdir(path.join(directory, entry), { recursive: true });
    await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(directory, 'package-lock.json'), '{}');
    await writeFile(path.join(directory, '.gitignore'), 'node_modules/\n.scratch/\n');
    await writeFile(path.join(directory, 'scripts/test-isolated.mjs'), await readFile(path.join(root, 'scripts/test-isolated.mjs')));
    for (const helper of ['redact.mjs', 'check-in-gate.mjs']) await writeFile(path.join(directory, 'scripts/ci', helper), await readFile(path.join(root, 'scripts/ci', helper)));
    await writeFile(path.join(directory, 'scripts/generate-workloads.mjs'), `
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.scratch/faza-2/workloads', {recursive:true});
writeFileSync('.scratch/faza-2/workloads/fixture.json', '{}');
`);
    for (const name of ['notice-cases', 'notice-skeletons', 'notice-places']) await writeFile(path.join(directory, 'tests/golden', name + '.json'), '{}');
    await writeFile(path.join(directory, 'data/rule-sets/2026-09-24-v2.json'), '{}');
    await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
    await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
    await writeFile(path.join(bin, 'podman'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args=process.argv.slice(2);
appendFileSync(process.env.STARTUP_TEST_CALLS, JSON.stringify(args)+'\\n');
if(args[0]==='network'&&args[1]==='create') process.exit(0);
if(args[0]==='network'&&args[1]==='inspect'){console.log('10.89.99.0/24');process.exit(0)}
if(args[0]==='compose'&&args.includes('up')){console.error('seeded startup failure');process.exit(7)}
if(args[0]==='compose'&&args.includes('logs')){
 console.log('FATAL 57P03 the database system is starting up');
 console.log('DATABASE_URL=postgres://owner:private-password@db/fixture token=private-token person@example.org');
 console.log('Authorization: Bearer private-bearer-token');
 process.exit(Number(process.env.STARTUP_TEST_CAPTURE_EXIT));
}
if(args[0]==='compose'&&args.includes('down')) process.exit(0);
if(args[0]==='image') process.exit(0);
console.error('Unexpected fixture command');process.exit(2);
`);
    for (const name of ['podman', 'systemctl']) await chmod(path.join(bin, name), 0o755);
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Seed disposable runner fixture']]) {
      const git = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
      assert.equal(git.status, 0, git.stderr);
    }
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
      STARTUP_TEST_CALLS: calls, STARTUP_TEST_CAPTURE_EXIT: String(captureExit), ISOLATED_REPORT_PATH: path.join(directory, 'result.json') };
    delete env.CI_CANDIDATE_ARCHIVE;
    const run = spawnSync(process.execPath, ['scripts/test-isolated.mjs'], { cwd: directory, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(run.status, 1, run.stderr);
    const report = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    assert.equal(report.runs.length, 2, JSON.stringify(report) + run.stdout + run.stderr);
    const invoked = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    for (const result of report.runs) {
      assert.equal(result.error, 'Compose startup failed with exit 7');
      assert.equal(result.cleanupExitCode, 0);
      assert.deepEqual(result.suites, {});
      assert.equal(result.startingRows, undefined);
      assert.ok(result.startupDiagnostics, 'Failed startup must retain service diagnostics before cleanup');
      assert.equal(result.startupDiagnostics.exitCode, captureExit);
      assert.deepEqual(result.startupDiagnostics.services, ['db', 'migration', 'fixture', 'app']);
      const log = await readFile(path.resolve(directory, result.startupDiagnostics.output), 'utf8');
      assert.match(log, /FATAL 57P03 the database system is starting up/);
      assert.match(log, /REDACTED/);
      assert.doesNotMatch(log + run.stdout + run.stderr + JSON.stringify(report), /private-[\w-]+|person@example\.org/);
      const commands = invoked.filter(args => args[0] === 'compose' && args[args.indexOf('-p') + 1] === result.project);
      assert.deepEqual(commands.map(args => args.includes('up') ? 'up' : args.includes('logs') ? 'logs' : 'down'), ['up', 'logs', 'down']);
      assert.deepEqual(commands[1].slice(-4), ['db', 'migration', 'fixture', 'app']);
      assert.equal(commands[1][commands[1].indexOf('--tail') + 1], '100');
    }
    const failures = report.failures as { stage: string; error: string }[];
    assert.deepEqual(failures.filter(item => item.stage === 'startup').map(item => item.error), ['Compose startup failed with exit 7', 'Compose startup failed with exit 7']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// A fixture repository with a fake podman. `up` fails (exit 7) after the first `bindFailures` attempts of
// each project fail with the rootlessport message, so a run ends at startup without a database.
async function runnerFixture(bindFailures: number, extraEnv: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bor-czuwa-runner-ports-'));
  const bin = path.join(directory, 'bin'), calls = path.join(directory, 'calls.jsonl');
  for (const entry of ['bin', 'scripts/ci', 'data/fixtures', 'data/rule-sets', 'tests/golden']) await mkdir(path.join(directory, entry), { recursive: true });
  await writeFile(path.join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(directory, 'package-lock.json'), '{}');
  await writeFile(path.join(directory, '.gitignore'), 'node_modules/\n.scratch/\n');
  await writeFile(path.join(directory, 'scripts/test-isolated.mjs'), await readFile(path.join(root, 'scripts/test-isolated.mjs')));
  for (const helper of ['redact.mjs', 'check-in-gate.mjs']) await writeFile(path.join(directory, 'scripts/ci', helper), await readFile(path.join(root, 'scripts/ci', helper)));
  await writeFile(path.join(directory, 'scripts/generate-workloads.mjs'), `
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('.scratch/faza-2/workloads', {recursive:true});
writeFileSync('.scratch/faza-2/workloads/fixture.json', '{}');
`);
  for (const name of ['notice-cases', 'notice-skeletons', 'notice-places']) await writeFile(path.join(directory, 'tests/golden', name + '.json'), '{}');
  await writeFile(path.join(directory, 'data/rule-sets/2026-09-24-v2.json'), '{}');
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
  await writeFile(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 0\n');
  await writeFile(path.join(bin, 'podman'), `#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
const args=process.argv.slice(2);
const log=entry=>appendFileSync(process.env.RUNNER_TEST_CALLS, JSON.stringify(entry)+'\\n');
const project=args[args.indexOf('-p')+1];
const lines=()=>readFileSync(process.env.RUNNER_TEST_CALLS,'utf8').trim().split('\\n').map(line=>JSON.parse(line));
if(args[0]==='compose'&&args.includes('up')){
  const env={db:process.env.TEST_DB_PORT,api:process.env.TEST_API_PORT,web:process.env.TEST_WEB_PORT};
  const attempt=lines().filter(c=>c.args.includes('up')&&c.args[c.args.indexOf('-p')+1]===project).length+1;
  log({args,env});
  if(process.env.RUNNER_TEST_REAL_BIND){
    const net=await import('node:net');
    const bind=port=>new Promise(done=>{const s=net.createServer();s.once('error',done);s.listen({port:Number(port),host:'127.0.0.1',exclusive:true},()=>s.close(()=>done(null)))});
    for(const port of Object.values(env)){const error=await bind(port);if(error){
      console.error('Error: rootlessport listen tcp 127.0.0.1:'+port+': bind: address already in use');process.exit(126)}}
    process.exit(0);
  }
  if(attempt<=Number(process.env.RUNNER_TEST_BIND_FAILURES)){
    console.error('Error: rootlessport listen tcp 127.0.0.1:'+env.db+': bind: address already in use');process.exit(126)}
  console.error('seeded startup failure');process.exit(7);
}
log({args});
if(args[0]==='network'&&args[1]==='create') process.exit(0);
if(args[0]==='network'&&args[1]==='inspect'){console.log('10.89.99.0/24');process.exit(0)}
if(args[0]==='compose'&&args.includes('logs')) process.exit(0);
if(args[0]==='compose'&&args.includes('down')) process.exit(0);
if(args[0]==='image'&&args[1]==='ls'){
  const projects=new Set(lines().filter(c=>c.args[0]==='compose').map(c=>c.args[c.args.indexOf('-p')+1]));
  for(const p of projects) for(const s of ['app','migration','fixture','web']) console.log('docker.io/library/'+p+'-'+s+':latest');
  for(const p of projects) console.log('docker.io/library/'+p+'-app-extra:latest');
  console.log('docker.io/library/bor-czuwa-isolated-other-session-app:latest');
  console.log('docker.io/postgis/postgis:17-3.5');
  process.exit(0);
}
if(args[0]==='image'&&args[1]==='rm') process.exit(0);
console.error('Unexpected fixture command');process.exit(2);
`);
  for (const name of ['podman', 'systemctl']) await chmod(path.join(bin, name), 0o755);
  for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Seed disposable runner fixture']]) {
    const git = spawnSync('git', args, { cwd: directory, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
    RUNNER_TEST_CALLS: calls, RUNNER_TEST_BIND_FAILURES: String(bindFailures), ISOLATED_REPORT_PATH: path.join(directory, 'result.json'), ...extraEnv };
  delete env.CI_CANDIDATE_ARCHIVE;
  const run = spawnSync(process.execPath, ['scripts/test-isolated.mjs'], { cwd: directory, env, encoding: 'utf8', timeout: 30_000 });
  const report = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
  const invoked = (await readFile(calls, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { directory, run, report, invoked };
}

test('a busy port makes the runner draw new ports below the ephemeral range and record the retry', async () => {
  const { directory, run, report, invoked } = await runnerFixture(1);
  try {
    for (const result of report.runs) {
      const ups = invoked.filter(call => call.args.includes('up') && call.args[call.args.indexOf('-p') + 1] === result.project);
      assert.equal(ups.length, 2, 'one bind failure must cost exactly one retry: ' + run.stdout);
      for (const up of ups) {
        const ports = Object.values(up.env).map(Number);
        assert.equal(new Set(ports).size, 3, 'three distinct ports');
        for (const port of ports) assert.ok(port >= 20000 && port < 32768, `port ${port} is below the kernel's ephemeral range`);
      }
      assert.notDeepEqual(ups[0].env, ups[1].env, 'the retry draws new ports');
      assert.equal(result.portRetries.length, 1);
      assert.deepEqual(result.portRetries[0].ports, { db: Number(ups[0].env.db), api: Number(ups[0].env.api), web: Number(ups[0].env.web) });
      assert.match(result.portRetries[0].error, /address already in use/);
      assert.deepEqual(result.ports, { db: Number(ups[1].env.db), api: Number(ups[1].env.api), web: Number(ups[1].env.web) });
      assert.equal(result.error, 'Compose startup failed with exit 7', 'the second attempt reaches the seeded non-port failure');
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a startup failure that is not a busy port is not retried', async () => {
  const { directory, report, invoked } = await runnerFixture(0);
  try {
    for (const result of report.runs) {
      assert.equal(invoked.filter(call => call.args.includes('up') && call.args[call.args.indexOf('-p') + 1] === result.project).length, 1);
      assert.deepEqual(result.portRetries, []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('after compose down the runner removes exactly its own four image tags and records them', async () => {
  const { directory, report, invoked } = await runnerFixture(0);
  try {
    for (const result of report.runs) {
      const names = ['app', 'migration', 'fixture', 'web'].map(service => `docker.io/library/${result.project}-${service}:latest`);
      assert.deepEqual([...result.imageCleanup.removed].sort(), [...names].sort());
      assert.equal(result.imageCleanup.exitCode, 0);
      const down = invoked.findIndex(call => call.args.includes('down') && call.args[call.args.indexOf('-p') + 1] === result.project);
      const removal = invoked.filter((call, index) => index > down && call.args[0] === 'image' && call.args[1] === 'rm'
        && call.args.some((arg: string) => arg.includes(result.project)));
      assert.equal(removal.length, 1);
      const named = removal[0].args.slice(2).filter((arg: string) => !arg.startsWith('-'));
      assert.deepEqual([...named].sort(), [...names].sort(), 'by exact name: no decoy, no other session, no prune');
    }
    assert.ok(!invoked.some(call => call.args.includes('prune')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a port taken after the bind check is held by a real listener: the first start fails, the retry starts', async () => {
  const holder = createServer();
  await new Promise<void>(resolve => holder.listen(0, '127.0.0.1', resolve));
  const held = (holder.address() as AddressInfo).port;
  const { directory, report, invoked } = await runnerFixture(0, { RUNNER_TEST_REAL_BIND: '1', ISOLATED_FORCE_FIRST_DB_PORT: String(held) });
  try {
    if (process.env.RUNNER_TEST_KEEP_REPORT) await writeFile(process.env.RUNNER_TEST_KEEP_REPORT, JSON.stringify(report, null, 2));
    for (const result of report.runs) {
      const ups = invoked.filter(call => call.args.includes('up') && call.args[call.args.indexOf('-p') + 1] === result.project);
      assert.equal(ups.length, 2);
      assert.equal(Number(ups[0].env.db), held, 'the first attempt used the held port');
      assert.notEqual(Number(ups[1].env.db), held);
      assert.equal(result.portRetries.length, 1);
      assert.equal(result.portRetries[0].ports.db, held);
      // Startup succeeded on the second attempt: the run got past it, to the image fingerprints the fake lacks.
      assert.notEqual(result.error, 'Compose startup failed with exit 126');
      assert.match(String(result.error), /image/i);
    }
  } finally {
    await new Promise<void>(resolve => holder.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('ISOLATED_RUN executes only that numbered run and does not demand two consecutive starts', async () => {
  const { directory, report, invoked } = await runnerFixture(0, { ISOLATED_RUN: '2' });
  try {
    assert.deepEqual(report.runs.map((result: { run: number }) => result.run), [2]);
    assert.equal(invoked.filter(call => call.args.includes('up')).length, 1);
    assert.ok(!('consecutiveStartsMatch' in report), 'pairing is the merge step\'s job');
    assert.ok(!report.failures.some((item: { stage?: string }) => item.stage === 'clean_starts' && /Two consecutive/.test(String((item as { error?: string }).error))));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ISOLATED_RUN rejects anything but 1 or 2 before starting a stack', async () => {
  const { directory, report, invoked } = await runnerFixture(0, { ISOLATED_RUN: '3' });
  try {
    assert.deepEqual(report.runs, []);
    assert.deepEqual(report.failures, [{ stage: 'setup', error: 'ISOLATED_RUN must be 1 or 2, got 3' }]);
    assert.ok(!invoked.some(call => call.args.includes('up')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
