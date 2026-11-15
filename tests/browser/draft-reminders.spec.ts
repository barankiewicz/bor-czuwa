import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { finishFromWhen, footer, heading, startEvent } from './stages.ts';
import { android, seedDrafts } from './native-notifications.ts';

// Draft reminders on Android (faza 4 ticket 14), against a fake of the native notifications plugin
// that behaves as the phone does: a delivered reminder stays listed as pending.

const reminders = (page: Page) => page.evaluate(() => ((window as any).fakeNotifications.pending as {
  title: string; body: string; schedule: { at: string }; actionTypeId: string; extra: { draftIds: string[] };
}[]).map(item => ({ at: item.schedule.at, title: item.title, body: item.body, draftIds: item.extra.draftIds }))
  .sort((a, b) => a.at.localeCompare(b.at)));
const calls = (page: Page) => page.evaluate(() => (window as any).fakeNotifications.calls as string[]);

const shot = { id: 'draft-shot', eventType: 0, capturedAt: '2026-10-03T07:00:00.000Z' };
const remains = { id: 'draft-remains', eventType: 2, capturedAt: '2026-10-03T08:00:00.000Z', occurredMode: 'now' };

async function openWithDrafts(page: Page, context: BrowserContext, drafts: object[]) {
  await page.clock.install({ time: new Date('2026-10-03T12:00:00Z') });
  await page.goto('/');
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await seedDrafts(page, drafts);
  await android(context);
  await page.reload();
}

test('one Draft is reminded twice, by its Event and missing step; several share one reminder a day', async ({ page, context }) => {
  await openWithDrafts(page, context, [shot]);
  await expect.poll(() => reminders(page)).toEqual([
    { at: '2026-10-04T08:00:00.000Z', title: 'Dokończ zgłoszenie strzału', body: 'Dalej: Kiedy to się stało?', draftIds: ['draft-shot'] },
    { at: '2026-10-06T08:00:00.000Z', title: 'Dokończ zgłoszenie strzału', body: 'Dalej: Kiedy to się stało?', draftIds: ['draft-shot'] }
  ]);
  await seedDrafts(page, [remains]);
  await page.reload();
  await expect.poll(() => reminders(page)).toEqual([
    { at: '2026-10-04T08:00:00.000Z', title: 'Szkice do dokończenia: 2', body: 'Wybierz w Moich zapisach, od którego zacząć.', draftIds: ['draft-shot', 'draft-remains'] },
    { at: '2026-10-06T08:00:00.000Z', title: 'Szkice do dokończenia: 2', body: 'Wybierz w Moich zapisach, od którego zacząć.', draftIds: ['draft-shot', 'draft-remains'] }
  ]);
  for (const { body } of await reminders(page)) expect(body).not.toMatch(/wróć|wrócić|na miejsce/i);
});

test('the Menu switch cancels pending reminders and turning it back on restores them', async ({ page, context }) => {
  await openWithDrafts(page, context, [shot]);
  await expect.poll(async () => (await reminders(page)).length).toBe(2);
  await page.getByRole('button', { name: 'Menu' }).click();
  const toggle = page.getByRole('switch', { name: 'Przypomnienia o szkicach' });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => reminders(page)).toEqual([]);
  await expect(page.locator('.brief-confirmation')).toHaveText('Przypomnienia o szkicach wyłączone.');
  // The choice outlives a restart, and a restart schedules nothing while it is off.
  await page.reload();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => reminders(page)).toEqual([]);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await reminders(page)).map(item => item.at)).toEqual(['2026-10-04T08:00:00.000Z', '2026-10-06T08:00:00.000Z']);
  await expect(page.locator('.brief-confirmation')).toHaveText('Przypomnienia o szkicach włączone.');
});

test('"Dokończ" opens the Draft at its missing step, or Moje zapisy when several wait', async ({ page, context }) => {
  await openWithDrafts(page, context, [remains]);
  await expect.poll(async () => (await reminders(page)).length).toBe(2);
  const [single] = await page.evaluate(() => (window as any).fakeNotifications.pending);
  await page.evaluate(notification => (window as any).tapReminder('finish', notification), single);
  await expect(heading(page, 'Sprawdź i zapisz').or(heading(page, 'Gdzie to było?'))).toBeVisible();
  await page.evaluate(() => (window as any).tapReminder('finish',
    { id: 1, extra: { draftReminderDay: '2026-10-04', draftIds: ['draft-remains', 'draft-shot'] } }));
  await expect(heading(page, 'Moje zapisy')).toBeVisible();
});

test('"Nie przypominaj" stops reminders for the group and keeps the Drafts', async ({ page, context }) => {
  await openWithDrafts(page, context, [shot, remains]);
  await expect.poll(async () => (await reminders(page)).length).toBe(2);
  const [group] = await page.evaluate(() => (window as any).fakeNotifications.pending);
  await page.evaluate(notification => (window as any).tapReminder('stop', notification), group);
  await expect(page.locator('.brief-confirmation')).toHaveText('Nie przypomnimy już o tych szkicach. Zostają w Moich zapisach.');
  await expect.poll(() => reminders(page)).toEqual([]);
  await page.getByRole('button', { name: /Moje zapisy/ }).click();
  await expect(page.getByText('Dokończ zgłoszenie strzału')).toBeVisible();
  await expect(page.getByText('Dokończ zgłoszenie szczątków w lesie')).toBeVisible();
});

test('the notification permission is asked at "Dokończę później", never over the capture receipt', async ({ page, context }) => {
  await page.goto('/');
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await android(context, { permission: 'prompt', exact: 'granted' });
  await page.reload();
  await startEvent(page, 'Strzał');
  await expect.poll(() => calls(page)).toContain('checkPermissions');
  expect(await calls(page)).not.toContain('requestPermissions');
  expect(await reminders(page)).toEqual([]);
  await footer(page).getByRole('button', { name: 'Dokończę później' }).click();
  await expect.poll(() => calls(page)).toContain('requestPermissions');
  await expect.poll(async () => (await reminders(page)).length).toBe(2);
});

type ReminderFrame = { advice: number | null; height: number; below: number; time: number | null; wall: number };

function steadyReminder(samples: ReminderFrame[]) {
  for (let index = 1; index < samples.length; index++) {
    const moved = Math.abs(samples[index].below - samples[index - 1].below);
    expect(moved, JSON.stringify(samples)).toBeLessThan(40);
    if (samples[index].advice === samples[index - 1].advice) expect(moved, JSON.stringify(samples)).toBeLessThan(1);
  }
}

function reminderEndpoint(samples: ReminderFrame[], present: boolean) {
  expect(samples.at(-1)!.advice).toBe(present ? 1 : null);
  if (present) expect(samples.at(-1)!.height).toBeGreaterThan(0);
  else expect(samples.at(-1)!.height).toBe(0);
}

for (const injectJump of [false, true]) test(`the exact-alarm advice travels on its native timeline${injectJump ? ' and rejects a layout jump' : ''}`, async ({ page, context }, testInfo) => {
  await page.clock.install({ time: new Date('2026-10-03T12:00:00Z') });
  await page.goto('/');
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await seedDrafts(page, [shot]);
  await android(context, { permission: 'granted', exact: 'denied' });
  await page.reload();
  await page.clock.resume();
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByText('Przypomnienie może się spóźnić')).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.querySelector('.reminder-settings > div')!.getAnimations().map(animation => animation.finished));
  });
  const sample = async (toggle: () => Promise<void>, jump = false) => {
    await page.evaluate(() => {
      const original = Element.prototype.animate;
      const state = { animation: null as Animation | null, restore: () => { Element.prototype.animate = original; } };
      (window as any).reminderTimeline = state;
      Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
        const animation = Reflect.apply(original, this, args) as Animation;
        // Leave Svelte's zero-duration starter alone; hold only the real native transition.
        if (this.matches('.reminder-settings > div') && Number(animation.effect?.getComputedTiming().duration) > 0) {
          animation.pause(); state.animation = animation;
        }
        return animation;
      };
    });
    try {
      await toggle();
      await expect.poll(() => page.evaluate(() => Boolean((window as any).reminderTimeline.animation))).toBe(true);
      return await page.evaluate(async jump => {
        const state = (window as any).reminderTimeline;
        const animation = state.animation as Animation;
        state.restore();
        const duration = Number(animation.effect!.getComputedTiming().duration);
        const samples: ReminderFrame[] = [];
        let finished = false;
        let delay: { wallElapsed: number; before: number; after: number } | null = null;
        for (let index = 0; index < 40; index++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          if (index === 5) {
            const wall = performance.now(), before = Number(animation.currentTime);
            // Stress a delayed observation while the real native timeline remains held.
            await new Promise<void>(resolve => setTimeout(resolve, 80));
            delay = { wallElapsed: performance.now() - wall, before, after: Number(animation.currentTime) };
          }
          const time = Math.min(index * (1000 / 60), duration);
          if (!finished) animation.currentTime = time;
          const settings = document.querySelector<HTMLElement>('.reminder-settings')!;
          if (jump && index === 5) settings.style.paddingBottom = '80px';
          if (jump && index === 6) settings.style.removeProperty('padding-bottom');
          const wrapper = document.querySelector<HTMLElement>('.reminder-settings > div');
          samples.push({ advice: wrapper ? Number(getComputedStyle(wrapper).opacity) : null,
            height: wrapper?.getBoundingClientRect().height ?? 0,
            below: document.querySelector('.menu-list')!.getBoundingClientRect().top - settings.getBoundingClientRect().top,
            time: finished ? null : Number(animation.currentTime), wall: performance.now() });
          // Finish through the platform so Svelte performs its actual removal/intro cleanup.
          if (!finished && time === duration) { animation.finish(); finished = true; }
        }
        return { samples, duration, delay };
      }, jump);
    } finally {
      await page.evaluate(() => {
        const state = (window as any).reminderTimeline; state.restore(); state.animation?.finish();
        document.querySelector<HTMLElement>('.reminder-settings')!.style.removeProperty('padding-bottom');
      });
    }
  };
  const toggle = page.getByRole('switch', { name: 'Przypomnienia o szkicach' });
  const out = await sample(() => toggle.click(), injectJump);
  const back = await sample(() => toggle.click());
  await testInfo.attach('native-reminder-timeline', { body: JSON.stringify({ injectJump, out, back }), contentType: 'application/json' });
  expect(out.duration).toBe(200); expect(back.duration).toBe(200);
  for (const result of [out, back]) {
    expect(result.delay!.wallElapsed).toBeGreaterThan(0);
    expect(result.delay!.after).toBe(result.delay!.before);
  }
  expect(out.samples).toHaveLength(40); expect(back.samples).toHaveLength(40);
  const fading = out.samples.filter(item => item.advice !== null && item.advice > 0.02 && item.advice < 0.98);
  expect(fading.length, JSON.stringify(out)).toBeGreaterThanOrEqual(4);
  if (injectJump) expect(() => steadyReminder(out.samples)).toThrow();
  else steadyReminder(out.samples);
  reminderEndpoint(out.samples, false);
  const arriving = back.samples.filter(item => item.advice !== null);
  expect(arriving[0].advice!, JSON.stringify(back)).toBeLessThan(0.3);
  expect(arriving.filter(item => item.advice! > 0.02 && item.advice! < 0.98).length, JSON.stringify(back)).toBeGreaterThanOrEqual(4);
  steadyReminder(back.samples); reminderEndpoint(back.samples, true);
  const invalidSteady = structuredClone(back.samples);
  invalidSteady.at(-1)!.below += 2;
  expect(() => steadyReminder(invalidSteady)).toThrow();
  const invalidEndpoint = structuredClone(out.samples);
  invalidEndpoint.at(-1)!.advice = 0;
  expect(() => reminderEndpoint(invalidEndpoint, false)).toThrow();
});

test('a Draft saved as a Report loses its reminders at once', async ({ page, context }) => {
  await page.route('**/api/**', route => route.abort());
  await context.setGeolocation({ latitude: 53.4, longitude: 22.8, accuracy: 12 });
  await page.goto('/');
  await expect(heading(page, 'Co się stało?')).toBeVisible();
  await android(context);
  await page.reload();
  await startEvent(page, 'Strzał');
  await expect.poll(async () => (await reminders(page)).length).toBe(2);
  await finishFromWhen(page, false);
  await page.getByRole('button', { name: 'Zapisz zgłoszenie' }).click();
  await expect(heading(page, /^Zgłoszenie$/)).toBeVisible();
  await expect.poll(() => reminders(page), { timeout: 3000 }).toEqual([]);
});

test('a reminder never names a fact that would mean going back, such as the remains photo', async ({ page, context }) => {
  const photoMissing = { id: 'draft-photo', eventType: 2, capturedAt: '2026-10-03T08:00:00.000Z', occurredMode: 'now',
    fix: { lat: 53.4, lon: 22.8, accuracy_m: 12, at: '2026-10-03T08:00:00.000Z' } };
  await openWithDrafts(page, context, [photoMissing]);
  await expect.poll(async () => (await reminders(page)).map(item => item.body)).toEqual(['Dalej: Sprawdź i zapisz', 'Dalej: Sprawdź i zapisz']);
});
