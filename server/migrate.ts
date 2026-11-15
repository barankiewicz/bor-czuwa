import { failureClass } from './failure-class.ts';
import { migrateDatabase } from './migrations.ts';

try {
  if (!process.env.MIGRATION_DATABASE_URL) throw new Error('MIGRATION_DATABASE_URL is required');
  if (!process.env.RUNTIME_DB_PASSWORD) throw new Error('RUNTIME_DB_PASSWORD is required');
  await migrateDatabase(process.env.MIGRATION_DATABASE_URL, process.env.RUNTIME_DB_PASSWORD);
} catch (error) {
  console.error(error);
  // activate.sh reports this token alone, never the message text.
  console.error(`Failure class: ${failureClass(error)}`);
  process.exit(1);
}
