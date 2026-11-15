import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { redact, redactValue } from './redact.mjs';

const root = process.cwd();
const directory = path.resolve(process.env.CI_EVIDENCE_DIR ?? '.scratch/ci');
const required = ['install', 'typecheck', 'domain', 'marker', 'staging', 'ops', 'android', 'isolated', 'packaging', 'audit', 'candidate'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
await mkdir(directory, { recursive: true });
const save = (name, value) => writeFile(path.join(directory, name), `${JSON.stringify(value, redactValue, 2)}\n`);
// Public build origins identify the artifact. Validate this allowlisted structure
// separately; diagnostic strings and arbitrary metadata still pass through redact.
function publicConfiguration(configuration) {
  const demoTestRecipient = configuration?.demoTestRecipient ?? '';
  const demo = demoTestRecipient !== '';
  if (!configuration || !['staging', 'production'].includes(configuration.mode)
    || configuration.apiOrigin !== '' || configuration.hsts !== 'host-policy'
    || configuration.command !== (configuration.mode === 'production' ? 'npm run build' : 'npm run build:staging')
    || (demo && (configuration.mode !== 'staging'
      || !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(demoTestRecipient)))
    || (configuration.mode === 'production' || demo
      ? !/^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/.test(configuration.androidApiOrigin ?? '')
      : configuration.androidApiOrigin !== null)) throw new Error('Invalid public build configuration');
  return { mode: configuration.mode, apiOrigin: '', androidApiOrigin: configuration.androidApiOrigin,
    ...(demo ? { demoTestRecipient } : {}),
    hsts: 'host-policy', command: configuration.command };
}
const identity = {
  sourceCommit: git('rev-parse', 'HEAD'),
  lockfileSha256: sha256(await readFile(path.join(root, 'package-lock.json'))),
  dirty: git('status', '--porcelain').length > 0
};

if (process.argv[2] === 'run') {
  const name = process.argv[3];
  if (!required.includes(name) || process.argv[4] !== '--' || !process.argv[5]) throw new Error('Usage: evidence.mjs run <required-check> -- <command> [args]');
  const startedAt = new Date().toISOString();
  let log = '';
  let interrupted;
  const child = spawn(process.argv[5], process.argv.slice(6), { cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    interrupted = signal;
    try { process.kill(-child.pid, signal); } catch { /* Child already exited. */ }
  });
  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', line => {
      const safe = `${redact(line)}\n`;
      log = (log + safe).slice(-2 * 1024 * 1024);
      process.stdout.write(safe);
    });
  }
  const result = await new Promise(resolve => {
    child.once('error', error => { log += `${redact(error.message)}\n`; resolve({ exitCode: 127 }); });
    child.once('close', (code, signal) => resolve({ exitCode: code ?? 1, signal: signal ?? interrupted ?? null }));
  });
  await writeFile(path.join(directory, `${name}.log`), log);
  await save(`${name}.json`, { name, identity, startedAt, finishedAt: new Date().toISOString(), ...result,
    outcome: result.exitCode === 0 && !interrupted ? 'success' : 'failure' });
  process.exitCode = result.exitCode || (interrupted ? 1 : 0);
} else if (process.argv[2] === 'finalize') {
  const failures = [];
  const checks = {};
  const artifacts = {};
  for (const name of required) {
    try {
      const check = JSON.parse(await readFile(path.join(directory, `${name}.json`), 'utf8'));
      checks[name] = check;
      if (check.name !== name || check.outcome !== 'success' || check.exitCode !== 0) failures.push(`${name}: ${check.outcome ?? 'missing outcome'}`);
      if (JSON.stringify(check.identity) !== JSON.stringify(identity)) failures.push(`${name}: source or lockfile identity changed`);
    } catch { failures.push(`${name}: missing or unreadable result`); }
  }
  let isolated;
  let audit;
  try {
    isolated = JSON.parse(await readFile(path.join(directory, 'isolated-report.json'), 'utf8'));
    if (isolated.identity?.gitHead !== identity.sourceCommit || isolated.failures?.length !== 0 || isolated.consecutiveStartsMatch !== true
      || isolated.runs?.length !== 2 || new Set(isolated.runs.map(run => run.project)).size !== 2
      || isolated.runs.some((run, index) => run.run !== index + 1 || !run.project || !run.cleanStartingRows
        || !run.startingRows || !Object.keys(run.startingRows).length || Object.values(run.startingRows).some(count => count !== 0)
        || !run.endingRows || !Object.keys(run.endingRows).length
        || run.cleanupExitCode !== 0 || ['api', 'browser'].some(suite => run.suites?.[suite]?.exitCode !== 0)
        || !['app', 'web', 'fixtureLoader', 'postgis'].every(image => run.images?.[image]?.id))) {
      failures.push('isolated: two complete clean runs with image identities required');
    }
  } catch { failures.push('isolated: missing suite evidence'); }
  try {
    audit = JSON.parse(await readFile(path.join(directory, 'audit-summary.json'), 'utf8'));
    if (!audit.vulnerabilities || audit.registryError) failures.push('audit: registry result unavailable');
  } catch { failures.push('audit: missing dependency audit'); }
  for (const name of ['staging.tar.gz', 'app-debug.apk']) {
    try {
      const bytes = await readFile(path.join(directory, 'artifacts', name));
      if (!bytes.length) throw new Error('empty artifact');
      artifacts[name] = { sha256: sha256(bytes), bytes: bytes.length };
    } catch { failures.push(`artifact: missing ${name}`); }
  }
  let toolchain;
  try {
    toolchain = JSON.parse(await readFile(path.join(directory, 'toolchain.json'), 'utf8'));
    if (!['node', 'npm', 'java', 'gradle', 'podman', 'compose', 'playwright', 'platform'].every(name => typeof toolchain[name] === 'string' && toolchain[name].length)) {
      throw new Error('Incomplete toolchain identity');
    }
  }
  catch { failures.push('toolchain: missing identity'); }
  if (identity.dirty) failures.push('source: uncommitted changes');
  let releaseCandidate;
  let packaging;
  try {
    releaseCandidate = JSON.parse(await readFile(path.join(directory, 'release-artifact.json'), 'utf8'));
    if (sha256(await readFile(path.join(directory, 'artifacts/release.tar'))) !== releaseCandidate.sha256
      || releaseCandidate.http?.passed !== true || releaseCandidate.http.artifactSha256 !== releaseCandidate.sha256) throw new Error('Artifact changed');
  } catch { failures.push('candidate: missing tested artifact'); }
  try {
    const log = await readFile(path.join(directory, 'packaging.log'), 'utf8');
    const proof = JSON.parse(log.trim().split('\n').at(-1));
    if (proof.ok !== true || proof.sourceCommit !== identity.sourceCommit || proof.planted < 26
      || proof.images?.length !== 4 || proof.cleanupFailed) throw new Error('Incomplete private-context proof');
    packaging = { passed: true, ...proof };
  } catch { failures.push('packaging: missing private-context exclusion proof'); }
  if (!isolated?.candidate?.verifiedBefore || !isolated?.candidate?.verifiedAfter
    || isolated.candidate.artifactSha256 !== releaseCandidate?.sha256 || isolated.candidate.mode !== releaseCandidate?.mode) {
    failures.push('candidate: isolated suites did not test this exact artifact');
  }
  const report = { schemaVersion: 2, releaseCandidate, packaging, recordedAt: new Date().toISOString(), identity,
    workflow: { runId: process.env.GITHUB_RUN_ID ?? null, attempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      event: process.env.GITHUB_EVENT_NAME ?? 'local', ref: process.env.GITHUB_REF ?? null },
    checksEligible: failures.length === 0, releaseApproved: false, assetMode: 'staging',
    checks, isolated, audit, toolchain, artifacts, failures };
  const safe = JSON.parse(JSON.stringify(report, redactValue));
  try {
    safe.releaseCandidate.configuration = publicConfiguration(releaseCandidate?.configuration);
  } catch {
    safe.failures.push('candidate: invalid public build configuration');
    safe.checksEligible = false;
  }
  await writeFile(path.join(directory, 'candidate.json'), `${JSON.stringify(safe, null, 2)}\n`);
  console.log(safe.failures.length ? safe.failures.join('\n') : 'Required checks passed. Release approval remains separate.');
  process.exitCode = safe.failures.length ? 1 : 0;
} else throw new Error('Usage: evidence.mjs run|finalize');
