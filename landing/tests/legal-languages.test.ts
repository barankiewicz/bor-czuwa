import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

// The English legal texts are translations of the Polish ones, so the two must keep the same
// shape: as many headings at each level, and the same bracketed placeholders, which stay in
// Polish so that one fill-in finds them in both files.
const directory = path.resolve(import.meta.dirname, '../../src/lib/legal/v1');
const read = (name: string) => readFileSync(path.join(directory, name), 'utf8');

function headings(text: string) {
  const levels: Record<string, number> = {};
  // Markdown headings and the raw HTML ones that carry an anchor id.
  for (const [, hashes, tag] of text.matchAll(/^(?:(#{1,6}) |<h([1-6])\b)/gm)) {
    const level = `h${hashes ? hashes.length : tag}`;
    levels[level] = (levels[level] ?? 0) + 1;
  }
  return levels;
}

// A placeholder is square brackets that are not the text of a link. Line wrapping may differ.
const placeholders = (text: string) =>
  [...text.matchAll(/\[[^\]]+\](?!\()/g)].map(match => match[0].replace(/\s+/g, ' ')).sort();

const anchors = (text: string) => [...text.matchAll(/<h[1-6] id="([^"]+)"/g)].map(match => match[1]);

for (const name of ['privacy', 'terms']) test(`${name}: the English text keeps the Polish headings and placeholders`, () => {
  const [polish, english] = [read(`${name}.md`), read(`${name}.en.md`)];
  assert.ok(headings(polish).h2 > 0, 'the Polish text has sections');
  assert.deepEqual(headings(english), headings(polish), 'headings per level');
  assert.ok(placeholders(polish).length > 0, 'the Polish text has placeholders');
  assert.deepEqual(placeholders(english), placeholders(polish), 'placeholders');
  assert.deepEqual(anchors(english), anchors(polish), 'anchor ids');
});
