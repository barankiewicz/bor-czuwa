import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { placeSearch } from '../server/place-search.ts';

test('place search sends only entered text, bounds upstream calls, and caches results', async () => {
  let clock = 1000;
  const urls: URL[] = [];
  const search = placeSearch(async input => {
    urls.push(new URL(String(input)));
    return new Response(JSON.stringify([{ display_name: 'Białystok', lat: '53.1325', lon: '23.1688' }]));
  }, () => clock, async ms => { clock += ms; });
  assert.deepEqual(await search('a', 'A'), { status: 400 });
  assert.deepEqual(await search('Białystok', 'A'), { status: 200,
    places: [{ name: 'Białystok', lat: 53.1325, lon: 23.1688 }] });
  assert.equal(urls[0].searchParams.get('q'), 'Białystok');
  assert.equal(urls[0].searchParams.get('limit'), '5');
  assert.equal(urls[0].searchParams.get('countrycodes'), 'pl');
  assert.deepEqual(await search('Białystok', 'A'), { status: 200,
    places: [{ name: 'Białystok', lat: 53.1325, lon: 23.1688 }] });
  // The second upstream call waits out the one-second gap instead of going at once.
  const before = clock;
  assert.equal((await search('Warszawa', 'A')).status, 200);
  assert.ok(clock - before >= 1000);
  assert.equal(urls.length, 2);
});

// Virtual time: sleepers wake in order, and microtasks settle before the clock moves on.
function sim() {
  let clock = 1000;
  const sleepers: { at: number; wake: () => void }[] = [];
  const fetches: number[] = [];
  const search = placeSearch(async () => {
    fetches.push(clock);
    return new Response(JSON.stringify([{ display_name: 'x', lat: '53', lon: '23' }]));
  }, () => clock, ms => new Promise<void>(resolve => sleepers.push({ at: clock + ms, wake: resolve })));
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  async function advance(to: number) {
    await settle();
    for (;;) {
      sleepers.sort((a, b) => a.at - b.at);
      const next = sleepers[0];
      if (!next || next.at > to) break;
      sleepers.shift();
      clock = Math.max(clock, next.at);
      next.wake();
      await settle();
    }
    clock = Math.max(clock, to);
    await settle();
  }
  const at = async (time: number, run: () => void) => { await advance(1000 + time); run(); await settle(); };
  return { search, fetches, advance, at, now: () => clock - 1000 };
}

test('a client hammering once a second cannot starve a second client', async () => {
  // Two clients at 1 request a second ask for 2 a second against a 1 a second ceiling, so the
  // victim cannot be served every time; round-robin gives it half. Before, it got 0 of 6.
  const s = sim();
  const attacker: Promise<{ status: number }>[] = [];
  const victim: Promise<{ status: number }>[] = [];
  for (let round = 0; round < 6; round++) {
    await s.at(round * 1000, () => { attacker.push(s.search(`attacker ${round}`, 'A')); });
    await s.at(round * 1000 + 500, () => { victim.push(s.search(`victim ${round}`, 'V')); });
  }
  await s.advance(1000 + 20_000);
  const statuses = (await Promise.all(victim)).map(r => r.status);
  assert.ok(statuses.filter(code => code === 200).length >= 3, `victim got ${statuses}`);
  assert.equal(statuses[0], 200);
});

test('a victim within its fair share is served on every attempt while an attacker hammers', async () => {
  const s = sim();
  const attacker: Promise<{ status: number }>[] = [];
  const victim: Promise<{ status: number }>[] = [];
  for (let round = 0; round < 6; round++) {
    await s.at(round * 2000, () => { attacker.push(s.search(`attacker ${round}`, 'A')); });
    await s.at(round * 2000 + 500, () => { victim.push(s.search(`victim ${round}`, 'V')); });
    await s.at(round * 2000 + 1000, () => { attacker.push(s.search(`attacker again ${round}`, 'A')); });
  }
  await s.advance(1000 + 30_000);
  assert.deepEqual((await Promise.all(victim)).map(r => r.status), [200, 200, 200, 200, 200, 200]);
});

test('the victim alone still gets 200 on every round', async () => {
  const s = sim();
  const victim: Promise<{ status: number }>[] = [];
  for (let round = 0; round < 6; round++) await s.at(round * 1000 + 500, () => { victim.push(s.search(`victim ${round}`, 'V')); });
  await s.advance(1000 + 20_000);
  assert.deepEqual((await Promise.all(victim)).map(r => r.status), [200, 200, 200, 200, 200, 200]);
});

test('three clients at once are each served, one upstream call per second', async () => {
  const s = sim();
  const outcome: Record<string, number[]> = { A: [], B: [], C: [] };
  const pending: Promise<void>[] = [];
  for (let round = 0; round < 3; round++) {
    await s.at(round * 1000, () => {
      for (const client of ['A', 'B', 'C']) {
        pending.push(s.search(`${client} ${round}`, client).then(r => { outcome[client].push(r.status); }));
      }
    });
  }
  await s.advance(1000 + 30_000);
  await Promise.all(pending);
  for (const client of ['A', 'B', 'C']) {
    assert.equal(outcome[client].length, 3);
    assert.ok(outcome[client].includes(200), `client ${client} never served: ${outcome[client]}`);
    assert.ok(outcome[client].every(code => code === 200 || code === 429));
  }
  assert.equal(outcome.A.filter(code => code === 200).length + outcome.B.filter(code => code === 200).length +
    outcome.C.filter(code => code === 200).length, s.fetches.length);
  for (let i = 1; i < s.fetches.length; i++) assert.ok(s.fetches[i] - s.fetches[i - 1] >= 1000, `gap ${s.fetches[i] - s.fetches[i - 1]}`);
});

test('a queued search that is abandoned frees its place and spends no upstream call', async () => {
  const s = sim();
  await s.at(0, () => { void s.search('pierwsze', 'A'); });
  const abandoned = new AbortController();
  let first: Promise<{ status: number }> | undefined;
  await s.at(100, () => { first = s.search('drugie', 'A', abandoned.signal); });
  await s.at(200, () => abandoned.abort());
  let replacement: Promise<{ status: number }> | undefined;
  await s.at(300, () => { replacement = s.search('trzecie', 'A'); });
  await s.advance(1000 + 10_000);
  assert.equal((await replacement!).status, 200);
  assert.equal((await first!).status, 429);
  assert.equal(s.fetches.length, 2);
});

test('client keys expire by themselves, with no later request to prune them', async () => {
  const s = sim();
  await s.at(0, () => { void s.search('pierwsze', 'A'); });
  await s.advance(1000 + 10);
  assert.equal(s.search.tracked(), 1);
  await s.advance(1000 + 11_000);
  assert.equal(s.search.tracked(), 0);
});

test('two requests from one client inside a second never make two upstream calls inside it', async () => {
  const s = sim();
  const answers: Promise<{ status: number }>[] = [];
  await s.at(0, () => { answers.push(s.search('pierwsze', 'A')); });
  await s.at(200, () => { answers.push(s.search('drugie', 'A')); });
  await s.at(300, () => { answers.push(s.search('trzecie', 'A')); });
  await s.advance(1000 + 10_000);
  const statuses = (await Promise.all(answers)).map(r => r.status);
  assert.equal(statuses[2], 429);
  for (let i = 1; i < s.fetches.length; i++) assert.ok(s.fetches[i] - s.fetches[i - 1] >= 1000);
});

test('client entries expire and the table does not grow with distinct clients', async () => {
  const s = sim();
  let peak = 0;
  for (let i = 0; i < 10_000; i++) {
    const answer = s.search(`miasto ${i}`, `client-${i}`);
    await s.advance(1000 + (i + 1) * 1000);
    assert.equal((await answer).status, 200);
    peak = Math.max(peak, s.search.tracked());
  }
  assert.ok(peak <= 12, `peak ${peak}`);
  await s.advance(1000 + 10_000 * 1000 + 11_000);
  assert.equal(s.search.tracked(), 0);
});

test('a burst is served one a second, and what cannot go within 3 s gets 429', async () => {
  const s = sim();
  const answers: Promise<{ status: number }>[] = [];
  await s.at(0, () => { for (let i = 0; i < 6; i++) answers.push(s.search(`miasto ${i}`, `c${i}`)); });
  await s.advance(1000 + 20_000);
  const statuses = (await Promise.all(answers)).map(r => r.status);
  assert.equal(statuses.filter(code => code === 200).length, 3);
  assert.equal(statuses.filter(code => code === 429).length, 3);
});

test('round-robin survives rate entries expiring: a waiting client goes before a repeat client', async () => {
  const s = sim();
  const order: string[] = [];
  const ask = (text: string, client: string) => { void s.search(text, client).then(() => { order.push(text); }); };
  await s.at(0, () => ask('B first', 'B'));
  await s.at(500, () => ask('B second', 'B'));
  await s.at(600, () => ask('A only', 'A'));
  await s.advance(1000 + 10_000);
  assert.deepEqual(order, ['B first', 'A only', 'B second']);
});

test('a client that queued twice does not go ahead of clients that arrived after its first request', async () => {
  const s = sim();
  const order: string[] = [];
  const ask = (text: string, client: string) => { void s.search(text, client).then(() => { order.push(text); }); };
  await s.at(0, () => ask('A first', 'A'));
  await s.at(100, () => ask('A second', 'A'));
  await s.at(200, () => ask('Bydgoszcz', 'B'));
  await s.at(300, () => ask('Chełm', 'C'));
  await s.advance(1000 + 10_000);
  assert.deepEqual(order, ['A first', 'Bydgoszcz', 'Chełm', 'A second']);
});

test('no client key outlives a burst whose waiters time out after the table empties', async () => {
  const s = sim();
  await s.at(0, () => { for (const client of ['A', 'B', 'C', 'D', 'E']) void s.search(`miasto ${client}`, client); });
  await s.advance(1000 + 3500);
  await s.advance(1000 + 60_000);
  assert.equal(s.search.tracked(), 0);
});

test('a repeat request from the last served client never reorders clients already waiting', async () => {
  const s = sim();
  const outcome: Record<string, { status: number; at: number }> = {};
  const ask = (text: string, client: string) => { void s.search(text, client).then(r => { outcome[text] = { status: r.status, at: s.now() }; }); };
  await s.at(0, () => ask('A pierwsze', 'A'));
  await s.at(100, () => ask('B czeka', 'B'));
  await s.at(200, () => ask('A drugie', 'A'));
  await s.at(300, () => ask('C czeka', 'C'));
  await s.at(1001, () => ask('C znowu', 'C'));
  await s.at(1002, () => ask('D dochodzi', 'D'));
  await s.advance(1000 + 10_000);
  assert.deepEqual(outcome['B czeka'], { status: 200, at: 1000 });
  assert.equal(outcome['A pierwsze'].status, 200);
  // Waiting clients keep their turns: C then D go at 2000 and 3000, nobody ahead of them is skipped.
  assert.deepEqual([outcome['C czeka'], outcome['D dochodzi']], [{ status: 200, at: 2000 }, { status: 200, at: 3000 }]);
  assert.equal(outcome['C znowu'].status, 429);
  assert.deepEqual(s.fetches.slice(1).map((t, i) => t - s.fetches[i]), [1000, 1000, 1000]);
});

test('five steady clients each get about a fifth of the slots, none locked out', async () => {
  const s = sim();
  const wins: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const pending: Promise<void>[] = [];
  for (let round = 0; round < 30; round++) {
    await s.at(round * 1000, () => {
      for (const client of ['A', 'B', 'C', 'D', 'E']) {
        pending.push(s.search(`miasto ${client} ${round}`, client).then(r => { if (r.status === 200) wins[client]++; }));
      }
    });
  }
  await s.advance(1000 + 40_000);
  await Promise.all(pending);
  for (const client of Object.keys(wins)) assert.ok(wins[client] >= 5, `client ${client} got ${wins[client]} of 30: ${JSON.stringify(wins)}`);
  for (let i = 1; i < s.fetches.length; i++) assert.ok(s.fetches[i] - s.fetches[i - 1] >= 1000);
});

test('continuous traffic from 10 000 distinct clients never accumulates client state', async () => {
  const s = sim();
  let peak = 0;
  for (let i = 0; i < 10_000; i++) {
    const answer = s.search(`miasto ${i}`, `client-${i}`);
    await s.advance(1000 + (i + 1) * 1000);
    await answer;
    peak = Math.max(peak, s.search.tracked());
  }
  assert.ok(peak <= 12, `peak ${peak}`);
});
