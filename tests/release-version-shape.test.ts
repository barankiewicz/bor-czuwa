import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appVersionShape, releaseVersionShape } from '../src/lib/version-shapes.ts';

test('a release version is N.N.N and nothing else, fixture names included', () => {
  for (const version of ['0.1.3', '1.0.0', '12.34.567']) assert.equal(releaseVersionShape(version), true, version);
  for (const version of ['internal-fixture', 'internal-workload', 'mixed-benchmark', '0.1', '0.1.3-rc1', '1.2.3.4', '']) assert.equal(releaseVersionShape(version), false, version);
});

test('the server shape still takes fixture names, for test data', () => {
  assert.equal(appVersionShape('internal-fixture'), true);
});
