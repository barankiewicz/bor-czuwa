import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrateDatabase } from '../server/migrations.ts';
import { minimalGeodataSchema, seedMinimalGeodata } from './helpers/minimal-geodata.ts';
import { geodataReadiness } from '../server/startup-check.ts';
import { testDatabaseUrl } from './helpers/test-database.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const adminUrl = testDatabaseUrl();
const runtimePassword = process.env.RUNTIME_DB_PASSWORD ?? 'runtime-local-only';
const schema = minimalGeodataSchema;

async function withDatabase(run: (admin: pg.Client, runtimeUrl: string) => Promise<void>) {
  const name = `startup_test_${randomUUID().replaceAll('-', '')}`;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  try {
    await root.query(`CREATE DATABASE ${name}`);
    await migrateDatabase(url.toString(), runtimePassword);
    const admin = new pg.Client({ connectionString: url.toString() });
    await admin.connect();
    try {
      const runtime = new URL(url);
      runtime.username = 'app_runtime';
      runtime.password = runtimePassword;
      await run(admin, runtime.toString());
    } finally { await admin.end(); }
  } finally {
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  }
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as { port: number };
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function run(args: string[], databaseUrl: string, port = 3001) {
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl, HOST: '127.0.0.1', PORT: String(port) } });
  let stderr = '';
  let stdout = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { stdout += chunk; });
  const exited = new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
  return { child, exited, output: () => ({ stderr, stdout }) };
}

async function refusal(args: string[], databaseUrl: string) {
  const started = run(args, databaseUrl, await freePort());
  const code = await Promise.race([started.exited, setTimeout(30_000, 'timeout')]);
  if (code === 'timeout') started.child.kill('SIGKILL');
  return { code, ...started.output() };
}

async function status(port: number, path: string) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } catch { return { status: 0, body: {} }; }
}

async function until(check: () => Promise<boolean>, limitMs: number) {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    if (await check()) return Date.now() - started;
    await setTimeout(250);
  }
  throw new Error(`condition not met within ${limitMs} ms`);
}

// exit status, token, printed sentence: the contract the unit and the monitor read.
const cases: { name: string; token: string; exit: number; sentence: string; break: string[]; fix: string[];
  url?: (runtimeUrl: string) => string }[] = [
  { name: 'C1 applied migration changed', token: 'ledger_checksum_mismatch', exit: 80,
    sentence: 'An applied migration differs from this release.',
    break: ["UPDATE schema_migrations SET checksum = '00' || substr(checksum, 3) WHERE version = 5"],
    fix: ['DELETE FROM schema_migrations', 'INSERT INTO schema_migrations SELECT * FROM zz_ledger_backup'] },
  { name: 'C2 ledger newer than the release', token: 'ledger_newer_than_application', exit: 81,
    sentence: 'The database was migrated by a newer release.',
    break: ["INSERT INTO schema_migrations (version, checksum) VALUES (16, 'ab')"],
    fix: ['DELETE FROM schema_migrations WHERE version = 16'] },
  { name: 'C3 migration missing', token: 'migration_required', exit: 82,
    sentence: 'This release has migrations the database does not have yet.',
    break: ['DELETE FROM schema_migrations WHERE version = 15'],
    fix: ['DELETE FROM schema_migrations', 'INSERT INTO schema_migrations SELECT * FROM zz_ledger_backup'] },
  { name: 'C4 ledger table missing', token: 'ledger_missing', exit: 83,
    sentence: 'The database has no migration ledger.',
    break: ['ALTER TABLE schema_migrations RENAME TO zz_sm_gone'],
    fix: ['ALTER TABLE zz_sm_gone RENAME TO schema_migrations'] },
  { name: 'C5 geodata schema gone', token: 'geodata_schema_missing', exit: 86,
    sentence: 'The current geodata schema, or a table or column it needs, is gone.',
    break: [`ALTER SCHEMA ${schema} RENAME TO zz_geo_gone`],
    fix: [`ALTER SCHEMA zz_geo_gone RENAME TO ${schema}`] },
  { name: 'C6 stored Rule set differs', token: 'rule_set_changed', exit: 84,
    sentence: 'A stored Rule set differs from the one this release ships.',
    break: [`UPDATE rule_set SET parameters = parameters || '{"zz":1}'::jsonb`],
    fix: [`UPDATE rule_set SET parameters = parameters - 'zz'`] },
  { name: 'C7 non-conforming schema name', token: 'geodata_rebuild_required', exit: 87,
    sentence: 'The geodata uses an old storage layout and must be rebuilt.',
    break: ["UPDATE geodata_snapshot SET storage_schema = 'geo_zz'"],
    fix: [`UPDATE geodata_snapshot SET storage_schema = '${schema}'`] },
  { name: 'C14 required table missing', token: 'schema_incomplete', exit: 96,
    sentence: 'A table or column this release needs is missing from the database.',
    break: ['ALTER TABLE current_geodata RENAME TO zz_cg_gone'], fix: ['ALTER TABLE zz_cg_gone RENAME TO current_geodata'] },
  { name: 'C15 required column missing', token: 'schema_incomplete', exit: 96,
    sentence: 'A table or column this release needs is missing from the database.',
    break: ['ALTER TABLE geodata_snapshot RENAME COLUMN storage_schema TO zz_ss_gone'],
    fix: ['ALTER TABLE geodata_snapshot RENAME COLUMN zz_ss_gone TO storage_schema'] },
  { name: 'C11 wrong runtime password', token: 'database_auth_failed', exit: 91,
    sentence: 'The database refused the runtime login; check the runtime password.', break: [], fix: [],
    url: runtimeUrl => { const wrong = new URL(runtimeUrl); wrong.password = 'not-the-password'; return wrong.toString(); } },
  { name: 'C22 malformed database URL', token: 'database_url_invalid', exit: 97,
    sentence: 'The database address in the runtime settings is not a valid URL.', break: [], fix: [], url: () => 'postgres://[' },
  { name: 'C12 no such database', token: 'database_missing', exit: 92,
    sentence: 'The database named in the runtime settings does not exist.', break: [], fix: [],
    url: runtimeUrl => { const gone = new URL(runtimeUrl); gone.pathname = '/startup_test_no_such_database'; return gone.toString(); } },
  { name: 'C13 runtime grant missing', token: 'database_permission_denied', exit: 93,
    sentence: 'The runtime role lacks a grant this release needs.',
    break: ['REVOKE SELECT ON current_geodata FROM app_runtime'], fix: ['GRANT SELECT ON current_geodata TO app_runtime'] },
  { name: 'C9 no current geodata', token: 'geodata_missing', exit: 85,
    sentence: 'No current geodata is recorded.',
    break: ['DELETE FROM current_geodata'],
    fix: ["INSERT INTO current_geodata (snapshot_id) VALUES ('s')"] },
  { name: 'C10 geodata without dwellings', token: 'geodata_empty', exit: 88,
    sentence: 'The current geodata holds no dwellings or no recipient areas.',
    break: [`DELETE FROM ${schema}.dwelling`],
    fix: [`INSERT INTO ${schema}.dwelling VALUES (ST_Multi(ST_GeomFromText('POLYGON((0 0,1 0,1 1,0 0))', 2180)))`] },
  { name: 'C17 dwelling table without its geometry column', token: 'geodata_schema_missing', exit: 86,
    sentence: 'The current geodata schema, or a table or column it needs, is gone.',
    break: [`ALTER TABLE ${schema}.dwelling RENAME COLUMN geom TO zz_geom`], fix: [`ALTER TABLE ${schema}.dwelling RENAME COLUMN zz_geom TO geom`] },
  { name: 'C20 hunting-district number column missing', token: 'geodata_schema_missing', exit: 86,
    sentence: 'The current geodata schema, or a table or column it needs, is gone.',
    break: [`ALTER TABLE ${schema}.obwod_lowiecki RENAME COLUMN number TO zz_number`], fix: [`ALTER TABLE ${schema}.obwod_lowiecki RENAME COLUMN zz_number TO number`] },
  { name: 'C21 recipient areas without their geometry column', token: 'geodata_schema_missing', exit: 86,
    sentence: 'The current geodata schema, or a table or column it needs, is gone.',
    break: ['ALTER TABLE recipient_jurisdiction RENAME COLUMN geom TO zz_geom'], fix: ['ALTER TABLE recipient_jurisdiction RENAME COLUMN zz_geom TO geom'] },
  { name: 'C18 geometry column of the wrong type', token: 'geodata_schema_missing', exit: 86,
    sentence: 'The current geodata schema, or a table or column it needs, is gone.',
    break: [`ALTER TABLE ${schema}.obwod_lowiecki ALTER COLUMN geom TYPE text USING ST_AsText(geom)`],
    fix: [`ALTER TABLE ${schema}.obwod_lowiecki ALTER COLUMN geom TYPE geometry(MultiPolygon, 2180) USING ST_GeomFromText(geom, 2180)`] },
  { name: 'C19 no recipient areas for the current snapshot', token: 'geodata_empty', exit: 88,
    sentence: 'The current geodata holds no dwellings or no recipient areas.',
    break: ['CREATE TABLE zz_rj AS SELECT * FROM recipient_jurisdiction', 'DELETE FROM recipient_jurisdiction'],
    fix: ['INSERT INTO recipient_jurisdiction SELECT * FROM zz_rj', 'DROP TABLE zz_rj'] }
];

test('every startup refusal exits with its own status and prints its own sentence', async () => {
  await withDatabase(async (admin, runtimeUrl) => {
    await seedMinimalGeodata(admin);
    await admin.query('CREATE TABLE zz_ledger_backup AS SELECT * FROM schema_migrations');
    // Positive control: the unbroken database starts, so each refusal below is its one fault.
    const controlPort = await freePort();
    const control = run(['server/main.ts'], runtimeUrl, controlPort);
    try {
      await until(async () => (await status(controlPort, '/api/ready')).status === 200, 20_000);
    } finally {
      control.child.kill('SIGTERM');
      assert.equal(await control.exited, 0);
    }
    const seen = new Set<string>();
    for (const item of cases) {
      for (const sql of item.break) await admin.query(sql);
      try {
        for (const [label, args] of [['main', ['server/main.ts']], ['check', ['ops/production/check-database.ts']]] as const) {
          const result = await refusal([...args], item.url?.(runtimeUrl) ?? runtimeUrl);
          const line = label === 'main'
            ? `Start refused: ${item.token}. ${item.sentence} The API was not started.`
            : `Database check refused: ${item.token}.`;
          assert.equal(result.stderr.trim(), line, `${item.name} (${label})`);
          assert.equal(result.code, item.exit, `${item.name} (${label}) exit status`);
        }
        seen.add(item.token);
      } finally {
        for (const sql of item.fix) await admin.query(sql);
      }
    }
    assert.equal(seen.size, new Set(cases.map(item => item.token)).size, 'every token was seen');
    assert.equal(new Set(cases.map(item => item.exit)).size, seen.size, 'one status per token');
    // And after every fault is repaired the database starts again: refusals are not left behind.
    const port = await freePort();
    const again = run(['server/main.ts'], runtimeUrl, port);
    try {
      await until(async () => (await status(port, '/api/ready')).status === 200, 20_000);
    } finally {
      again.child.kill('SIGTERM');
      assert.equal(await again.exited, 0);
    }
  });
});

test('an unreachable database is a retryable refusal of its own', async () => {
  const unreachable = 'postgres://app_runtime:x@127.0.0.1:1/none';
  const result = await refusal(['server/main.ts'], unreachable);
  assert.equal(result.stderr.trim(),
    'Start refused: database_unavailable. The database could not be reached. The API was not started.');
  assert.equal(result.code, 94);
});

test('readiness follows the geodata: 503 when there is none, 200 when it is back', async () => {
  await withDatabase(async (admin, runtimeUrl) => {
    await seedMinimalGeodata(admin);
    const port = await freePort();
    const api: ReturnType<typeof run> = run(['server/main.ts'], runtimeUrl, port);
    try {
      await until(async () => (await status(port, '/api/ready')).status === 200, 20_000);
      await admin.query('DELETE FROM current_geodata');
      // The cache window is tested with an injected clock below; here only that the change is noticed.
      await until(async () => (await status(port, '/api/ready')).status === 503, 30_000);
      assert.deepEqual((await status(port, '/api/ready')).body, { error: 'geodata_unavailable' });
      // Liveness does not follow readiness, so the unit is not killed for it.
      assert.equal((await status(port, '/api/health')).status, 200);
      await admin.query("INSERT INTO current_geodata (snapshot_id) VALUES ('s')");
      await until(async () => (await status(port, '/api/ready')).status === 200, 30_000);
      // A table that lost the column Findings reads, and a snapshot with no recipient areas, are not ready either.
      for (const [broken, fixed] of [
        [`ALTER TABLE ${minimalGeodataSchema}.dwelling RENAME COLUMN geom TO zz_geom`, `ALTER TABLE ${minimalGeodataSchema}.dwelling RENAME COLUMN zz_geom TO geom`],
        ['ALTER TABLE recipient_dataset RENAME TO zz_rd', 'ALTER TABLE zz_rd RENAME TO recipient_dataset'],
        [`ALTER TABLE ${minimalGeodataSchema}.obwod_lowiecki RENAME COLUMN number TO zz_number`, `ALTER TABLE ${minimalGeodataSchema}.obwod_lowiecki RENAME COLUMN zz_number TO number`],
        ['ALTER TABLE recipient_jurisdiction RENAME COLUMN geom TO zz_geom', 'ALTER TABLE recipient_jurisdiction RENAME COLUMN zz_geom TO geom']]) {
        await admin.query(broken);
        await until(async () => (await status(port, '/api/ready')).status === 503, 30_000);
        if (broken.includes('recipient_jurisdiction RENAME')) {
          const lookup = await fetch(`http://127.0.0.1:${port}/api/recipients`, { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lat: 52.2, lon: 21 }) });
          assert.equal(lookup.status, 503, 'the lookup fails the way readiness said it would');
        }
        await admin.query(fixed);
        await until(async () => (await status(port, '/api/ready')).status === 200, 30_000);
      }
    } finally {
      api.child.kill('SIGTERM');
      await api.exited;
    }
  });
});

// What the column probe returns for any table: every column the check asks for, geom as a geometry.
const allColumns = ['osm_id', 'kind', 'inspire_id', 'name', 'parent_kind', 'document_state', 'documents', 'objectid', 'number', 'source_year', 'snapshot_id', 'unit_id', 'sources']
  .map(name => ({ name, type: 'text' })).concat([{ name: 'geom', type: 'geometry(MultiPolygon,2180)' }]);

test('a clock that goes backwards does not keep an old readiness answer alive', async () => {
  let empty = false;
  const database = { async query(sql: string) {
    if (sql.startsWith('SELECT 1 FROM current_geodata')) return { rowCount: empty ? 0 : 1, rows: [] };
    if (sql.includes('storage_schema')) return { rowCount: 1, rows: [{ storage_schema: minimalGeodataSchema }] };
    if (sql.includes('pg_attribute')) return { rowCount: 9, rows: allColumns };
    return { rowCount: 1, rows: [{}] };
  } };
  let clock = 1_000_000;
  const ready = geodataReadiness(database as never, () => clock);
  assert.equal(await ready(), true);
  empty = true;
  clock -= 3_600_000;
  assert.equal(await ready(), false, 'a stamp from the future is not trusted');
});

test('the readiness answer is remembered for 5 s on the clock it is given, and not a moment longer', async () => {
  let empty = false;
  let queries = 0;
  const database = { async query(sql: string) {
    queries++;
    if (sql.startsWith('SELECT 1 FROM current_geodata')) return { rowCount: empty ? 0 : 1, rows: [] };
    if (sql.includes('storage_schema')) return { rowCount: 1, rows: [{ storage_schema: minimalGeodataSchema }] };
    if (sql.includes('pg_attribute')) return { rowCount: 9, rows: allColumns };
    return { rowCount: 1, rows: [{}] };
  } };
  let clock = 1_000_000;
  const ready = geodataReadiness(database as never, () => clock);
  assert.equal(await ready(), true);
  const afterFirst = queries;
  empty = true;
  clock += 4999;
  assert.equal(await ready(), true, 'still the remembered answer at 4999 ms');
  assert.equal(queries, afterFirst, 'no query inside the window');
  clock += 1;
  assert.equal(await ready(), false, 'asked again at 5000 ms');
  assert.ok(queries > afterFirst);
});
