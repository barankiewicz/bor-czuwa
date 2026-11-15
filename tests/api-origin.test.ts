import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { mutationOriginAllowed } from '../server/api.ts';

// nginx forwards the server block's own name, so the app host's block names the app host.
function viaProxy(origin: string | undefined, forwardedHost = 'app.example.test') {
  return { socket: { remoteAddress: '127.0.0.1' },
    headers: { origin, 'x-forwarded-host': forwardedHost, 'x-forwarded-proto': 'https' } } as unknown as IncomingMessage;
}

test('a mutation from the app host is allowed and one from the apex is refused', () => {
  process.env.TRUSTED_PROXY_IP = '127.0.0.1';
  assert.equal(mutationOriginAllowed(viaProxy('https://app.example.test')), true);
  assert.equal(mutationOriginAllowed(viaProxy('https://example.test')), false);
  assert.equal(mutationOriginAllowed(viaProxy('https://localhost')), true);
  assert.equal(mutationOriginAllowed(viaProxy(undefined)), true);
});
