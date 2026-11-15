// Prove that container builds see only intended inputs. Copies the tracked files into a disposable
// directory, plants synthetic private markers there, builds, and scans every image layer.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { parseArgs } from 'node:util';
import zlib from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const { values: options } = parseArgs({ options: {
  engine: { type: 'string', default: 'podman' },
  negative: { type: 'boolean', default: false },
  'build-images': { type: 'boolean', default: false },
} });
const engine = options.engine;
const policies = ['.dockerignore', '.containerignore'];
const stem = `private-context-${randomUUID().slice(0, 8)}`;
const marker = `PRIVATE-CONTEXT-${randomUUID()}`;
// Private places a checkout accumulates: tool worktrees and caches, credentials, captures, test and build output,
// including inside the directories the build does admit.
const planted = [
  '.tools/worktrees/private/src/marker.ts', '.tool-a/marker', '.tool-b/marker', '.tool-c/marker',
  '.scratch/capture.png', 'prototypes/capture.png', 'test-results/trace.zip', 'playwright-report/index.html',
  'coverage/report', '.pytest_cache/marker', 'node_modules/private/marker', 'build/private-marker',
  '.svelte-kit/private-marker', '.git/private-marker', 'android/release.jks', 'fastlane/play-store.json',
  '.env', '.env.production', '.npmrc', '.aws/credentials', '.ssh/id_ed25519', 'secrets/token',
  'unexpected-local-directory/marker', 'src/.env.local', 'server/credentials.json', 'server/secrets.json',
  'scripts/private.pem', 'scripts/.envrc', 'scripts/__pycache__/marker.pyc', 'data/capture.har',
  'static/private.key', 'containers/.env',
];
const summary = { ok: false, engine, negative: options.negative, planted: planted.length, images: [] };
let temporary;

function run(command, argv, settings = {}) {
  const result = spawnSync(command, argv, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...settings });
  if (result.status !== 0) throw new Error(`${command} ${argv[0]} failed (exit ${result.status})`);
  return result.stdout;
}

async function layerStream(file) {
  const handle = await open(file, 'r');
  const magic = Buffer.alloc(4);
  try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
  const source = createReadStream(file);
  if (magic.subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))) return pipeline(source, zlib.createGunzip(), () => {});
  if (magic.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) return pipeline(source, zlib.createZstdDecompress(), () => {});
  return source;
}

async function scanLayer(file) {
  const needle = Buffer.from(marker);
  let tail = Buffer.alloc(0);
  let bytes = 0;
  let leaked = false;
  for await (const chunk of await layerStream(file)) {
    bytes += chunk.length;
    const window = Buffer.concat([tail, chunk]);
    leaked ||= window.includes(needle);
    tail = window.subarray(Math.max(0, window.length - needle.length + 1));
  }
  return { bytes, leaked };
}

// Scans every layer of a built image and returns the file list of its first layer.
async function inspect(name, tag) {
  const directory = path.join(temporary, `image-${name}`);
  await mkdir(directory);
  const archive = path.join(directory, 'image.tar');
  run(engine, ['save', ...(engine === 'podman' ? ['--format', 'docker-archive'] : []), '-o', archive, tag]);
  run('tar', ['-xf', archive, '-C', directory]);
  await rm(archive);
  const [manifest] = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const image = { name, layers: manifest.Layers.length, layerBytes: 0 };
  summary.images.push(image);
  let leaked = false;
  for (const layer of manifest.Layers) {
    const scan = await scanLayer(path.join(directory, layer));
    image.layerBytes += scan.bytes;
    leaked ||= scan.leaked;
  }
  if (leaked) throw new Error(`private_marker_in_layer:${name}`);
  const entries = run('tar', ['-tf', path.join(directory, manifest.Layers[0])]);
  await rm(directory, { recursive: true, force: true });
  return entries.split('\n').map(entry => entry.replace(/^(\.\/)?context\/?/, '')).filter(entry => entry && !entry.endsWith('/'));
}

try {
  if (!['podman', 'docker'].includes(engine)) throw new Error('unsupported_engine');
  summary.sourceCommit = run('git', ['-C', root, 'rev-parse', 'HEAD']).trim();
  summary.dirty = run('git', ['-C', root, 'status', '--porcelain']).length > 0;
  // The policy's plain "!name" lines are the admitted roots; every tracked file under them is a build input.
  const policy = await readFile(path.join(root, '.dockerignore'), 'utf8').catch(() => '');
  const roots = policy.split('\n').map(line => line.trim()).filter(line => /^![^*?[]+$/.test(line)).map(line => line.slice(1));
  const admitted = file => roots.some(entry => file === entry || file.startsWith(`${entry}/`));
  temporary = await mkdtemp(path.join(tmpdir(), 'private-context-'));
  const context = path.join(temporary, 'context');
  // Copy tracked files only, so no real private file is ever read into a build. Working edits count;
  // the ignore policies are copied even before their first commit.
  const copied = [];
  for (const file of new Set([...run('git', ['-C', root, 'ls-files', '-z']).split('\0').filter(Boolean), ...policies])) {
    try { await cp(path.join(root, file), path.join(context, file), { dereference: false }); copied.push(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Untracked files under the admitted roots would also reach the engine. Recreate them by name, empty.
  const untracked = roots.length ? run('git', ['-C', root, 'ls-files', '-z', '--others', '--', ...roots]).split('\0').filter(Boolean) : [];
  for (const file of untracked) {
    await mkdir(path.dirname(path.join(context, file)), { recursive: true });
    await writeFile(path.join(context, file), '');
  }
  // Podman prefers .containerignore and Docker a per-Containerfile .dockerignore; either would bypass this policy.
  const otherPolicy = [...copied, ...untracked].find(file => /\.(docker|container)ignore$/.test(file) && file !== '.dockerignore');
  if (otherPolicy) throw new Error(`other_ignore_file:${otherPolicy}`);
  for (const file of planted) {
    await mkdir(path.dirname(path.join(context, file)), { recursive: true });
    await writeFile(path.join(context, file), marker);
  }
  if (options.negative) for (const file of policies.map(name => path.join(context, name))) {
    try { await writeFile(file, `${await readFile(file, 'utf8')}\n!.tools\n!.tools/**\n`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // A scratch image holding the whole context shows everything the engine would send to any build.
  const probe = path.join(temporary, 'probe.Containerfile');
  await writeFile(probe, 'FROM scratch\nCOPY . /context/\n');
  run(engine, ['build', '-f', probe, '-t', `localhost/${stem}:context`, context], { stdio: ['ignore', 2, 2] });
  const entries = await inspect('context', `localhost/${stem}:context`);
  const expected = copied.filter(admitted);
  const unexpected = entries.find(entry => !expected.includes(entry));
  if (unexpected) throw new Error(`unexpected_in_context:${unexpected}`);
  const missing = expected.find(file => !entries.includes(file));
  if (missing) throw new Error(`tracked_input_missing:${missing}`);
  summary.contextFiles = entries.length;
  summary.contextBytes = summary.images[0].layerBytes;
  if (options['build-images']) {
    // Build the images through Compose, as npm run stack and the isolated runner do.
    if (engine === 'podman') run('systemctl', ['--user', 'start', 'podman.socket']);
    run(engine, ['compose', '-f', path.join(context, 'compose.yaml'), '-p', stem, 'build', 'fixture', 'app', 'web'],
      { stdio: ['ignore', 2, 2] });
    for (const name of ['fixture', 'app', 'web']) await inspect(name, `${stem}-${name}`);
  }
  summary.ok = true;
} catch (error) {
  summary.error = error.message;
  process.exitCode = 1;
} finally {
  // Remove every image this run tagged, including those a failed Compose build left behind.
  const images = spawnSync(engine, ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}'], { encoding: 'utf8' });
  for (const image of (images.stdout ?? '').split('\n').filter(image => image.includes(stem))) {
    if (spawnSync(engine, ['image', 'rm', image], { stdio: 'ignore' }).status !== 0) summary.cleanupFailed = true;
  }
  if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => { summary.cleanupFailed = true; });
  if (summary.cleanupFailed) { summary.ok = false; process.exitCode = 1; }
  console.log(JSON.stringify(summary));
}
