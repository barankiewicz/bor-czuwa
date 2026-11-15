import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { requiredGeodataColumns, requiredRecipientColumns } from '../server/startup-check.ts';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const templates = (source: string) => source.split('`').filter((_, index) => index % 2 === 1);
const words = (text: string) => new Set(text.match(/[a-z_][a-z0-9_]*/g) ?? []);

// Columns of a table as its owner defines it: the ingest for snapshot tables, the baseline migration for public ones.
function ingestColumns(table: string) {
  const found = read('scripts/geodata_snapshot.py').match(new RegExp(`'${table}': (?:"([^"]*)"|'([^']*)')`));
  const definition = found?.[1] ?? found?.[2] ?? '';
  return new Set(definition.split(',').map(part => part.trim().split(/\s+/)[0]).filter(name => /^[a-z_]+$/.test(name) && name !== 'PRIMARY'));
}
function baselineColumns(table: string) {
  const block = read('server/migrations/001-baseline.sql').match(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${table} \\(([\\s\\S]*?)\\n\\);`))?.[1] ?? '';
  return new Set(block.split('\n').map(line => line.trim().split(/\s+/)[0]).filter(name => /^[a-z_]+$/.test(name) && name !== 'PRIMARY'));
}

test('the readiness column lists cover every column the queries use', () => {
  const findings = templates(read('server/findings.ts'));
  for (const [table, required] of Object.entries(requiredGeodataColumns)) {
    const columns = ingestColumns(table);
    assert.ok(columns.size > 1, `could not read the ${table} definition`);
    const used = new Set<string>();
    for (const query of findings.filter(text => new RegExp(`\\$\\{schema\\}\\.${table}\\b`).test(text))) {
      for (const word of words(query)) if (columns.has(word)) used.add(word);
    }
    assert.ok(used.size > 0, `no Findings query for ${table} found`);
    for (const column of used) assert.ok(required.includes(column), `${table}.${column} is read by Findings but not checked`);
    for (const column of required) assert.ok(columns.has(column), `${table}.${column} is checked but not defined by the ingest`);
  }
});

test('the readiness column lists cover the recipient lookup queries', () => {
  const sources = [...templates(read('server/recipient-lookup.ts')), ...templates(read('server/operator.ts'))];
  for (const [table, required] of Object.entries(requiredRecipientColumns)) {
    const columns = baselineColumns(table);
    assert.ok(columns.size > 1, `could not read the ${table} definition`);
    const used = new Set<string>();
    for (const query of sources.filter(text => new RegExp(`\\b${table}\\b`).test(text))) {
      for (const word of words(query)) if (columns.has(word)) used.add(word);
    }
    for (const column of used) assert.ok(required.includes(column), `${table}.${column} is read by the lookup but not checked`);
    for (const column of required) assert.ok(columns.has(column), `${table}.${column} is checked but not in the baseline`);
  }
});
