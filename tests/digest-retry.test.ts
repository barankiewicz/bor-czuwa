import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryDigest } from '../server/operator.ts';

test('a failing digest run is retried up to 3 attempts, then gives up loudly', async () => {
  let calls = 0;
  const result = await retryDigest(async () => { if (++calls < 3) throw new Error('smtp_down'); return 'sent'; },
    { attempts: 3, delayMs: 0 });
  assert.equal(result, 'sent');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retryDigest(async () => { calls++; throw new Error('smtp_down'); }, { attempts: 3, delayMs: 0 }),
    /digest_gave_up_after_3_attempts: smtp_down/);
  assert.equal(calls, 3);
});
