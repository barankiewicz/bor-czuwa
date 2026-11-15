import nodemailer from 'nodemailer';
import { pool } from './db.ts';

export type ExclusionReason = 'fabricated' | 'duplicate' | 'test';

export async function clusterReportIds(seedId: string) {
  const result = await pool.query(`WITH RECURSIVE cluster(report_id) AS (
      SELECT id FROM report WHERE id = $1
      UNION
      SELECT matched.report_id FROM cluster CROSS JOIN LATERAL integrity_matches(cluster.report_id) matched
    ) SELECT report_id AS id FROM cluster ORDER BY report_id`, [seedId]);
  if (!result.rowCount) throw new Error('report_not_found');
  return result.rows.map(row => row.id as string);
}

async function recordExclusion(ids: string[], kind: 'excluded' | 'exclusion_lifted', reason?: ExclusionReason) {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('invalid_report_ids');
  if (kind === 'excluded' && !['fabricated', 'duplicate', 'test'].includes(reason ?? '')) {
    throw new Error('invalid_exclusion_reason');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT id FROM report WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
    if (locked.rowCount !== ids.length) throw new Error('report_not_found');
    const state = await client.query('SELECT id, exclusion_reason FROM report_public_state WHERE id = ANY($1::uuid[])', [ids]);
    if (state.rows.some(row => kind === 'excluded' ? row.exclusion_reason !== null : row.exclusion_reason === null)) {
      throw new Error(kind === 'excluded' ? 'already_excluded' : 'not_excluded');
    }
    await client.query(`INSERT INTO report_event (report_id, kind, details)
      SELECT id, $2, $3::jsonb FROM unnest($1::uuid[]) AS id`,
    [ids, kind, JSON.stringify(reason ? { reason } : {})]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export const exclude = (ids: string[], reason: ExclusionReason) => recordExclusion(ids, 'excluded', reason);
export const liftExclusion = (ids: string[]) => recordExclusion(ids, 'exclusion_lifted');

export async function unpublish(id: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('UPDATE report SET publishable = false WHERE id = $1 AND publishable RETURNING id', [id]);
    if (!result.rowCount) throw new Error('report_not_found_or_already_unpublished');
    await client.query("INSERT INTO report_event (report_id, kind) VALUES ($1, 'unpublished')", [id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function reportCounts() {
  const { rows: [row] } = await pool.query(`SELECT
    count(*) FILTER (WHERE exclusion_reason IS NULL)::int AS included,
    (count(*) FILTER (WHERE exclusion_reason IS NOT NULL) +
      (SELECT total FROM excluded_withdrawal_count))::int AS excluded
    FROM report_public_state`);
  return row as { included: number; excluded: number };
}

export async function digestForDay(day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw new Error('invalid_day');
  const { rows: seeds } = await pool.query(`SELECT s.report_id, s.duplicate_point_count,
      s.burst_count, s.duplicate_photo_count, s.over_limit_hour, s.over_limit_day
    FROM integrity_signal s JOIN report r ON r.id = s.report_id
    WHERE (r.received_at AT TIME ZONE 'Europe/Warsaw')::date = $1::date
      AND (s.duplicate_point_count > 0 OR s.burst_count >= 6 OR s.duplicate_photo_count > 0
        OR s.over_limit_hour IS NOT NULL OR s.over_limit_day IS NOT NULL)
    ORDER BY s.report_id`, [day]);
  const groups: { ids: Set<string>; signals: typeof seeds }[] = [];
  for (const seed of seeds) {
    const existing = groups.find(group => group.ids.has(seed.report_id));
    if (existing) {
      existing.signals.push(seed);
      continue;
    }
    const ids = new Set(await clusterReportIds(seed.report_id));
    const matches = groups.filter(group => [...ids].some(id => group.ids.has(id)));
    const group = matches[0] ?? { ids: new Set<string>(), signals: [] };
    for (const id of ids) group.ids.add(id);
    group.signals.push(seed);
    if (!matches.length) groups.push(group);
    for (const other of matches.slice(1)) {
      for (const id of other.ids) group.ids.add(id);
      group.signals.push(...other.signals);
      groups.splice(groups.indexOf(other), 1);
    }
  }
  const lines = [`Integrity digest ${day}`, `${groups.length} clusters`];
  for (const [index, group] of groups.entries()) {
    const ids = [...group.ids].sort();
    const { rows: places } = await pool.query(`SELECT DISTINCT j.name FROM report r
      JOIN current_geodata c ON true
      JOIN recipient_jurisdiction j ON j.snapshot_id = c.snapshot_id AND j.kind = 'gmina'
        AND ST_Covers(j.geom, ST_Transform(ST_SetSRID(ST_MakePoint(r.incident_lon, r.incident_lat), 4326), 2180))
      WHERE r.id = ANY($1::uuid[]) ORDER BY j.name`, [ids]);
    const types = [
      group.signals.some(signal => signal.duplicate_point_count > 0) && 'duplicate_point',
      group.signals.some(signal => signal.burst_count >= 6) && 'burst',
      group.signals.some(signal => signal.duplicate_photo_count > 0) && 'duplicate_photo',
      group.signals.some(signal => signal.over_limit_hour !== null || signal.over_limit_day !== null) && 'over_limit'
    ].filter(Boolean).join(', ');
    lines.push('', `Cluster ${index + 1}: ${ids.length} Reports`,
      `Gmina: ${places.map(row => row.name).join(', ') || 'unknown'}`,
      `Signals: ${types}`, `Report ids: ${ids.join(', ')}`);
  }
  return lines.join('\n') + '\n';
}

export async function mailDigest(day: string) {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, DIGEST_FROM, DIGEST_TO } = process.env;
  if (![SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD, DIGEST_FROM, DIGEST_TO].every(Boolean)) {
    throw new Error('smtp_not_configured');
  }
  const port = Number(SMTP_PORT);
  if (![465, 587].includes(port)) throw new Error('invalid_smtp_port');
  const transport = nodemailer.createTransport({ host: SMTP_HOST, port, secure: port === 465,
    requireTLS: true, auth: { user: SMTP_USER, pass: SMTP_PASSWORD } });
  await transport.sendMail({ from: DIGEST_FROM, to: DIGEST_TO,
    subject: `Integrity digest ${day}`, text: await digestForDay(day) });
}

export async function requeueFindings(reason: string, since?: string) {
  if (!['computation_failed', 'before_earliest_rule_set', 'unknown_species', 'no_geodata_snapshot',
    'point_outside_fixture', 'area_outside_fixture', 'snapshot_storage_unavailable'].includes(reason)) {
    throw new Error('invalid_findings_reason');
  }
  if (since && (!/^\d{4}-\d{2}-\d{2}$/.test(since) ||
    !Number.isFinite(Date.parse(since)) || new Date(since).toISOString().slice(0, 10) !== since)) {
    throw new Error('invalid_since_date');
  }
  const result = await pool.query(`UPDATE findings_job j SET failed_reason = NULL, attempts = 0,
      available_at = now(), rule_set_id = NULL, geodata_snapshot_id = NULL
    WHERE failed_reason = $1 AND ($2::date IS NULL OR EXISTS (
      SELECT 1 FROM report_event e WHERE e.report_id = j.report_id AND e.kind = 'findings_failed'
        AND e.details->>'reason' = $1 AND e.at >= $2::date))
    RETURNING report_id`, [reason, since ?? null]);
  return result.rowCount;
}
