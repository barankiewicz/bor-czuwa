import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { digest, githubApi, verifyCandidate } from './release-candidate.mjs';

export const testCertificate = 'b7f73299d7593972f920802d7ff4b1e5442be3b887773cd65b58ccb8b09436f0';
const applicationId = 'pl.borczuwa.app.demo';
const need = (condition, message) => { if (!condition) throw new Error(message); };
const json = async filename => JSON.parse(await readFile(filename, 'utf8'));

export function assertPrivateCandidate(report, verified, expected) {
  need(/^[a-f0-9]{40}$/.test(expected.sourceCommit), 'expected source commit missing');
  need(verified.mode === 'staging' && verified.action === 'activate'
    && verified.sourceCommit === expected.sourceCommit && report.identity?.sourceCommit === expected.sourceCommit,
  'private candidate identity differs');
  need(/^[a-f0-9]{64}$/.test(verified.verificationZipSha256)
    && Number.isSafeInteger(verified.verificationArtifactId) && verified.verificationArtifactId > 0
    && /^\d+$/.test(verified.workflowRunId) && Number.isSafeInteger(verified.workflowAttempt)
    && verified.workflowAttempt > 0, 'authenticated native provenance missing');
  const configuration = report.releaseCandidate?.configuration;
  need(configuration?.mode === 'staging' && configuration.apiOrigin === ''
    && configuration.command === 'npm run build:staging'
    && /^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/.test(expected.origin)
    && configuration.androidApiOrigin === expected.origin
    && /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(expected.recipient)
    && configuration.demoTestRecipient === expected.recipient, 'private demo configuration differs');
  const apk = report.artifacts?.['app-debug.apk'];
  need(apk && /^[a-f0-9]{64}$/.test(apk.sha256) && Number.isSafeInteger(apk.bytes) && apk.bytes > 0,
    'authenticated private APK identity missing');
}

export function assertPrivateApk(description, manifest, version, expected) {
  const parts = version.split('.');
  need(parts.length === 3 && parts.every(part => /^\d+$/.test(part)), 'source version invalid');
  const [major, minor, patch] = parts.map(Number);
  need(major <= 209999 && minor <= 99 && patch <= 99, 'source version exceeds Android ranges');
  const versionCode = major * 10000 + minor * 100 + patch;
  need(versionCode > 0 && manifest.versionCode === versionCode && manifest.versionName === version,
    'private APK version differs');
  need(manifest.applicationId === applicationId && description.applicationId === applicationId,
    'private APK application ID differs');
  need(manifest.debuggable === true && manifest.testLabel === true, 'private APK test identity missing');
  need(description.androidScheme === 'https' && description.remoteServerUrl === false
    && description.bundledShell === true, 'private APK offline shell differs');
  need(description.compiledConfiguration?.mode === 'staging'
    && description.compiledConfiguration.apiOrigin === expected.origin
    && description.compiledConfiguration.demoTestRecipient === expected.recipient,
    'private APK compiled demo configuration differs');
}

export function assertSamePayload(original, finalized) {
  const before = Object.entries(original).sort(([a], [b]) => a.localeCompare(b));
  const after = Object.entries(finalized).sort(([a], [b]) => a.localeCompare(b));
  need(before.length > 0 && JSON.stringify(before) === JSON.stringify(after), 'non-signature APK payload changed');
}

export function assertTestCertificate(certificate) {
  need(certificate === testCertificate, 'existing test certificate differs');
}

function toolEnvironment(signing = false) {
  const environment = {};
  for (const name of ['PATH', 'HOME', 'JAVA_HOME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  if (signing) {
    for (const name of ['PRIVATE_ANDROID_TEST_STORE_PASSWORD', 'PRIVATE_ANDROID_TEST_KEY_PASSWORD']) {
      need(process.env[name], 'existing test credential reference missing');
      environment[name] = process.env[name];
    }
  }
  return environment;
}

function run(binary, args, signing = false) {
  try {
    return execFileSync(binary, args, { env: toolEnvironment(signing), maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new Error('private APK tool refused the operation');
  }
}

export function parsePrivateApkManifest(badging) {
  const identity = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m.exec(badging);
  need(identity, 'private APK manifest unreadable');
  const labels = badging.split('\n').filter(line => /^application-label(?:-[^:]+)?:/.test(line));
  const defaults = labels.filter(line => line.startsWith('application-label:'));
  return { applicationId: identity[1], versionCode: Number(identity[2]), versionName: identity[3],
    debuggable: /^application-debuggable$/m.test(badging),
    testLabel: defaults.length === 1 && labels.every(label =>
      /^application-label(?:-[^:]+)?:'[^'\r\n]*\bTEST\b[^'\r\n]*'$/.test(label)) };
}

function manifestOf(apk, tools) {
  return parsePrivateApkManifest(run(path.join(tools, 'aapt'), ['dump', 'badging', apk]).toString());
}

function certificateOf(apk, tools) {
  const output = run(path.join(tools, 'apksigner'), ['verify', '--print-certs', apk]).toString();
  const certificates = [...output.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-fA-F0-9]{64})$/gm)];
  need(certificates.length === 1, 'private APK signer missing or ambiguous');
  return certificates[0][1].toLowerCase();
}

export async function finalizePrivateAndroid(directory, output, expected, policy, api = githubApi) {
  need(policy.environment === 'demo' && policy.repository === 'barankiewicz/bor-czuwa'
    && Array.isArray(policy.branches) && policy.branches.length > 0
    && policy.branches.every(branch => typeof branch === 'string' && branch.startsWith('deploy/private-')),
  'private demo policy required');
  const verified = await verifyCandidate(directory, 'staging', policy, api, 'activate');
  const zip = path.join(directory, 'verification.zip');
  const zipSha256 = digest(await readFile(zip));
  need(zipSha256 === verified.verificationZipSha256, 'verified ZIP changed');
  const manifestBytes = run('unzip', ['-p', zip, 'candidate.json']);
  need(digest(manifestBytes) === verified.candidateSha256, 'verified manifest changed');
  const report = JSON.parse(manifestBytes);
  assertPrivateCandidate(report, verified, expected);

  const sourceRoot = await realpath(fileURLToPath(new URL('../', import.meta.url)));
  for (const relative of ['scripts/finalize-private-android.mjs', 'scripts/private-android-apk.py', 'scripts/private-android-runtime.mjs', 'scripts/release-candidate.mjs',
    'src/lib/build-configuration.ts', 'src/lib/api-url.ts', 'src/lib/demo-handoff.ts', 'src/lib/demo-policy.ts',
    'src/service-worker.ts', 'vite.config.ts', 'package-lock.json']) {
    need(digest(await readFile(path.join(sourceRoot, relative))) === report.releaseCandidate.files[relative],
      'reviewed native finalization tools differ from candidate');
  }
  const requestedOutput = path.resolve(output);
  const destination = path.join(await realpath(path.dirname(requestedOutput)), path.basename(requestedOutput));
  const candidateRoot = await realpath(directory);
  need(destination !== candidateRoot && !destination.startsWith(candidateRoot + path.sep), 'output must be outside the candidate');
  try { await lstat(destination); throw new Error('private output already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  need(sdk, 'Android SDK reference missing');
  const tools = path.join(sdk, 'build-tools/36.0.0');
  const inspector = fileURLToPath(new URL('./private-android-apk.py', import.meta.url));
  const version = (await json(path.join(directory, 'payload/package.json'))).version;
  const inspect = apk => JSON.parse(run('python3', [inspector, 'inspect', apk]));
  await mkdir(destination, { mode: 0o700 });
  let step = 'validate-original';
  try {
    const original = path.join(destination, 'ci-app-debug.apk');
    run('python3', [inspector, 'extract', zip, original]);
    const originalInfo = await lstat(original);
    need(originalInfo.size === report.artifacts['app-debug.apk'].bytes, 'private APK size differs');
    const before = inspect(original);
    need(before.apkSha256 === report.artifacts['app-debug.apk'].sha256, 'private APK digest differs');
    const manifest = manifestOf(original, tools);
    assertPrivateApk(before, manifest, version, expected);
    const originalCertificate = certificateOf(original, tools);

    step = 'check-existing-test-key';
    const keystore = path.join(homedir(), '.android/debug.keystore');
    const keyInfo = await lstat(keystore);
    need(keyInfo.isFile() && !keyInfo.isSymbolicLink() && keyInfo.uid === process.getuid()
      && await realpath(keystore) === path.resolve(keystore), 'existing owned test key required');
    need(!keystore.startsWith(sourceRoot + path.sep)
      && !keystore.startsWith(candidateRoot + path.sep), 'keep the test key outside source and candidate');
    await chmod(keystore, 0o600);
    const publicCertificate = run('keytool', ['-exportcert', '-keystore', keystore, '-alias', 'androiddebugkey',
      '-storepass:env', 'PRIVATE_ANDROID_TEST_STORE_PASSWORD'], true);
    assertTestCertificate(digest(publicCertificate));

    step = 'finalize-copy';
    const aligned = path.join(destination, 'aligned.apk');
    const partial = path.join(destination, 'app-private-test.apk.partial');
    run(path.join(tools, 'zipalign'), ['-P', '16', '-f', '4', original, aligned]);
    run(path.join(tools, 'apksigner'), ['sign', '--ks', keystore, '--ks-key-alias', 'androiddebugkey',
      '--ks-pass', 'env:PRIVATE_ANDROID_TEST_STORE_PASSWORD', '--key-pass', 'env:PRIVATE_ANDROID_TEST_KEY_PASSWORD',
      '--out', partial, aligned], true);
    step = 'validate-finalized';
    run(path.join(tools, 'zipalign'), ['-c', '-P', '16', '4', partial]);
    const after = inspect(partial);
    const finalizedManifest = manifestOf(partial, tools);
    assertPrivateApk(after, finalizedManifest, version, expected);
    assertSamePayload(before.payloadFiles, after.payloadFiles);
    assertTestCertificate(certificateOf(partial, tools));
    need(digest(await readFile(zip)) === zipSha256, 'original CI ZIP changed');
    const receipt = { schemaVersion: 1, kind: 'private-native-test', eligibility: 'staging',
      sourceCommit: verified.sourceCommit, candidateSha256: verified.candidateSha256,
      verificationZipSha256: zipSha256, verificationArtifactId: verified.verificationArtifactId,
      workflowRunId: verified.workflowRunId, workflowAttempt: verified.workflowAttempt,
      workflowBranch: verified.workflowBranch, workflowSha256: policy.workflowSha256,
      originalApkSha256: before.apkSha256, originalCertificateSha256: originalCertificate,
      finalizedApkSha256: after.apkSha256, certificateSha256: testCertificate,
      payloadSha256: digest(JSON.stringify(before.payloadFiles)), payloadFiles: before.payloadFiles,
      applicationId, versionName: manifest.versionName, versionCode: manifest.versionCode,
      androidApiOrigin: expected.origin, demoTestRecipient: expected.recipient,
      sourceZipUnchanged: true, nonSignaturePayloadUnchanged: true,
      productionEligible: false, deviceInstallOrUpdateExercised: false };
    step = 'publish';
    await unlink(aligned);
    await writeFile(path.join(destination, 'provenance.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(partial, path.join(destination, 'app-private-test.apk'));
    return receipt;
  } catch (error) {
    await writeFile(path.join(destination, 'failure.json'), JSON.stringify({ status: 'refused', step }) + '\n', { flag: 'wx', mode: 0o600 });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [directory, output, sourceCommit, branch, ...extra] = process.argv.slice(2);
    need(directory && output && /^[a-f0-9]{40}$/.test(sourceCommit ?? '')
      && /^deploy\/private-[A-Za-z0-9._/-]+$/.test(branch ?? '') && !extra.length,
      'Usage: finalize-private-android.mjs CANDIDATE NEW_OUTPUT EXPECTED_SOURCE_COMMIT PRIVATE_BRANCH');
    // Only this independently reviewed operator checkout supplies workflow trust.
    // A downloaded candidate/upload is not an executable source of signing controls.
    const reviewedRoot = fileURLToPath(new URL('../', import.meta.url));
    const policy = { environment: 'demo', repository: 'barankiewicz/bor-czuwa', branches: [branch],
      workflowSha256: digest(await readFile(path.join(reviewedRoot, '.github/workflows/verify.yml'))) };
    const receipt = await finalizePrivateAndroid(path.resolve(directory), output, { sourceCommit,
      origin: process.env.ANDROID_API_ORIGIN, recipient: process.env.VITE_DEMO_TEST_RECIPIENT }, policy);
    console.log(JSON.stringify({ sourceCommit: receipt.sourceCommit, originalApkSha256: receipt.originalApkSha256,
      finalizedApkSha256: receipt.finalizedApkSha256, certificateSha256: receipt.certificateSha256,
      applicationId: receipt.applicationId, versionCode: receipt.versionCode,
      provenance: path.join(path.resolve(output), 'provenance.json'), productionEligible: false }));
  } catch {
    console.error('Private native finalization refused; no release or device action authorized.');
    process.exitCode = 1;
  }
}
