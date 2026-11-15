import { test, expect } from '@playwright/test';
import { answerHome, answerNow, blankTiles, chooseHours, choosePoint, footer, leaveCompass, openNoticeRow, save, setEstimate, startEvent } from './stages.ts';

const homeShot = 'Dokładne miejsce, z którego słychać było strzał, pominięto dla ochrony miejsca zamieszkania.';
const homeSeen = 'Dokładne miejsce pominięto dla ochrony miejsca zamieszkania.';
const skipped = 'Obszar wskazano bez oszacowania kierunku i odległości.';
const manual = 'Miejsce wskazano ręcznie; brak dokładności GPS dla tego punktu.';
const cases = [
  { name: 'skipped shot estimate', event: 'Strzał', sentence: skipped },
  { name: 'heard direction and distance', event: 'Strzał', bearing: true, distance: true, sentence: 'Obszar oszacowano ze słuchu (kierunek ok. 180° (południe), odległość ok. 500 m).', report: 'Obszar oszacowano ze słuchu: ok. 500 m od Ciebie, kierunek ok. 180° (południe).' },
  { name: 'heard direction only', event: 'Strzał', bearing: true, sentence: 'Obszar oszacowano ze słuchu (kierunek ok. 180° (południe)).', report: 'Obszar oszacowano ze słuchu: kierunek ok. 180° (południe).' },
  { name: 'heard distance only', event: 'Strzał', distance: true, sentence: 'Obszar oszacowano ze słuchu (odległość ok. 500 m).', report: 'Obszar oszacowano ze słuchu: ok. 500 m od Ciebie.' },
  { name: 'seen direction and distance', event: 'Człowiek z bronią', bearing: true, distance: true, sentence: 'Obszar oszacowano z obserwacji (kierunek ok. 180° (południe), odległość ok. 500 m).', report: 'Obszar oszacowano z obserwacji: ok. 500 m od Ciebie, kierunek ok. 180° (południe).' },
  { name: 'seen direction only', event: 'Ranne zwierzę', bearing: true, sentence: 'Obszar oszacowano z obserwacji (kierunek ok. 180° (południe)).', report: 'Obszar oszacowano z obserwacji: kierunek ok. 180° (południe).' },
  { name: 'seen distance only', event: 'Kłusownictwo', distance: true, sentence: 'Obszar oszacowano z obserwacji (odległość ok. 500 m).', report: 'Obszar oszacowano z obserwacji: ok. 500 m od Ciebie.' },
  { name: 'device point', event: 'Człowiek z bronią', sentence: 'Miejsce zapisano na podstawie pozycji telefonu.' },
  { name: 'skipped shot from home', event: 'Strzał', home: true, sentence: homeShot },
  { name: 'heard estimate from home', event: 'Strzał', home: true, bearing: true, distance: true, sentence: homeShot },
  { name: 'skipped sighting from home', event: 'Człowiek z bronią', home: true, sentence: homeSeen },
  { name: 'seen estimate from home', event: 'Ranne zwierzę', home: true, bearing: true, distance: true, sentence: homeSeen },
  { name: 'chosen shot point', event: 'Strzał', point: 'exact', sentence: manual },
  { name: 'chosen sighting point', event: 'Kłusownictwo', point: 'exact', sentence: manual },
  { name: 'chosen shot area', event: 'Strzał', point: 'area', sentence: skipped },
  { name: 'chosen sighting area', event: 'Człowiek z bronią', point: 'area', sentence: 'Obszar wskazano w przybliżeniu.' },
  { name: 'chosen shot place from home', event: 'Strzał', point: 'exact', home: true, sentence: homeShot },
  { name: 'chosen sighting area from home', event: 'Człowiek z bronią', point: 'area', home: true, sentence: homeSeen }
] as const;

// Ticket 30: the Report screen names an estimate as a distance from the Reporter, so it cannot be read as the
// distance from homes in the Findings; the Notice keeps its own sentence.
for (const item of cases) test(`${item.name}: Report and Notice place sentences, words only on review`, async ({ page, context }) => {
  await context.setGeolocation({ latitude: 53.403481, longitude: 22.658699, accuracy: 12 });
  await blankTiles(page);
  await page.route('**/api/reports', route => route.fulfill({ status: 400, json: { error: 'validation_refused' } }));
  await page.goto('/');
  await startEvent(page, item.event);
  if ('point' in item) {
    await page.getByRole('button', { name: /^Kilka godzin temu/ }).click();
    await chooseHours(page, 2);
    await footer(page).getByRole('button', { name: 'Dalej', exact: true }).click();
    await choosePoint(page, 53.42, 22.68, item.point === 'exact');
  } else {
    await answerNow(page);
    await setEstimate(page, 'bearing' in item ? 180 : undefined, 'distance' in item ? 500 : undefined);
    await leaveCompass(page);
  }
  await answerHome(page, 'home' in item);
  // Sprawdź says the place in the Reporter's words; the Notice's sentence is for the authority (ticket 29 cut).
  await expect(page.locator('#place-row')).not.toContainText(item.sentence);
  await expect(page.locator('.screen-body')).not.toContainText(/Przybliżony obszar zdarzenia:|siatk[aię]|4 km|8 km/);
  await save(page);
  await page.getByText('Szczegóły zgłoszenia', { exact: true }).click();
  await expect(page.locator('.facts')).toContainText('report' in item ? item.report : item.sentence);
  if ('report' in item) await expect(page.locator('.facts')).toContainText('Odległość od zabudowań podają pomiary powyżej.');
  await expect(page.locator('.screen-body')).not.toContainText('Przybliżony obszar zdarzenia:');
  await page.getByRole('button', { name: 'Przygotuj powiadomienie', exact: true }).click();
  const other = page.getByRole('button', { name: 'Wybierz inną jednostkę po nazwie' });
  await expect(other.or(page.getByLabel('Nazwa lub miejscowość'))).toBeVisible();
  const unknownGmina = page.getByRole('radio', { name: 'Nie wiem', exact: true });
  if (await unknownGmina.isVisible()) await unknownGmina.check();
  const police = page.getByRole('checkbox', { name: /Komenda Powiatowa Policji w Mońkach/ });
  if (await police.isVisible()) await police.check();
  else {
    if (await other.isVisible()) await other.click();
    await page.getByLabel('Nazwa lub miejscowość').fill('Monkach');
    await page.getByRole('button', { name: /Komenda Powiatowa Policji w Mońkach/ }).click();
  }
  await page.getByRole('button', { name: 'Dalej: podpis', exact: true }).click();
  await page.getByRole('radio', { name: 'Bez podpisu' }).check();
  await page.getByRole('button', { name: 'Przygotuj powiadomienia' }).click();
  await openNoticeRow(page, 'Komenda Powiatowa Policji w Mońkach');
  await page.getByText('Przejrzyj treść powiadomienia', { exact: true }).click();
  await expect(page.locator('.notice-body')).toContainText(item.sentence);
  if ('home' in item) await expect(page.locator('.notice-body')).not.toContainText(/53\.403481|22\.658699|kierunek ok\.|odległość ok\./);
});
