import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyCandidate, writeActivationReceipt, digest, humanGates, requiredChecks } from '../scripts/release-candidate.mjs';

const root = path.resolve(import.meta.dirname, '..');
test('release refuses missing trusted evidence before disposable deployment writes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'candidate-refusal-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/release-candidate.mjs', 'verify', directory, 'production'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Release blocked:.*policy/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// The provider adapter is a disposable trust-boundary fixture. It is not exposed
// by the release CLI and does not authenticate any real candidate.
test('disposable deployment consumes matching provider artifact and refuses invalid evidence', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'candidate-provider-'));
  const payload = path.join(directory, 'payload');
  const evidence = path.join(directory, 'evidence');
  await mkdir(payload);
  await mkdir(path.join(evidence, 'artifacts'), { recursive: true });
  try {
    const contents: Record<string, string> = { 'package-lock.json': 'locked fixture', 'build/index.html': '<h1>Fixture</h1>',
      'android-release/app-release-unsigned.apk': 'unsigned APK fixture', 'android-release/app-release.aab': 'unsigned AAB fixture' };
    for (const [relative, bytes] of Object.entries(contents)) {
      await mkdir(path.dirname(path.join(payload, relative)), { recursive: true });
      await writeFile(path.join(payload, relative), bytes);
    }
    const files = Object.fromEntries(Object.entries(contents).map(([name, bytes]) => [name, digest(bytes)]));
    execFileSync('tar', ['-cf', path.join(evidence, 'artifacts/release.tar'), '-C', payload, '.']);
    const artifactSha256 = digest(await readFile(path.join(evidence, 'artifacts/release.tar')));
    // Finalize in a clean disposable repository so this test covers the real
    // evidence serializer without depending on the developer checkout's state.
    await writeFile(path.join(directory, '.gitignore'), '*\n');
    await writeFile(path.join(directory, 'package-lock.json'), contents['package-lock.json']);
    const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim();
    git('init', '-q');
    git('add', '-f', '.gitignore', 'package-lock.json');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Create disposable release fixture');
    const identity = { sourceCommit: git('rev-parse', 'HEAD'), lockfileSha256: files['package-lock.json'], dirty: false };
    let report: any = { identity, workflow: { runId: '123', attempt: '1' }, checksEligible: true, failures: [],
      checks: Object.fromEntries(requiredChecks.map(name => [name, { name, identity, exitCode: 0, outcome: 'success' }])),
      packaging: { passed: true, sourceCommit: identity.sourceCommit, planted: 26, images: ['context', 'app', 'web', 'fixture'] }, toolchain: Object.fromEntries(['node', 'npm', 'java', 'gradle', 'podman', 'compose', 'playwright', 'platform'].map(name => [name, 'fixture'])),
      isolated: { identity: { gitHead: identity.sourceCommit }, failures: [], consecutiveStartsMatch: true,
        runs: [1, 2].map(run => ({ run, project: `fixture-${run}`, cleanStartingRows: true, startingRows: { reports: 0 }, endingRows: { reports: 1 },
          cleanupExitCode: 0, suites: { api: { exitCode: 0 }, browser: { exitCode: 0 } },
          images: Object.fromEntries(['app', 'web', 'fixtureLoader', 'postgis'].map(name => [name, { id: 'fixture-image' }])) })),
        candidate: { artifactSha256, mode: 'production', verifiedBefore: true, verifiedAfter: true } },
      releaseCandidate: { mode: 'production', sha256: artifactSha256, files, configuration: { mode: 'production', apiOrigin: '', androidApiOrigin: 'https://api.example.invalid', hsts: 'host-policy', command: 'npm run build' },
        android: { validated: true, unsignedApkSha256: files['android-release/app-release-unsigned.apk'], unsignedAabSha256: files['android-release/app-release.aab'], versionCode: 2 },
        http: { passed: true, indexing: 'noindex', artifactSha256 } } };
    for (const [name, check] of Object.entries(report.checks)) await writeFile(path.join(evidence, `${name}.json`), JSON.stringify(check));
    await writeFile(path.join(evidence, 'isolated-report.json'), JSON.stringify(report.isolated));
    await writeFile(path.join(evidence, 'toolchain.json'), JSON.stringify(report.toolchain));
    await writeFile(path.join(evidence, 'audit-summary.json'), JSON.stringify({ vulnerabilities: { total: 0 } }));
    await writeFile(path.join(evidence, 'packaging.log'), JSON.stringify({ ...report.packaging, ok: true }));
    await writeFile(path.join(evidence, 'release-artifact.json'), JSON.stringify(report.releaseCandidate));
    await writeFile(path.join(evidence, 'artifacts/staging.tar.gz'), 'fixture staging output');
    await writeFile(path.join(evidence, 'artifacts/app-debug.apk'), 'fixture debug output');
    const finalized = spawnSync(process.execPath, [path.join(root, 'scripts/ci/evidence.mjs'), 'finalize'], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, CI_EVIDENCE_DIR: evidence,
        GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' }
    });
    assert.equal(finalized.status, 0, finalized.stdout + finalized.stderr);
    report = JSON.parse(await readFile(path.join(evidence, 'candidate.json'), 'utf8'));
    assert.equal(report.releaseCandidate.configuration.androidApiOrigin, 'https://api.example.invalid');
    const workflow = 'trusted workflow fixture';
    const policy: any = { repository: 'fixture/repository', workflowSha256: digest(workflow), branches: ['main'],
      allowedSigners: path.join(directory, 'allowed-signers'), approver: 'fixture-owner' };
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(directory, 'key')]);
    await writeFile(policy.allowedSigners, 'fixture-owner ' + await readFile(path.join(directory, 'key.pub'), 'utf8'));
    let run: any = { repository: { full_name: policy.repository }, head_repository: { full_name: policy.repository },
      path: '.github/workflows/verify.yml', event: 'push', head_branch: 'main', head_sha: identity.sourceCommit,
      status: 'completed', conclusion: 'success', run_attempt: 1, updated_at: new Date().toISOString() };
    let artifactDigest = '';
    let jobConclusion = 'success';
    let artifactExpired = false;
    const api = async (endpoint: string) => {
      if (endpoint.includes('/contents/')) return { content: Buffer.from(workflow).toString('base64') };
      if (endpoint.endsWith('/jobs?per_page=100')) return { total_count: 1, jobs: [{ name: 'Required checks', conclusion: jobConclusion }] };
      if (endpoint.endsWith('/artifacts?per_page=100')) return { total_count: 1, artifacts: [{ id: 456, name: `verification-${identity.sourceCommit}-123-1`, digest: artifactDigest, expired: artifactExpired }] };
      return run;
    };
    const pack = async () => {
      await writeFile(path.join(evidence, 'candidate.json'), JSON.stringify(report));
      await rm(path.join(directory, 'verification.zip'), { force: true });
      execFileSync('zip', ['-q', '-r', path.join(directory, 'verification.zip'), '.'], { cwd: evidence });
      artifactDigest = 'sha256:' + digest(await readFile(path.join(directory, 'verification.zip')));
    };
    const accept = async (action = 'activate', extra: object = {}) => {
      const gates: any = Object.fromEntries(Object.keys(humanGates).map(name => [name,
        { outcome: 'accepted', owner: 'fictional owner', reference: 'disposable fixture only', sha256: 'b'.repeat(64) }]));
      Object.assign(gates.legal, { versions: ['fixture-v1'] });
      Object.assign(gates.rules, { version: 'fixture-rules' });
      Object.assign(gates.geodata, { snapshot: 'fixture-snapshot' });
      Object.assign(gates.directory, { basis: 'accepted-exception' });
      Object.assign(gates.android, { unsignedApkSha256: files['android-release/app-release-unsigned.apk'], unsignedAabSha256: files['android-release/app-release.aab'],
        signedApkSha256: 'c'.repeat(64), signedAabSha256: 'd'.repeat(64), certificateSha256: 'e'.repeat(64), versionCode: 2, freshInstall: true, updateFromVersionCode: 1 });
      const file = path.join(directory, 'acceptance.json');
      await writeFile(file, JSON.stringify({ candidateSha256: digest(JSON.stringify(report)), action,
        expiresAt: new Date(Date.now() + 3600000).toISOString(), gates, ...extra }));
      await rm(file + '.sig', { force: true });
      execFileSync('ssh-keygen', ['-Y', 'sign', '-f', path.join(directory, 'key'), '-n', 'bor-czuwa-release', file], { stdio: 'ignore' });
    };
    const verify = () => verifyCandidate(directory, 'production', policy, api);
    await pack();
    await assert.rejects(verify, /human evidence missing.*Alicja/);
    await accept();
    const accepted = await verify();
    assert.equal(accepted.artifactSha256, artifactSha256);
    assert.equal(accepted.verificationZipSha256, artifactDigest.slice('sha256:'.length));
    assert.equal(accepted.verificationArtifactId, 456);
    assert.equal(accepted.workflowRunId, '123');
    assert.equal(accepted.workflowAttempt, 1);
    await t.test('verifier tools do not inherit provider or signing credentials', async () => {
      const tools = path.join(directory, 'tools');
      const observations = path.join(directory, 'child-environments.jsonl');
      const nodeProbe = path.join(directory, 'node-environment-probe.mjs');
      const forbidden = ['GH_TOKEN', 'PRIVATE_ANDROID_TEST_STORE_PASSWORD', 'PRIVATE_ANDROID_TEST_KEY_PASSWORD',
        'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_PASSWORD', 'NODE_OPTIONS'];
      const saved = Object.fromEntries(['PATH', ...forbidden].map(name => [name, process.env[name]]));
      await mkdir(tools);
      for (const command of ['unzip', 'ssh-keygen']) {
        const real = execFileSync('which', [command], { encoding: 'utf8' }).trim();
        const wrapper = path.join(tools, command);
        await writeFile(wrapper, '#!/usr/bin/python3\nimport json, os, sys\n'
          + `names = ${JSON.stringify(forbidden)}\n`
          + `with open(${JSON.stringify(observations)}, 'a') as output:\n`
          + `    output.write(json.dumps({'tool': ${JSON.stringify(command)}, 'present': [name for name in names if name in os.environ]}) + '\\n')\n`
          + `os.execv(${JSON.stringify(real)}, [${JSON.stringify(real)}, *sys.argv[1:]])\n`);
        await chmod(wrapper, 0o700);
      }
      // This module executes only if the real marker-check Node child inherits NODE_OPTIONS.
      await writeFile(nodeProbe, `import { appendFileSync } from 'node:fs';\n`
        + `appendFileSync(${JSON.stringify(observations)}, JSON.stringify({ tool: 'node-probe', present: [] }) + '\\n');\n`);
      try {
        process.env.PATH = tools + path.delimiter + saved.PATH;
        for (const name of forbidden) process.env[name] = 'disposable-credential-sentinel';
        process.env.NODE_OPTIONS = `--import=${nodeProbe}`;
        await verify();
        const observed = (await readFile(observations, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(observed.map(item => item.tool), ['unzip', 'unzip', 'ssh-keygen']);
        for (const item of observed) assert.deepEqual(item.present, [], `${item.tool} inherited credential environment names`);
      } finally {
        for (const [name, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });

    await t.test('rollback verifies the installed bytes offline once the hosted artifact has expired', async () => {
      const receiptFile = path.join(directory, 'activation-receipt.json');
      const rollbackAcceptance = { rollback: { authorization: 'fixture decision', indexedDbCompatible: true, backups: 'off' } };
      const noGithub = async () => { throw new Error('GitHub must not be called'); };
      const rollback = (adapter: (endpoint: string) => Promise<unknown> = noGithub) => verifyCandidate(directory, 'production', policy, adapter, 'rollback');
      const zipFile = path.join(directory, 'verification.zip');
      await accept('rollback', rollbackAcceptance);
      artifactExpired = true;
      try {
        // Control: without a receipt the live check still applies and an expired artifact is refused.
        await assert.rejects(rollback(api), /CI artifact missing or ambiguous/);
        await writeActivationReceipt(directory, accepted);
        const rolledBack = await rollback();
        assert.equal(rolledBack.action, 'rollback');
        assert.equal(rolledBack.sourceCommit, accepted.sourceCommit);
        assert.equal(rolledBack.candidateSha256, accepted.candidateSha256);
        assert.equal(rolledBack.verificationZipSha256, accepted.verificationZipSha256);
        assert.equal((await stat(receiptFile)).mode & 0o022, 0, 'receipt must not be writable by group or others');
        // A changed installed byte, a changed archive and an extra file are each refused by name.
        await writeFile(path.join(payload, 'build/index.html'), '<h1>Rebuilt</h1>');
        await assert.rejects(rollback(), /installed release does not match its activation receipt: build\/index\.html/);
        await writeFile(path.join(payload, 'build/index.html'), contents['build/index.html']);
        await writeFile(path.join(payload, 'build/extra.js'), 'planted');
        await assert.rejects(rollback(), /installed release does not match its activation receipt: build\/extra\.js/);
        await rm(path.join(payload, 'build/extra.js'));
        await rm(path.join(payload, 'build/index.html'));
        await assert.rejects(rollback(), /installed release does not match its activation receipt: build\/index\.html/);
        await writeFile(path.join(payload, 'build/index.html'), contents['build/index.html']);
        const archive = await readFile(zipFile);
        await writeFile(zipFile, Buffer.concat([archive, Buffer.from('x')]));
        await assert.rejects(rollback(), /installed release does not match its activation receipt: verification\.zip/);
        await writeFile(zipFile, archive);
        await rollback();
        // The signed human acceptance still gates the production rollback.
        await accept('activate');
        await assert.rejects(rollback(), /human acceptance refers to another candidate\/action/);
        await accept('rollback', rollbackAcceptance);
        // An unknown receipt version is ignored and the live check applies again.
        const stored = JSON.parse(await readFile(receiptFile, 'utf8'));
        await writeFile(receiptFile, JSON.stringify({ ...stored, version: 99 }));
        await assert.rejects(rollback(api), /CI artifact missing or ambiguous/);
        // Activation never consults the receipt: an expired artifact still blocks it.
        await writeFile(receiptFile, JSON.stringify(stored));
        await assert.rejects(verify, /CI artifact missing or ambiguous/);
      } finally {
        artifactExpired = false;
        await rm(receiptFile, { force: true });
        await accept();
      }
      // Activation age limits are unchanged: 80 hours refused, 70 hours accepted.
      run.updated_at = new Date(Date.now() - 80 * 3600000).toISOString();
      await assert.rejects(verify, /stale CI run/);
      run.updated_at = new Date(Date.now() - 70 * 3600000).toISOString();
      await verify();
      run.updated_at = new Date().toISOString();
    });
    await assert.rejects(verifyCandidate(directory, 'production', { ...policy, environment: 'demo' }, api),
      /demo policy cannot approve production/);
    // Disposable deployment writes only bytes accepted by the same gate as activation.
    const destination = path.join(directory, 'deployed.html');
    await writeFile(destination, await readFile(path.join(payload, 'build/index.html')));
    assert.equal(await readFile(destination, 'utf8'), '<h1>Fixture</h1>');
    run.conclusion = 'failure'; await assert.rejects(verify, /CI run not successful/); run.conclusion = 'success';
    jobConclusion = 'failure'; await assert.rejects(verify, /required CI job/); jobConclusion = 'success';
    run.event = 'pull_request'; await assert.rejects(verify, /untrusted CI workflow/); run.event = 'push';
    run.run_attempt = 2; await assert.rejects(verify, /stale CI source or attempt/); run.run_attempt = 1;
    run.head_sha = 'f'.repeat(40); await assert.rejects(verify, /stale CI source/); run.head_sha = identity.sourceCommit;
    run.updated_at = '2020-01-01T00:00:00Z'; await assert.rejects(verify, /stale CI run/); run.updated_at = new Date().toISOString();
    const goodDigest = artifactDigest; artifactDigest = 'sha256:' + '0'.repeat(64);
    await assert.rejects(verify, /CI artifact digest mismatch/); artifactDigest = goodDigest;
    policy.workflowSha256 = '0'.repeat(64); await assert.rejects(verify, /untrusted workflow revision/); policy.workflowSha256 = digest(workflow);
    await writeFile(path.join(payload, 'build/index.html'), '<h1>Rebuilt</h1>');
    await assert.rejects(verify, /installed artifact changed/);
    await writeFile(path.join(payload, 'build/index.html'), contents['build/index.html']);
    const check = report.checks.domain; delete report.checks.domain; await pack();
    await assert.rejects(verify, /required check missing/); report.checks.domain = check;
    report.checks.domain = { ...check, identity: { ...identity, sourceCommit: 'f'.repeat(40) } }; await pack();
    await assert.rejects(verify, /stale check: domain/); report.checks.domain = check;
    report.releaseCandidate.http.artifactSha256 = '0'.repeat(64); await pack();
    await assert.rejects(verify, /tested HTTP artifact missing or rebuilt/); report.releaseCandidate.http.artifactSha256 = artifactSha256;
    await pack(); await accept();
    const approval = JSON.parse(await readFile(path.join(directory, 'acceptance.json'), 'utf8'));
    approval.gates.host.outcome = 'accepted-locally';
    await writeFile(path.join(directory, 'acceptance.json'), JSON.stringify(approval));
    await assert.rejects(verify, /ssh-keygen/);
    await accept();
    report.releaseCandidate.mode = 'staging'; await pack();
    await assert.rejects(verify, /staging and production eligibility differ/);
    report.releaseCandidate.configuration.mode = 'staging';
    report.releaseCandidate.configuration.command = 'npm run build:staging';
    report.releaseCandidate.configuration.androidApiOrigin = null;
    report.isolated.candidate.mode = 'staging';
    await pack();
    await assert.rejects(verifyCandidate(directory, 'staging', policy, api, 'rollback'),
      /staging cannot sign or roll back production/);
    const demoPolicy = { ...policy, environment: 'demo' };
    await assert.rejects(verifyCandidate(directory, 'staging', demoPolicy, api, 'sign'),
      /staging cannot sign or roll back production/);
    const demoRollback = await verifyCandidate(directory, 'staging', demoPolicy, api, 'rollback');
    assert.equal(demoRollback.mode, 'staging');
    assert.equal(demoRollback.action, 'rollback');
    const unsafe = { ...report.releaseCandidate, configuration: { ...report.releaseCandidate.configuration,
      androidApiOrigin: 'https://operator:private-password@api.example.invalid' } };
    await writeFile(path.join(evidence, 'release-artifact.json'), JSON.stringify(unsafe));
    const refused = spawnSync(process.execPath, [path.join(root, 'scripts/ci/evidence.mjs'), 'finalize'], {
      cwd: directory, encoding: 'utf8', env: { ...process.env, CI_EVIDENCE_DIR: evidence }
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /invalid public build configuration/);
    assert.doesNotMatch(await readFile(path.join(evidence, 'candidate.json'), 'utf8'), /private-password/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
