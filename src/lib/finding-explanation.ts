import type { Measurement } from './report.js';
import type { NoticeRuleSet } from './notice-composer.js';
import type { OkresOchronnyFinding } from './time-findings.js';
import { distanceBand } from './notice-composer.js';
import { translate, type Language } from './strings.js';

export function explainDwelling(measurement: Measurement, accuracy: number | null, rule: NoticeRuleSet, language: Language): string {
  const t = (value: string) => translate(language, value);
  if (measurement.status === 'not_computed') return measurement.reason === 'outside_coverage'
    ? t('Nie obliczono odległości od zabudowań, ponieważ wskazane miejsce wykracza poza zasięg danych.')
    : t('Podano przybliżony obszar, więc nie ma punktu, od którego można zmierzyć odległość.');
  if (measurement.status === 'area_none_within_radius') return `${t('Próg dla zabudowań mieszkalnych to')} ${measurement.threshold_m} m. ${t('Wokół wskazanego obszaru, w promieniu 1000 m od jego brzegu, nie znaleziono zabudowań mieszkalnych.')}`;
  if (measurement.status === 'area_measured') return `${t('Próg dla zabudowań mieszkalnych to')} ${measurement.threshold_m} m. ${t('Odległość zmierzono od całego wskazanego obszaru, a nie od jego środka. To opis odległości, nie ocena winy.')}`;
  if (measurement.status === 'none_within_radius') return t('Przeszukano obszar wokół punktu; nie znaleziono zabudowań mieszkalnych. To nie jest pomiar odległości do budynku.');
  const threshold = `${rule.dwelling_threshold_m} m`;
  if (accuracy === null) return `${t('Próg dla zabudowań mieszkalnych to')} ${threshold}. ${t('Punkt wskazano ręcznie. Bez dokładności GPS nie można pewnie porównać odległości z progiem.')}`;
  const band = distanceBand(measurement.value_m, accuracy, rule.dwelling_threshold_m);
  const comparison = band === 'straddles'
    ? t('Margines dokładności obejmuje próg, więc pomiar nie pozwala ustalić, po której stronie progu było zdarzenie.')
    : band === 'inside'
      ? t('Cały przedział pomiaru leży poniżej progu. To opis odległości, nie ocena winy.')
      : t('Cały przedział pomiaru leży powyżej progu.');
  return `${t('Próg dla zabudowań mieszkalnych to')} ${threshold}. ${t('Dokładność punktu:')} ±${Math.round(accuracy)} m. ${comparison}`;
}

export function explainNight(rule: NoticeRuleSet, language: Language): string {
  const t = (value: string) => translate(language, value);
  return `${t('Noc zaczyna się')} ${rule.noc.starts_after_sunset_minutes} ${t('minut po zachodzie słońca i kończy')} ${rule.noc.ends_before_sunrise_minutes} ${t('minut przed wschodem. Lista gatunków pochodzi z tego zestawu reguł. Sam wynik nie przesądza o naruszeniu prawa.')}`;
}

export function seasonCitation(rule: NoticeRuleSet, species: string | null, finding: OkresOchronnyFinding | null): string {
  if (finding?.status !== 'not_a_game_species') return rule.citations.okres_ochronny;
  return (species && rule.species[species]?.delisting_citation) || rule.citations.delisting || rule.citations.okres_ochronny;
}

