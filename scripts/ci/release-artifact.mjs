import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, cp, readFile, readdir, writeFile, rm, chmod, stat, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest } from '../release-candidate.mjs';

const root = process.cwd();
const mode = process.env.CANDIDATE_MODE ?? 'staging';
if (!['staging', 'production'].includes(mode)) throw new Error('Invalid candidate mode');
const demoTestRecipient = process.env.VITE_DEMO_TEST_RECIPIENT ?? '';
if (demoTestRecipient && (mode !== 'staging' || !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(demoTestRecipient))) {
  throw new Error('Private demo requires a valid test recipient and staging eligibility');
}
if (demoTestRecipient && !/^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/.test(process.env.ANDROID_API_ORIGIN ?? '')) {
  throw new Error('Private demo Android origin required');
}
if (execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Candidate requires clean committed source');
// The build is named by its commit alone. An inherited override would let one commit build
// different archives and two commits share an update name; only the two-versions test sets it.
if (process.env.KIT_VERSION_NAME) throw new Error('Candidate builds must not set KIT_VERSION_NAME');
// Dependencies must come from this checkout's own lockfile install. A symlinked node_modules
// leaks its target's paths and versions into the hashed output.
if (!(await lstat(path.join(root, 'node_modules'))).isDirectory()) throw new Error('Candidate requires node_modules installed by npm ci in this checkout');
const output = path.resolve(process.env.CI_EVIDENCE_DIR ?? '.scratch/ci');
const run = (program, args, options = {}) => execFileSync(program, args, { stdio: 'inherit', ...options });
const directory = await mkdtemp(path.join(tmpdir(), 'bor-czuwa-artifact-'));
try {
  // This archive includes runtime source only, never the workspace or private evidence.
  const inputs = ['package.json', 'package-lock.json', 'server', 'src', 'data', 'ops', 'scripts', 'containers', 'tsconfig.json', 'tsconfig.server.json', 'vite.config.ts'];
  const source = execFileSync('git', ['-C', root, 'archive', 'HEAD', ...inputs], { maxBuffer: 64 * 1024 * 1024 });
  run('tar', ['-xf', '-', '-C', directory], { input: source, stdio: ['pipe', 'inherit', 'inherit'] });
  run('npm', ['run', mode === 'production' ? 'build' : 'build:staging'], { env: { ...process.env, VITE_API_ORIGIN: '' } });
  await cp('build', path.join(directory, 'build'), { recursive: true });
  const sourceCommit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  await writeFile(path.join(directory, 'build/RELEASE'), sourceCommit + '\n');
  if (mode === 'production') {
    if (!/^https:\/\/[a-zA-Z0-9.-]+(:[0-9]+)?$/.test(process.env.ANDROID_API_ORIGIN ?? '')) throw new Error('Production Android origin required');
    run('bash', ['scripts/build-android.sh', '--release']);
    run('./gradlew', ['--no-daemon', 'assembleRelease', 'bundleRelease'], { cwd: path.join(root, 'android') });
    await mkdir(path.join(directory, 'android-release'));
    await cp('android/app/build/outputs/apk/release/app-release-unsigned.apk', path.join(directory, 'android-release/app-release-unsigned.apk'));
    await cp('android/app/build/outputs/bundle/release/app-release.aab', path.join(directory, 'android-release/app-release.aab'));
  }
  const files = {};
  async function walk(current, prefix = '') {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), relative + '/');
      else {
        if (!entry.isFile()) throw new Error('Release input must be a regular file');
        files[relative] = digest(await readFile(path.join(current, entry.name)));
      }
    }
  }
  await walk(directory);
  await mkdir(path.join(output, 'artifacts'), { recursive: true });
  const archive = path.join(output, 'artifacts/release.tar');
  // The archive bytes are the release identity, so tar must not record who built it, when, or
  // under which umask: entries are sorted, owned by 0:0, carry the commit time, and modes are set
  // explicitly (directories 0755, files 0644, or 0755 where the source file is executable).
  async function normalize(current) {
    await chmod(current, 0o755);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await normalize(full);
      else await chmod(full, (await stat(full)).mode & 0o111 ? 0o755 : 0o644);
    }
  }
  await normalize(directory);
  // An inherited SOURCE_DATE_EPOCH is ignored on purpose: the commit alone fixes the time.
  const epoch = execFileSync('git', ['-C', root, 'log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim();
  run('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '--format=gnu', '-cf', archive, '-C', directory, '.']);
  const sha256 = digest(await readFile(archive));
  let android;
  if (mode === 'production') {
    const apk = path.join(directory, 'android-release/app-release-unsigned.apk');
    const aab = path.join(directory, 'android-release/app-release.aab');
    run('unzip', ['-tq', apk]);
    run('unzip', ['-tq', aab]);
    const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (!sdk) throw new Error('Android SDK required for candidate binary validation');
    const badging = execFileSync(path.join(sdk, 'build-tools/36.0.0/aapt'), ['dump', 'badging', apk], { encoding: 'utf8' });
    const identity = /package: name='pl.borczuwa.app' versionCode='(\d+)' versionName='([^']+)'/.exec(badging);
    const version = JSON.parse(await readFile('package.json', 'utf8')).version;
    if (!identity || identity[2] !== version) throw new Error('Unsigned APK package/version identity mismatch');
    android = { validated: true, packageName: 'pl.borczuwa.app', versionName: identity[2], versionCode: Number(identity[1]),
      unsignedApkSha256: files['android-release/app-release-unsigned.apk'], unsignedAabSha256: files['android-release/app-release.aab'],
      scope: 'release compilation, APK identity and APK/AAB ZIP integrity; signed physical journeys remain required' };
  }
  // HTTP probes use these exact archived bytes. No build follows this boundary.
  const probe = execFileSync(process.execPath, ['scripts/ci/production-http.mjs', directory, mode], { encoding: 'utf8' });
  const http = JSON.parse(probe);
  http.artifactSha256 = sha256;
  await writeFile(path.join(output, 'release-artifact.json'), JSON.stringify({ mode, sha256, files, http, android,
    configuration: { mode, apiOrigin: '', androidApiOrigin: mode === 'production' || demoTestRecipient ? process.env.ANDROID_API_ORIGIN : null,
      ...(demoTestRecipient ? { demoTestRecipient } : {}),
      hsts: 'host-policy', command: mode === 'production' ? 'npm run build' : 'npm run build:staging' } }, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
