import type { Pool } from 'pg';

/**
 * Removes Reports a test flooded in while the real Findings and Integrity workers are still draining them.
 *
 * One transaction per Report, and a Report is never waited on while this transaction holds anything else:
 * 1. Delete the Findings job first. A worker that claimed it holds the row until its writes commit, so this
 *    waits that worker out while holding no lock the worker could need.
 * 2. Lock the Report row FOR UPDATE, which waits out any worker holding a foreign-key share on it and makes
 *    later foreign-key checks wait for this transaction. It is again taken while holding nothing a worker needs.
 * 3. Delete the rest of the Report's rows.
 * Deleting every Report in one transaction instead held earlier Reports' rows while waiting for later ones, and
 * an Integrity worker expanding neighbours (an INSERT into integrity_refresh for each matching Report) held a
 * share on a later Report while waiting for an earlier one: PostgreSQL error 40P01.
 */
export async function removeFlood(pool: Pool, ids: string[]) {
  for (const id of ids) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM findings_job WHERE report_id = $1', [id]);
      await client.query('SELECT 1 FROM report WHERE id = $1 FOR UPDATE', [id]);
      for (const table of ['findings', 'report_event', 'integrity_signal', 'integrity_refresh'])
        await client.query(`DELETE FROM ${table} WHERE report_id = $1`, [id]);
      await client.query('DELETE FROM report WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}
