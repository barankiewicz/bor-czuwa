import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';

// Losing the database connection while a worker or request holds a checked-out client must reject
// that query and be recorded, never end the process. The child talks to PostgreSQL through a proxy
// this test cuts, so the client sees "Connection terminated unexpectedly" as it does when postgres dies.
test('a database that disappears under a checked-out client rejects the query and the process survives', async () => {
  const target = new URL(process.env.TEST_RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL!);
  const sockets = new Set<net.Socket>();
  const proxy = net.createServer(client => {
    const upstream = net.connect(Number(target.port || 5432), target.hostname);
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
      socket.on('close', () => sockets.delete(socket));
    }
    client.pipe(upstream);
    upstream.pipe(client);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const { port } = proxy.address() as net.AddressInfo;
  const url = new URL(target.href);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  const child = fork(new URL('./helpers/db-client-loss-process.ts', import.meta.url), [], {
    env: { ...process.env, DATABASE_URL: url.href }, execArgv: process.execArgv
  });
  const steps: Record<string, any> = {};
  const exited = once(child, 'exit');
  child.on('message', (message: any) => { steps[message.step] = message; });
  const waitFor = async (step: string) => {
    for (let attempt = 0; attempt < 300 && !steps[step] && child.exitCode === null; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  try {
    await waitFor('held');
    assert.ok(steps.held, 'the child holds a client');
    await new Promise(resolve => setTimeout(resolve, 300));
    const closed = once(proxy, 'close');
    proxy.close();
    for (const socket of sockets) socket.destroy();
    await closed;
    // Reopen only after the child has reported a failed readiness, so a slow child cannot miss the outage.
    await waitFor('outage');
    assert.ok(steps.outage, `readiness reported the outage (exit ${child.exitCode})`);
    proxy.listen(port, '127.0.0.1');
    await once(proxy, 'listening');
    await waitFor('done');
    assert.ok(steps.done, `the process survived the loss (exit ${child.exitCode})`);
    assert.equal(steps['ready-before'].status, 200);
    assert.match(steps.rejected.message, /terminated|ECONNRESET|57P01/i, 'the in-flight query rejects');
    assert.ok(steps.done, 'readiness polling finished');
    assert.ok(steps.done.statuses.some((status: number) => status !== 200), 'readiness saw the outage');
    assert.equal(steps.done.statuses.at(-1), 200, 'readiness recovers when the database returns');
    assert.ok(steps.done.recoveryCount >= 1, 'the failure was recorded and the recovery counted');
    const [code] = await exited;
    assert.equal(code, 0, 'the process ended by itself after recovering, not by an unhandled error');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    for (const socket of sockets) socket.destroy();
    if (proxy.listening) proxy.close();
  }
});
