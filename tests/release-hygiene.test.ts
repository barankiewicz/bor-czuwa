import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('release gate refuses test markers and legal placeholders in shipped assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bor-czuwa-release-'));
  try {
    await mkdir(join(directory, '_app'));
    await writeFile(join(directory, 'index.html'), '<title>Bór czuwa</title>');
    const check = () => spawnSync(process.execPath, ['scripts/check-release.mjs', directory], { encoding: 'utf8' });
    assert.equal(check().status, 0);
    for (const marker of ['wersja testowa', 'noindex', 'dane testowe', 'danych testowych',
      '[data startu]', '[e-mail projektu]', '[lokalizacja serwera]', 'Szkic do przeglądu prawników', 'test version', 'test data coverage', '[Brzmienie do potwierdzenia przez prawników.]']) {
      await writeFile(join(directory, '_app', 'legal.js'), JSON.stringify(marker));
      const result = check();
      assert.equal(result.status, 1, marker);
      assert.match(result.stderr, /Release blocked/);
    }
    await writeFile(join(directory, '_app', 'legal.js'), 'Miejsce jest poza zasięgiem dostępnych danych.');
    assert.equal(check().status, 0);
    await rm(join(directory, 'index.html'));
    assert.equal(check().status, 1, 'missing build must fail closed');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Android release refuses missing signing values before building', () => {
  const signing = ['ANDROID_KEYSTORE_PATH', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD'];
  for (const missing of signing) {
    const environment: NodeJS.ProcessEnv = { ...process.env, ANDROID_API_ORIGIN: 'https://api.example.org' };
    for (const name of signing) environment[name] = 'deployment-test';
    delete environment[missing];
    const result = spawnSync('bash', ['scripts/build-release.sh'], { env: environment, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`Missing signing environment: ${missing}`));
    assert.doesNotMatch(result.stdout, /vite|Gradle/);
  }
});
