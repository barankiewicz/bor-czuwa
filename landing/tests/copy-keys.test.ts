import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copy } from '../src/lib/copy.ts';

// Every leaf string as "a.b.0.c" -> text, so the two languages compare key by key.
function leaves(value: unknown, prefix = '', out = new Map<string, string>()) {
  if (typeof value === 'string') out.set(prefix, value);
  else for (const [key, child] of Object.entries(value as object)) leaves(child, prefix ? `${prefix}.${key}` : key, out);
  return out;
}

const pl = leaves(copy.pl);
const en = leaves(copy.en);

test('every copy key exists and has text in both languages', () => {
  const missing = (from: Map<string, string>, other: Map<string, string>) =>
    [...from.keys()].filter(key => !other.get(key)?.trim());
  assert.deepEqual(missing(pl, en), [], 'in Polish, missing or empty in English');
  assert.deepEqual(missing(en, pl), [], 'in English, missing or empty in Polish');
});

// A word is anything between spaces that holds a letter or a digit, so a lone separator does not count.
const words = (text: string) => text.split(/\s+/).filter(token => /[\p{L}\p{N}]/u.test(token)).length;
const pages = ['home', 'about', 'support', 'privacy', 'terms'];
const pageOf = (key: string) => pages.find(page => key.startsWith(`${page}.`)) ?? 'shared';
function count(strings: Map<string, string>) {
  const totals: Record<string, number> = {};
  for (const [key, text] of strings) totals[pageOf(key)] = (totals[pageOf(key)] ?? 0) + words(text);
  return totals;
}

test('the English is at most a tenth longer than the Polish on every page', t => {
  const [polish, english] = [count(pl), count(en)];
  const over: string[] = [];
  for (const page of [...pages, 'shared']) {
    t.diagnostic(`${page}: pl ${polish[page]}, en ${english[page]}`);
    if (english[page] > polish[page] * 1.1) over.push(`${page}: ${english[page]} English words against ${polish[page]} Polish`);
  }
  assert.deepEqual(over, []);
});
