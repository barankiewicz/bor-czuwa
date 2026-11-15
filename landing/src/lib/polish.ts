// Polish words inside English text carry lang="pl", so a screen reader switches voice for them
// (WCAG 3.1.2, language of parts). The terms are statutory names and loanwords the English copy
// keeps untranslated, plus the bracketed placeholders, which stay Polish in both languages so one
// fill-in finds them. Only the markup changes; no wording does. The brand name "Bór czuwa" is a
// name, not a passage, and is left alone.
const terms = [
  'Prezes Urzędu Ochrony Danych Osobowych', 'Komitet Inicjatywy Uwaga! Polowanie', 'Państwowa Straż Łowiecka',
  'zabudowania mieszkalne', 'obszary chronione', 'obwód łowiecki', 'okres ochronny', 'sprzeciw / usunięcie',
  'Prawo łowieckie', 'e-Doręczenia', 'RDOŚ', 'komitet', 'gmina'
];
const words = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+')).join('|');
// A term as a whole word, or a bracketed placeholder that is not the text of a link.
const pattern = new RegExp(`(?<![\\p{L}])(?:${words})(?![\\p{L}])|\\[[^\\]<>]+\\](?!\\()`, 'gu');

// Wraps the terms in the text of an HTML fragment, leaving tags, scripts, styles and anything
// already marked up as Polish untouched.
export function tagPolish(html: string): string {
  let skipping = 0;
  return html.split(/(<[^>]*>)/).map(part => {
    if (part.startsWith('<')) {
      if (/^<(script|style|title)\b/i.test(part)) skipping++;
      else if (/^<\/(script|style|title)\b/i.test(part)) skipping--;
      return part;
    }
    return skipping > 0 ? part : part.replace(pattern, match => `<span lang="pl">${match}</span>`);
  }).join('');
}
