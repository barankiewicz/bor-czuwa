import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tagPolish } from '../src/lib/polish.ts';

// WCAG 3.1.2: Polish words inside English text are marked lang="pl" so a screen reader changes
// voice. Reads the built English pages; LANDING_BUILD points at a fixture for the failing runs.
const root = process.env.LANDING_BUILD ?? path.resolve(import.meta.dirname, '../build');
if (!existsSync(root)) throw new Error(`${root} is missing; run npm run build:landing first`);
const english = ['en/index.html', 'en/about/index.html', 'en/privacy/index.html', 'en/terms/index.html'];
const polishTerms = ['Państwowa Straż Łowiecka', 'zabudowania mieszkalne', 'obwód łowiecki', 'okres ochronny', 'Prezes Urzędu Ochrony Danych Osobowych', 'komitet', 'Komitet Inicjatywy Uwaga! Polowanie', 'RDOŚ', 'prawników'];

// What a reader sees outside any lang="pl" element, with the document's own tags removed.
function untagged(html: string): string {
  const body = html.slice(html.indexOf('<body')).replace(/<(script|style)[\s\S]*?<\/\1>/g, '');
  return body.replace(/<span lang="pl">[\s\S]*?<\/span>/g, ' ').replace(/<a [^>]*lang="pl"[^>]*>[\s\S]*?<\/a>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

for (const file of english) test(`${file}: every Polish term is inside lang="pl"`, () => {
  const html = readFileSync(path.join(root, file), 'utf8');
  assert.match(html, /<html lang="en"/);
  const outside = untagged(html);
  for (const term of polishTerms) assert.ok(!outside.includes(term.replace(/ /g, ' ')), `"${term}" is read in the English voice`);
  assert.doesNotMatch(outside, /\[[^\]]*[ąćęłńóśźż][^\]]*\]/i, 'a Polish placeholder is read in the English voice');
  // The head is not touched: a title or description never carries markup.
  assert.doesNotMatch(html.slice(0, html.indexOf('<body')), /<span lang/);
});

test('the pages that carry Polish terms carry them tagged', () => {
  const home = readFileSync(path.join(root, 'en/index.html'), 'utf8');
  assert.match(home, /<span lang="pl">Państwowa Straż Łowiecka<\/span>/);
  assert.match(home, /<span lang="pl">zabudowania mieszkalne<\/span>/);
  const privacy = readFileSync(path.join(root, 'en/privacy/index.html'), 'utf8');
  assert.match(privacy, /<span lang="pl">obwód\s+łowiecki<\/span>/);
});

test('tagPolish leaves tags, scripts and wording alone and does not double-wrap', () => {
  const html = '<title>RDOŚ</title><p class="RDOŚ">the RDOŚ and the gminas</p><script>"gmina"</script>';
  const once = tagPolish(html);
  assert.equal(once, '<title>RDOŚ</title><p class="RDOŚ">the <span lang="pl">RDOŚ</span> and the gminas</p><script>"gmina"</script>');
  assert.equal(once.replace(/<\/?span[^>]*>/g, ''), html, 'removing the markup gives back the original text');
});
