import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { z } from 'zod';
import { reportSchema } from '../src/lib/report.ts';
import { reportNoticeEventSchema } from '../src/lib/notice-event.ts';
import { noteDatabaseFailure, pool } from './db.ts';
import { rateLimit } from './rate-limit.ts';
import { reportDomain } from './report-domain.ts';
import { areaPlaces, areaSchema, isKnownRecipient, lookupRecipients, recipientLocationSchema } from './recipient-lookup.ts';
import { failureClass } from './failure-class.ts';
import { workerStatus } from './worker-status.ts';
import { geodataReadiness } from './startup-check.ts';
import { placeSearch } from './place-search.ts';
import { timesWithinWindow } from './input-catalogue.ts';
const addressFlagSchema = z.strictObject({
  kind: z.enum(['police', 'psl', 'nationalPark', 'rdos', 'gmina']),
  unit_id: z.string().min(1).max(100)
});
const warsawDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit'
});
const maxActiveRequests = 64;
const activeLimit = { event: 8, write: 64, lookup: 12, read: 24, health: 8 } as const;
const workerPollStaleAfterSeconds = 180;
const jobQueueStaleAfterSeconds = 300;

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function body(request: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw new Error('invalid_body');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function bearerToken(request: IncomingMessage) {
  return request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
}

function clientAddress(request: IncomingMessage) {
  const peer = request.socket.remoteAddress ?? '';
  const forwarded = request.headers['x-real-ip'];
  return peer === process.env.TRUSTED_PROXY_IP && typeof forwarded === 'string' && isIP(forwarded)
    ? forwarded : peer;
}

export function siteOrigin(request: IncomingMessage) {
  const trusted = request.socket.remoteAddress === process.env.TRUSTED_PROXY_IP;
  const host = trusted ? request.headers['x-forwarded-host'] : request.headers.host;
  const protocol = trusted ? request.headers['x-forwarded-proto'] : 'http';
  if (typeof host !== 'string' || (protocol !== 'http' && protocol !== 'https')) return undefined;
  try { return new URL(`${protocol}://${host}`).origin; }
  catch { return undefined; }
}

// A browser mutation comes from the app's own origin or from the Android WebView. The landing's
// origin is a different site and is refused.
export function mutationOriginAllowed(request: IncomingMessage) {
  const origin = request.headers.origin;
  return origin === undefined || origin === 'https://localhost' || origin === siteOrigin(request);
}

export function createApiServer(now: () => number = Date.now, placeFetch: typeof fetch = fetch) {
  const limits = rateLimit(now);
  const reports = reportDomain(now, limits);
  const searchPlaces = placeSearch(placeFetch, now);
  const geodataReady = geodataReadiness(pool);
  let activeRequests = 0;
  const activeByClass = { event: 0, write: 0, lookup: 0, read: 0, health: 0 };
  const activeEventReports = new Set<string>();
  const server = createServer(async (request, response) => {
    let errorClass: string | undefined;
    response.once('finish', () => {
      if (response.statusCode !== 503) return;
      const key = errorClass ?? 'service_unavailable';
      workerStatus.api503[key] = (workerStatus.api503[key] ?? 0) + 1;
    });
    const path = request.url ?? '';
    const eventReport = path.match(/^\/api\/reports\/([a-f0-9-]+)\/events$/i)?.[1].toLowerCase();
    const routeClass = path.endsWith('/events') ? 'event'
      : path === '/api/health' || path === '/api/ready' ? 'health'
        : path === '/api/recipients' || path === '/api/area-places' || path === '/api/places' ? 'lookup'
          : request.method === 'GET' || request.method === 'OPTIONS' ? 'read' : 'write';
    if (path.startsWith('/api/') && request.headers.origin === 'https://localhost') {
        response.setHeader('Access-Control-Allow-Origin', 'https://localhost');
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    }
    // Every POST, not a list of routes: a new route is gated without anyone remembering to add it.
    const mutation = (request.method === 'POST' && path.startsWith('/api/')) ||
      (request.method === 'DELETE' && /^\/api\/reports\/[a-f0-9-]+$/i.test(path));
    if (mutation) {
      if (!mutationOriginAllowed(request)) return json(response, 403, { error: 'invalid_origin' });
      if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return json(response, 415, { error: 'json_required' });
      }
    }
    if (activeRequests >= maxActiveRequests || activeByClass[routeClass] >= activeLimit[routeClass] ||
      (eventReport && activeEventReports.has(eventReport))) {
      response.setHeader('Retry-After', '1');
      return json(response, 429, { error: 'try_again' });
    }
    activeRequests++;
    activeByClass[routeClass]++;
    if (eventReport) activeEventReports.add(eventReport);
    response.once('close', () => {
      activeRequests--;
      activeByClass[routeClass]--;
      if (eventReport) activeEventReports.delete(eventReport);
    });
    try {
      if (request.method === 'OPTIONS' && path.startsWith('/api/') && request.headers.origin === 'https://localhost') {
        response.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, DELETE',
          'Access-Control-Allow-Headers': 'authorization, content-type'
        });
        return response.end();
      }
      if (request.method === 'GET' && request.url === '/api/challenge') {
        return json(response, 200, await reports.challenge());
      }
      if (request.method === 'POST' && request.url === '/api/places') {
        let payload: unknown;
        try { payload = await body(request); }
        catch { return json(response, 400, { error: 'invalid_query' }); }
        if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          Object.keys(payload).length !== 1 || typeof (payload as { query?: unknown }).query !== 'string') {
          return json(response, 400, { error: 'invalid_query' });
        }
        const abandoned = new AbortController();
        response.once('close', () => abandoned.abort());
        const result = await searchPlaces((payload as { query: string }).query, clientAddress(request), abandoned.signal);
        if (result.status === 429) response.setHeader('Retry-After', '1');
        return json(response, result.status, result.status === 200 ? { places: result.places } :
          { error: result.status === 400 ? 'invalid_query' : result.status === 429 ? 'try_again' : 'search_unavailable' });
      }
      if (request.method === 'GET' && request.url === '/api/health') {
        return json(response, 200, { status: 'ok' });
      }
      if (request.method === 'GET' && request.url === '/api/ready') {
        await pool.query('SELECT 1');
        // Nothing to answer a lookup from: not ready, though the database is up.
        if (!await geodataReady()) return json(response, 503, { error: 'geodata_unavailable' });
        return json(response, 200, { status: 'ready' });
      }
      if (request.method === 'GET' && request.url === '/api/worker-status') {
        const result = await pool.query(`SELECT count(*) FILTER (WHERE failed_reason IS NULL)::int AS queued,
            count(*) FILTER (WHERE failed_reason = 'computation_failed')::int AS terminal_failures,
            count(*) FILTER (WHERE failed_reason IS NOT NULL AND failed_reason <> 'computation_failed')::int AS domain_outcomes,
            greatest(0, extract(epoch FROM now() - min(available_at)
              FILTER (WHERE failed_reason IS NULL)))::int AS oldest_job_age_seconds
          FROM findings_job`);
        const integrity = await pool.query(`SELECT count(*) FILTER (WHERE failed_reason IS NULL)::int AS queued,
          count(*) FILTER (WHERE failed_reason IS NOT NULL)::int AS terminal_failures,
          greatest(0, extract(epoch FROM now() - min(requested_at)
            FILTER (WHERE failed_reason IS NULL)))::int AS oldest_age_seconds
          FROM integrity_refresh`);
        const pollAge = Math.floor((now() - workerStatus.lastPollAt) / 1000);
        const integrityPollAge = Math.floor((now() - workerStatus.lastIntegrityPollAt) / 1000);
        const oldestJobAge = result.rows[0].oldest_job_age_seconds;
        return json(response, 200, {
          status: pollAge > workerPollStaleAfterSeconds || oldestJobAge > jobQueueStaleAfterSeconds ||
            integrityPollAge > workerPollStaleAfterSeconds ||
            integrity.rows[0].oldest_age_seconds > jobQueueStaleAfterSeconds ? 'stale' : 'ok',
          last_poll_age_seconds: pollAge,
          integrity_last_poll_age_seconds: integrityPollAge,
          integrity_queued: integrity.rows[0].queued,
          integrity_terminal_failures: integrity.rows[0].terminal_failures,
          integrity_oldest_age_seconds: integrity.rows[0].oldest_age_seconds,
          api_503_by_class: { ...workerStatus.api503 },
          recovery_count: workerStatus.recoveryCount,
          database_recovery_count: workerStatus.databaseRecoveryCount,
          // Refusing in the last 15 minutes: the monitor's next run sees it whatever its timing.
          report_ceiling_active: workerStatus.reportCeilingRefusedAt !== undefined &&
            now() - workerStatus.reportCeilingRefusedAt < 900_000,
          ...result.rows[0]
        });
      }
      if (request.method === 'POST' && request.url === '/api/recipients') {
        let payload;
        try { payload = await body(request); }
        catch { return json(response, 400, { error: 'invalid_point' }); }
        const input = recipientLocationSchema.safeParse(payload);
        if (!input.success) return json(response, 400, { error: 'invalid_point' });
        const result = await lookupRecipients(input.data);
        return result ? json(response, 200, result) : json(response, 503, { error: 'jurisdiction_unavailable' });
      }
      if (request.method === 'POST' && request.url === '/api/area-places') {
        let input;
        try { input = areaSchema.safeParse(await body(request)); }
        catch { return json(response, 400, { error: 'invalid_area' }); }
        if (!input.success) return json(response, 400, { error: 'invalid_area' });
        return json(response, 200, await areaPlaces(input.data));
      }
      if (request.method === 'POST' && request.url === '/api/recipient-address-flags') {
        let input;
        try { input = addressFlagSchema.safeParse(await body(request)); }
        catch { return json(response, 400, { error: 'invalid_address_flag' }); }
        if (!input.success || !isKnownRecipient(input.data.kind, input.data.unit_id)) {
          return json(response, 400, { error: 'invalid_address_flag' });
        }
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const limit = await limits.take(client, clientAddress(request), 'address_flag');
          if (!limit.counts) {
            await client.query('ROLLBACK');
            response.setHeader('Retry-After', limit.retryAfter);
            return json(response, 429, { error: 'daily_limit' });
          }
          await client.query('INSERT INTO recipient_address_flag (kind, unit_id, flagged_on) VALUES ($1, $2, $3)',
            [input.data.kind, input.data.unit_id, warsawDay.format(now())]);
          await client.query('COMMIT');
          return json(response, 201, { status: 'recorded' });
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      }
      if (request.method === 'POST' && request.url === '/api/reports') {
        let input;
        let solution: unknown;
        try {
          const payload = await body(request);
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return json(response, 400, { error: 'invalid_report' });
          const { solution: supplied, ...fields } = payload as Record<string, unknown>;
          solution = supplied;
          input = reportSchema.safeParse(fields);
        } catch {
          return json(response, 400, { error: 'invalid_report' });
        }
        if (!input.success) return json(response, 400, { error: 'invalid_report' });
        const report = input.data;
        if (!timesWithinWindow(report, now())) return json(response, 400, { error: 'invalid_report' });
        const result = await reports.accept(report, solution, clientAddress(request));
        if (result.kind === 'limited') {
          response.setHeader('Retry-After', result.retryAfter);
          return json(response, 429, { error: 'daily_limit' });
        }
        if (result.kind === 'invalid_solution' || result.kind === 'used_solution') {
          return json(response, 403, { error: result.kind });
        }
        return json(response, result.kind === 'created' ? 201 : result.kind === 'replayed' ? 200 : result.kind === 'withdrawn' ? 410 : 409,
          { id: report.id });
      }
      const match = request.url?.match(/^\/api\/reports\/([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})(?:\/(findings|events))?$/i);
      if (request.method === 'DELETE' && match && !match[2]) {
        const id = match[1].toLowerCase();
        const outcome = await reports.withdraw(id, bearerToken(request), clientAddress(request));
        if (!outcome) return json(response, 404, { error: 'not_found' });
        if (typeof outcome === 'object') {
          response.setHeader('Retry-After', outcome.retryAfter);
          return json(response, 429, { error: 'daily_limit' });
        }
        response.writeHead(204, { 'cache-control': 'no-store' });
        return response.end();
      }
      if (request.method === 'POST' && match?.[2] === 'events') {
        const id = match[1].toLowerCase();
        if (!await reports.authorised(id, bearerToken(request))) return json(response, 404, { error: 'not_found' });
        let input;
        try { input = reportNoticeEventSchema.safeParse(await body(request)); }
        catch { return json(response, 400, { error: 'invalid_event' }); }
        if (!input.success) return json(response, 400, { error: 'invalid_event' });
        const outcome = await reports.recordEvent(id, input.data);
        if (outcome === 'not_found') return json(response, 404, { error: 'not_found' });
        if (outcome === 'event_limit') return json(response, 409, { error: 'event_limit' });
        if (outcome === 'notice_not_confirmed') return json(response, 409, { error: outcome });
        return json(response, outcome === 'created' ? 201 : outcome === 'replayed' ? 200 : 409,
          { id: input.data.id });
      }
      if (request.method === 'GET' && match?.[2] === 'findings') {
        const id = match[1].toLowerCase();
        if (!await reports.authorised(id, bearerToken(request))) return json(response, 404, { error: 'not_found' });
        const result = await pool.query(`SELECT f.rule_set_id, f.geodata_snapshot_id,
            s.created_at AS snapshot_date, s.datasets, f.dwelling_distance, f.obwod_lowiecki,
            f.accuracy_m, f.area_bounds, f.noc, f.okres_ochronny, f.protected_areas, f.nearest_ambona
          FROM findings f JOIN geodata_snapshot s ON s.id = f.geodata_snapshot_id
          WHERE f.report_id = $1 ORDER BY f.id LIMIT 1`, [id]);
        if (result.rowCount) return json(response, 200, { status: 'computed', ...result.rows[0] });
        const job = await pool.query('SELECT failed_reason FROM findings_job WHERE report_id = $1', [id]);
        return json(response, 200, job.rows[0]?.failed_reason
          ? { status: 'failed', reason: job.rows[0].failed_reason } : { status: 'pending' });
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) {
      // Query errors may contain Report facts. Never log the exception or request.
      errorClass = failureClass(error);
      noteDatabaseFailure(error);
      json(response, 503, { error: 'temporarily_unavailable' });
    }
  });
  const cleanup = () => pool.query('DELETE FROM rate_counter WHERE expires_at <= $1', [new Date(now())]).catch(() => {});
  const expiryTimer = setInterval(() => void cleanup(), 60_000);
  expiryTimer.unref();
  server.on('listening', () => void cleanup());
  server.on('close', () => { limits.stop(); clearInterval(expiryTimer); });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}
