import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureClass } from '../server/failure-class.ts';

test('failure classes discard private messages and untrusted labels', () => {
  assert.equal(failureClass({ code: '23514', message: 'private report', query: 'private query' }), '23514');
  assert.equal(failureClass({ code: 'private report', name: 'private report' }), 'Error');
  assert.equal(failureClass(new TypeError('private report')), 'TypeError');
});
