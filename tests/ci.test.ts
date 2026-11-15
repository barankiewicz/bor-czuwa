import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'scripts/ci/evidence.mjs');

test('CI retains failed setup and behavioral checks with redacted diagnostics', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bor-czuwa-ci-'));
  try {
    const diagnostics = `
console.error('DATABASE_URL=postgres://operator:private-password@localhost/db token=private-token person@example.org');
console.error('Authorization: Bearer private-bearer-token');
console.error('Authorization: Basic private-basic-token');
console.error(JSON.stringify({ Authorization: 'Bearer private-json-bearer-token', 'Proxy-Authorization': 'Basic private-json-basic-token' }));
console.error(require('node:util').inspect({ 'Proxy-Authorization': 'Basic private-inspected-basic-token' }));
console.error("{ 'Authorization': 'Bearer private-quoted-bearer-token' }");
`;
    for (const [name, code] of [['install', 7], ['domain', 1]] as const) {
      const result = spawnSync(process.execPath, [cli, 'run', name, '--', process.execPath, '-e',
        `${diagnostics}\nprocess.exit(${code});`],
      { cwd: root, env: { ...process.env, CI_EVIDENCE_DIR: directory }, encoding: 'utf8' });
      assert.equal(result.status, code, result.stderr);
      const evidence = JSON.parse(await readFile(path.join(directory, `${name}.json`), 'utf8'));
      assert.equal(evidence.outcome, 'failure');
      assert.equal(evidence.exitCode, code);
      const log = await readFile(path.join(directory, `${name}.log`), 'utf8');
      assert.match(log, /REDACTED/);
      assert.doesNotMatch(log + result.stdout + result.stderr, /private-[\w-]+|person@example\.org/);
      const jsonHeaders = log.split('\n').find(line => line.startsWith('{"Authorization":'));
      assert.ok(jsonHeaders, 'the JSON header diagnostic remains present');
      assert.deepEqual(JSON.parse(jsonHeaders), { Authorization: '[REDACTED]', 'Proxy-Authorization': '[REDACTED]' });
      assert.match(log, /'Proxy-Authorization': '\[REDACTED\]'/);
      assert.match(log, /'Authorization': '\[REDACTED\]'/);
    }
    const result = spawnSync(process.execPath, [cli, 'finalize'], {
      cwd: root, env: { ...process.env, CI_EVIDENCE_DIR: directory }, encoding: 'utf8'
    });
    assert.equal(result.status, 1);
    const summary = JSON.parse(await readFile(path.join(directory, 'candidate.json'), 'utf8'));
    assert.equal(summary.checksEligible, false);
    assert.match(summary.failures.join('\n'), /install.*failure/);
    assert.match(summary.failures.join('\n'), /isolated.*missing/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('candidate refuses skipped results, incomplete isolated runs and changed source identity', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bor-czuwa-candidate-'));
  const env = { ...process.env, CI_EVIDENCE_DIR: directory };
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, env, encoding: 'utf8' });
  const save = async (name: string, value: unknown) => writeFile(path.join(directory, name), JSON.stringify(value));
  try {
    assert.equal(run('run', 'install', '--', process.execPath, '-e', 'process.exit(0)').status, 0);
    const successful = JSON.parse(await readFile(path.join(directory, 'install.json'), 'utf8'));
    for (const name of ['typecheck', 'domain', 'marker', 'staging', 'ops', 'android', 'isolated', 'packaging', 'audit', 'candidate']) {
      await save(`${name}.json`, { ...successful, name });
    }
    const isolated = {
      identity: { gitHead: successful.identity.sourceCommit }, failures: [], consecutiveStartsMatch: true,
      runs: [1, 2].map(run => ({ run, project: `fictional-${run}`, cleanStartingRows: true, startingRows: { reports: 0 }, endingRows: { reports: 4 },
        cleanupExitCode: 0, suites: { api: { exitCode: 0 }, browser: { exitCode: 0 } },
        images: Object.fromEntries(['app', 'web', 'fixtureLoader', 'postgis'].map(name => [name, { id: 'sha256:fixture' }])) }))
    };
    await save('isolated-report.json', isolated);
    await save('audit-summary.json', { vulnerabilities: { total: 2, high: 2 } });
    await save('toolchain.json', {
      ...Object.fromEntries(['node', 'npm', 'java', 'gradle', 'podman', 'compose', 'playwright', 'platform'].map(name => [name, 'test fixture'])),
      headers: { Authorization: 'Bearer private-metadata-bearer-token', 'proxy-authorization': 'Basic private-metadata-basic-token' }
    });
    await mkdir(path.join(directory, 'artifacts'));
    await writeFile(path.join(directory, 'artifacts/staging.tar.gz'), 'fictional staging artifact');
    await writeFile(path.join(directory, 'artifacts/app-debug.apk'), 'fictional debug artifact');
    const finalize = async () => {
      const result = run('finalize');
      const summary = JSON.parse(await readFile(path.join(directory, 'candidate.json'), 'utf8'));
      return { result, summary };
    };
    await writeFile(path.join(directory, 'artifacts/release.tar'), 'fictional release archive');
    const { createHash } = await import('node:crypto');
    const archiveSha = createHash('sha256').update('fictional release archive').digest('hex');
    await save('isolated-report.json', { ...isolated, candidate: { artifactSha256: archiveSha, mode: 'staging', verifiedBefore: true, verifiedAfter: true } });
    await save('release-artifact.json', { mode: 'staging', configuration: { mode: 'staging', apiOrigin: '', androidApiOrigin: null, hsts: 'host-policy', command: 'npm run build:staging' }, sha256: archiveSha, http: { passed: true, artifactSha256: archiveSha } });
    await writeFile(path.join(directory, 'packaging.log'), JSON.stringify({ ok: true, sourceCommit: successful.identity.sourceCommit,
      planted: 26, images: ['context', 'app', 'web', 'fixture'] }));
    const clean = await finalize();
    assert.deepEqual(clean.summary.failures, successful.identity.dirty ? ['source: uncommitted changes'] : []);
    assert.equal(clean.result.status, successful.identity.dirty ? 1 : 0);
    assert.equal(clean.summary.releaseApproved, false);
    assert.equal(clean.summary.audit.vulnerabilities.high, 2, 'advisories remain visible without claiming clearance');
    assert.match(clean.summary.artifacts['staging.tar.gz'].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(clean.summary.toolchain.headers, { Authorization: '[REDACTED]', 'proxy-authorization': '[REDACTED]' });
    assert.doesNotMatch(await readFile(path.join(directory, 'candidate.json'), 'utf8'), /private-metadata/);
    await save('toolchain.json', {});
    assert.match((await finalize()).summary.failures.join('\n'), /toolchain: missing identity/);
    await save('domain.json', { ...successful, name: 'domain', outcome: 'skipped' });
    assert.match((await finalize()).summary.failures.join('\n'), /domain: skipped/);
    await save('domain.json', { ...successful, name: 'domain', identity: { ...successful.identity, lockfileSha256: 'other' } });
    assert.match((await finalize()).summary.failures.join('\n'), /domain: source or lockfile identity changed/);
    await save('isolated-report.json', { ...isolated, runs: isolated.runs.slice(0, 1) });
    assert.match((await finalize()).summary.failures.join('\n'), /two complete clean runs/);
    await rm(path.join(directory, 'artifacts/app-debug.apk'));
    assert.match((await finalize()).summary.failures.join('\n'), /artifact: missing app-debug.apk/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a disposable locked-install failure and changed Notice expectation both fail required commands', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'bor-czuwa-seeded-change-'));
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, CI_EVIDENCE_DIR: path.join(directory, 'evidence') };
    delete env.NODE_TEST_CONTEXT;
    await writeFile(path.join(directory, 'package.json'), '{"name":"fictional-ci-fixture","version":"1.0.0"}');
    const setup = spawnSync(process.execPath, [cli, 'run', 'install', '--', 'npm', '--prefix', directory,
      'ci', '--ignore-scripts', '--offline'], { cwd: root, env, encoding: 'utf8' });
    assert.equal(setup.status, 1, setup.stdout);
    assert.match(setup.stdout, /package-lock.json|npm-shrinkwrap.json/);
    const check = path.join(directory, 'notice.test.ts');
    await writeFile(check, `import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceBand } from ${JSON.stringify(path.join(root, 'src/lib/notice-composer.ts'))};
test('seeded incorrect Notice distance expectation', () => assert.equal(distanceBand(97), 'seeded incorrect wording'));
`);
    const behavior = spawnSync(process.execPath, [cli, 'run', 'domain', '--', process.execPath,
      '--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'), '--test', check], { cwd: root, env, encoding: 'utf8' });
    assert.equal(behavior.status, 1, behavior.stdout);
    assert.match(behavior.stdout, /seeded incorrect Notice distance expectation/);
    assert.match(behavior.stdout, /ERR_ASSERTION/);
    for (const name of ['install', 'domain']) {
      const record = JSON.parse(await readFile(path.join(directory, 'evidence', `${name}.json`), 'utf8'));
      assert.equal(record.outcome, 'failure');
      assert.equal(record.exitCode, 1);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// The two matrix jobs each report one numbered run; the merge step rebuilds the two-run report that
// `evidence.mjs finalize` and the release verifier read.
const merge = path.join(root, 'scripts/ci/merge-isolated.mjs');
const archiveSha = 'a'.repeat(64);
const identity = { gitHead: 'c'.repeat(40), sourceAndBuildSha256: 'd'.repeat(64), fixtureAndGoldenSha256: 'e'.repeat(64) };
const singleRun = (run: number, overrides: Record<string, unknown> = {}) => ({
  recordedAt: '2026-11-15T10:00:00.000Z', identity, failures: [], conditions: { node: 'v24' },
  candidate: { artifactSha256: archiveSha, mode: 'staging', verifiedBefore: true, verifiedAfter: true },
  runs: [{ run, project: `fictional-${run}`, cleanStartingRows: true, startingRows: { reports: 0 }, startingFailedJobReasons: {}, endingRows: { reports: 4 },
    cleanupExitCode: 0, suites: { api: { exitCode: 0 }, browser: { exitCode: 0 } },
    images: Object.fromEntries(['app', 'web', 'fixtureLoader', 'postgis'].map(name => [name, { id: 'sha256:fixture' }])) }],
  ...overrides
});
const checkRecord = (exitCode = 0) => ({ name: 'isolated', identity: { sourceCommit: 'c'.repeat(40), lockfileSha256: 'f'.repeat(64), dirty: false },
  startedAt: '2026-11-15T10:00:00.000Z', finishedAt: '2026-11-15T10:30:00.000Z', exitCode, signal: null, outcome: exitCode === 0 ? 'success' : 'failure' });

async function mergeFixture(options: { skip?: number; reports?: Record<number, unknown>; checks?: Record<number, unknown>; builtSha?: string } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'bor-czuwa-merge-'));
  const inputs = path.join(directory, 'runs'), evidence = path.join(directory, 'ci');
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'release-artifact.json'), JSON.stringify({ sha256: options.builtSha ?? archiveSha }));
  for (const run of [1, 2]) {
    if (run === options.skip) continue;
    await mkdir(path.join(inputs, `run-${run}`), { recursive: true });
    await writeFile(path.join(inputs, `run-${run}`, `isolated-report-${run}.json`), JSON.stringify(options.reports?.[run] ?? singleRun(run)));
    await writeFile(path.join(inputs, `run-${run}`, 'isolated.json'), JSON.stringify(options.checks?.[run] ?? checkRecord()));
    await writeFile(path.join(inputs, `run-${run}`, 'isolated.log'), `log of run ${run}\n`);
    await writeFile(path.join(inputs, `run-${run}`, `01-run-${run}-api.log`), 'api output');
  }
  const result = spawnSync(process.execPath, [merge, inputs, evidence], { encoding: 'utf8' });
  const read = async (name: string) => JSON.parse(await readFile(path.join(evidence, name), 'utf8'));
  return { directory, evidence, result, read };
}

test('merging two clean single runs rebuilds the two-run report finalize accepts', async () => {
  const { directory, evidence, result, read } = await mergeFixture();
  try {
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const report = await read('isolated-report.json');
    assert.deepEqual(report.runs.map((run: { run: number }) => run.run), [1, 2]);
    assert.deepEqual(report.failures, []);
    assert.equal(report.consecutiveStartsMatch, true);
    assert.deepEqual(report.identity, identity);
    assert.deepEqual(report.candidate, { artifactSha256: archiveSha, mode: 'staging', verifiedBefore: true, verifiedAfter: true });
    const check = await read('isolated.json');
    assert.equal(check.name, 'isolated');
    assert.equal(check.outcome, 'success');
    assert.equal(check.exitCode, 0);
    assert.equal(check.finishedAt, '2026-11-15T10:30:00.000Z');
    assert.match(await readFile(path.join(evidence, 'isolated.log'), 'utf8'), /log of run 1[\s\S]*log of run 2/);
    assert.equal(await readFile(path.join(evidence, '01-run-2-api.log'), 'utf8'), 'api output');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('merging fails when a run is missing, failed, or tested another archive', async () => {
  const cases: [string, Parameters<typeof mergeFixture>[0], RegExp][] = [
    ['a run missing', { skip: 2 }, /run 2.*missing/],
    ['a run that failed', { reports: { 2: singleRun(2, { failures: [{ run: 2, suite: 'browser', exitCode: 1 }] }) }, checks: { 2: checkRecord(1) } }, /run 2.*failed|failure/i],
    ['an archive hash other than the built one', { builtSha: 'b'.repeat(64) }, /archive/],
    ['runs that tested different archives', { reports: { 2: singleRun(2, { candidate: { artifactSha256: 'b'.repeat(64), mode: 'staging', verifiedBefore: true, verifiedAfter: true } }) } }, /archive/],
    ['runs of different commits', { reports: { 2: singleRun(2, { identity: { ...identity, gitHead: '9'.repeat(40) } }) } }, /identity/]
  ];
  for (const [name, options, expected] of cases) {
    const { directory, result, read } = await mergeFixture(options);
    try {
      assert.equal(result.status, 1, `${name}: ${result.stdout}`);
      const report = await read('isolated-report.json');
      assert.ok(report.failures.length > 0, `${name}: report records the failure`);
      assert.match(JSON.stringify(report.failures) + result.stderr + result.stdout, expected, name);
      assert.equal((await read('isolated.json')).outcome, 'failure', name);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
