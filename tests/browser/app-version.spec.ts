import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { releaseVersionShape } from '../../src/lib/version-shapes.ts';
import { answerHome, answerNow, blankTiles, leaveCompass, reportPost, save, startEvent } from './stages.ts';

test.use({ serviceWorkers: 'block' });

test('a Report records the version of the client that sent it', async ({ page, context }) => {
  const { version } = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  await blankTiles(page);
  await context.setGeolocation({ latitude: 52.2297, longitude: 21.0122, accuracy: 12 });
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await leaveCompass(page);
  await answerHome(page, false);
  const posted = await reportPost(page);
  await save(page);
  const payload = (await posted.request).postDataJSON();
  expect(payload.app_version).toBe(version);
  expect(releaseVersionShape(payload.app_version)).toBe(true);
});
