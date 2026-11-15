import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';
import { migrateDatabase } from '../../server/migrations.ts';
import { testDatabaseUrl } from './test-database.ts';

// Each clock owns its database and API process. Live workers cannot consume its jobs or counters.
export async function startClockedApi(now: number) {
  const name = `clock_test_${randomUUID().replaceAll('-', '')}`;
  const owner = new pg.Client({ connectionString: testDatabaseUrl() });
  await owner.connect();
  const url = new URL(testDatabaseUrl());
  url.pathname = `/${name}`;
  const database = new pg.Client({ connectionString: url.toString() });
  let child: ChildProcess | undefined;
  let exited: Promise<unknown[]> | undefined;
  async function close() {
    try {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const timeout = setTimeout(() => child!.kill('SIGKILL'), 5000);
        try {
          const [code, signal] = await exited!;
          if (code !== 0) throw new Error(`Clocked API exited with ${code ?? signal}`);
        } finally { clearTimeout(timeout); }
      }
    } finally {
      try {
        await database.end();
        await owner.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally { await owner.end(); }
    }
  }
  try {
    await owner.query(`CREATE DATABASE ${name}`);
    const password = process.env.RUNTIME_DB_PASSWORD ?? 'runtime-local-only';
    await migrateDatabase(url.toString(), password);
    await database.connect();
    url.username = 'app_runtime';
    url.password = password;
    child = fork(new URL('./clocked-api-process.ts', import.meta.url), [], {
      execArgv: ['--import', 'tsx'],
      env: { ...process.env, DATABASE_URL: url.toString(), TEST_CLOCK_NOW: String(now) },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc']
    });
    exited = once(child, 'exit');
    async function reply() {
      const [value] = await Promise.race([
        once(child!, 'message', { signal: AbortSignal.timeout(15_000) }),
        exited!.then(([code, signal]) => { throw new Error(`Clocked API exited with ${code ?? signal}`); })
      ]);
      return value;
    }
    const base = await reply() as string;
    return { base, database, close, async setTime(value: number) {
      const acknowledged = reply();
      child!.send(value);
      if (await acknowledged !== value) throw new Error('Clocked API did not acknowledge its clock');
    } };
  } catch (error) {
    await close();
    throw error;
  }
}
