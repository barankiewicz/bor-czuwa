/** Removes Reports the way a restore from an older backup would: every row that names them,
 * then the Reports themselves, and no Withdrawal tombstone. Disposable test databases only.
 * `database` must be one connection (a Client), because the removal is one transaction. */
type Connection = { query(text: string, values?: unknown[]): Promise<unknown> };

async function removeOnce(database: Connection, ids: string[]) {
  await database.query('BEGIN');
  try {
    // The integrity loop inserts integrity_signal and integrity_refresh rows for a Report, and those inserts take
    // a KEY SHARE lock on the report row. Locking the Reports first makes a concurrent insert either finish before
    // the children are deleted or wait and then fail its own foreign key, never land between the child deletes and the
    // Report delete.
    await database.query('SELECT id FROM report WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
    for (const table of ['integrity_refresh', 'integrity_signal', 'findings_job', 'findings', 'report_event']) {
      await database.query(`DELETE FROM ${table} WHERE report_id = ANY($1::uuid[])`, [ids]);
    }
    await database.query('DELETE FROM report WHERE id = ANY($1::uuid[])', [ids]);
    await database.query('COMMIT');
  } catch (error) {
    await database.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function loseReports(database: Connection, ids: string[]) {
  // A worker holds a child row (findings_job, integrity_refresh) and then needs the Report row, while this holds the
  // Report row and then needs the child row. Postgres ends such a cycle by aborting one side with 40P01; when that
  // is this side, the whole transaction, Report lock included, is retried.
  for (let attempt = 1; ; attempt++) {
    try { return await removeOnce(database, ids); }
    catch (error) {
      if ((error as { code?: string }).code !== '40P01' || attempt >= 5) throw error;
    }
  }
}
