import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'vite';
import { noFileWatcher } from './helpers/no-file-watcher.ts';

const root = new URL('..', import.meta.url).pathname;

test('native invitation readiness, invalidation and unused response bodies retain their boundaries', async () => {
  const previousRecipient = process.env.VITE_DEMO_TEST_RECIPIENT;
  const previousOrigin = process.env.VITE_API_ORIGIN;
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const previousBridge = Object.getOwnPropertyDescriptor(globalThis, 'androidBridge');
  const previousFetch = globalThis.fetch;
  process.env.VITE_DEMO_TEST_RECIPIENT = 'synthetic-test@example.invalid';
  process.env.VITE_API_ORIGIN = 'https://demo.example.invalid';
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {} });
  Object.defineProperty(globalThis, 'androidBridge', { configurable: true, value: {} });
  const server = await createServer({ root, mode: 'staging', server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom', plugins: [noFileWatcher] });
  try {
    const { Capacitor } = await server.ssrLoadModule('@capacitor/core');
    const native = Capacitor.isNativePlatform;
    Capacitor.isNativePlatform = () => true;
    try {
      const transport = await server.ssrLoadModule('/src/lib/api-url.ts');
      let calls = 0;
      let canceledBodies = 0;
      let networkFailure = false;
      let status = 401;
      const states: boolean[] = [];
      const unsubscribe = transport.watchNativeDemoInvitation((accepted: boolean) => states.push(accepted));
      globalThis.fetch = (async () => {
        calls++;
        if (networkFailure) throw new TypeError('synthetic-network-failure');
        const bytes = new TextEncoder().encode(JSON.stringify({ status: status === 200 ? 'ready' : 'unavailable' }));
        return new Response(new ReadableStream({
          start(controller) { controller.enqueue(bytes); controller.close(); },
          cancel() { canceledBodies++; }
        }), { status, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
      const invitation = 'a'.repeat(64);
      await assert.rejects(() => transport.connectNativeDemo('invalid'), /demo_invitation_invalid/);
      assert.equal(calls, 0);
      await assert.rejects(() => transport.connectNativeDemo(invitation), /demo_invitation_refused/);
      assert.equal(transport.hasNativeDemoInvitation(), false);
      assert.equal(canceledBodies, 1, 'refused readiness must release its unused response body');
      status = 200;
      await transport.connectNativeDemo(invitation);
      assert.equal(transport.hasNativeDemoInvitation(), true);
      status = 503;
      await assert.rejects(() => transport.connectNativeDemo(invitation), /demo_unavailable/);
      assert.equal(canceledBodies, 2, 'unavailable readiness must release its unused response body');
      assert.equal(transport.hasNativeDemoInvitation(), true);
      networkFailure = true;
      await assert.rejects(() => transport.connectNativeDemo(invitation), /synthetic-network-failure/);
      assert.equal(transport.hasNativeDemoInvitation(), true);
      networkFailure = false;
      status = 200;
      for (const path of ['/api/../../outside', '/api/one#fragment', '/api/\\outside', '//other.example/api/']) {
        assert.throws(() => transport.apiFetch(path), /demo_api_path_refused/);
      }
      transport.clearNativeDemoInvitation();
      assert.equal(transport.hasNativeDemoInvitation(), false);
      await transport.connectNativeDemo(invitation);
      status = 403;
      const proofRefusal = await transport.apiFetch('/api/reports');
      await proofRefusal.body?.cancel();
      assert.equal(transport.hasNativeDemoInvitation(), true, 'a proof refusal must not clear the invitation');
      status = 401;
      const gateRefusal = await transport.apiFetch('/api/challenge');
      await gateRefusal.body?.cancel();
      assert.equal(transport.hasNativeDemoInvitation(), false);
      assert.deepEqual(states, [false, true, false, true, false]);
      unsubscribe();
      Capacitor.isNativePlatform = () => false;
      Reflect.deleteProperty(globalThis, 'androidBridge');
      await assert.rejects(() => transport.connectNativeDemo(invitation), /demo_native_only/);
    } finally { Capacitor.isNativePlatform = native; }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    if (previousBridge) Object.defineProperty(globalThis, 'androidBridge', previousBridge);
    else Reflect.deleteProperty(globalThis, 'androidBridge');
    if (previousRecipient === undefined) delete process.env.VITE_DEMO_TEST_RECIPIENT;
    else process.env.VITE_DEMO_TEST_RECIPIENT = previousRecipient;
    if (previousOrigin === undefined) delete process.env.VITE_API_ORIGIN;
    else process.env.VITE_API_ORIGIN = previousOrigin;
    await server.close();
  }
});
