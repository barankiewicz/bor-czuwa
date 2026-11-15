import { test } from 'node:test';
import assert from 'node:assert/strict';
import { polishDatasetName } from '../src/lib/findings-reading.ts';
import { translate } from '../src/lib/strings.ts';
import { expectedEnglish } from './dataset-names-expected.ts';

// Every identifier polishDatasetName knows, plus one it does not (the fallback), as the sources sheet receives them.
const identifiers = Object.keys(expectedEnglish);

for (const identifier of identifiers) test(`English sources sheet names ${identifier}`, () => {
  assert.equal(translate('en', polishDatasetName(identifier)), expectedEnglish[identifier]);
});

test('Polish interface and the Notice keep the Polish names', () => {
  for (const identifier of identifiers) assert.equal(translate('pl', polishDatasetName(identifier)), polishDatasetName(identifier));
});
