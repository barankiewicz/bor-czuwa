import pg from 'pg';
import { loadRuleSets } from './db.ts';

if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.MIGRATION_DATABASE_URL,
  connectionTimeoutMillis: 30_000, statement_timeout: 30 * 60_000, query_timeout: 31 * 60_000,
  lock_timeout: 30_000, idle_in_transaction_session_timeout: 10 * 60_000 });
try {
  await loadRuleSets(pool);
} finally {
  await pool.end();
}
