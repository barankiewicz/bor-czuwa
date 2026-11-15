import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { pool } from '../server/db.ts';
import { backfillNextIntegritySignal, computeIntegritySignals, queueIntegrityRefresh } from '../server/integrity.ts';
import { digestForDay, reportCounts } from '../server/operator.ts';

const run = promisify(execFile);
const ids: string[] = [];
// One accept or withdrawal in the densest cell must stay well under the pool's 10 s statement timeout.
const CEILING_MS = 2000;
const hash = () => randomBytes(32).toString('hex');

// Reports spread 1.5 km apart so that only a shared photo hash can link them.
async function insertReports(count: number, opts: { photo?: string; receivedAt: string; stepMinutes?: number;
  spreadDegrees?: number; lat?: number; token?: string }) {
  const { rows } = await pool.query(`INSERT INTO report (id, token_sha256, event_type, captured_at, occurred_at,
      occurred_source, occurred_coarseness, device_lat, device_lon, accuracy_m, device_fix_at,
      incident_lat, incident_lon, incident_source, has_note, photo_sha256, app_version,
      privacy_policy_version, terms_of_use_version, received_at)
    SELECT gen_random_uuid(), coalesce(encode(sha256(convert_to($7::text, 'UTF8')), 'hex'), encode(sha256(gen_random_uuid()::text::bytea), 'hex')), 'person_with_gun', $3::timestamptz,
      $3::timestamptz, 'device_clock', 'exact', $5::float8, 18 + n * $4::float8, 8, $3::timestamptz,
      $5::float8, 18 + n * $4::float8, 'device_fix', false, $2::jsonb, '0.1.0', 'fixture', 'fixture',
      $3::timestamptz + n * $6::float8 * interval '1 minute'
    FROM generate_series(1, $1) AS n RETURNING id, token_sha256`,
  [count, JSON.stringify(opts.photo ? [opts.photo] : []), opts.receivedAt, opts.spreadDegrees ?? 0.02,
    opts.lat ?? 47, opts.stepMinutes ?? 0, opts.token ?? null]);
  ids.push(...rows.map(row => row.id));
  return rows as { id: string; token_sha256: string }[];
}

async function drain(reportIds: string[], limit = 2000) {
  for (let i = 0; i < limit; i++) {
    const { rows: [left] } = await pool.query(`SELECT count(*)::int AS n FROM integrity_refresh
      WHERE report_id = ANY($1::uuid[]) AND failed_reason IS NULL`, [reportIds]);
    if (!left.n) return i;
    await backfillNextIntegritySignal(pool);
  }
  assert.fail('refresh queue did not drain');
}

const cli = (...args: string[]) => run('npx', ['tsx', 'server/operator-cli.ts', ...args],
  { env: process.env, cwd: new URL('..', import.meta.url).pathname }).then(
  r => ({ code: 0, out: r.stdout + r.stderr }),
  (e: { code: number; stdout: string; stderr: string }) => ({ code: e.code, out: e.stdout + e.stderr }));

after(async () => {
  for (const table of ['integrity_refresh', 'integrity_signal', 'findings_job', 'findings', 'report_event']) {
    await pool.query(`DELETE FROM ${table} WHERE report_id = ANY($1::uuid[])`, [ids]);
  }
  await pool.query('DELETE FROM report WHERE id = ANY($1::uuid[])', [ids]);
  await pool.end();
});

test('200 Reports sharing one photo hash: a new Report refreshes a bounded neighbourhood', async () => {
  const photo = hash();
  const existing = await insertReports(199, { photo, receivedAt: '2026-05-01T10:00:00Z' });
  const [fresh] = await insertReports(1, { photo, receivedAt: '2026-05-01T11:00:00Z', lat: 47.5 });
  const all = [...existing.map(row => row.id), fresh.id];
  await queueIntegrityRefresh(pool, fresh.id);
  const started = performance.now();
  await backfillNextIntegritySignal(pool); // the new Report's own refresh and neighbour expansion
  const { rows: [queued] } = await pool.query(`SELECT count(*)::int AS n FROM integrity_refresh
    WHERE report_id = ANY($1::uuid[])`, [all]);
  assert.ok(queued.n <= 100, `one refresh queued ${queued.n} neighbours`);
  const steps = await drain(all);
  const ms = Math.round(performance.now() - started);
  console.log(`photo-hash flood: neighbours queued ${queued.n}, drain steps ${steps}, ${ms} ms`);
  const { rows: [signal] } = await pool.query('SELECT duplicate_photo_count FROM integrity_signal WHERE report_id = $1', [fresh.id]);
  assert.ok(signal.duplicate_photo_count <= 100);
});

test('photo-hash matches stay inside the 30 day window; genuine duplicates still match', async () => {
  const photo = hash();
  const [a] = await insertReports(1, { photo, receivedAt: '2026-06-01T10:00:00Z', lat: 46 });
  const [near] = await insertReports(1, { photo, receivedAt: '2026-06-03T10:00:00Z', lat: 46.2 });
  const [far] = await insertReports(1, { photo, receivedAt: '2026-07-15T10:00:00Z', lat: 46.4 });
  const { rows } = await pool.query('SELECT report_id, duplicate_photo FROM integrity_matches($1) WHERE report_id <> $1', [a.id]);
  assert.deepEqual(rows.map(row => row.report_id), [near.id]);
  assert.equal(rows[0].duplicate_photo, true);
  assert.ok(!rows.some(row => row.report_id === far.id));
});

test('digest reports a truncated cluster and exclude --cluster refuses it', async () => {
  const photo = hash();
  const members = await insertReports(130, { photo, receivedAt: '2026-02-10T10:00:00Z', lat: 45 });
  await computeIntegritySignals(pool, members[0].id);
  const digest = await digestForDay('2026-02-10');
  assert.match(digest, /truncated/i);
  const refused = await cli('exclude', '--cluster', members[0].id, 'test', '--confirm', '100');
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /truncated|cap/i);
  const { rows: [state] } = await pool.query(`SELECT count(*)::int AS n FROM report_public_state
    WHERE id = ANY($1::uuid[]) AND exclusion_reason IS NOT NULL`, [members.map(row => row.id)]);
  assert.equal(state.n, 0);
});

test('exclude --cluster previews members and reasons and needs --confirm <count>', async () => {
  const photo = hash();
  const group = await insertReports(3, { photo, receivedAt: '2026-03-10T10:00:00Z', lat: 44 });
  const [outsider] = await insertReports(1, { receivedAt: '2026-03-10T10:00:00Z', lat: 43 });
  const excludedOf = async (list: string[]) => (await pool.query(`SELECT count(*)::int AS n FROM report_public_state
    WHERE id = ANY($1::uuid[]) AND exclusion_reason IS NOT NULL`, [list])).rows[0].n;
  const preview = await cli('exclude', '--cluster', group[0].id, 'test');
  assert.notEqual(preview.code, 0);
  for (const member of group) assert.ok(preview.out.includes(member.id));
  assert.match(preview.out, /photo/);
  const token = preview.out.match(/--confirm (\S+)/)?.[1] ?? '';
  assert.match(token, /^3-[0-9a-f]{8}$/);
  assert.equal(await excludedOf(group.map(row => row.id)), 0);
  const wrong = await cli('exclude', '--cluster', group[0].id, 'test', '--confirm', '2-00000000');
  assert.notEqual(wrong.code, 0);
  assert.equal(await excludedOf(group.map(row => row.id)), 0);
  const before = await reportCounts();
  const done = await cli('exclude', '--cluster', group[0].id, 'test', '--confirm', token);
  assert.equal(done.code, 0, done.out);
  assert.equal(await excludedOf(group.map(row => row.id)), 3);
  assert.equal(await excludedOf([outsider.id]), 0);
  const after = await reportCounts();
  assert.equal(after.excluded - before.excluded, 3);
  assert.equal(before.included - after.included, 3);
});

test('a seed withdrawn mid-digest does not abort the digest', async () => {
  // `gone` is alone in its cluster, so the digest must expand it itself, after the withdrawal.
  const goneToken = randomBytes(32).toString('hex');
  const [gone] = await insertReports(1, { token: goneToken, photo: hash(), receivedAt: '2026-04-10T10:00:00Z', lat: 42 });
  const [kept1, kept2] = await insertReports(2, { photo: hash(), receivedAt: '2026-04-10T10:00:00Z', lat: 41 });
  for (const row of [gone, kept1]) await computeIntegritySignals(pool, row.id);
  await pool.query('UPDATE integrity_signal SET duplicate_photo_count = 1 WHERE report_id = $1', [gone.id]);
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const original = pg.Client.prototype.query;
  let fired = false;
  // After the digest lists its seeds, withdraw one on a separate connection.
  const withdraw = () => original.call(admin, 'SELECT public.withdraw_report($1, $2)', [gone.id, goneToken]);
  (pg.Client.prototype as any).query = function (this: pg.Client, ...args: any[]) {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? '';
    if (fired || this === admin || !text.includes('FROM integrity_signal s JOIN report r')) {
      return (original as any).apply(this, args);
    }
    fired = true;
    // pg.Pool.query passes a callback; hold its delivery until the withdrawal has committed.
    const last = args.length - 1;
    if (typeof args[last] === 'function') {
      const callback = args[last];
      args[last] = (error: Error | undefined, value: unknown) => withdraw().then(() => callback(error, value));
      return (original as any).apply(this, args);
    }
    return Promise.resolve((original as any).apply(this, args)).then(async (value: unknown) => {
      await withdraw();
      return value;
    });
  };
  try {
    const digest = await digestForDay('2026-04-10');
    assert.ok(fired, "hook never fired");
    assert.match(digest, /clusters/);
    assert.ok(digest.includes(kept1.id));
    assert.ok(digest.includes(kept2.id));
  } finally {
    (pg.Client.prototype as any).query = original;
    await admin.end();
  }
});

test('a Report whose capped list holds a withdrawn one is refreshed too (the cap is not symmetric)', async () => {
  const photo = hash();
  const bToken = randomBytes(32).toString('hex');
  // A sits 29 days before B. 100 fillers sit 6 to 7 days after B and more than 30 days after A.
  // B's nearest 100 links are the fillers, so A is outside B's list while B is inside A's.
  const [a] = await insertReports(1, { photo, receivedAt: '2026-08-01T10:00:00Z', lat: 40 });
  const [b] = await insertReports(1, { token: bToken, photo, receivedAt: '2026-08-30T10:00:00Z', lat: 40.2 });
  await insertReports(100, { photo, receivedAt: '2026-09-05T10:00:00Z', lat: 40.4, stepMinutes: 1 });
  await computeIntegritySignals(pool, a.id);
  const count = async () => (await pool.query('SELECT duplicate_photo_count AS n FROM integrity_signal WHERE report_id = $1', [a.id])).rows[0].n;
  assert.equal(await count(), 1);
  await pool.query('SELECT public.withdraw_report($1, $2)', [b.id, bToken]);
  await drain([a.id]);
  assert.equal(await count(), 0);
});

test('a Signal clipped at the cap says so; an unclipped one does not', async () => {
  const photo = hash();
  const flood = await insertReports(130, { photo, receivedAt: '2026-09-10T10:00:00Z', lat: 39 });
  const [pair1] = await insertReports(2, { photo: hash(), receivedAt: '2026-09-10T10:00:00Z', lat: 38 });
  await computeIntegritySignals(pool, flood[0].id);
  await computeIntegritySignals(pool, pair1.id);
  const read = async (id: string) => (await pool.query('SELECT duplicate_photo_count AS n, matches_clipped AS clipped FROM integrity_signal WHERE report_id = $1', [id])).rows[0];
  // The list holds 100 rows; the seed's own burst row is one of them, so 99 are photo links.
  const clippedRow = await read(flood[0].id);
  assert.equal(clippedRow.clipped, true);
  assert.ok(clippedRow.n >= 99 && clippedRow.n <= 100);
  assert.deepEqual(await read(pair1.id), { n: 1, clipped: false });
  const digest = await digestForDay('2026-09-10');
  assert.match(digest, /clipped at 100/);
  const preview = await cli('exclude', '--cluster', flood[0].id, 'test');
  assert.match(preview.out, /100\+ links|clipped/);
});

test('an expansion that times out becomes a warning line and the rest of the digest completes', async () => {
  const members = await insertReports(30, { photo: hash(), receivedAt: '2026-10-10T10:00:00Z', lat: 37 });
  const [lone] = await insertReports(1, { photo: hash(), receivedAt: '2026-10-10T10:00:00Z', lat: 36 });
  await computeIntegritySignals(pool, members[0].id);
  await computeIntegritySignals(pool, lone.id);
  const digest = await digestForDay('2026-10-10', { expansionTimeoutMs: 1 });
  assert.match(digest, /Warning: .*timed out/);
  assert.match(digest, /clusters/);
});

test('the digest lists at most 10 ids per cluster with a count of the rest', async () => {
  const members = await insertReports(60, { photo: hash(), receivedAt: '2026-11-10T10:00:00Z', lat: 35 });
  await computeIntegritySignals(pool, members[0].id);
  const digest = await digestForDay('2026-11-10');
  assert.match(digest, /Cluster 1: 60 Reports/);
  assert.match(digest, /and 50 more/);
  const listed = members.filter(row => digest.includes(row.id)).length;
  assert.equal(listed, 10);
});

test('a crafted bridge Report shows how it pulled a legitimate Report in, and the confirmation names the exact set', async () => {
  const bridgePhoto = hash();
  const [victim] = await insertReports(1, { photo: bridgePhoto, receivedAt: '2026-12-01T10:00:00Z', lat: 34 });
  const [legit] = await insertReports(1, { photo: hash(), receivedAt: '2026-12-02T10:00:00Z', lat: 33, spreadDegrees: 0 });
  // The bridge copies the victim's photo hash and sits on the legitimate Report's exact point.
  const [bridge] = await insertReports(1, { photo: bridgePhoto, receivedAt: '2026-12-02T11:00:00Z', lat: 33, spreadDegrees: 0 });
  const preview = await cli('exclude', '--cluster', legit.id, 'fabricated');
  assert.notEqual(preview.code, 0);
  for (const row of [victim, legit, bridge]) assert.ok(preview.out.includes(row.id), 'member missing from preview');
  const victimLine = preview.out.split('\n').find(line => line.includes(victim.id)) ?? '';
  assert.match(victimLine, /duplicate_photo/);
  assert.ok(victimLine.includes(bridge.id), 'victim line must name the Report it was reached from');
  const token = preview.out.match(/--confirm (\S+)/)?.[1] ?? '';
  // A token for a different set of the same size is refused.
  const other = await insertReports(3, { photo: hash(), receivedAt: '2026-12-05T10:00:00Z', lat: 32 });
  const otherToken = (await cli('exclude', '--cluster', other[0].id, 'fabricated')).out.match(/--confirm (\S+)/)?.[1];
  assert.equal(otherToken?.split('-')[0], token.split('-')[0]);
  assert.notEqual(otherToken, token);
  const swapped = await cli('exclude', '--cluster', legit.id, 'fabricated', `--confirm=${otherToken}`);
  assert.notEqual(swapped.code, 0);
  const excluded = async () => (await pool.query(`SELECT count(*)::int AS n FROM report_public_state
    WHERE id = ANY($1::uuid[]) AND exclusion_reason IS NOT NULL`, [[victim.id, legit.id, bridge.id]])).rows[0].n;
  assert.equal(await excluded(), 0);
  assert.equal((await cli('exclude', '--cluster', legit.id, 'fabricated', '--confirm', token)).code, 0);
  assert.equal(await excluded(), 3);
});

test('one accept and one withdrawal stay cheap in a 2000 Report burst cell sharing one photo hash', async () => {
  const photo = hash();
  const token = randomBytes(32).toString('hex');
  // 2000 Reports on one point within 40 minutes, all with one photo hash: every link kind is crowded.
  const crowd = await insertReports(1999, { photo, receivedAt: '2027-02-01T10:00:00Z', lat: 30, spreadDegrees: 0, stepMinutes: 0.02 });
  const [fresh] = await insertReports(1, { token, photo, receivedAt: '2027-02-01T10:20:00Z', lat: 30, spreadDegrees: 0 });
  await queueIntegrityRefresh(pool, fresh.id);
  // The worker takes the oldest queued row; time the step that handles the new Report.
  let acceptMs = -1;
  for (let step = 0; step < 3000 && acceptMs < 0; step++) {
    const began = performance.now();
    await backfillNextIntegritySignal(pool);
    const { rows: [pending] } = await pool.query('SELECT count(*)::int AS n FROM integrity_refresh WHERE report_id = $1', [fresh.id]);
    if (!pending.n) acceptMs = Math.round(performance.now() - began);
  }
  assert.ok(acceptMs >= 0, 'the new Report was never refreshed');
  const { rows: [queued] } = await pool.query('SELECT count(*)::int AS n FROM integrity_refresh WHERE report_id = ANY($1::uuid[])', [crowd.map(row => row.id)]);
  const started = performance.now();
  await pool.query('SELECT public.withdraw_report($1, $2)', [fresh.id, token]);
  const withdrawMs = Math.round(performance.now() - started);
  console.log(`crowded cell: accept ${acceptMs} ms (queued ${queued.n}), withdrawal ${withdrawMs} ms`);
  assert.ok(acceptMs < CEILING_MS, `accept took ${acceptMs} ms`);
  assert.ok(withdrawMs < CEILING_MS, `withdrawal took ${withdrawMs} ms`);
});
