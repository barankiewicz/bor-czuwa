import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { digest } from '../release-candidate.mjs';

export async function candidateStack(root, archive) {
  const metadata = JSON.parse(await readFile(path.join(path.dirname(archive), '../release-artifact.json'), 'utf8'));
  if (digest(await readFile(archive)) !== metadata.sha256) throw new Error('Candidate archive changed before suites');
  const directory = await mkdtemp(path.join(tmpdir(), 'candidate-stack-'));
  try {
    execFileSync('tar', ['-xf', archive, '-C', directory]);
    const verify = async () => {
      if (digest(await readFile(archive)) !== metadata.sha256) throw new Error('Candidate archive changed during suites');
      const seen = [];
      async function walk(current, prefix = '') {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const relative = prefix + entry.name;
          if (['compose.json', 'nginx.conf.template'].includes(relative)) continue;
          if (entry.isDirectory()) await walk(path.join(current, entry.name), relative + '/');
          else {
            if (!entry.isFile() || digest(await readFile(path.join(current, entry.name))) !== metadata.files[relative]) throw new Error(`Candidate payload changed: ${relative}`);
            seen.push(relative);
          }
        }
      }
      await walk(directory);
      if (seen.length !== Object.keys(metadata.files).length) throw new Error('Candidate payload incomplete');
    };
    await verify();
    const nginx = await readFile(path.join(directory, 'containers/nginx.conf'), 'utf8');
    await writeFile(path.join(directory, 'nginx.conf.template'), nginx);
    const runtime = ['src', 'server', 'scripts', 'data', 'package.json', 'package-lock.json'].map(name => `${directory}/${name}:/app/${name}:ro,z`);
    const compose = { services: {
      app: { volumes: runtime }, migration: { volumes: runtime },
      fixture: { volumes: ['scripts', 'data'].map(name => `${directory}/${name}:/app/${name}:ro,z`) },
      web: { volumes: [`${directory}/build:/usr/share/nginx/html:ro,z`, `${directory}/build/security-headers.conf:/etc/nginx/security-headers.conf:ro,z`,
        `${directory}/nginx.conf.template:/etc/nginx/templates/nginx.conf.template:ro,z`] }
    } };
    const overlay = path.join(directory, 'compose.json');
    await writeFile(overlay, JSON.stringify(compose));
    return { files: ['-f', path.join(root, 'compose.yaml'), '-f', overlay], mode: metadata.mode,
      artifactSha256: metadata.sha256, verify, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
