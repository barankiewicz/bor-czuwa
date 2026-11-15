import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, stat, realpath, readdir, writeFile, chmod, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const requiredChecks = ['install', 'typecheck', 'domain', 'marker', 'staging', 'ops', 'android', 'isolated', 'packaging', 'audit', 'candidate'];
export const humanGates = {
  legal: 'Alicja and partner lawyers (human step 02)',
  directory: 'directory release owner (faza-2/29)',
  rules: 'legal and Findings owner (02/05)',
  geodata: 'national data owner (06)',
  national: 'national data and capacity owner (06)',
  host: 'dedicated-host operator (faza-2/28)',
  android: 'signed Android/device owner (13)',
  accessibility: 'accessibility/device owner (19/26)',
  reconciliation: '31-finding reconciliation owner (28)',
  final: 'Alicja (faza-2/31 final acceptance)'
};
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const need = (condition, message) => { if (!condition) throw new Error(message); };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const childEnvironment = () => Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']
  .filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]));
const archiveEntry = (zip, name) => execFileSync('unzip', ['-p', zip, name],
  { env: childEnvironment(), maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

// Written beside payload/ (the verifier's walk covers payload/ only) once activation has verified the
// candidate online. A later rollback of this release checks the installed bytes against it, with no GitHub.
export const receiptName = 'activation-receipt.json';
const receiptVersion = 1;

export async function writeActivationReceipt(directory, result) {
  const zip = path.join(directory, 'verification.zip');
  const manifestBytes = archiveEntry(zip, 'candidate.json');
  need(result?.verificationZipSha256 === digest(await readFile(zip)) && result.candidateSha256 === digest(manifestBytes),
    'result does not match the verification archive');
  const files = JSON.parse(manifestBytes).releaseCandidate?.files;
  need(files && Object.keys(files).length > 0, 'artifact file identity missing');
  const file = path.join(directory, receiptName);
  await writeFile(`${file}.tmp`, JSON.stringify({ version: receiptVersion, result, files }), { mode: 0o644, flag: 'wx' });
  await chmod(`${file}.tmp`, 0o644);
  await rename(`${file}.tmp`, file);
}

export async function githubApi(endpoint) {
  const response = await fetch(`https://api.github.com/${endpoint}`, { signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(process.env.GH_TOKEN ? { Authorization: `Bearer ${process.env.GH_TOKEN}` } : {}) } });
  need(response.ok, `GitHub evidence unavailable (${response.status})`);
  return response.json();
}

// Every listed file must match its digest, and no unlisted executable/source file may shadow the tested
// release. Dependencies are installed separately with locked manifests and lifecycle scripts disabled.
// `refuse(kind, relative)` words the refusal, so the live check and the offline check keep their own sentences.
async function checkInstalledPayload(directory, files, refuse) {
  const payload = path.join(directory, 'payload');
  for (const [relative, expected] of Object.entries(files)) {
    need(!path.isAbsolute(relative) && !relative.split('/').includes('..'), 'invalid artifact path');
    const file = path.join(payload, relative);
    const real = await realpath(file).catch(() => null);
    need(real !== null, refuse('changed', relative));
    need(real.startsWith(`${await realpath(payload)}/`), refuse('escape', relative));
    need(digest(await readFile(file)) === expected, refuse('changed', relative));
  }
  async function walk(current, prefix = '') {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (prefix === '' && ['node_modules', '.venv', 'installed', '.install-home', 'RELEASE'].includes(entry.name)) continue;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative + '/');
      else need(Object.hasOwn(files, relative), refuse('unlisted', relative));
    }
  }
  await walk(payload);
}

// A rollback to a release this host activated after receipts existed needs no hosted artifact. Returns null
// when there is no usable receipt (none, unreadable, or another version), and the live check then applies.
async function verifyReceipt(directory, mode, policy) {
  let receipt;
  try { receipt = JSON.parse(await readFile(path.join(directory, receiptName), 'utf8')); } catch { return null; }
  if (receipt?.version !== receiptVersion) return null;
  const changed = what => `installed release does not match its activation receipt: ${what}`;
  const result = receipt.result;
  const zip = path.join(directory, 'verification.zip');
  need(digest(await readFile(zip)) === result?.verificationZipSha256, changed('verification.zip'));
  const manifestBytes = archiveEntry(zip, 'candidate.json');
  need(digest(manifestBytes) === result.candidateSha256, changed('candidate.json'));
  const report = JSON.parse(manifestBytes);
  const candidate = report.releaseCandidate;
  need(JSON.stringify(candidate?.files) === JSON.stringify(receipt.files) && report.identity?.sourceCommit === result.sourceCommit,
    changed('candidate.json'));
  need(result.mode === mode && candidate.mode === mode, 'staging and production eligibility differ');
  await checkInstalledPayload(directory, receipt.files, (kind, relative) => changed(relative));
  if (mode === 'production') await verifyAcceptance(directory, result.candidateSha256, candidate, policy, 'rollback');
  else need(policy.environment === 'demo', 'staging cannot sign or roll back production');
  return { ...result, action: 'rollback' };
}

// The API adapter is an explicit test seam. The executable always uses GitHub HTTPS.
export async function verifyCandidate(directory, mode, policy, api = githubApi, action = 'activate') {
  need(['staging', 'production'].includes(mode), 'unknown eligibility mode');
  need(['activate', 'sign', 'rollback'].includes(action), 'unknown release action');
  need(policy.environment !== 'demo' || mode === 'staging', 'demo policy cannot approve production');
  need(/^[\w.-]+\/[\w.-]+$/.test(policy.repository), 'trusted repository missing');
  need(/^[a-f0-9]{64}$/.test(policy.workflowSha256), 'trusted workflow digest missing');
  if (action === 'rollback') {
    const offline = await verifyReceipt(directory, mode, policy);
    if (offline) return offline;
  }
  const zip = path.join(directory, 'verification.zip');
  const manifestBytes = archiveEntry(zip, 'candidate.json');
  const report = JSON.parse(manifestBytes);
  const identity = report.identity;
  const runId = report.workflow?.runId;
  need(/^\d+$/.test(String(runId)), 'trusted CI run missing');
  const base = `repos/${policy.repository}`;
  const run = await api(`${base}/actions/runs/${runId}`);
  need(run.repository?.full_name === policy.repository && run.head_repository?.full_name === policy.repository,
    'untrusted CI repository');
  need(run.path === '.github/workflows/verify.yml' && ['push', 'workflow_dispatch'].includes(run.event)
    && policy.branches?.includes(run.head_branch), 'untrusted CI workflow/event/branch');
  need(run.status === 'completed' && run.conclusion === 'success', 'CI run not successful');
  need(run.head_sha === identity?.sourceCommit && run.run_attempt === Number(report.workflow.attempt), 'stale CI source or attempt');
  need(/^[a-f0-9]{40}$/.test(identity?.sourceCommit), 'source commit missing');
  need(identity.dirty === false && /^[a-f0-9]{64}$/.test(identity.lockfileSha256), 'uncommitted or incomplete source identity');
  const age = Date.now() - Date.parse(run.updated_at);
  need(Number.isFinite(age) && age >= 0 && (action === 'rollback' || age <= (policy.maxAgeHours ?? 72) * 3600000), 'stale CI run');
  const workflow = await api(`${base}/contents/.github/workflows/verify.yml?ref=${identity.sourceCommit}`);
  need(digest(Buffer.from(workflow.content, 'base64')) === policy.workflowSha256, 'untrusted workflow revision');
  const jobs = await api(`${base}/actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100`);
  need(jobs.total_count <= 100 && jobs.jobs?.some(job => job.name === 'Required checks' && job.conclusion === 'success'), 'required CI job missing or failed');
  const artifacts = await api(`${base}/actions/runs/${runId}/artifacts?per_page=100`);
  const name = `verification-${identity.sourceCommit}-${runId}-${run.run_attempt}`;
  const matches = artifacts.artifacts?.filter(item => item.name === name && !item.expired) ?? [];
  need(artifacts.total_count <= 100 && matches.length === 1, 'CI artifact missing or ambiguous');
  const verificationZipSha256 = digest(await readFile(zip));
  need(matches[0].digest === `sha256:${verificationZipSha256}`, 'CI artifact digest mismatch');
  need(report.checksEligible === true && report.failures?.length === 0, 'required check evidence absent or failed');
  for (const name of requiredChecks) {
    const check = report.checks?.[name];
    need(check?.outcome === 'success' && check.exitCode === 0, `required check missing or failed: ${name}`);
    need(JSON.stringify(check.identity) === JSON.stringify(identity), `stale check: ${name}`);
  }
  need(report.toolchain && ['node', 'npm', 'java', 'gradle', 'podman', 'compose', 'playwright', 'platform']
    .every(name => typeof report.toolchain[name] === 'string' && report.toolchain[name].length), 'toolchain identity missing');
  need(report.packaging?.passed === true && report.packaging.sourceCommit === identity.sourceCommit
    && report.packaging.planted >= 26 && report.packaging.images?.length === 4 && !report.packaging.cleanupFailed, 'private-context exclusion proof missing');
  const candidate = report.releaseCandidate;
  need(candidate?.mode === mode, 'staging and production eligibility differ');
  need(report.isolated?.candidate?.verifiedBefore && report.isolated?.candidate?.verifiedAfter
    && report.isolated.candidate.artifactSha256 === candidate.sha256 && report.isolated.candidate.mode === mode, 'isolated suites did not test this artifact');
  need(candidate.configuration?.mode === mode && typeof candidate.configuration.apiOrigin === 'string', 'build configuration missing');
  need(candidate.http?.passed === true && candidate.http.artifactSha256 === candidate.sha256, 'tested HTTP artifact missing or rebuilt');
  const tar = archiveEntry(zip, 'artifacts/release.tar');
  need(digest(tar) === candidate.sha256, 'tested artifact digest mismatch');
  need(candidate.files && Object.keys(candidate.files).length > 0, 'artifact file identity missing');
  need(candidate.files['package-lock.json'] === identity.lockfileSha256, 'artifact lockfile identity mismatch');
  await checkInstalledPayload(directory, candidate.files, (kind, relative) => kind === 'unlisted'
    ? `unverified artifact file: ${relative}` : kind === 'escape' ? 'artifact symlink escape' : `installed artifact changed: ${relative}`);
  const candidateSha256 = digest(manifestBytes);
  if (mode === 'production') {
    need(candidate.android?.validated === true && candidate.android.unsignedApkSha256 === candidate.files['android-release/app-release-unsigned.apk']
      && candidate.android.unsignedAabSha256 === candidate.files['android-release/app-release.aab'] && candidate.android.versionCode > 0,
    'exact unsigned Android binary validation missing');
    need(/^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/.test(candidate.configuration.androidApiOrigin ?? ''), 'Android build origin missing');
    execFileSync(process.execPath, [new URL('./check-release.mjs', import.meta.url).pathname, path.join(directory, 'payload/build')],
      { env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    need(candidate.http.indexing === 'noindex', 'app host noindex evidence absent');
    if (action !== 'sign') await verifyAcceptance(directory, candidateSha256, candidate, policy, action);
  } else need(action === 'activate' || (action === 'rollback' && policy.environment === 'demo'),
    'staging cannot sign or roll back production');
  return { sourceCommit: identity.sourceCommit, candidateSha256, artifactSha256: candidate.sha256, mode, action,
    androidApiOrigin: candidate.configuration.androidApiOrigin ?? null, verificationZipSha256,
    verificationArtifactId: matches[0].id, workflowRunId: String(runId), workflowAttempt: run.run_attempt,
    workflowBranch: run.head_branch };
}

async function verifyAcceptance(directory, candidateSha256, candidate, policy, action) {
  const file = path.join(directory, 'acceptance.json');
  let acceptance;
  try { acceptance = await json(file); } catch { throw new Error(`human evidence missing: ${Object.values(humanGates).join('; ')}`); }
  need(policy.allowedSigners && policy.approver, 'trusted human approver missing');
  execFileSync('ssh-keygen', ['-Y', 'verify', '-f', policy.allowedSigners, '-I', policy.approver,
    '-n', 'bor-czuwa-release', '-s', `${file}.sig`], { env: childEnvironment(), input: await readFile(file), stdio: ['pipe', 'pipe', 'pipe'] });
  need(acceptance.candidateSha256 === candidateSha256 && acceptance.action === action, 'human acceptance refers to another candidate/action');
  need(Date.parse(acceptance.expiresAt) > Date.now(), 'human acceptance expired');
  for (const [gate, owner] of Object.entries(humanGates)) {
    const evidence = acceptance.gates?.[gate];
    need(evidence?.outcome === 'accepted' && evidence.owner?.trim() && evidence.reference?.trim()
      && /^[a-f0-9]{64}$/.test(evidence.sha256), `human evidence missing: ${gate}; owner: ${owner}`);
  }
  need(acceptance.gates.rules.version && acceptance.gates.geodata.snapshot && Array.isArray(acceptance.gates.legal.versions) && acceptance.gates.legal.versions.length > 0,
    'legal versions, Rule set and Geodata snapshot required');
  need(['coverage', 'accepted-exception'].includes(acceptance.gates.directory.basis), 'directory coverage or accepted exception required');
  const android = acceptance.gates.android;
  need(android.unsignedApkSha256 === candidate.files['android-release/app-release-unsigned.apk']
    && android.unsignedAabSha256 === candidate.files['android-release/app-release.aab']
    && ['signedApkSha256', 'signedAabSha256', 'certificateSha256'].every(key => /^[a-f0-9]{64}$/.test(android[key]))
    && android.versionCode === candidate.android.versionCode && android.freshInstall === true && android.updateFromVersionCode > 0,
  'signed Android fresh-install/update identity missing; owner: 13');
  if (action === 'rollback') need(acceptance.rollback?.indexedDbCompatible === true && acceptance.rollback?.backups === 'off'
    && acceptance.rollback?.authorization, 'rollback requires explicit IndexedDB compatibility and backups-off authorization');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, directory, mode = 'production', action = 'activate'] = process.argv.slice(2);
    if (command === 'write-receipt') {
      need(directory && mode, 'Usage: release-candidate.mjs write-receipt DIRECTORY RESULT_JSON');
      await writeActivationReceipt(path.resolve(directory), JSON.parse(mode));
      process.exit(0);
    }
    need(command === 'verify' && directory, 'Usage: release-candidate.mjs verify DIRECTORY staging|production [activate|sign|rollback]');
    const policyPath = process.env.RELEASE_POLICY_PATH ?? '/etc/bor-czuwa/release-policy.json';
    let policy;
    try {
      const info = await stat(policyPath);
      need(info.uid === 0 && (info.mode & 0o022) === 0, 'policy must be root-owned and not writable by group/others');
      policy = await json(policyPath);
      if (policy.allowedSigners) {
        const signers = await stat(policy.allowedSigners);
        need(signers.uid === 0 && (signers.mode & 0o022) === 0, 'allowed signers must be root-owned and not writable by group/others');
      }
    } catch { throw new Error('trusted policy missing or unsafe'); }
    const result = await verifyCandidate(path.resolve(directory), mode, policy, githubApi, action);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(`Release blocked: ${error.message}`);
    process.exitCode = 1;
  }
}
