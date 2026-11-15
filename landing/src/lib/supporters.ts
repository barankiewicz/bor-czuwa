// Organisations that support the project, shown on the support page with their logo. The owner
// approves each one before it is added (2026-11-12). Put the logo file in static/supporters/ and
// add an entry; the list shows in this order.
export type Supporter = {
  name: string; // the organisation's name, also the logo's text alternative
  url: string; // its website, linked from the logo
  logo: string; // file name in static/supporters/, SVG or PNG
};

export const supporters: Supporter[] = [
  // owner, 2026-11-12; the logo is the one on uwagapolowanie.pl
  { name: 'Uwaga! Polowanie', url: 'https://uwagapolowanie.pl', logo: 'uwaga-polowanie.png' }
];
