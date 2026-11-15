// The approved English label of every dataset identifier the sources sheet can receive, written out so a changed
// catalogue entry fails a test instead of being compared with itself. The last identifier is one polishDatasetName does not know, under a prefix the sheet lists.
export const expectedEnglish: Record<string, string> = {
  BDOT10k: 'Topographic Objects Database (Baza Danych Obiektów Topograficznych)',
  'BDOT10k/BUBD-A': 'residential buildings from the Topographic Objects Database',
  'BDOT10k BUBD': 'buildings from the Topographic Objects Database',
  'GDOŚ': 'protected areas of the General Directorate for Environmental Protection',
  'GDOS:ParkiNarodowe': 'national parks of the General Directorate for Environmental Protection',
  'GDOS:Rezerwaty': 'nature reserves of the General Directorate for Environmental Protection',
  'GDOS:ParkiKrajobrazowe': 'landscape parks of the General Directorate for Environmental Protection',
  'GDOS:ObszarySpecjalnejOchrony': 'Natura 2000 special protection areas for birds',
  'GDOS:SpecjalneObszaryOchrony': 'Natura 2000 special areas of conservation',
  CRFOP: 'Central Register of Nature Conservation Forms (Centralny Rejestr Form Ochrony Przyrody)',
  BDL: 'Forest Data Bank (Bank Danych o Lasach)',
  'Bank Danych o Lasach': 'Forest Data Bank (Bank Danych o Lasach)',
  PRG: 'National Register of Boundaries (Państwowy Rejestr Granic)',
  'OpenStreetMap hunting stands': 'hunting stands from OpenStreetMap',
  'GDOS:Future': 'spatial dataset'
};
