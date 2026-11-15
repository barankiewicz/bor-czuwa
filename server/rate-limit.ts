import { createHmac, randomBytes, randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import type { PoolClient } from 'pg';

const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' });

export function rateAddress(address: string) {
  if (isIP(address) !== 6) return address;
  // URL canonicalization expands embedded IPv4 into hexadecimal and normalizes compression.
  const canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [left, right = ''] = canonical.split('::');
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  const groups = canonical.includes('::')
    ? [...start, ...Array(8 - start.length - end.length).fill('0'), ...end] : start;
  const words = groups.map(group => parseInt(group, 16));
  // Node's dual-stack listener presents IPv4 peers as mapped IPv6; nginx sees IPv4.
  if (words.slice(0, 5).every(word => word === 0) && words[5] === 0xffff) {
    return [words[6] >> 8, words[6] & 255, words[7] >> 8, words[7] & 255].join('.');
  }
  return words.slice(0, 4).map(word => word.toString(16).padStart(4, '0')).join(':') + '::/64';
}

// The /48 holding an address's /64, or undefined for IPv4.
function rateAddress48(address: string) {
  const key = rateAddress(address);
  return key.endsWith('::/64') ? key.split(':').slice(0, 3).join(':') + '::/48' : undefined;
}

function nextMidnight(now: number) {
  const today = day.format(now);
  let low = Math.floor(now / 1000);
  let high = low + 26 * 3600;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (day.format(middle * 1000) === today) low = middle;
    else high = middle;
  }
  return high * 1000;
}

// Hard ceilings that refuse a write. Everything below them is accepted and only measured (ADR-0008).
const addressDaily = 50;
// An IPv6 /48 is one site's allocation: a free tunnel broker hands one out with 65,536 /64s in it.
const prefixDaily = 200;

// The service-wide ceiling is the one number the operator may need to raise in a hurry (a Report
// going viral looks exactly like a flood from here), so it lives in runtime.env, not in a release.
function serviceHourlyCeiling() {
  const value = process.env.REPORT_HOURLY_CEILING;
  if (value === undefined || value === '') return 600;
  if (!/^[1-9][0-9]{0,6}$/.test(value)) throw new Error('REPORT_HOURLY_CEILING must be a whole number from 1');
  return Number(value);
}

export function rateLimit(now: () => number) {
  const serviceHourly = serviceHourlyCeiling();
  let salt = randomBytes(32);
  let rotation = nextMidnight(now());
  let timer: ReturnType<typeof setTimeout>;
  function rotate() {
    salt = randomBytes(32);
    rotation = nextMidnight(now());
    schedule();
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(rotate, Math.max(1, rotation - now()));
    timer.unref();
  }
  schedule();
  async function count(client: PoolClient, key: string, at: number, ceiling: { daily?: number; hourly?: number }) {
    const hash = createHmac('sha256', salt).update(key).digest('hex');
    const result = await client.query(`INSERT INTO rate_counter (ip_hash, daily_count, hourly_count, hour_start, expires_at)
      VALUES ($1, 1, 1, date_trunc('hour', $2::timestamptz), $3::timestamptz)
      ON CONFLICT (ip_hash) DO UPDATE SET
        daily_count = rate_counter.daily_count + 1,
        hourly_count = CASE WHEN rate_counter.hour_start = EXCLUDED.hour_start THEN rate_counter.hourly_count + 1 ELSE 1 END,
        hour_start = EXCLUDED.hour_start, expires_at = EXCLUDED.expires_at
      WHERE ($4::integer IS NULL OR rate_counter.daily_count < $4)
        AND ($5::integer IS NULL OR rate_counter.hour_start <> EXCLUDED.hour_start OR rate_counter.hourly_count < $5)
      RETURNING daily_count AS daily, hourly_count AS hourly`,
    [hash, new Date(at), new Date(rotation), ceiling.daily ?? null, ceiling.hourly ?? null]);
    return result.rows[0] as { daily: number; hourly: number } | undefined;
  }
  function untilMidnight(at: number) { return Math.max(1, Math.ceil((rotation - at) / 1000)); }
  return {
    stop: () => clearTimeout(timer),
    async take(client: PoolClient, address: string, scope: 'address_flag') {
      const at = now();
      if (at >= rotation) rotate();
      return { counts: await count(client, `${scope}\0${rateAddress(address)}`, at, { daily: addressDaily }),
        retryAfter: untilMidnight(at) };
    },
    async takeWithdrawal(client: PoolClient, address: string) {
      const at = now();
      if (at >= rotation) rotate();
      const counts = await count(client, `withdrawal\0${rateAddress(address)}`, at, { daily: addressDaily });
      const prefix = rateAddress48(address);
      if (counts && prefix && !await count(client, `withdrawal48\0${prefix}`, at, { daily: prefixDaily })) {
        return { counts: undefined, retryAfter: untilMidnight(at) };
      }
      return { counts, retryAfter: untilMidnight(at) };
    },
    async takeReport(client: PoolClient, address: string) {
      const at = now();
      if (at >= rotation) rotate();
      const key = rateAddress(address);
      const counts = await count(client, `report\0${key}`, at, { daily: addressDaily });
      if (!counts) return { counts, retryAfter: untilMidnight(at) };
      const prefix = rateAddress48(address);
      if (prefix && !await count(client, `report48\0${prefix}`, at, { daily: prefixDaily })) {
        return { counts: undefined, retryAfter: untilMidnight(at) };
      }
      if (!await count(client, 'service', at, { hourly: serviceHourly })) {
        // To the next full hour plus a random part of the one after, so queued phones do not all
        // return in the same second and the quickest of them win again.
        const nextHour = Math.ceil(((Math.floor(at / 3600_000) + 1) * 3600_000 - at) / 1000);
        return { counts: undefined, retryAfter: Math.max(1, nextHour) + randomInt(3600), serviceCeiling: true };
      }
      return { counts, retryAfter: untilMidnight(at) };
    }
  };
}
