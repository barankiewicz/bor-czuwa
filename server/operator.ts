import { createHash } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Pool, PoolClient } from 'pg';
import { pool } from './db.ts';

export type ExclusionReason = 'fabricated' | 'duplicate' | 'test';

// The cluster walk, its cap and the Integrity window all live in SQL (integrity_cap, integrity_window,
// integrity_cluster); this file only reads them back. Public Reports can link themselves, so the walk
// stops at the cap and says so.
export type ClusterMember = { id: string; linkedFrom: string | null; reasons: string[]; signalClipped: boolean };
export type ClusterPreview = { members: ClusterMember[]; truncated: boolean; cap: number };

type Queryable = { query: Pool['query'] };

// One vocabulary for link reasons, in the digest's Signals line and in the Exclusion preview.
const reasonLabels = ['duplicate_point', 'burst', 'duplicate_photo'] as const;

export async function clusterPreview(seedId: string, db: Queryable = pool): Promise<ClusterPreview> {
  const { rows } = await db.query('SELECT * FROM integrity_cluster($1)', [seedId]);
  if (!rows.length) throw new Error('report_not_found');
  const { rows: clipped } = await db.query(
    'SELECT report_id FROM integrity_signal WHERE report_id = ANY($1::uuid[]) AND matches_clipped',
    [rows.map(row => row.report_id)]);
  const clippedIds = new Set(clipped.map(row => row.report_id as string));
  return {
    truncated: rows[0].truncated as boolean,
    cap: rows[0].member_cap as number,
    members: rows.map(row => ({ id: row.report_id as string, linkedFrom: row.linked_from as string | null,
      reasons: reasonLabels.filter(label => row[label]) as string[], signalClipped: clippedIds.has(row.report_id) }))
  };
}

export async function clusterReportIds(seedId: string) {
  const { members, truncated } = await clusterPreview(seedId);
  if (truncated) throw new Error('cluster_truncated');
  return members.map(member => member.id);
}

// What --confirm must repeat: the member count and a short hash of the sorted ids, so a swapped
// member with the same total is a different token.
export function clusterConfirmation(members: ClusterMember[]) {
  const digest = createHash('sha256').update(members.map(member => member.id).sort().join('\n')).digest('hex');
  return `${members.length}-${digest.slice(0, 8)}`;
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

// The digest names at most this many ids per cluster and this many clusters, so one message stays
// under about 25 KB however large a flood is.
const DIGEST_IDS_PER_CLUSTER = 10;
const DIGEST_MAX_CLUSTERS = 50;

export async function digestForDay(day: string, options: { expansionTimeoutMs?: number } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(day))) throw new Error('invalid_day');
  // One snapshot: a Report withdrawn while the digest runs cannot vanish between listing and expanding.
  const client = await pool.connect();
  let discard: Error | undefined;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const text = await digestInSnapshot(client, day, options.expansionTimeoutMs);
    await client.query('COMMIT');
    return text;
  } catch (error) {
    await client.query('ROLLBACK').catch(rollbackError => { discard = rollbackError as Error; });
    throw error;
  } finally { client.release(discard); }
}

async function digestInSnapshot(db: PoolClient, day: string, expansionTimeoutMs?: number) {
  const { rows: seeds } = await db.query(`SELECT s.report_id, s.duplicate_point_count,
      s.burst_count, s.duplicate_photo_count, s.over_limit_hour, s.over_limit_day
    FROM integrity_signal s JOIN report r ON r.id = s.report_id
    WHERE (r.received_at AT TIME ZONE 'Europe/Warsaw')::date = $1::date
      AND (s.duplicate_point_count > 0 OR s.burst_count >= 6 OR s.duplicate_photo_count > 0
        OR s.over_limit_hour IS NOT NULL OR s.over_limit_day IS NOT NULL)
    ORDER BY s.report_id`, [day]);
  const groups: { ids: Set<string>; signals: typeof seeds; truncated: boolean; cap: number }[] = [];
  const warnings: string[] = [];
  // In production nothing is set here: the pool's 10 s statement_timeout (server/db.ts) is what raises 57014
  // below. The option exists so a test can reach that path with a 1 ms limit.
  if (expansionTimeoutMs) await db.query(`SET LOCAL statement_timeout = ${Math.floor(expansionTimeoutMs)}`);
  for (const seed of seeds) {
    const existing = groups.find(group => group.ids.has(seed.report_id));
    if (existing) {
      existing.signals.push(seed);
      continue;
    }
    // A savepoint lets a statement timeout cost only this seed, not the snapshot transaction.
    await db.query('SAVEPOINT expansion');
    let preview: ClusterPreview | null;
    try {
      preview = await clusterPreview(seed.report_id, db);
      await db.query('RELEASE SAVEPOINT expansion');
    } catch (error) {
      await db.query('ROLLBACK TO SAVEPOINT expansion');
      if ((error as Error).message === 'report_not_found') preview = null;
      else if ((error as { code?: string }).code === '57014') {
        warnings.push(`Warning: the cluster of ${seed.report_id} timed out while expanding and is not listed`);
        preview = null;
      } else throw error;
    }
    if (!preview) continue;
    const ids = new Set(preview.members.map(member => member.id));
    const matches = groups.filter(group => [...ids].some(id => group.ids.has(id)));
    const group = matches[0] ?? { ids: new Set<string>(), signals: [], truncated: false, cap: preview.cap };
    for (const id of ids) group.ids.add(id);
    group.truncated ||= preview.truncated;
    group.signals.push(seed);
    if (!matches.length) groups.push(group);
    for (const other of matches.slice(1)) {
      for (const id of other.ids) group.ids.add(id);
      group.signals.push(...other.signals);
      group.truncated ||= other.truncated;
      groups.splice(groups.indexOf(other), 1);
    }
  }
  if (expansionTimeoutMs) await db.query('RESET statement_timeout');
  const lines = [`Integrity digest ${day}`, `${groups.length} clusters${groups.length > DIGEST_MAX_CLUSTERS ? `, the first ${DIGEST_MAX_CLUSTERS} listed` : ''}`, ...warnings];
  for (const [index, group] of groups.slice(0, DIGEST_MAX_CLUSTERS).entries()) {
    const ids = [...group.ids].sort();
    const { rows: places } = await db.query(`SELECT DISTINCT j.name FROM report r
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
    const { rows: [clipped] } = await db.query(
      'SELECT count(*)::int AS n FROM integrity_signal WHERE report_id = ANY($1::uuid[]) AND matches_clipped', [ids]);
    const listed = ids.slice(0, DIGEST_IDS_PER_CLUSTER).join(', ');
    lines.push('', group.truncated
      ? `Cluster ${index + 1}: ${ids.length}+ Reports, truncated at ${group.cap}; more are linked than listed`
      : `Cluster ${index + 1}: ${ids.length} Reports`,
    `Gmina: ${places.map(row => row.name).join(', ') || 'unknown'}`,
    `Signals: ${types}${clipped.n ? `; counts clipped at ${group.cap} on ${clipped.n} Reports (that many or more)` : ''}`,
    `Report ids: ${listed}${ids.length > DIGEST_IDS_PER_CLUSTER ? ` and ${ids.length - DIGEST_IDS_PER_CLUSTER} more` : ''}`);
  }
  return lines.join('\n') + '\n';
}

// A failed daily run (database busy, SMTP down) is tried again, 3 attempts 5 minutes apart. After the last
// one it throws, the CLI exits non-zero and integrity-digest.service fails with the reason in the journal.
export async function retryDigest<T>(run: () => Promise<T>, { attempts = 3, delayMs = 300_000 } = {}) {
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await run(); } catch (error) {
      last = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`digest_gave_up_after_${attempts}_attempts: ${(last as Error).message}`);
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
  await retryDigest(async () => transport.sendMail({ from: DIGEST_FROM, to: DIGEST_TO,
    subject: `Integrity digest ${day}`, text: await digestForDay(day) }));
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
