import { test, expect } from '@playwright/test';
import { assertEffectiveTargets, undersizedTargets, untilSettled } from '../../scripts/faza6-targets.mjs';

// The Faza 6 collector must fail on a small target and stay quiet on the app's own patterns: a 24 px input
// inside a 56 px label, and a button read while it scales in.
const page56 = `
  <style>button, label.choice { display: flex; align-items: center; min-width: 56px; min-height: 56px; margin: 4px; }
  input { width: 24px; height: 24px; } .grow { animation: grow 220ms ease-out; } @keyframes grow { from { transform: scale(.7); } }</style>
  <label class="choice"><input type="checkbox"> Zaznacz</label>
  <button class="grow">Usuń zdjęcie 1</button>
  <p>Zob. <a href="#x">link w zdaniu</a>.</p>`;

test('a 24 px input in a 56 px label and a settling button are not flagged', async ({ page }) => {
  await page.setContent(page56);
  await assertEffectiveTargets(page, 'fixture');
  expect(await undersizedTargets(page)).toEqual([]);
});

test('a 40 px control fails the assertion and is named', async ({ page }) => {
  await page.setContent(`${page56}<button style="min-height: 40px; height: 40px">Mała</button>`);
  await expect(assertEffectiveTargets(page, 'fixture')).rejects.toThrow(/under 56 px.*Mała/);
});

test('a bare 24 px checkbox with no label is flagged', async ({ page }) => {
  await page.setContent(`${page56}<input type="checkbox" aria-label="goły">`);
  await untilSettled(page);
  expect(await undersizedTargets(page)).toEqual(['input "goły" 24x24']);
});

test('read mid-animation, the scaling button would be a false row; settling first removes it', async ({ page }) => {
  // Frozen at half way (delay -110 ms of 220 ms, paused), so the reading does not depend on timing.
  await page.setContent(`${page56}<style>.grow { animation: grow 220ms ease-out paused; animation-delay: -110ms; }</style>`);
  expect((await undersizedTargets(page)).join()).toMatch(/Usuń zdjęcie 1/);
  await page.evaluate(() => document.querySelectorAll<HTMLElement>('.grow').forEach(item => { item.style.animation = 'none'; }));
  await untilSettled(page);
  expect(await undersizedTargets(page)).toEqual([]);
});
