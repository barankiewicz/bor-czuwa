import pg from 'pg';
import { assertStartupCompatible, refusalToken, startupRefusals } from '../../server/startup-check.ts';

let database: pg.Client | undefined;
try {
  // Built inside the try: an unparsable URL throws here, and must be a fixed refusal, not a stack trace.
  database = new pg.Client({ connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000, statement_timeout: 10_000 });
  await database.connect();
  await assertStartupCompatible(database);
} catch (error) {
  // The same check the API runs at start. Only the fixed token is printed, never the exception.
  const token = refusalToken(error);
  console.error(`Database check refused: ${token}.`);
  process.exitCode = startupRefusals[token].exit;
} finally {
  await database?.end().catch(() => {});
}
