import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(process.env.CI_EVIDENCE_DIR ?? '.scratch/ci');
const version = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const versions = { node: process.version, npm: version('npm', ['--version']),
  podman: version('podman', ['--version']), compose: version('podman', ['compose', 'version']),
  java: version('java', ['--version']), gradle: version('./android/gradlew', ['--version']),
  playwright: version('./node_modules/.bin/playwright', ['--version']),
  platform: `${process.platform}/${process.arch}` };
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'toolchain.json'), `${JSON.stringify(versions, null, 2)}\n`);
