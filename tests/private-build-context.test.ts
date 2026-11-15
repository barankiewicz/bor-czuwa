import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function check(engine: string, ...args: string[]) {
  const result = spawnSync(process.execPath, ['scripts/check-private-context.mjs', '--engine', engine, ...args],
    { encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  return { status: result.status, output: result.stdout + result.stderr, summary: JSON.parse(result.stdout.trim().split('\n').at(-1) || '{}') };
}

// Each engine can read a different ignore file, so both are checked wherever they run.
for (const engine of ['podman', 'docker']) {
  const missing = spawnSync(engine, ['info'], { stdio: 'ignore' }).status !== 0 && `${engine} is not reachable`;

  test(`${engine} build context leaves out private workspace artifacts`, { skip: missing }, () => {
    const { status, output, summary } = check(engine);
    assert.equal(status, 0, output);
    assert.equal(summary.ok, true);
    assert.ok(summary.planted >= 30);
    assert.ok(summary.contextFiles > 0);
  });

  test(`${engine} packaging check fails when a private marker is admitted`, { skip: missing }, () => {
    const { status, output, summary } = check(engine, '--negative');
    assert.equal(status, 1, output);
    assert.equal(summary.error, 'private_marker_in_layer:context');
  });
}
