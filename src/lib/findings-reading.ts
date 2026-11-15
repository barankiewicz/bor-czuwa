import type { DwellingAreaClass, ProtectedArea, ProtectedAreaKind, ProtectedAreaRules } from './report.js';

/** The class of an Incident area against the Rule set's dwelling threshold; a distance equal to it is within. */
export function dwellingAreaClass(minM: number, containsDwelling: boolean, thresholdM: number): DwellingAreaClass {
  return containsDwelling ? 'contains_dwelling' : minM <= thresholdM ? 'partly_within_threshold' : 'beyond_threshold';
}

export function protectedAreaBan(kind: ProtectedAreaKind, area: ProtectedArea, rules: ProtectedAreaRules | null,
  source: 'device_fix' | 'moved_by_reporter' | 'area', accuracy: number | null): boolean {
  const distance = area.boundary_distance?.value_m;
  // A whole area has no Accuracy: the ban needs it wholly inside with a positive margin to the boundary.
  if (source === 'area') {
    if (area.coverage !== 'wholly_inside' || distance === undefined || distance <= 0) return false;
  } else if (source !== 'device_fix' || accuracy === null || distance === undefined || distance <= accuracy) return false;
  if (kind === 'park_narodowy') return rules?.treatment.park_narodowy === 'ban';
  return kind === 'rezerwat' && area.document_state === 'neither' && rules?.treatment.rezerwat === 'ban_without_documents';
}

export function polishDatasetName(identifier: string): string {
  const names: Record<string, string> = {
    BDOT10k: 'Baza Danych Obiektów Topograficznych',
    'BDOT10k/BUBD-A': 'zabudowania mieszkalne z Bazy Danych Obiektów Topograficznych',
    'BDOT10k BUBD': 'zabudowania z Bazy Danych Obiektów Topograficznych',
    'GDOŚ': 'obszary chronione Generalnej Dyrekcji Ochrony Środowiska',
    'GDOS:ParkiNarodowe': 'parki narodowe Generalnej Dyrekcji Ochrony Środowiska',
    'GDOS:Rezerwaty': 'rezerwaty przyrody Generalnej Dyrekcji Ochrony Środowiska',
    'GDOS:ParkiKrajobrazowe': 'parki krajobrazowe Generalnej Dyrekcji Ochrony Środowiska',
    'GDOS:ObszarySpecjalnejOchrony': 'obszary specjalnej ochrony ptaków Natura 2000',
    'GDOS:SpecjalneObszaryOchrony': 'specjalne obszary ochrony siedlisk Natura 2000',
    CRFOP: 'Centralny Rejestr Form Ochrony Przyrody',
    BDL: 'Bank Danych o Lasach',
    'Bank Danych o Lasach': 'Bank Danych o Lasach',
    PRG: 'Państwowy Rejestr Granic',
    'OpenStreetMap hunting stands': 'ambony z OpenStreetMap'
  };
  return names[identifier] ?? 'zbiór danych przestrzennych';
}
