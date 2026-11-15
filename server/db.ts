import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { workerStatus } from './worker-status.ts';

const connectionFailureCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNTERMINATED', 'EPIPE', '57P01', '57P02', '57P03']);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  connectionTimeoutMillis: 5000,
  statement_timeout: 10_000,
  lock_timeout: 3000,
  idle_in_transaction_session_timeout: 15_000
});

pool.on('error', () => {
  noteDatabaseFailure();
  console.error('Idle database connection failed; pool will reconnect.');
});

// The pool's own 'error' listener covers idle clients only. Without one, a client that loses its
// connection while checked out emits an unhandled 'error' and ends the process; its query still rejects.
pool.on('connect', client => {
  client.on('error', () => {
    noteDatabaseFailure();
    console.error('Database connection failed; pool will reconnect.');
  });
  if (!workerStatus.awaitingDatabaseRecovery) return;
  workerStatus.awaitingDatabaseRecovery = false;
  workerStatus.databaseRecoveryCount++;
});

export function noteDatabaseFailure(error?: unknown) {
  if (error === undefined) {
    workerStatus.awaitingDatabaseRecovery = true;
    return;
  }
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code !== undefined && connectionFailureCodes.has(String(code))) {
    workerStatus.awaitingDatabaseRecovery = true;
  }
}

async function ruleSetsFromFiles() {
  const directory = new URL('../data/rule-sets/', import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith('.json')).sort();
  return Promise.all(files.map(async file =>
    JSON.parse(await readFile(new URL(file, directory), 'utf8'))));
}

async function assertStoredRuleSet(database: Pick<pg.PoolClient, 'query'>, rule: { id: string }) {
  // Findings name the Rule set that produced them, so a published one never changes under its id.
  const { rows: [stored] } = await database.query('SELECT parameters = $2::jsonb AS same FROM rule_set WHERE id = $1',
    [rule.id, rule]);
  if (!stored?.same) throw new Error(`rule_set_changed:${rule.id}`);
}

export async function assertRuleSetsCompatible(database: Pick<pg.PoolClient, 'query'> = pool) {
  for (const rule of await ruleSetsFromFiles()) await assertStoredRuleSet(database, rule);
}

export async function loadRuleSets(database: Pick<pg.PoolClient, 'query'> = pool) {
  for (const rule of await ruleSetsFromFiles()) {
    await database.query(`INSERT INTO rule_set (id, effective_from, published_at, parameters)
      VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [rule.id, rule.effective_from, rule.published_at, rule]);
    await assertStoredRuleSet(database, rule);
  }
}
