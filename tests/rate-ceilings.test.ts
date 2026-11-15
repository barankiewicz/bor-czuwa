import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startClockedApi } from './helpers/clocked-api.ts';
import { solve, reportAt } from './helpers/reports.ts';
import { rateLimit } from '../server/rate-limit.ts';

// A free tunnel-broker /48 holds 65,536 /64s, so the per-/64 ceiling alone lets one person file
// millions of Reports a day. The /48 ceiling closes that without touching IPv4 CGNAT clients.
test('IPv6 Reports also share a daily ceiling per /48', async () => {
  const prior = process.env.TRUSTED_PROXY_IP;
  process.env.TRUSTED_PROXY_IP = '127.0.0.1';
  let isolated: Awaited<ReturnType<typeof startClockedApi>> | undefined;
  try {
    isolated = await startClockedApi(Date.now());
    const base = isolated.base;
    const post = async (address: string) => {
      const solution = solve(await (await fetch(`${base}/api/challenge`)).json());
      return fetch(`${base}/api/reports`, { method: 'POST', headers: {
        'content-type': 'application/json', 'x-real-ip': address }, body: JSON.stringify({ ...reportAt(), solution }) });
    };
    for (let index = 0; index < 200; index++) {
      assert.equal((await post(`2001:db8:7:${Math.floor(index / 50)}::${index + 1}`)).status, 201, `Report ${index + 1}`);
    }
    const refused = await post('2001:db8:7:ff::1');
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get('retry-after')) > 0);
    assert.equal((await post('2001:db8:8:0::1')).status, 201);
    assert.equal((await post('192.0.2.7')).status, 201);
  } finally {
    try { await isolated?.close(); }
    finally {
      if (prior === undefined) delete process.env.TRUSTED_PROXY_IP;
      else process.env.TRUSTED_PROXY_IP = prior;
    }
  }
});

// Per-address ceilings cannot stop a flood from many addresses. A refused Report stays queued
// on the phone (ADR-0008), so a service-wide hourly ceiling delays honest Reports, never loses them.
test('Reports from the whole service share an hourly ceiling that reopens the next hour', async () => {
  let isolated: Awaited<ReturnType<typeof startClockedApi>> | undefined;
  const hour = Date.UTC(2026, 10, 14, 10);
  let now = hour + 5 * 60_000;
  const limits = rateLimit(() => now);
  try {
    isolated = await startClockedApi(now);
    const client = isolated.database as unknown as Parameters<typeof limits.takeReport>[0];
    for (let index = 0; index < 600; index++) {
      const taken = await limits.takeReport(client, `198.51.${Math.floor(index / 250)}.${index % 250}`);
      assert.ok(taken.counts, `Report ${index + 1}`);
    }
    // Every refused phone would otherwise come back in the same second at the full hour, so the wait
    // runs to the next hour plus a random part of the hour after it.
    const waits = new Set<number>();
    for (let index = 0; index < 20; index++) {
      const refused = await limits.takeReport(client, `203.0.113.${index}`);
      assert.equal(refused.counts, undefined);
      assert.equal(refused.serviceCeiling, true);
      assert.ok(refused.retryAfter >= 55 * 60 && refused.retryAfter < 115 * 60, String(refused.retryAfter));
      waits.add(refused.retryAfter);
    }
    assert.ok(waits.size > 10, 'Retry-After is spread');
    now = hour + 3600_000;
    assert.ok((await limits.takeReport(client, '203.0.113.9')).counts);
  } finally {
    limits.stop();
    await isolated?.close();
  }
});

test('the hourly ceiling comes from REPORT_HOURLY_CEILING and refuses to start on a bad value', async () => {
  const prior = process.env.REPORT_HOURLY_CEILING;
  let isolated: Awaited<ReturnType<typeof startClockedApi>> | undefined;
  const now = Date.UTC(2026, 10, 14, 10, 5);
  try {
    for (const bad of ['0', '-5', '1.5', 'many', ' 600']) {
      process.env.REPORT_HOURLY_CEILING = bad;
      assert.throws(() => rateLimit(() => now), /REPORT_HOURLY_CEILING/, bad);
    }
    process.env.REPORT_HOURLY_CEILING = '3';
    const limits = rateLimit(() => now);
    try {
      isolated = await startClockedApi(now);
      const client = isolated.database as unknown as Parameters<typeof limits.takeReport>[0];
      for (let index = 0; index < 3; index++) assert.ok((await limits.takeReport(client, `198.51.100.${index}`)).counts);
      assert.equal((await limits.takeReport(client, '198.51.100.9')).counts, undefined);
    } finally { limits.stop(); }
  } finally {
    if (prior === undefined) delete process.env.REPORT_HOURLY_CEILING;
    else process.env.REPORT_HOURLY_CEILING = prior;
    await isolated?.close();
  }
});
