import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { loadRuleSets } from './db.ts';

const files = ['001-baseline.sql', '002-runtime-grants.sql', '003-worker-snapshot-lock.sql',
  '004-report-withdrawal.sql', '005-query-indexes.sql', '006-hearing-bearing.sql',
  '007-integrity-refresh.sql', '008-reporter-sized-areas.sql', '009-sighting-estimates.sql',
  '010-worker-failure-diagnostics.sql', '011-minute-receive-times.sql',
  '012-excluded-withdrawal-count.sql', '013-area-findings-shape.sql',
  '014-coarse-times-findings-lock.sql', '015-five-km-estimates.sql',
  '016-withdrawal-binds-token.sql', '017-bounded-integrity-graph.sql'] as const;
const lockId = 26092703;

function validateRuntimeRole(role: string) {
  if (role !== 'app_runtime' && role !== 'bor_czuwa_demo_runtime') {
    throw new Error('unsupported_runtime_role');
  }
}

async function expectedMigrations(runtimeRole = process.env.RUNTIME_DB_ROLE ?? 'app_runtime') {
  validateRuntimeRole(runtimeRole);
  // A new SQL file left out of the list would otherwise be skipped without a word.
  const present = (await readdir(new URL('./migrations/', import.meta.url))).filter(file => file.endsWith('.sql')).sort();
  if (present.join('\n') !== files.join('\n')) throw new Error('migration_list_mismatch');
  return Promise.all(files.map(async (file, index) => {
    const source = await readFile(new URL(`./migrations/${file}`, import.meta.url), 'utf8');
    // Keep applied production history byte-identical. Demo ledgers bind the exact
    // rendered role-specific SQL, including grants and operator-event protection.
    const sql = runtimeRole === 'app_runtime' ? source : source.replace(/\bapp_runtime\b/g, runtimeRole);
    return { version: index + 1, checksum: createHash('sha256').update(sql).digest('hex'), sql };
  }));
}

async function appliedMigrations(database: Pick<pg.Client, 'query'>) {
  const result = await database.query('SELECT version, checksum FROM public.schema_migrations ORDER BY version')
    .catch(error => {
      if ((error as { code?: string }).code === '42P01') throw new Error('schema_migration_required');
      throw error;
    });
  return result.rows as { version: number; checksum: string }[];
}

function checkVersions(applied: { version: number; checksum: string }[],
  expected: Awaited<ReturnType<typeof expectedMigrations>>, complete: boolean) {
  if (applied.length > expected.length) throw new Error('schema_version_newer_than_application');
  for (const [index, row] of applied.entries()) {
    if (row.version !== expected[index].version || row.checksum !== expected[index].checksum) {
      throw new Error('schema_migration_mismatch');
    }
  }
  if (complete && applied.length !== expected.length) throw new Error('schema_migration_required');
}

export async function assertSchemaCompatible(database: Pick<pg.Pool, 'query'>,
  runtimeRole = process.env.RUNTIME_DB_ROLE ?? 'app_runtime') {
  const expected = await expectedMigrations(runtimeRole);
  const applied = await appliedMigrations(database);
  checkVersions(applied, expected, true);
}

export async function migrateDatabase(connectionString: string, runtimePassword: string,
  runtimeRole = process.env.RUNTIME_DB_ROLE ?? 'app_runtime') {
  validateRuntimeRole(runtimeRole);
  if (!runtimePassword) throw new Error('RUNTIME_DB_PASSWORD is required');
  let client: pg.Client | undefined;
  for (let attempt = 0; attempt < 10; attempt++) {
    const candidate = new pg.Client({
      connectionString,
      connectionTimeoutMillis: 30_000,
      statement_timeout: 30 * 60_000,
      query_timeout: 31 * 60_000,
      lock_timeout: 30_000,
      idle_in_transaction_session_timeout: 10 * 60_000
    });
    try {
      await candidate.connect();
      client = candidate;
      break;
    } catch (error) {
      await candidate.end().catch(() => {});
      if ((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED' || attempt === 9) throw error;
      await setTimeout(1000);
    }
  }
  if (!client) throw new Error('migration_database_unavailable');
  try {
    await client.query('SET search_path TO public');
    await client.query('SELECT pg_advisory_lock($1)', [lockId]);
    const expected = await expectedMigrations(runtimeRole);
    let applied: { version: number; checksum: string }[];
    await client.query('BEGIN');
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      applied = await appliedMigrations(client);
      checkVersions(applied, expected, false);
      if (runtimeRole === 'app_runtime') {
        await client.query(`DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
            CREATE ROLE app_runtime LOGIN;
          ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime'
            AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
            RAISE EXCEPTION 'runtime_role_requires_provisioning';
          END IF;
        END $$`);
        // Provisioning owns privileged attributes; the owner only manages runtime login.
        await client.query('ALTER ROLE app_runtime LOGIN NOINHERIT');
        const password = await client.query("SELECT format('ALTER ROLE app_runtime PASSWORD %L', $1::text) AS sql", [runtimePassword]);
        await client.query(password.rows[0].sql);
      } else {
        // Root bootstrap owns the isolated login and password. Its maintenance
        // owner does not need cluster-wide CREATEROLE or role administration.
        const role = await client.query(`SELECT rolcanlogin, rolinherit, rolsuper,
          rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
          FROM pg_roles WHERE rolname = $1`, [runtimeRole]);
        const attributes = role.rows[0];
        if (!attributes?.rolcanlogin || attributes.rolinherit || attributes.rolsuper
          || attributes.rolcreatedb || attributes.rolcreaterole
          || attributes.rolreplication || attributes.rolbypassrls) {
          throw new Error('runtime_role_requires_provisioning');
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    for (const migration of expected.slice(applied.length)) {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
          [migration.version, migration.checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    await loadRuleSets(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => {});
    await client.end();
  }
}
