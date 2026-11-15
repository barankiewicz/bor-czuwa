import type pg from 'pg';
import { assertRuleSetsCompatible } from './db.ts';
import { assertSchemaCompatible } from './migrations.ts';

type Database = Pick<pg.Pool, 'query'>;

// One row per way a start can be refused. The exit status carries the token to the host:
// systemd passes it to ExecStopPost as $EXIT_STATUS, and ops/production/startup_refusals.py
// holds the same table (a test compares the two). `retry` marks the causes that can clear
// by themselves, so the unit keeps restarting for those and stops for the rest.
export const startupRefusals = {
  ledger_checksum_mismatch: { exit: 80, retry: false, text: 'An applied migration differs from this release.' },
  ledger_newer_than_application: { exit: 81, retry: false, text: 'The database was migrated by a newer release.' },
  migration_required: { exit: 82, retry: false, text: 'This release has migrations the database does not have yet.' },
  ledger_missing: { exit: 83, retry: false, text: 'The database has no migration ledger.' },
  rule_set_changed: { exit: 84, retry: false, text: 'A stored Rule set differs from the one this release ships.' },
  geodata_missing: { exit: 85, retry: false, text: 'No current geodata is recorded.' },
  geodata_schema_missing: { exit: 86, retry: false, text: 'The current geodata schema, or a table or column it needs, is gone.' },
  geodata_rebuild_required: { exit: 87, retry: false, text: 'The geodata uses an old storage layout and must be rebuilt.' },
  geodata_empty: { exit: 88, retry: false, text: 'The current geodata holds no dwellings or no recipient areas.' },
  migration_list_mismatch: { exit: 89, retry: false, text: 'The migration files in this release do not match its list.' },
  unsupported_runtime_role: { exit: 90, retry: false, text: 'The configured runtime role is not one this release supports.' },
  schema_incomplete: { exit: 96, retry: false, text: 'A table or column this release needs is missing from the database.' },
  database_url_invalid: { exit: 97, retry: false, text: 'The database address in the runtime settings is not a valid URL.' },
  database_auth_failed: { exit: 91, retry: false, text: 'The database refused the runtime login; check the runtime password.' },
  database_missing: { exit: 92, retry: false, text: 'The database named in the runtime settings does not exist.' },
  database_permission_denied: { exit: 93, retry: false, text: 'The runtime role lacks a grant this release needs.' },
  database_unavailable: { exit: 94, retry: true, text: 'The database could not be reached.' },
  unknown: { exit: 95, retry: true, text: 'The cause is not one of the known classes.' }
} as const;

export type StartupRefusalToken = keyof typeof startupRefusals;

export class StartupRefused extends Error {
  constructor(readonly token: StartupRefusalToken) { super(token); }
}

const connectionCodes = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  '57P01', '57P02', '57P03', '53300']);

// Only a fixed token ever leaves this function, never the exception's text.
export function refusalToken(error: unknown): StartupRefusalToken {
  if (error instanceof StartupRefused) return error.token;
  const message = error instanceof Error ? error.message : '';
  if (message === 'schema_migration_mismatch') return 'ledger_checksum_mismatch';
  if (message === 'schema_version_newer_than_application') return 'ledger_newer_than_application';
  if (message === 'schema_migration_required') return 'migration_required';
  if (message.startsWith('rule_set_changed:')) return 'rule_set_changed';
  if (message === 'migration_list_mismatch') return 'migration_list_mismatch';
  if (message === 'unsupported_runtime_role') return 'unsupported_runtime_role';
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  // Configuration faults a restart cannot cure: a wrong login, a missing database, a missing grant.
  if (code === '28P01' || code === '28000') return 'database_auth_failed';
  if (code === 'ERR_INVALID_URL') return 'database_url_invalid';
  if (code === '3D000') return 'database_missing';
  if (code === '42501') return 'database_permission_denied';
  if (code === '42P01' || code === '42703') return 'schema_incomplete';
  if (connectionCodes.has(code) || /timeout|terminated unexpectedly/i.test(message)) return 'database_unavailable';
  return 'unknown';
}

export function refusalLine(token: StartupRefusalToken) {
  return `Start refused: ${token}. ${startupRefusals[token].text} The API was not started.`;
}

const geodataTables = ['dwelling', 'obwod_lowiecki', 'protected_area', 'recipient_jurisdiction', 'ambona'];
// The columns Findings reads from each snapshot table (server/findings.ts) and recipient lookup reads from the
// public tables (server/recipient-lookup.ts, operator.ts); geom must be a geometry. tests/startup-columns.test.ts
// derives the columns those queries use and fails if one is missing here.
export const requiredGeodataColumns: Record<string, string[]> = {
  dwelling: ['geom'], obwod_lowiecki: ['objectid', 'number', 'source_year', 'geom'], ambona: ['osm_id', 'geom'],
  protected_area: ['kind', 'inspire_id', 'name', 'parent_kind', 'document_state', 'documents', 'geom']
};
export const requiredRecipientColumns: Record<string, string[]> = {
  recipient_jurisdiction: ['snapshot_id', 'kind', 'unit_id', 'name', 'geom'], recipient_dataset: ['snapshot_id', 'sources']
};

async function assertColumns(database: Database, relation: string, columns: string[]) {
  const found = await database.query(`SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
    FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`, [relation]);
  const types = new Map<string, string>(found.rows.map((row: { name: string; type: string }) => [row.name, row.type]));
  for (const column of columns) {
    const type = types.get(column);
    if (type === undefined || (column === 'geom' && !type.startsWith('geometry'))) throw new StartupRefused('geodata_schema_missing');
  }
}

// The storage schemas the API answers from. `queuedJobs` adds the snapshots that unfinished
// Findings jobs are pinned to, which the start check also needs and the readiness probe does not.
export async function assertGeodataUsable(database: Database, queuedJobs: boolean) {
  const current = await database.query('SELECT 1 FROM current_geodata LIMIT 1');
  if (!current.rowCount) throw new StartupRefused('geodata_missing');
  const snapshots = await database.query(`SELECT DISTINCT s.storage_schema FROM geodata_snapshot s
    WHERE s.id IN (SELECT snapshot_id FROM current_geodata
      ${queuedJobs ? 'UNION SELECT geodata_snapshot_id FROM findings_job WHERE failed_reason IS NULL' : ''})`);
  for (const { storage_schema: schema } of snapshots.rows) {
    if (!/^geo_[a-f0-9]{20}$/.test(schema ?? '')) throw new StartupRefused('geodata_rebuild_required');
    try {
      for (const table of geodataTables) await database.query(`SELECT 1 FROM ${schema}.${table} LIMIT 1`);
      const populated = await database.query(`SELECT 1 FROM ${schema}.dwelling LIMIT 1`);
      if (!populated.rowCount) throw new StartupRefused('geodata_empty');
      for (const [table, columns] of Object.entries(requiredGeodataColumns)) await assertColumns(database, `${schema}.${table}`, columns);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '3F000' || code === '42P01') throw new StartupRefused('geodata_schema_missing');
      throw error;
    }
  }
  // Recipient lookup answers from these two tables for the current snapshot.
  for (const [table, columns] of Object.entries(requiredRecipientColumns)) await assertColumns(database, `public.${table}`, columns);
  const recipients = await database.query(`SELECT 1 FROM current_geodata c
    JOIN recipient_dataset d ON d.snapshot_id = c.snapshot_id
    WHERE EXISTS (SELECT 1 FROM recipient_jurisdiction j WHERE j.snapshot_id = c.snapshot_id) LIMIT 1`);
  if (!recipients.rowCount) throw new StartupRefused('geodata_empty');
}

// The one check both the API's start and the rollback pre-check run, so they cannot drift.
export async function assertStartupCompatible(database: Database) {
  const ledger = await database.query("SELECT to_regclass('public.schema_migrations') AS ledger");
  if (!ledger.rows[0].ledger) throw new StartupRefused('ledger_missing');
  await assertSchemaCompatible(database);
  await assertRuleSetsCompatible(database);
  await assertGeodataUsable(database, true);
}

// /api/ready asks this on every poll. A few seconds of memory keep health polling from
// running the geodata probe against PostGIS each time.
// The default clock is monotonic: a wall clock set back would keep an old answer alive.
export function geodataReadiness(database: Database, now: () => number = () => performance.now(), ttlMs = 5000) {
  let cached: { at: number; ready: boolean } | undefined;
  return async () => {
    // A clock that went backwards makes the age negative; that answer is not trusted.
    if (cached && now() - cached.at >= 0 && now() - cached.at < ttlMs) return cached.ready;
    let ready = true;
    try { await assertGeodataUsable(database, false); }
    catch (error) { if (!(error instanceof StartupRefused)) throw error; ready = false; }
    cached = { at: now(), ready };
    return ready;
  };
}
