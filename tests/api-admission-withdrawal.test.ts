import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { startClockedApi } from './helpers/clocked-api.ts';
import { solve, reportAt } from './helpers/reports.ts';

// One API with its own database and no workers, behind a trusted proxy so each request can
// present its own client address.
let api: Awaited<ReturnType<typeof startClockedApi>>;
let prior: string | undefined;
before(async () => {
  prior = process.env.TRUSTED_PROXY_IP;
  process.env.TRUSTED_PROXY_IP = '127.0.0.1';
  api = await startClockedApi(Date.now());
});
after(async () => {
  try { await api?.close(); }
  finally {
    if (prior === undefined) delete process.env.TRUSTED_PROXY_IP;
    else process.env.TRUSTED_PROXY_IP = prior;
  }
});

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
async function challenge() { return solve(await (await fetch(`${api.base}/api/challenge`)).json()); }
const send = (body: unknown, address: string) => fetch(`${api.base}/api/reports`, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-real-ip': address }, body: JSON.stringify(body) });
const withdraw = (id: string, token: string, address: string) => fetch(`${api.base}/api/reports/${id}`, {
  method: 'DELETE', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-real-ip': address } });

test('replaying an accepted Report with its one solution spends the address budget', async () => {
  const body = { ...reportAt(), solution: await challenge() };
  const address = '198.51.100.10';
  assert.equal((await send(body, address)).status, 201);
  // The first Report took 1 of the 50 daily counts; 49 replays take the rest.
  for (let replay = 0; replay < 49; replay++) assert.equal((await send(body, address)).status, 200, `replay ${replay + 1}`);
  const refused = await send(body, address);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
});

test('the same solution replayed from a second address is charged to that address', async () => {
  const body = { ...reportAt(), solution: await challenge() };
  assert.equal((await send(body, '198.51.100.12')).status, 201);
  for (let replay = 0; replay < 50; replay++) assert.equal((await send(body, '198.51.100.13')).status, 200, `replay ${replay + 1}`);
  assert.equal((await send(body, '198.51.100.13')).status, 429);
  // The first address spent only its one count.
  assert.equal((await send(body, '198.51.100.12')).status, 200);
});

test('a conflicting resend of an accepted id also spends the budget', async () => {
  const report = reportAt();
  const solution = await challenge();
  const address = '198.51.100.11';
  assert.equal((await send({ ...report, solution }, address)).status, 201);
  const other = { ...report, token_sha256: hashOf(randomUUID()), solution };
  for (let resend = 0; resend < 49; resend++) assert.equal((await send(other, address)).status, 409, `resend ${resend + 1}`);
  assert.equal((await send(other, address)).status, 429);
});

test('a tombstone binds to its token hash and blocks only the Report it names', async () => {
  const report = reportAt();
  const token = randomBytes(32).toString('hex');
  assert.equal((await withdraw(report.id, token, '198.51.100.20')).status, 204);
  const stranger = { ...report, token_sha256: hashOf(randomBytes(32).toString('hex')) };
  assert.equal((await send({ ...stranger, solution: await challenge() }, '198.51.100.21')).status, 201);
  const forgotten = reportAt();
  const mine = randomBytes(32).toString('hex');
  assert.equal((await withdraw(forgotten.id, mine, '198.51.100.22')).status, 204);
  // Control: the owner of the token is still stopped.
  assert.equal((await send({ ...forgotten, token_sha256: hashOf(mine), solution: await challenge() }, '198.51.100.23')).status, 410);
});

test('a wrong token on an existing id answers exactly like an unknown id', async () => {
  const report = reportAt();
  assert.equal((await send({ ...report, solution: await challenge() }, '198.51.100.30')).status, 201);
  const wrong = await withdraw(report.id, randomBytes(32).toString('hex'), '198.51.100.31');
  const unknown = await withdraw(randomUUID(), randomBytes(32).toString('hex'), '198.51.100.32');
  assert.equal(wrong.status, unknown.status);
  assert.equal(await wrong.text(), await unknown.text());
  assert.equal(wrong.status, 204);
  // The Report survives, and a resend still reports it as the same Report.
  assert.equal((await send({ ...report, solution: await challenge() }, '198.51.100.33')).status, 200);
});

test('withdrawals from many /64s in one /48 hit the /48 ceiling', async () => {
  const statuses: number[] = [];
  for (let index = 0; index < 260; index++) {
    statuses.push((await withdraw(randomUUID(), randomBytes(32).toString('hex'), `2001:db8:9:${index.toString(16)}::1`)).status);
  }
  assert.equal(statuses.filter(status => status === 204).length, 200);
  assert.equal(statuses.filter(status => status === 429).length, 60);
  // Another /48 and IPv4 are untouched.
  assert.equal((await withdraw(randomUUID(), randomBytes(32).toString('hex'), '2001:db8:a:0::1')).status, 204);
  assert.equal((await withdraw(randomUUID(), randomBytes(32).toString('hex'), '192.0.2.9')).status, 204);
});
