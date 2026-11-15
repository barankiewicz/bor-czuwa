import { expect, type Page } from '@playwright/test';

// Expectations stay independent of the application policy implementation.
export const demoRecipient = process.env.VITE_DEMO_TEST_RECIPIENT || undefined;
export const expectedRecipient = (ordinary: string) => demoRecipient ?? ordinary;
export const expectedSubject = (ordinary: string) => demoRecipient ? `[TEST] ${ordinary}` : ordinary;
export const pdfSwitch = demoRecipient ? 'Pobierz testowy PDF' : 'Złóż PDF w serwisie urzędowym';
export const pdfRoute = demoRecipient ? 'Testowy PDF do przejrzenia' : 'Złożysz PDF w serwisie urzędowym';
export const pdfConfirmation = demoRecipient ? 'Potwierdzam przekazanie' : 'Potwierdzam przekazanie przez serwis urzędowy';

export async function openLegalDraft(page: Page) {
  if (demoRecipient) {
    await expect(page.getByRole('heading', { name: /^(Prywatny test|Private test)$/ })).toBeVisible();
    await page.locator('.legal-page > details.disclosure > summary').click();
  }
}

export function expectDemoDestination(text: string, realAddresses: string[] = []) {
  if (!demoRecipient) return;
  expect(text).toContain(demoRecipient);
  for (const address of realAddresses) {
    expect(text).not.toContain(address);
    expect(text).not.toContain(address.replace('@', '%40'));
  }
}
