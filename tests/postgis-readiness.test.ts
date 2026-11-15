import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const pause = () => new Promise(resolve => setTimeout(resolve, 50));

test('database readiness excludes the temporary PostGIS bootstrap server', { timeout: 60_000 }, async () => {
  const podman = (...args: string[]) => execFileSync('podman', args, { encoding: 'utf8', timeout: 30_000 });
  const config = JSON.parse(podman('compose', '-f', path.join(root, 'compose.yaml'), 'config', '--format', 'json'));
  const database = config.services.db;
  const healthcheck = database.healthcheck.test;
  assert.equal(healthcheck[0], 'CMD-SHELL');
  const directory = await mkdtemp(path.join(tmpdir(), 'bor-czuwa-postgis-readiness-'));
  const name = `bor-czuwa-postgis-readiness-${randomUUID()}`;
  const probe = (command: string[]) => spawnSync('podman', ['exec', name, ...command], { encoding: 'utf8', timeout: 5_000 });
  const configuredReady = () => probe(['sh', '-c', healthcheck.slice(1).join(' ')]);
  try {
    await chmod(directory, 0o777);
    const script = path.join(directory, 'hold-bootstrap.sh');
    await writeFile(script, '#!/bin/sh\nprintf ready > /probe/bootstrap\nwhile [ ! -f /probe/release ]; do sleep 0.05; done\n');
    await chmod(script, 0o755);
    podman('run', '--detach', '--name', name, '--publish', '127.0.0.1::5432',
      '--env', 'POSTGRES_USER=skeleton', '--env', 'POSTGRES_PASSWORD=skeleton-local-only', '--env', 'POSTGRES_DB=skeleton',
      '--tmpfs', '/var/lib/postgresql/data:rw,size=512m',
      '--volume', `${directory}:/probe:rw,Z`,
      '--volume', `${script}:/docker-entrypoint-initdb.d/99-readiness-probe.sh:ro,Z`,
      database.image, ...database.command);
    const started = Date.now();
    while (true) {
      try { await access(path.join(directory, 'bootstrap')); break; }
      catch { assert.ok(Date.now() - started < 20_000, 'PostGIS bootstrap barrier was not reached'); await pause(); }
    }
    const socket = probe(['pg_isready', '-U', 'skeleton', '-d', 'skeleton']);
    const tcp = probe(['pg_isready', '-h', '127.0.0.1', '-U', 'skeleton', '-d', 'skeleton']);
    const health = configuredReady();
    console.log(JSON.stringify({ bootstrap: { socket: socket.status, tcp: tcp.status, configured: health.status } }));
    assert.equal(socket.status, 0, socket.stdout + socket.stderr);
    assert.notEqual(tcp.status, 0, 'Temporary initialization must not accept TCP connections');
    assert.notEqual(health.status, 0, 'Database healthcheck must not accept the temporary bootstrap server');
    await writeFile(path.join(directory, 'release'), 'continue\n');
    const released = Date.now();
    while (configuredReady().status !== 0) {
      assert.ok(Date.now() - released < 20_000, 'Final PostgreSQL server did not become ready');
      await pause();
    }
    assert.equal(probe(['pg_isready', '-h', '127.0.0.1', '-U', 'skeleton', '-d', 'skeleton']).status, 0);
    const address = podman('port', name, '5432').trim();
    const migration = spawnSync(process.execPath, ['--import', 'tsx', 'server/migrate.ts'], {
      cwd: root, env: { ...process.env, MIGRATION_DATABASE_URL: `postgres://skeleton:skeleton-local-only@${address}/skeleton`, RUNTIME_DB_PASSWORD: 'runtime-local-only', RUNTIME_DB_ROLE: 'app_runtime' },
      encoding: 'utf8', timeout: 20_000
    });
    assert.equal(migration.status, 0, migration.stdout + migration.stderr);
    const applied = probe(['psql', '-U', 'skeleton', '-d', 'skeleton', '-Atc', 'SELECT count(*) FROM schema_migrations']);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(Number(applied.stdout.trim()), 15, 'All current migrations must finish after final readiness');
    console.log(JSON.stringify({ final: { configured: 0, tcp: 0, migration: migration.status, applied: Number(applied.stdout.trim()) } }));
  } finally {
    await writeFile(path.join(directory, 'release'), 'cleanup\n');
    const cleanup = spawnSync('podman', ['rm', '--force', '--time=0', name], { encoding: 'utf8', timeout: 15_000 });
    await rm(directory, { recursive: true, force: true });
    assert.equal(cleanup.status, 0, cleanup.stdout + cleanup.stderr);
  }
});
