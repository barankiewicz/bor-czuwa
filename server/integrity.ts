import { failureClass } from './failure-class.ts';
import type { Pool, PoolClient } from 'pg';

export async function queueIntegrityRefresh(db: Pool | PoolClient, reportId: string) {
  await db.query(`INSERT INTO integrity_refresh (report_id, expand_neighbors) VALUES ($1, true)
    ON CONFLICT (report_id) DO UPDATE SET requested_at = now(), available_at = now(),
      attempts = 0, failed_reason = NULL, error_class = NULL, failure_step = NULL, expand_neighbors = true,
      generation = integrity_refresh.generation + 1, lease_until = NULL`, [reportId]);
}

export async function queueIntegrityNeighbors(db: Pool | PoolClient, reportId: string) {
  // A pending row is locked by ON CONFLICT until this transaction commits.
  await db.query(`INSERT INTO integrity_refresh (report_id, requested_at)
    SELECT report_id, now() FROM integrity_affected($1) WHERE report_id <> $1
    ON CONFLICT (report_id) DO UPDATE SET requested_at = now(), available_at = now(),
      attempts = 0, failed_reason = NULL, error_class = NULL, failure_step = NULL,
      generation = integrity_refresh.generation + 1, lease_until = NULL
    WHERE integrity_refresh.lease_until IS NOT NULL OR integrity_refresh.failed_reason IS NOT NULL`, [reportId]);
}

export async function computeIntegritySignals(db: Pool | PoolClient, reportId: string) {
  // One match beyond the cap is fetched only to learn that the list was clipped.
  await db.query(`WITH fetched AS MATERIALIZED (SELECT * FROM integrity_matches_limited($1, integrity_cap() + 1)),
      kept AS (SELECT * FROM fetched ORDER BY gap, report_id LIMIT integrity_cap()),
      counts AS (
      SELECT $1::uuid AS report_id,
        count(*) FILTER (WHERE duplicate_point)::int AS duplicate_point_count,
        count(*) FILTER (WHERE burst)::int AS burst_count,
        count(*) FILTER (WHERE duplicate_photo)::int AS duplicate_photo_count,
        (SELECT count(*) FROM fetched) > integrity_cap() AS matches_clipped
      FROM kept
    )
    INSERT INTO integrity_signal (report_id, duplicate_point_count, burst_count, duplicate_photo_count, matches_clipped)
    SELECT report_id, duplicate_point_count, burst_count, duplicate_photo_count, matches_clipped FROM counts ORDER BY report_id
    ON CONFLICT (report_id) DO UPDATE SET
      duplicate_point_count = EXCLUDED.duplicate_point_count,
      burst_count = EXCLUDED.burst_count,
      duplicate_photo_count = EXCLUDED.duplicate_photo_count,
      matches_clipped = EXCLUDED.matches_clipped`, [reportId]);
}

export async function backfillNextIntegritySignal(db: Pool) {
  const client = await db.connect();
  try {
    const { rows: [queued] } = await client.query(`UPDATE integrity_refresh SET lease_until = now() + interval '60 seconds'
      WHERE report_id = (SELECT report_id FROM integrity_refresh
        WHERE failed_reason IS NULL AND available_at <= now()
          AND (lease_until IS NULL OR lease_until <= now())
        ORDER BY available_at, report_id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING report_id, generation, expand_neighbors`);
    if (!queued) return false;
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query('SAVEPOINT refresh');
    let step = 'compute_signals';
    try {
      await computeIntegritySignals(client, queued.report_id);
      step = 'delete_refresh';
      await client.query('DELETE FROM integrity_refresh WHERE report_id = $1 AND generation = $2',
        [queued.report_id, queued.generation]);
      step = 'queue_neighbors';
      if (queued.expand_neighbors) await queueIntegrityNeighbors(client, queued.report_id);
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT refresh');
      await client.query(`UPDATE integrity_refresh SET attempts = attempts + 1,
        available_at = now() + power(2, least(attempts, 6)) * interval '1 second',
        failed_reason = CASE WHEN attempts >= 3 THEN 'refresh_failed' ELSE NULL END,
        error_class = $3, failure_step = $4,
        lease_until = NULL WHERE report_id = $1 AND generation = $2`,
      [queued.report_id, queued.generation, failureClass(error), step]);
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
