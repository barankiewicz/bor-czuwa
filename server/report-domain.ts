import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { setTimeout } from 'node:timers/promises';
import type { Report } from '../src/lib/report.ts';
import type { NoticeEvent, NoticeOutcome } from '../src/lib/notice-event.ts';
import { pool } from './db.ts';
import { challenges } from './challenge.ts';
import { rateLimit } from './rate-limit.ts';
import { queueIntegrityRefresh } from './integrity.ts';
import { workerStatus } from './worker-status.ts';

// Five recipients can each have several handoffs and dated outcome corrections.
// This lifetime cap counts only Reporter-written events, never system events.
const maxNoticeEventsPerReport = 128;

export function reportDomain(now: () => number, limits: ReturnType<typeof rateLimit>) {
  const proof = challenges(now);

  // A wrong or missing token looks the same as an unknown Report.
  async function authorised(id: string, token: string | undefined) {
    if (!token) return false;
    const hash = createHash('sha256').update(token).digest('hex');
    return !!(await pool.query('SELECT 1 FROM report WHERE id = $1 AND token_sha256 = $2', [id, hash])).rowCount;
  }

  // Takes the Report counters inside the caller's transaction and rolls back on refusal, so a
  // refused call leaves no count behind. The Altcha solution is stateless, so a replay, a
  // conflicting resend and a retry of a withdrawn id call this too: a resend costs what a
  // new Report costs. Returns the limit for a caller that reads its counts, and `refused`
  // (already rolled back) for the caller to return.
  async function takeReportBudget(client: PoolClient, address: string) {
    const limit = await limits.takeReport(client, address);
    if (limit.counts) return { limit, refused: undefined };
    await client.query('ROLLBACK');
    if (limit.serviceCeiling) workerStatus.reportCeilingRefusedAt = now();
    return { limit, refused: { kind: 'limited', retryAfter: limit.retryAfter } as const };
  }

  return {
    challenge: proof.create,
    authorised,

    async accept(report: Report, solution: unknown, address: string) {
      const challenge = await proof.verify(solution);
      if (!challenge) return { kind: 'invalid_solution' } as const;

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))', [report.id]);
        // A tombstone stops only the Report whose token it names.
        const withdrawn = await client.query('SELECT 1 FROM report_withdrawal WHERE id = $1 AND token_sha256 = $2',
          [report.id, report.token_sha256]);
        if (withdrawn.rowCount) {
          const { refused } = await takeReportBudget(client, address);
          if (refused) return refused;
          await client.query('COMMIT');
          return { kind: 'withdrawn' } as const;
        }
        const inserted = await client.query(`INSERT INTO report
          (id, token_sha256, event_type, captured_at, occurred_at, occurred_source,
           occurred_coarseness, occurred_window_end, device_lat, device_lon, accuracy_m, device_fix_at,
           incident_lat, incident_lon, incident_source, has_note, app_version,
           privacy_policy_version, terms_of_use_version, species, incident_bounds, area_basis,
           precise_fix_withheld, hearing_bearing_deg, hearing_distance_band, hearing_distance_m, photo_sha256, proof_challenge)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
          ON CONFLICT (id) DO NOTHING RETURNING id`,
        [report.id, report.token_sha256, report.event_type, report.captured_at,
          report.occurred_at.at, report.occurred_at.source, report.occurred_at.coarseness, report.occurred_at.window_end ?? null,
          report.device_fix?.lat ?? null, report.device_fix?.lon ?? null, report.device_fix?.accuracy_m ?? null,
          report.device_fix?.at ?? null,
          'type' in report.incident_location ? (report.incident_location.bounds[1] + report.incident_location.bounds[3]) / 2 : report.incident_location.lat,
          'type' in report.incident_location ? (report.incident_location.bounds[0] + report.incident_location.bounds[2]) / 2 : report.incident_location.lon,
          'type' in report.incident_location ? 'area' : report.incident_location.source,
          report.has_note, report.app_version,
          report.privacy_policy_version, report.terms_of_use_version, report.species,
          'type' in report.incident_location ? JSON.stringify(report.incident_location.bounds) : null,
          'type' in report.incident_location ? report.incident_location.basis : null,
          'type' in report.incident_location ? report.incident_location.precise_fix_withheld : null,
          'type' in report.incident_location ? report.incident_location.hearing_bearing_deg ?? null : null,
          'type' in report.incident_location ? report.incident_location.hearing_distance_band ?? null : null,
          'type' in report.incident_location ? report.incident_location.hearing_distance_m ?? null : null,
          report.photo_sha256 === undefined ? null : JSON.stringify(report.photo_sha256), challenge]);

        if (!inserted.rowCount) {
          const existing = await client.query('SELECT token_sha256 FROM report WHERE id = $1', [report.id]);
          const { refused } = await takeReportBudget(client, address);
          if (refused) return refused;
          await client.query('COMMIT');
          return { kind: existing.rows[0].token_sha256 === report.token_sha256 ? 'replayed' : 'conflict' } as const;
        }

        const { limit, refused } = await takeReportBudget(client, address);
        if (refused) return refused;
        const counts = limit.counts!;
        if (counts.hourly > 5 || counts.daily > 15) {
          await client.query(`INSERT INTO integrity_signal (report_id, over_limit_hour, over_limit_day)
            VALUES ($1, $2, $3)`, [report.id,
            counts.hourly > 5 ? counts.hourly : null,
            counts.daily > 15 ? counts.daily : null]);
        }
        await client.query(`INSERT INTO report_event (report_id, kind, at, details)
          VALUES ($1, 'created', $2, $3), ($1, 'synced', date_trunc('minute', now()), '{}')`,
        [report.id, report.captured_at, {
          privacy_policy_version: report.privacy_policy_version,
          terms_of_use_version: report.terms_of_use_version
        }]);
        await client.query('INSERT INTO findings_job (report_id) VALUES ($1)', [report.id]);
        await queueIntegrityRefresh(client, report.id);
        await client.query('COMMIT');
        return { kind: 'created' } as const;
      } catch (error) {
        await client.query('ROLLBACK');
        if ((error as { constraint?: string }).constraint === 'report_proof_challenge_key') {
          return { kind: 'used_solution' } as const;
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async recordEvent(id: string, event: NoticeEvent | NoticeOutcome) {
      const { id: eventId, kind, at, ...details } = event;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Serialize events and exclude Withdrawal without blocking workers' foreign-key reads.
        const owned = await client.query('SELECT 1 FROM report WHERE id = $1 FOR NO KEY UPDATE', [id]);
        if (!owned.rowCount) { await client.query('ROLLBACK'); return 'not_found' as const; }
        const existing = await client.query('SELECT report_id FROM report_event WHERE event_id = $1', [eventId]);
        if (existing.rowCount) {
          await client.query('COMMIT');
          return existing.rows[0].report_id === id ? 'replayed' as const : 'conflict' as const;
        }
        const count = await client.query('SELECT count(*)::int AS total FROM report_event WHERE report_id = $1 AND event_id IS NOT NULL', [id]);
        if (count.rows[0].total >= maxNoticeEventsPerReport) {
          await client.query('ROLLBACK');
          return 'event_limit' as const;
        }
        if (kind === 'outcome_reported') {
          const confirmed = await client.query(`SELECT 1 FROM report_event WHERE report_id = $1
            AND kind = 'confirmed_by_reporter' AND details->>'notice_id' = $2
            AND details->>'recipient_kind' = $3 AND details->>'unit_id' = $4 LIMIT 1`,
          [id, details.notice_id, details.recipient_kind, details.unit_id]);
          if (!confirmed.rowCount) { await client.query('ROLLBACK'); return 'notice_not_confirmed' as const; }
        }
        const inserted = await client.query(`INSERT INTO report_event (report_id, kind, at, details, event_id)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (event_id) DO NOTHING RETURNING id`, [id, kind, at, details, eventId]);
        let outcome: 'created' | 'replayed' | 'conflict' = 'created';
        if (!inserted.rowCount) {
          // Resolve ownership while this transaction still protects the Report.
          const raced = await client.query('SELECT report_id FROM report_event WHERE event_id = $1', [eventId]);
          outcome = raced.rows[0]?.report_id === id ? 'replayed' : 'conflict';
        }
        await client.query('COMMIT');
        return outcome;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },

    async withdraw(id: string, token: string | undefined, address: string) {
      if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
      const hash = createHash('sha256').update(token).digest('hex');
      for (let attempt = 0; attempt < 4; attempt++) {
        if (attempt) await setTimeout(attempt * 50);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))', [id]);
          const existing = await client.query('SELECT token_sha256 FROM report WHERE id = $1 FOR UPDATE', [id]);
          const withdrawn = await client.query('SELECT 1 FROM report_withdrawal WHERE id = $1 AND token_sha256 = $2', [id, hash]);
          // A Report this token owns, or a tombstone it already left, is the honest case and is
          // free. Everything else (an unknown id, or an id another token owns) is charged alike,
          // because either leaves a tombstone behind.
          if (!withdrawn.rowCount && existing.rows[0]?.token_sha256 !== hash) {
            const limit = await limits.takeWithdrawal(client, address);
            if (!limit.counts) {
              await client.query('ROLLBACK');
              return { retryAfter: limit.retryAfter };
            }
          }
          const result = await client.query('SELECT public.withdraw_report($1, $2) AS withdrawn', [id, token]);
          await client.query('COMMIT');
          return result.rows[0].withdrawn as boolean;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => {});
          const code = (error as { code?: string }).code;
          if (attempt < 3 && ['40P01', '55P03', '40001', '23503'].includes(code ?? '')) continue;
          throw error;
        } finally { client.release(); }
      }
      throw new Error('withdrawal_retry_exhausted');
    }
  };
}
