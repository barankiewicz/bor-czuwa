import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { assertSchemaCompatible, migrateDatabase } from '../server/migrations.ts';
import { seedMinimalGeodata } from './helpers/minimal-geodata.ts';
import { testDatabaseUrl } from './helpers/test-database.ts';

const adminUrl = testDatabaseUrl();
const runtimePassword = process.env.RUNTIME_DB_PASSWORD ?? 'runtime-local-only';
// SHA-256 of server/schema.sql at d2bc825, before migrations existed.
const preTicketSchemaHash = '84956ad55ebb700bb5c15b9b27c2347c448cecc4b3c12b751e7c0493d3256fca';

async function withDatabase(run: (url: string) => Promise<void>) {
  const name = `migration_test_${randomUUID().replaceAll('-', '')}`;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  try {
    await root.query(`CREATE DATABASE ${name}`);
    await run(url.toString());
  } finally {
    await root.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await root.end();
  }
}

test('fresh and concurrent migrations apply once; runtime has data privileges without DDL', async () => {
  await withDatabase(async url => {
    const empty = new pg.Client({ connectionString: url });
    await empty.connect();
    try { await assert.rejects(assertSchemaCompatible(empty), /schema_migration_required/); }
    finally { await empty.end(); }
    await Promise.all([migrateDatabase(url, runtimePassword), migrateDatabase(url, runtimePassword)]);
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await assertSchemaCompatible(admin);
      const before = await admin.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version');
      assert.deepEqual(before.rows.map(row => row.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const indexes = await admin.query(`SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND indexname IN
          ('report_event_report_id_id_idx', 'findings_job_ready_idx') ORDER BY indexname`);
      assert.deepEqual(indexes.rows.map(row => row.indexname),
        ['findings_job_ready_idx', 'report_event_report_id_id_idx']);
      assert.match(indexes.rows[0].indexdef, /WHERE \(failed_reason IS NULL\)/);
      await migrateDatabase(url, runtimePassword);
      const after = await admin.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version');
      assert.deepEqual(after.rows, before.rows);

      const runtimeUrl = new URL(url);
      runtimeUrl.username = 'app_runtime';
      runtimeUrl.password = runtimePassword;
      const runtime = new pg.Client({ connectionString: runtimeUrl.toString() });
      await runtime.connect();
      try {
        await assertSchemaCompatible(runtime);
        assert.ok((await runtime.query('SELECT count(*) FROM rule_set')).rowCount);
        await assert.rejects(runtime.query('CREATE TABLE runtime_ddl_forbidden (id integer)'),
          (error: Error & { code?: string }) => error.code === '42501');
        const forbidden = (error: Error & { code?: string }) => error.code === '42501';
        await assert.rejects(runtime.query('DELETE FROM report_event'), forbidden);
        await assert.rejects(runtime.query("UPDATE report_event SET kind = 'created'"), forbidden);
        await assert.rejects(runtime.query('DELETE FROM report'), forbidden);
        await assert.rejects(runtime.query('UPDATE report SET publishable = true'), forbidden);
        const id = randomUUID();
        const token = randomBytes(32).toString('hex');
        const hash = createHash('sha256').update(token).digest('hex');
        await admin.query(`INSERT INTO report
          (id, token_sha256, event_type, captured_at, occurred_at, occurred_source,
           occurred_coarseness, incident_lat, incident_lon, incident_source, has_note,
           app_version, privacy_policy_version, terms_of_use_version)
          VALUES ($1, $2, 'shot', now(), now(), 'device_clock', 'exact',
            52, 21, 'moved_by_reporter', false, 'test', 'v1', 'v1')`, [id, hash]);
        await admin.query("INSERT INTO report_event (report_id, kind, details) VALUES ($1, 'excluded', '{\"reason\":\"fabricated\"}')", [id]);
        await admin.query('UPDATE report SET publishable = false WHERE id = $1', [id]);
        await admin.query("INSERT INTO report_event (report_id, kind) VALUES ($1, 'unpublished')", [id]);
        for (const kind of ['excluded', 'exclusion_lifted', 'unpublished']) {
          await assert.rejects(runtime.query('INSERT INTO report_event (report_id, kind) VALUES ($1, $2)', [id, kind]), forbidden);
        }
        await assert.rejects(runtime.query('UPDATE report SET id = $2 WHERE id = $1', [id, randomUUID()]), forbidden);
        await runtime.query('BEGIN');
        assert.equal((await runtime.query('SELECT id FROM report WHERE id = $1 FOR UPDATE', [id])).rowCount, 1);
        await runtime.query('ROLLBACK');
        await assert.rejects(runtime.query('UPDATE excluded_withdrawal_count SET total = 0'), forbidden);
        await assert.rejects(runtime.query('DELETE FROM excluded_withdrawal_count'), forbidden);
        // A malformed token is refused. A well-formed token that does not own the Report leaves it
        // in place and answers as an unknown id would (ticket 48), recording only its own tombstone.
        assert.equal((await runtime.query('SELECT withdraw_report($1, $2) AS withdrawn', [id, null])).rows[0].withdrawn, false);
        for (const candidate of [hash, randomBytes(32).toString('hex')]) {
          assert.equal((await runtime.query('SELECT withdraw_report($1, $2) AS withdrawn', [id, candidate])).rows[0].withdrawn, true);
        }
        assert.equal((await runtime.query('SELECT 1 FROM report WHERE id = $1', [id])).rowCount, 1);
        assert.equal((await runtime.query('SELECT publishable FROM report WHERE id = $1', [id])).rows[0].publishable, false);
        assert.equal((await runtime.query('SELECT withdraw_report($1, $2) AS withdrawn', [id, token])).rows[0].withdrawn, true);
        assert.equal((await runtime.query('SELECT withdraw_report($1, $2) AS withdrawn', [id, token])).rows[0].withdrawn, true);
        assert.equal((await runtime.query('SELECT 1 FROM report WHERE id = $1', [id])).rowCount, 0);
        assert.equal((await runtime.query('SELECT 1 FROM report_event WHERE report_id = $1', [id])).rowCount, 0);
        assert.equal((await runtime.query('SELECT total FROM excluded_withdrawal_count')).rows[0].total, '1');
        assert.deepEqual((await admin.query(`SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'excluded_withdrawal_count'
          ORDER BY ordinal_position`)).rows.map(row => row.column_name), ['singleton', 'total']);
        await runtime.query(`INSERT INTO rate_counter
          (ip_hash, daily_count, hourly_count, hour_start, expires_at)
          VALUES ('test-hash', 1, 1, now(), now() + interval '1 hour')`);
        await runtime.query('INSERT INTO report_withdrawal (id, token_sha256) VALUES ($1, $2)',
          [randomUUID(), 'a'.repeat(64)]);
        await admin.query("INSERT INTO geodata_snapshot (id, datasets, coverage) VALUES ('test', '[]', ST_Multi(ST_MakeEnvelope(0, 0, 1, 1, 2180)))");
        await admin.query("INSERT INTO current_geodata (snapshot_id) VALUES ('test')");
        assert.equal((await runtime.query('SELECT * FROM current_geodata c FOR SHARE OF c')).rowCount, 1);
        await assert.rejects(runtime.query("UPDATE current_geodata SET snapshot_id = 'other'"),
          (error: Error & { code?: string }) => error.code === '42501');
      } finally { await runtime.end(); }

      await admin.query("UPDATE schema_migrations SET checksum = 'changed' WHERE version = 2");
      await assert.rejects(assertSchemaCompatible(admin), /schema_migration_mismatch/);
      await admin.query('UPDATE schema_migrations SET checksum = $1 WHERE version = 2', [before.rows[1].checksum]);
      await admin.query("INSERT INTO schema_migrations (version, checksum) VALUES (17, 'future')");
      await assert.rejects(assertSchemaCompatible(admin), /schema_version_newer_than_application/);
      await assert.rejects(migrateDatabase(url, 'must-not-replace-runtime-password'),
        /schema_version_newer_than_application/);
      const stillRuntime = new pg.Client({ connectionString: runtimeUrl.toString() });
      await stillRuntime.connect();
      await stillRuntime.end();
    } finally { await admin.end(); }
  });
});

test('current untracked schema upgrades without losing Report, token, event or Findings', async () => {
  await withDatabase(async url => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      const preTicketSchema = await readFile(new URL('../server/migrations/001-baseline.sql', import.meta.url), 'utf8');
      assert.equal(createHash('sha256').update(preTicketSchema).digest('hex'), preTicketSchemaHash);
      await admin.query(preTicketSchema);
      const id = randomUUID();
      await admin.query(`INSERT INTO report
        (id, token_sha256, event_type, captured_at, occurred_at, occurred_source,
         occurred_coarseness, incident_lat, incident_lon, incident_source, has_note,
         app_version, privacy_policy_version, terms_of_use_version)
        VALUES ($1, $2, 'shot', now(), now(), 'device_clock', 'exact',
          52, 21, 'moved_by_reporter', false, 'test', 'v1', 'v1')`, [id, 'a'.repeat(64)]);
      await admin.query("INSERT INTO rule_set (id, effective_from, published_at, parameters) VALUES ('test', current_date, now(), '{}')");
      await admin.query(`INSERT INTO geodata_snapshot (id, datasets, coverage)
        VALUES ('test', '[]', ST_Multi(ST_MakeEnvelope(0, 0, 1, 1, 2180)))`);
      await admin.query("INSERT INTO report_event (report_id, kind, at) VALUES ($1, 'created', '2026-09-24T10:00:11.456Z')", [id]);
      await admin.query("INSERT INTO report_event (report_id, kind, at) VALUES ($1, 'findings_computed', '2026-09-24T12:00:41.789Z')", [id]);
      await admin.query("INSERT INTO findings (report_id, rule_set_id, geodata_snapshot_id, dwelling_distance, obwod_lowiecki, computed_at) VALUES ($1, 'test', 'test', '{}', '{}', '2026-09-24T12:00:41.789Z')", [id]);
      await admin.query('INSERT INTO findings_job (report_id) VALUES ($1)', [id]);
      await admin.query("UPDATE report SET received_at = '2026-09-24T12:00:37.123Z' WHERE id = $1", [id]);
      await admin.query("INSERT INTO report_event (report_id, kind, at) VALUES ($1, 'synced', '2026-09-24T12:00:37.123Z')", [id]);
      await migrateDatabase(url, runtimePassword);
      await assertSchemaCompatible(admin);
      assert.equal((await admin.query("SELECT to_regclass('public.report_event_report_id_id_idx') AS name")).rows[0].name,
        'report_event_report_id_id_idx');
      const preserved = await admin.query(`SELECT r.token_sha256,
        (SELECT count(*)::int FROM report_event WHERE report_id = r.id) AS events,
        (SELECT count(*)::int FROM findings WHERE report_id = r.id) AS findings,
        (SELECT count(*)::int FROM findings_job WHERE report_id = r.id) AS jobs
        FROM report r WHERE r.id = $1`, [id]);
      assert.deepEqual(preserved.rows[0], { token_sha256: 'a'.repeat(64), events: 3, findings: 1, jobs: 1 });
      const times = (await admin.query(`SELECT received_at,
        (SELECT at FROM report_event WHERE report_id = report.id AND kind = 'synced') AS synced_at,
        (SELECT count(*)::int FROM integrity_refresh WHERE report_id = report.id) AS queued
        FROM report WHERE id = $1`, [id])).rows[0];
      assert.equal(times.received_at.toISOString(), '2026-09-24T12:00:00.000Z');
      assert.equal(times.synced_at.toISOString(), '2026-09-24T12:00:00.000Z');
      assert.equal(times.queued, 1);
      const stored = await admin.query(`SELECT
        (SELECT computed_at FROM findings WHERE report_id = $1) AS computed_at,
        (SELECT at FROM report_event WHERE report_id = $1 AND kind = 'findings_computed') AS computed_event,
        (SELECT at FROM report_event WHERE report_id = $1 AND kind = 'created') AS created`, [id]);
      assert.equal(stored.rows[0].computed_at.toISOString(), '2026-09-24T12:00:00.000Z');
      assert.equal(stored.rows[0].computed_event.toISOString(), '2026-09-24T12:00:00.000Z');
      // The phone's own time on the created event is not a server time and stays as sent.
      assert.equal(stored.rows[0].created.toISOString(), '2026-09-24T10:00:11.456Z');
    } finally { await admin.end(); }
  });
});

test('failed baseline rolls back and rerun recovers after conflicting object is removed', async () => {
  await withDatabase(async url => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query('CREATE TABLE report (id integer)');
      await assert.rejects(migrateDatabase(url, runtimePassword));
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, 0);
      assert.equal((await admin.query("SELECT to_regclass('public.rule_set') AS name")).rows[0].name, null);
      await admin.query('DROP TABLE report');
      await migrateDatabase(url, runtimePassword);
      await assertSchemaCompatible(admin);
    } finally { await admin.end(); }
  });
});

test('a Rule set whose file no longer matches its stored parameters stops the migration', async () => {
  await withDatabase(async url => {
    await migrateDatabase(url, runtimePassword);
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      // Stands in for editing data/rule-sets/2019-03-01.json after it was published.
      await admin.query(`UPDATE rule_set SET parameters = jsonb_set(parameters, '{citations,noc}', '"edited"')
        WHERE id = 'pl-2019-03-01'`);
      await assert.rejects(migrateDatabase(url, runtimePassword), /rule_set_changed:pl-2019-03-01/);
    } finally { await admin.end(); }
  });
});

test('direct API startup under the runtime role refuses an edited Rule set file', async () => {
  await withDatabase(async url => {
    await migrateDatabase(url, runtimePassword);
    // The start check also needs current geodata, which a freshly migrated database does not have.
    const seed = new pg.Client({ connectionString: url });
    await seed.connect();
    try { await seedMinimalGeodata(seed); } finally { await seed.end(); }
    const directory = await mkdtemp(join(tmpdir(), 'findings-startup-'));
    const runtimeUrl = new URL(url);
    runtimeUrl.username = 'app_runtime';
    runtimeUrl.password = runtimePassword;
    try {
      for (const path of ['server', 'src', 'data', 'package.json']) {
        await cp(new URL(`../${path}`, import.meta.url), join(directory, path), { recursive: true });
      }
      await symlink(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir');
      const start = () => promisify(execFile)(process.execPath, ['--import', 'tsx', 'server/main.ts'], {
        cwd: directory, env: { ...process.env, DATABASE_URL: runtimeUrl.toString(), PORT: '0' }, timeout: 2000
      });
      // An unchanged build stays running; startup must not require Rule set write privileges.
      const started = Date.now();
      await start();
      assert.ok(Date.now() - started >= 1900);
      const file = join(directory, 'data/rule-sets/2019-03-01.json');
      const rule = JSON.parse(await readFile(file, 'utf8'));
      rule.citations.noc = 'edited';
      await writeFile(file, JSON.stringify(rule));
      await assert.rejects(start(), (error: Error & { stderr?: string; killed?: boolean }) =>
        !error.killed && /Start refused: rule_set_changed\./.test(error.stderr ?? ''));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test('a migration file missing from the runner list stops the migration', async () => {
  const unlisted = new URL('../server/migrations/999-unlisted-test.sql', import.meta.url);
  await writeFile(unlisted, 'SELECT 1;\n');
  try {
    await withDatabase(async url => {
      await assert.rejects(migrateDatabase(url, runtimePassword), /migration_list_mismatch/);
    });
  } finally { await rm(unlisted, { force: true }); }
});

test('isolated demo migration owner needs no role administration and runtime cannot forge operator events', async () => {
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  const owner = `demo_owner_test_${randomBytes(8).toString('hex')}`;
  const ownerPassword = randomBytes(24).toString('hex');
  const demoPassword = randomBytes(24).toString('hex');
  let createdOwner = false;
  let createdRuntime = false;
  try {
    const createRuntime = await root.query("SELECT format('CREATE ROLE bor_czuwa_demo_runtime LOGIN NOINHERIT PASSWORD %L', $1::text) AS sql", [demoPassword]);
    await root.query(createRuntime.rows[0].sql);
    createdRuntime = true;
    const createOwner = await root.query("SELECT format('CREATE ROLE %I LOGIN NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS sql", [owner, ownerPassword]);
    await root.query(createOwner.rows[0].sql);
    createdOwner = true;
    await withDatabase(async url => {
      const admin = new pg.Client({ connectionString: url });
      await admin.connect();
      try {
        await admin.query('CREATE EXTENSION postgis');
        const name = new URL(url).pathname.slice(1);
        await admin.query(`ALTER DATABASE ${name} OWNER TO ${owner}`);
        const ownerUrl = new URL(url);
        ownerUrl.username = owner;
        ownerUrl.password = ownerPassword;
        await migrateDatabase(ownerUrl.toString(), demoPassword, 'bor_czuwa_demo_runtime');
        await migrateDatabase(ownerUrl.toString(), demoPassword, 'bor_czuwa_demo_runtime');
        const runtimeUrl = new URL(url);
        runtimeUrl.username = 'bor_czuwa_demo_runtime';
        runtimeUrl.password = demoPassword;
        const runtime = new pg.Client({ connectionString: runtimeUrl.toString() });
        await runtime.connect();
        try {
          await assertSchemaCompatible(runtime, 'bor_czuwa_demo_runtime');
          await assert.rejects(assertSchemaCompatible(runtime, 'app_runtime'), /schema_migration_mismatch/);
          await assert.rejects(runtime.query('CREATE TABLE forbidden_demo_ddl (id integer)'),
            (error: Error & { code?: string }) => error.code === '42501');
          const id = randomUUID();
          const hash = createHash('sha256').update(randomBytes(32)).digest('hex');
          await admin.query(`INSERT INTO report
            (id, token_sha256, event_type, captured_at, occurred_at, occurred_source,
             occurred_coarseness, incident_lat, incident_lon, incident_source, has_note,
             app_version, privacy_policy_version, terms_of_use_version)
            VALUES ($1, $2, 'shot', now(), now(), 'device_clock', 'exact',
              52, 21, 'moved_by_reporter', false, 'test', 'v1', 'v1')`, [id, hash]);
          for (const kind of ['excluded', 'exclusion_lifted', 'unpublished']) {
            await assert.rejects(runtime.query('INSERT INTO report_event (report_id, kind) VALUES ($1, $2)', [id, kind]),
              (error: Error & { code?: string }) => error.code === '42501');
          }
          await runtime.query("INSERT INTO report_event (report_id, kind) VALUES ($1, 'created')", [id]);
          assert.equal((await runtime.query('SELECT kind FROM report_event WHERE report_id = $1', [id])).rows[0].kind, 'created');
          await admin.query("INSERT INTO rule_set (id, effective_from, published_at, parameters) VALUES ('test', current_date, now(), '{}')");
          await admin.query(`INSERT INTO geodata_snapshot (id, datasets, coverage)
            VALUES ('test', '[]', ST_Multi(ST_MakeEnvelope(0, 0, 1, 1, 2180)))`);
          await runtime.query(`INSERT INTO findings (report_id, rule_set_id, geodata_snapshot_id, dwelling_distance, obwod_lowiecki)
            VALUES ($1, 'test', 'test', '{}', '{}')`, [id]);
          for (const statement of ['UPDATE findings SET accuracy_m = 1', 'DELETE FROM findings']) {
            await assert.rejects(runtime.query(statement), (error: Error & { code?: string }) => error.code === '42501');
          }
          await assert.rejects(runtime.query(`INSERT INTO findings (report_id, rule_set_id, geodata_snapshot_id, dwelling_distance, obwod_lowiecki)
            VALUES ($1, 'test', 'test', '{}', '{}')`, [id]), (error: Error & { code?: string }) => error.code === '23505');
          const productionGrant = await admin.query(`SELECT has_table_privilege(oid, 'public.report', 'SELECT') AS allowed
            FROM pg_roles WHERE rolname = 'app_runtime'`);
          assert.equal(productionGrant.rows[0]?.allowed ?? false, false);
        } finally { await runtime.end(); }
      } finally { await admin.end(); }
    });
  } finally {
    if (createdRuntime) await root.query('DROP ROLE bor_czuwa_demo_runtime');
    if (createdOwner) await root.query(`DROP ROLE ${owner}`);
    await root.end();
  }
});

async function seedReportWithFindings(admin: pg.Client) {
  const id = randomUUID();
  await admin.query(`INSERT INTO report
    (id, token_sha256, event_type, captured_at, occurred_at, occurred_source,
     occurred_coarseness, incident_lat, incident_lon, incident_source, has_note,
     app_version, privacy_policy_version, terms_of_use_version)
    VALUES ($1, $2, 'shot', now(), now(), 'device_clock', 'exact',
      52, 21, 'moved_by_reporter', false, 'test', 'v1', 'v1')`, [id, randomBytes(32).toString('hex')]);
  await admin.query("INSERT INTO rule_set (id, effective_from, published_at, parameters) VALUES ('test', current_date, now(), '{}') ON CONFLICT DO NOTHING");
  await admin.query(`INSERT INTO geodata_snapshot (id, datasets, coverage)
    VALUES ('test', '[]', ST_Multi(ST_MakeEnvelope(0, 0, 1, 1, 2180))) ON CONFLICT DO NOTHING`);
  return id;
}

const insertFinding = `INSERT INTO findings (report_id, rule_set_id, geodata_snapshot_id, dwelling_distance, obwod_lowiecki, computed_at)
  VALUES ($1, 'test', 'test', '{}', '{}', $2)`;

// A database exactly as migration 013 left it: 001 to 013 applied and recorded in the ledger.
async function migrateToThirteen(admin: pg.Client) {
  await admin.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
    THEN CREATE ROLE app_runtime LOGIN; END IF; END $$`);
  await admin.query(`CREATE TABLE schema_migrations (
    version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const directory = new URL('../server/migrations/', import.meta.url);
  const names = (await readdir(directory)).filter(name => name.endsWith('.sql') && name < '014').sort();
  assert.equal(names.length, 13);
  for (const [index, name] of names.entries()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    await admin.query(sql);
    await admin.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
      [index + 1, createHash('sha256').update(sql).digest('hex')]);
  }
}

test('upgrading a 013 database floors fine server times, leaves the phone time and keeps every row', async () => {
  await withDatabase(async url => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await migrateToThirteen(admin);
      const id = await seedReportWithFindings(admin);
      await admin.query(insertFinding, [id, '2026-09-24T12:00:41.789Z']);
      for (const [kind, at] of [['created', '2026-09-24T10:00:11.456Z'], ['findings_computed', '2026-09-24T12:00:41.789Z'],
        ['findings_failed', '2026-09-24T12:01:42.5Z'], ['excluded', '2026-09-24T12:02:43.25Z'],
        ['exclusion_lifted', '2026-09-24T12:03:44.5Z'], ['unpublished', '2026-09-24T12:04:45.75Z']]) {
        await admin.query('INSERT INTO report_event (report_id, kind, at) VALUES ($1, $2, $3)', [id, kind, at]);
      }
      const gone = randomUUID();
      await admin.query("INSERT INTO report_withdrawal (id, token_sha256, withdrawn_at) VALUES ($1, $2, '2026-09-24T12:00:59.999Z')",
        [gone, randomBytes(32).toString('hex')]);
      const counts = async () => (await admin.query(`SELECT (SELECT count(*) FROM findings) AS f,
        (SELECT count(*) FROM report_event) AS e, (SELECT count(*) FROM report_withdrawal) AS w,
        (SELECT count(*) FROM schema_migrations) AS m`)).rows[0];
      const before = await counts();
      assert.equal(before.m, '13');
      await migrateDatabase(url, runtimePassword);
      await assertSchemaCompatible(admin);
      assert.deepEqual(await counts(), { ...before, m: '16' });
      assert.deepEqual((await admin.query("SELECT indexname FROM pg_indexes WHERE tablename = 'findings' AND indexname LIKE 'findings_report%' ORDER BY 1")).rows.map(row => row.indexname), ['findings_report_id_key']);
      const read = async (sql: string, ...args: unknown[]) => (await admin.query(sql, args)).rows[0].at.toISOString();
      assert.equal(await read('SELECT computed_at AS at FROM findings WHERE report_id = $1', id), '2026-09-24T12:00:00.000Z');
      assert.equal(await read("SELECT at FROM report_event WHERE report_id = $1 AND kind = 'findings_computed'", id), '2026-09-24T12:00:00.000Z');
      assert.equal(await read("SELECT at FROM report_event WHERE report_id = $1 AND kind = 'findings_failed'", id), '2026-09-24T12:01:00.000Z');
      for (const [kind, minute] of [['excluded', '12:02'], ['exclusion_lifted', '12:03'], ['unpublished', '12:04']]) {
        assert.equal(await read('SELECT at FROM report_event WHERE report_id = $1 AND kind = $2', id, kind), `2026-09-24T${minute}:00.000Z`);
      }
      assert.equal(await read('SELECT withdrawn_at AS at FROM report_withdrawal WHERE id = $1', gone), '2026-09-24T12:00:00.000Z');
      assert.equal(await read("SELECT at FROM report_event WHERE report_id = $1 AND kind = 'created'", id), '2026-09-24T10:00:11.456Z');
    } finally { await admin.end(); }
  });
});

test('a database holding two Findings rows for one Report stops migration 014 and changes nothing', async () => {
  await withDatabase(async url => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try {
      await admin.query(await readFile(new URL('../server/migrations/001-baseline.sql', import.meta.url), 'utf8'));
      const id = await seedReportWithFindings(admin);
      await admin.query(insertFinding, [id, '2026-09-24T12:00:41.789Z']);
      await admin.query(insertFinding, [id, '2026-09-24T12:00:42.789Z']);
      await assert.rejects(migrateDatabase(url, runtimePassword), /findings_duplicate_report_rows/);
      assert.equal((await admin.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 13);
      const rows = (await admin.query('SELECT computed_at FROM findings ORDER BY computed_at')).rows;
      assert.deepEqual(rows.map(row => row.computed_at.toISOString()), ['2026-09-24T12:00:41.789Z', '2026-09-24T12:00:42.789Z']);
      assert.equal((await admin.query("SELECT to_regclass('public.findings_report_id_key') AS name")).rows[0].name, null);
    } finally { await admin.end(); }
  });
});
