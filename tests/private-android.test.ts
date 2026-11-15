import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertPrivateApk, assertPrivateCandidate, assertSamePayload, assertTestCertificate,
  finalizePrivateAndroid, parsePrivateApkManifest } from '../scripts/finalize-private-android.mjs';

// Disposable rejection inputs exercise consumer guards, not successful CI, signing or device proof.
const sourceCommit = 'a'.repeat(40);
const origin = 'https://private-native.example.invalid';
const recipient = 'test-inbox@example.invalid';
const verified = { mode: 'staging', action: 'activate', sourceCommit, verificationZipSha256: 'e'.repeat(64),
  verificationArtifactId: 123, workflowRunId: '456', workflowAttempt: 1 };
const candidate = () => ({ identity: { sourceCommit }, releaseCandidate: { configuration: {
  mode: 'staging', apiOrigin: '', command: 'npm run build:staging', androidApiOrigin: origin,
  demoTestRecipient: recipient } }, artifacts: { 'app-debug.apk': { sha256: 'b'.repeat(64), bytes: 100 } } });
const expected = { sourceCommit, origin, recipient };

test('private native consumer refuses wrong candidate or demo configuration', () => {
  assert.throws(() => assertPrivateCandidate(candidate(), { ...verified, sourceCommit: 'c'.repeat(40) }, expected), /identity differs/);
  assert.throws(() => assertPrivateCandidate(candidate(), { ...verified, mode: 'production' }, expected), /identity differs/);
  assert.throws(() => assertPrivateCandidate(candidate(), { ...verified, action: 'sign' }, expected), /identity differs/);
  const otherOrigin = candidate(); otherOrigin.releaseCandidate.configuration.androidApiOrigin = 'https://other.example.invalid';
  assert.throws(() => assertPrivateCandidate(otherOrigin, verified, expected), /configuration differs/);
  const otherRecipient = candidate(); otherRecipient.releaseCandidate.configuration.demoTestRecipient = 'other@example.invalid';
  assert.throws(() => assertPrivateCandidate(otherRecipient, verified, expected), /configuration differs/);
  const missingApk = candidate(); missingApk.artifacts['app-debug.apk'].sha256 = '';
  assert.throws(() => assertPrivateCandidate(missingApk, verified, expected), /APK identity missing/);
});

test('private native consumer refuses owner app, remote shell, missing markers or wrong version', () => {
  const description = { applicationId: 'pl.borczuwa.app.demo', androidScheme: 'https',
    remoteServerUrl: false, bundledShell: true, compiledConfiguration: { mode: 'staging', apiOrigin: origin, demoTestRecipient: recipient } };
  const manifest = { applicationId: description.applicationId, versionName: '0.1.0', versionCode: 100,
    debuggable: true, testLabel: true };
  assert.throws(() => assertPrivateApk(description, { ...manifest, applicationId: 'pl.borczuwa.app' }, '0.1.0', expected), /application ID differs/);
  assert.throws(() => assertPrivateApk({ ...description, applicationId: 'pl.borczuwa.app' }, manifest, '0.1.0', expected), /application ID differs/);
  assert.throws(() => assertPrivateApk({ ...description, remoteServerUrl: true }, manifest, '0.1.0', expected), /offline shell differs/);
  assert.throws(() => assertPrivateApk({ ...description, bundledShell: false }, manifest, '0.1.0', expected), /offline shell differs/);
  assert.throws(() => assertPrivateApk({ ...description, compiledConfiguration: { ...description.compiledConfiguration, apiOrigin: origin + '.invalid' } }, manifest, '0.1.0', expected), /compiled demo configuration/);
  assert.throws(() => assertPrivateApk({ ...description, compiledConfiguration: { ...description.compiledConfiguration, demoTestRecipient: 'other@example.invalid' } }, manifest, '0.1.0', expected), /compiled demo configuration/);
  assert.throws(() => assertPrivateApk(description, { ...manifest, testLabel: false }, '0.1.0', expected), /test identity missing/);
  assert.throws(() => assertPrivateApk(description, { ...manifest, debuggable: false }, '0.1.0', expected), /test identity missing/);
  assert.throws(() => assertPrivateApk(description, { ...manifest, versionCode: 101 }, '0.1.0', expected), /version differs/);
});

test('private native consumer refuses changed, added or removed payload and another certificate', () => {
  const payload = { 'AndroidManifest.xml': 'a'.repeat(64), 'assets/public/index.html': 'b'.repeat(64) };
  assert.throws(() => assertSamePayload(payload, { ...payload, 'assets/public/index.html': 'c'.repeat(64) }), /payload changed/);
  assert.throws(() => assertSamePayload(payload, { ...payload, 'assets/public/extra.js': 'c'.repeat(64) }), /payload changed/);
  assert.throws(() => assertSamePayload(payload, { 'AndroidManifest.xml': payload['AndroidManifest.xml'] }), /payload changed/);
  assert.throws(() => assertTestCertificate('d'.repeat(64)), /test certificate differs/);
});

test('private native finalization refuses a public policy before provider, output or key use', async () => {
  let contacted = false;
  await assert.rejects(finalizePrivateAndroid('/not-a-candidate', '/not-output', expected,
    { environment: 'production', repository: 'barankiewicz/bor-czuwa', branches: ['deploy/private-fixture'] },
    async () => { contacted = true; throw new Error('provider must not run'); }), /private demo policy required/);
  assert.equal(contacted, false);
});

test('private native CLI refuses absent trust without producing a signed artifact', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'private-native-refusal-'));
  const output = path.join(directory, 'not-created');
  try {
    const result = spawnSync(process.execPath, ['scripts/finalize-private-android.mjs', directory, output, sourceCommit, 'deploy/private-fixture'], {
      cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: directory }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Private native finalization refused/);
    await assert.rejects(access(output), /ENOENT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


const goodManifest = () => parsePrivateApkManifest(`package: name='pl.borczuwa.app.demo' versionCode='100' versionName='0.1.0'
application-label:'Bór czuwa TEST'
application-label-en:'Bór czuwa TEST'
application-debuggable
`);

async function withInspectedApk(configuration: { mode: string; apiOrigin: string; demoTestRecipient: string },
  extra: Record<string, string | null | undefined>, run: (description: Record<string, unknown>) => void) {
  const directory = await mkdtemp(path.join(tmpdir(), 'private-native-inspector-'));
  try {
    const module = `export const buildConfiguration = ${JSON.stringify(configuration)};\n`;
    const moduleName = `assets/public/_app/immutable/bor-build-configuration-${createHash('sha256').update(module).digest('hex').slice(0, 16)}.js`;
    const apk = path.join(directory, 'fixture.apk');
    execFileSync('python3', ['-c', `import json,sys,zipfile
entries=json.load(sys.stdin)
with zipfile.ZipFile(sys.argv[1],'w') as archive:
 for name,value in entries.items(): archive.writestr(name,value)
`, apk], { input: JSON.stringify(Object.fromEntries(Object.entries({
      'assets/capacitor.config.json': JSON.stringify({ appId: 'pl.borczuwa.app.demo', server: { androidScheme: 'https' } }),
      'assets/public/index.html': '<script type="module" src="/_app/app.js"></script>',
      'assets/public/_app/app.js': `import { apiUrl, apiFetch } from '/_app/immutable/chunks/bor-api-url.fixture.js'; import { demoTestRecipient, handoffRecipient } from '/_app/immutable/chunks/bor-demo-handoff.fixture.js'; console.log(apiUrl('/api/ready'), apiFetch, handoffRecipient('old@example.invalid'), demoTestRecipient);`,
      'assets/public/_app/immutable/chunks/bor-api-url.fixture.js': `import { buildConfiguration as configuration } from '/${moduleName.slice('assets/public/'.length)}'; const apiOrigin = configuration.apiOrigin; function url(path) { return \`\${apiOrigin}\${path}\`; } function fetchApi(path) { return fetch(url(path)); } export { url as apiUrl, fetchApi as apiFetch };`,
      'assets/public/_app/immutable/chunks/bor-demo-handoff.fixture.js': `import { buildConfiguration as configuration } from '/${moduleName.slice('assets/public/'.length)}'; function resolve(mode, value) { return value; } const recipient = resolve(configuration.mode, configuration.demoTestRecipient); function handoff(address) { return recipient ?? address; } export { recipient as demoTestRecipient, handoff as handoffRecipient };`,
      [moduleName]: module, ...extra }).filter(([, value]) => value != null))), env: { PATH: process.env.PATH } });
    const result = execFileSync('python3', ['scripts/private-android-apk.py', 'inspect', apk], {
      cwd: path.resolve(import.meta.dirname, '..'), env: { PATH: process.env.PATH }, encoding: 'utf8'
    });
    run(JSON.parse(result));
  } finally { await rm(directory, { recursive: true, force: true }); }
}

const configuration = () => ({ mode: 'staging', apiOrigin: origin, demoTestRecipient: recipient });

test('real APK inspector refuses origin and recipient superstrings or unrelated decoy literals', async () => {
  await withInspectedApk(configuration(), {}, description => assertPrivateApk(description, goodManifest(), '0.1.0', expected));
  for (const wrong of [
    { ...configuration(), apiOrigin: origin + '.other.invalid' },
    { ...configuration(), demoTestRecipient: 'not-' + recipient },
    { ...configuration(), apiOrigin: 'https://other.invalid', demoTestRecipient: 'other@example.invalid' }
  ]) {
    await withInspectedApk(wrong, { 'assets/public/decoy.js': `/* ${origin} ${recipient} */` }, description => {
      assert.throws(() => assertPrivateApk(description, goodManifest(), '0.1.0', expected), /compiled demo configuration/);
    });
  }
});

test('actual badging parser requires TEST in default and every supplied localized application label', () => {
  for (const labels of [
    "application-label:'Bór czuwa'\napplication-label-en:'Bór czuwa TEST'",
    "application-label:'Bór czuwa TEST'\napplication-label-pl:'Bór czuwa'",
    "application-label-en:'Bór czuwa TEST'",
    "application-label:'Bór czuwa TEST'\napplication-label-pl:'Bór czuwa's test'",
    "application-label:'Bór czuwa TEST'\napplication-label-pl:'Bór czuwa\\'s test'"
  ]) {
    const manifest = parsePrivateApkManifest(`package: name='pl.borczuwa.app.demo' versionCode='100' versionName='0.1.0'\n${labels}\napplication-debuggable\n`);
    assert.equal(manifest.testLabel, false);
  }
  assert.equal(goodManifest().testLabel, true);
});


test('real APK inspector refuses an unused valid configuration decoy, missing module or multiple modules', async () => {
  const module = `export const buildConfiguration = ${JSON.stringify(configuration())};\n`;
  const name = `assets/public/_app/immutable/bor-build-configuration-${createHash('sha256').update(module).digest('hex').slice(0, 16)}.js`;
  const other = `export const buildConfiguration = ${JSON.stringify({ ...configuration(), apiOrigin: 'https://other.invalid' })};\n`;
  const otherName = `assets/public/_app/immutable/bor-build-configuration-${createHash('sha256').update(other).digest('hex').slice(0, 16)}.js`;
  for (const extra of [
    { 'assets/public/_app/app.js': `import { buildConfiguration as ignored } from '/${name.slice('assets/public/'.length)}'; console.log(${JSON.stringify(origin + '.other.invalid')});` },
    { 'assets/public/_app/app.js': `const configuration = ${JSON.stringify({ ...configuration(), apiOrigin: 'https://other.invalid' })}; console.log(configuration.apiOrigin);` },
    { [name]: null },
    { [otherName]: other },
    { [name]: module + '// unexpected encoding' }
  ]) {
    await assert.rejects(withInspectedApk(configuration(), extra, () => assert.fail('invalid runtime passed inspection')),
      /Private APK inspection refused/);
  }
});


test('real APK inspector binds active routing exports, not unused property reads or exported decoys', async () => {
  const module = `export const buildConfiguration = ${JSON.stringify(configuration())};\n`;
  const name = `/_app/immutable/bor-build-configuration-${createHash('sha256').update(module).digest('hex').slice(0, 16)}.js`;
  const dead = `import { buildConfiguration as cfg } from '${name}'; function unused() { console.log(cfg.mode, cfg.apiOrigin, cfg.demoTestRecipient); }`;
  for (const extra of [
    { 'assets/public/_app/immutable/chunks/bor-api-url.fixture.js': `${dead} function url(path) { return 'https://other.invalid' + path; } function fetchApi(path) { return fetch(url(path)); } export { url as apiUrl, fetchApi as apiFetch };` },
    { 'assets/public/_app/immutable/chunks/bor-api-url.fixture.js': `${dead} const origin = cfg.apiOrigin; function good(path) { return \`\${origin}\${path}\`; } function wrong(path) { return 'https://other.invalid' + path; } export { good as unusedApiUrl, wrong as apiUrl, wrong as apiFetch };` },
    { 'assets/public/_app/immutable/chunks/bor-demo-handoff.fixture.js': `${dead} function wrong(address) { return 'other@example.invalid'; } const recipient = cfg.demoTestRecipient; export { wrong as handoffRecipient, recipient as demoTestRecipient };` }
  ]) {
    await assert.rejects(withInspectedApk(configuration(), extra, () => assert.fail('decoy routing passed inspection')),
      /Private APK inspection refused/);
  }
});
