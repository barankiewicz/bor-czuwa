import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { answerHome, answerNow, heading, leaveCompass, reportPost, save, settled, startEvent } from './stages.ts';

const points = JSON.parse(await readFile(new URL('../../data/fixtures/acceptance.json', import.meta.url), 'utf8'));

// The target's geometry: a square view box of 256 units with the rim at 118 units.
const rim = 118;
const side = 256;

test.describe('on a phone', () => {
  test.use({ hasTouch: true, isMobile: true, serviceWorkers: 'block' });

  test.beforeEach(async ({ page, context }) => {
    const home = points.barn.point;
    await context.setGeolocation({ latitude: home.lat, longitude: home.lon, accuracy: 12 });
    // Headless Chromium blocks motion sensors unless granted, as a phone's site settings can.
    await context.grantPermissions(['geolocation', 'accelerometer', 'gyroscope', 'magnetometer']);
    // Count live orientation listeners so the test can see the sensor being released. Headless Chromium
    // also fires its own empty orientation event (it has no magnetometer); only the test's readings get through.
    await page.addInitScript(() => {
      const live = new Map<unknown, EventListener>();
      const add = window.addEventListener.bind(window);
      const remove = window.removeEventListener.bind(window);
      window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
        if (type !== 'deviceorientationabsolute') return add(type, listener, options as AddEventListenerOptions);
        const synthetic: EventListener = event => { if (!event.isTrusted) (listener as EventListener)(event); };
        live.set(listener, synthetic);
        return add(type, synthetic, options as AddEventListenerOptions);
      }) as typeof window.addEventListener;
      window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
        if (type !== 'deviceorientationabsolute') return remove(type, listener, options as EventListenerOptions);
        const synthetic = live.get(listener);
        live.delete(listener);
        return remove(type, synthetic ?? listener, options as EventListenerOptions);
      }) as typeof window.removeEventListener;
      Object.assign(window, { liveCompassListeners: () => live.size });
    });
  });

  test('the first reading of any quality can be set, in 5-degree steps', async ({ page }) => {
    await openTarget(page);
    const set = page.getByRole('button', { name: 'Ustaw ten kierunek' });
    // One reading, pointing east: no wait for agreement.
    await orient(page, [270]);
    await expect(set).toBeEnabled();
    await expect(page.getByRole('status').filter({ hasText: 'Telefon wskazuje: na wschód' })).toBeVisible();
    await set.click();
    await expect(target(page)).toHaveAttribute('data-bearing', '90');
    await expect(page.getByText('Wybrany kierunek: na wschód, odległość: nie wiem')).toBeVisible();
    // Noisy readings still point, at their recent mean, and stay settable.
    await orient(page, [10, 80, 20, 100]);
    await expect(set).toBeEnabled();
    await set.click();
    await expect(target(page)).toHaveAttribute('data-bearing', /^\d*[05]$/);
    // A phone tilted 40 degrees, then held upright at heading 60: the back camera points. The beam is the
    // mean of the last 250 ms, so the noisy readings first age out.
    await page.waitForTimeout(300);
    await orient(page, [300], 40);
    await expect(target(page)).toHaveAttribute('data-pointing', '60');
    await orient(page, [300, 300], 90);
    await expect(target(page)).toHaveAttribute('data-pointing', '60');
    await expect(page.getByText('Trzymaj telefon bardziej poziomo')).toHaveCount(0);
    await expect(set).toBeEnabled();
    await set.click();
    await expect(target(page)).toHaveAttribute('data-bearing', '60');
    await leaveCompass(page);
    await answerHome(page, false);
    const posted = await reportPost(page);
    await save(page);
    const payload = (await posted.request).postDataJSON();
    expect(payload.incident_location.hearing_bearing_deg).toBe(60);
    // Only the rounded bearing leaves the phone: no readings, matrices, spreads or unrounded headings.
    expect(JSON.stringify(payload)).not.toMatch(/alpha|heading|compass|pointing|matrix|magnetic|spread/i);
  });

  test('the readout keeps its room as its lines come and go, so nothing below moves', async ({ page }) => {
    await openTarget(page);
    // Measured from the target, as setting a direction scrolls the answer's buttons into view.
    const bottom = () => page.locator('.reading').evaluate(node =>
      Math.round(node.getBoundingClientRect().bottom - document.querySelector('.target')!.getBoundingClientRect().top));
    const empty = await bottom();
    // A steady phone pointing east, so the reading never lapses while the test waits.
    await page.evaluate(`setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute',
      { alpha: 270, beta: 0, gamma: 0, absolute: true })), 50)`);
    await expect(page.getByRole('status').filter({ hasText: 'Telefon wskazuje' })).toBeVisible();
    await expect.poll(bottom).toBe(empty);
    await page.getByRole('button', { name: 'Ustaw ten kierunek' }).click();
    await expect(page.getByText('Wybrany kierunek: na wschód, odległość: nie wiem')).toBeVisible();
    await expect.poll(bottom).toBe(empty);
    await page.getByRole('button', { name: 'Nie wiem, skąd' }).click();
    await expect(page.getByText('Kierunek: nie wiem')).toBeVisible();
    await expect.poll(bottom).toBe(empty);
    // Sampled every frame across a change, not only after it: no frame grows or shrinks the room.
    await page.evaluate(`{
      const node = document.querySelector('.reading'); const seen = new Set(); const start = performance.now();
      window.readingHeights = new Promise(done => {
        const step = () => { seen.add(Math.round(node.getBoundingClientRect().height));
          performance.now() - start < 700 ? requestAnimationFrame(step) : done([...seen]); };
        requestAnimationFrame(step);
      });
    }`);
    await page.getByRole('button', { name: 'Ustaw ten kierunek' }).click();
    const heights = await page.evaluate('window.readingHeights');
    expect(heights).toHaveLength(1);
  });

  test('the rose stays still while the beam turns with the phone', async ({ page }) => {
    await openTarget(page);
    const rose = () => page.locator('.target .rose').evaluate(element => {
      const north = element.querySelector('.letter.north')!.getBoundingClientRect();
      return `${getComputedStyle(element).transform} ${element.getAttribute('transform')} ${north.x},${north.y}`;
    });
    const still = await rose();
    const beam = page.locator('.target .beam');
    const angles = new Set<string>();
    // 60 readings sweeping 180 degrees.
    for (let index = 0; index < 60; index++) {
      await orient(page, [360 - index * 3]);
      if (index % 10 === 9) {
        expect(await rose()).toBe(still);
        angles.add(await beam.evaluate(element => (element as SVGGElement).style.transform));
      }
    }
    expect(await rose()).toBe(still);
    expect(angles.size).toBe(6);
  });

  test('one drag sets the bearing and the distance, and past the rim the view widens', async ({ page }) => {
    await openTarget(page);
    await expect(target(page)).toHaveAttribute('data-view', '1000');
    const start = await onTarget(page, 0, 100, 1000);
    const ring = await onTarget(page, 45, 500, 1000);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(ring.x, ring.y, { steps: 8 });
    await page.mouse.up();
    await expect(target(page)).toHaveAttribute('data-bearing', '45');
    await expect(target(page)).toHaveAttribute('data-distance', '500');
    await expect(page.getByText('Wybrane: na północny wschód, około 500 m')).toBeVisible();
    await expect(target(page)).toHaveAttribute('aria-valuetext', 'na północny wschód, 45°, około 500 m');

    // Out past the 1 km rim: the 3 km view takes over and the point is kept.
    const past = await onTarget(page, 45, 1150, 1000);
    await page.mouse.move(ring.x, ring.y);
    await page.mouse.down();
    await page.mouse.move(past.x, past.y, { steps: 8 });
    await page.mouse.up();
    await expect(target(page)).toHaveAttribute('data-view', '3000');
    await expect(target(page)).toHaveAttribute('data-bearing', '45');
    await expect(target(page)).toHaveAttribute('data-distance', /^(1000|1500|2000|3000)$/);
    await expect(page.locator('.target .point')).toBeVisible();
    await page.getByRole('button', { name: 'Przybliż' }).click();
    await expect(target(page)).toHaveAttribute('data-view', '1000');
    await expect(target(page)).toHaveAttribute('data-bearing', '45');

    // Past the 3 km rim the 5 km view takes over, and the answer can reach 5 km.
    await target(page).focus();
    for (let index = 0; index < 11; index++) await page.keyboard.press('PageUp');
    await expect(target(page)).toHaveAttribute('data-distance', '5000');
    await expect(target(page)).toHaveAttribute('data-view', '5000');

    // Back to the 500 m point, then send it.
    await target(page).focus();
    for (let index = 0; index < 10; index++) await page.keyboard.press('PageDown');
    for (let index = 0; index < 3; index++) await page.keyboard.press('PageUp');
    await expect(target(page)).toHaveAttribute('data-distance', '500');
    await leaveCompass(page);
    await answerHome(page, false);
    const posted = await reportPost(page);
    await save(page);
    const location = (await posted.request).postDataJSON().incident_location;
    expect([location.hearing_bearing_deg, location.hearing_distance_m]).toEqual([45, 500]);
  });

  test('upright and tilted phones point without a tilt message', async ({ page }) => {
    await openTarget(page);
    // Phone raised upright towards heading 300 (alpha 60): the camera looks north-west.
    await orient(page, [60], 90);
    await expect(target(page)).toHaveAttribute('data-pointing', '300');
    await expect(page.getByRole('status').filter({ hasText: 'Telefon wskazuje: na północny zachód' })).toBeVisible();
    await expect(page.getByText('Trzymaj telefon bardziej poziomo')).toHaveCount(0);
  });

  test('landscape rotation turns the pointing edge with the screen', async ({ page }) => {
    await openTarget(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true,
      screenOrientation: { type: 'landscapePrimary', angle: 90 } });
    expect(await page.evaluate(() => screen.orientation.angle)).toBe(90);
    // Device top faces north, so the landscape screen top faces east.
    await orient(page, [0]);
    await expect(target(page)).toHaveAttribute('data-pointing', '90');
  });

  test('a phone without a heading works by hand with no beam and no sensor message', async ({ page }) => {
    await openTarget(page);
    await page.evaluate(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute',
      { alpha: null, beta: null, gamma: null, absolute: true })));
    // An empty event means no magnetometer at all, so the target stops listening.
    await expect.poll(() => listeners(page)).toBe(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.target .beam')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ustaw ten kierunek' })).toHaveCount(0);
    await expect(target(page)).not.toHaveAttribute('data-bearing', /./);
    const east = await onTarget(page, 90, 750, 1000);
    await page.mouse.click(east.x, east.y);
    await expect(target(page)).toHaveAttribute('data-bearing', '90');
    await expect(target(page)).toHaveAttribute('data-distance', '750');

    // Blocked sensors still say how to unblock them, and never block the step.
    await page.context().clearPermissions();
    await page.context().grantPermissions(['geolocation']);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByRole('alert')).toContainText('Przeglądarka blokuje czujniki ruchu dla tej strony.');
    await expect(page.getByRole('button', { name: 'Dalej' })).toBeVisible();
  });

  test('the background stops the sensor and the foreground starts it again, keeping the answer', async ({ page }) => {
    await openTarget(page);
    await orient(page, [90]);
    await page.getByRole('button', { name: 'Ustaw ten kierunek' }).click();
    await expect(target(page)).toHaveAttribute('data-bearing', '270');
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(await listeners(page)).toBe(0);
    await expect(page.locator('.target .beam')).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => listeners(page)).toBe(1);
    await orient(page, [180]);
    await expect(target(page)).toHaveAttribute('data-pointing', '180');
    expect(await listeners(page)).toBe(1);
    await expect(target(page)).toHaveAttribute('data-bearing', '270');
  });

  test('the map is on by default, drawn from vector tiles, turning it off is remembered, and offline it is never missed', async ({ page, context }) => {
    const tiles: string[] = [];
    const raster: string[] = [];
    const terrain: string[] = [];
    await page.route('https://tile.openstreetmap.org/**', route => { raster.push(route.request().url()); return route.abort(); });
    await serveVectorTiles(page, tiles);
    await serveTerrain(context, terrain);
    // The suite turns the map off in its stored state; a Reporter's first Gdzie has it on.
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('direction-map'));
    await openTarget(page);
    // Gdzie has no map control of its own; the switch lives in Menu.
    await expect(page.getByRole('button', { name: /mapę/ })).toHaveCount(0);
    await expect.poll(() => tiles.length).toBe(9);
    // 1 km over 118 units at the barn's latitude (53.4) needs zoom 13.4; the coarsest zoom whose tiles still
    // span 128 units is 14. 3 and 5 km are both drawn from zoom 12.
    expect(new Set(tiles.map(url => url.split('/')[5]))).toEqual(new Set(['14']));
    // Forest, water, main roads, forest tracks and a village name, and nothing from the raster server.
    for (const kind of ['wood', 'water', 'road', 'track']) {
      await expect(page.locator(`.target .map-${kind}`).first()).toBeAttached();
    }
    // Contour lines traced on the phone from the recorded terrain tile, with their source credited.
    await expect.poll(() => terrain.length).toBe(9);
    // Painted once per scale: an image of the lines at the screen's density, with ink on it.
    const picture = page.locator('.target .contours image');
    await expect(picture).toHaveAttribute('href', /^blob:/);
    expect(await picture.evaluate(async element => {
      const image = new Image(); image.src = element.getAttribute('href')!; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, image.width, image.height).data;
      let inked = 0; for (let index = 3; index < data.length; index += 4) if (data[index] > 0) inked++;
      return inked / (data.length / 4);
    })).toBeGreaterThan(.005);
    await expect(page.locator('.target .place').first()).toBeVisible();
    expect(await page.locator('.target .map-tile path').evaluateAll(paths => paths.every(path => path.getAttribute('d')!.length > 10))).toBe(true);
    expect(raster).toEqual([]);
    await expect(page.locator('.credit')).toHaveText('OpenFreeMap © OpenMapTiles © OpenStreetMap · wysokości: Mapzen, Copernicus EU-DEM');
    await expect(page.getByRole('link', { name: '© OpenStreetMap' })).toHaveAttribute('href', 'https://www.openstreetmap.org/copyright');
    await page.getByRole('button', { name: 'Oddal' }).click();
    await expect(page.locator('.scale-caption')).toContainText('3 km');
    await expect.poll(() => tiles.filter(url => url.split('/')[5] === '12').length).toBe(9);
    // The old zoom gives way once the new one has drawn.
    await expect(page.locator('.target .map')).toHaveCount(1);
    await page.getByRole('button', { name: 'Oddal' }).click();
    await expect(page.locator('.scale-caption')).toContainText('5 km');
    await page.waitForTimeout(400);
    expect(tiles.length).toBe(18);
    expect(raster).toEqual([]);

    // Turned off in Menu, it stays off for later Reports and nothing more is fetched.
    await mapSwitch(page, false);
    await expect(page.getByText('Mapa pod tarczą kierunku wyłączona.')).toBeAttached();
    const before = tiles.length;
    await page.goto('/');
    await startEvent(page, 'Strzał');
    await answerNow(page);
    await page.waitForTimeout(500);
    expect(tiles.length).toBe(before);
    await expect(page.getByRole('link', { name: '© OpenStreetMap' })).toHaveCount(0);
    await mapSwitch(page, true);

    // A corrupt tile draws nothing and says nothing.
    await page.unroute('https://tiles.openfreemap.org/**');
    await serveVectorTiles(page, tiles, fixtureTile.subarray(0, fixtureTile.length - 100));
    await page.goto('/');
    await startEvent(page, 'Strzał');
    await answerNow(page);
    await expect.poll(() => tiles.length).toBe(before + 9);
    await page.waitForTimeout(500);
    await expect(page.locator('.target .map-tile')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '© OpenStreetMap' })).toHaveCount(0);
    await expect(page.locator('.credit')).toHaveCSS('opacity', '0');

    // Offline the target is rings on paper with no error, no credit and no retry.
    await page.unroute('https://tiles.openfreemap.org/**');
    await page.route('https://tiles.openfreemap.org/**', route => route.abort('internetdisconnected'));
    await context.unroute('https://s3.amazonaws.com/**');
    await context.route('https://s3.amazonaws.com/**', route => route.abort('internetdisconnected'));
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Strzał', exact: true })).toBeVisible();
    await context.setOffline(true);
    await startEvent(page, 'Strzał');
    await answerNow(page);
    await page.waitForTimeout(500);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.target .map-tile')).toHaveCount(0);
    await expect(page.getByRole('link', { name: '© OpenStreetMap' })).toHaveCount(0);
    await expect(page.locator('.credit')).toHaveCSS('opacity', '0');
    await expect(page.locator('.target .contours')).toHaveCount(0);
    await expect(page.locator('.target .ring').first()).toBeAttached();
    await expect(page.getByRole('button', { name: /ponownie/ })).toHaveCount(0);
  });

  test('the map takes each theme\'s map colours, never the answer\'s orange, and its text keeps AA contrast', async ({ page, context }) => {
    await serveVectorTiles(page, []);
    await serveTerrain(context, []);
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('direction-map'));
    await openTarget(page);
    await expect(page.locator('.target .place').first()).toBeVisible();
    const seen: Record<string, string[]> = {};
    for (const theme of ['light', 'dark', 'noc']) {
      const result = await page.evaluate(theme => {
        document.documentElement.dataset.theme = theme;
        const rgb = (value: string) => value.match(/\d+(\.\d+)?/g)!.slice(0, 3).map(Number);
        const lum = (value: string) => {
          const [r, g, b] = rgb(value).map(channel => { const c = channel / 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
          return .2126 * r + .7152 * g + .0722 * b;
        };
        const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
        const style = (selector: string) => getComputedStyle(document.querySelector(selector)!);
        const action = getComputedStyle(document.documentElement).getPropertyValue('--action').trim();
        const actionRgb = (() => { const probe = document.createElement('i'); probe.style.color = action; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; })();
        const fills = ['.face', '.map-wood', '.map-water'].map(selector => style(`.target ${selector}`).fill);
        const strokes = ['.map-road', '.map-track'].map(selector => style(`.target ${selector}`).stroke);
        const texts = ['.place', '.ring-label', '.letter'].map(selector => style(`.target ${selector}`).fill);
        return { fills, strokes, actionRgb, lowest: Math.min(...texts.flatMap(text => fills.map(fill => ratio(text, fill)))) };
      }, theme);
      expect(result.lowest, `${theme}: text over the map`).toBeGreaterThanOrEqual(4.5);
      expect([...result.fills, ...result.strokes]).not.toContain(result.actionRgb);
      seen[theme] = result.fills;
    }
    // Each theme has its own map, not the light one reused.
    expect(new Set(Object.values(seen).map(fills => fills.join())).size).toBe(3);
  });

  test('an untouched target shows the gesture until the first touch', async ({ page }) => {
    await openTarget(page);
    const hint = page.locator('.target .hint');
    await expect(hint).toBeAttached();
    const east = await onTarget(page, 90, 500, 1000);
    await page.mouse.click(east.x, east.y);
    await expect(hint).toHaveCount(0);
    await expect(target(page)).toHaveAttribute('data-bearing', '90');
  });

  test('a Draft made with the old dial reopens with its answer drawn', async ({ page }) => {
    await openTarget(page);
    await target(page).focus();
    await page.keyboard.press('Home');
    for (let index = 0; index < 18; index++) await page.keyboard.press('ArrowRight');
    await expect(target(page)).toHaveAttribute('data-bearing', '90');
    // The old dial's distance band, stored before metres were.
    await page.evaluate(async () => {
      const names = await indexedDB.databases();
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(names[0].name!); request.onsuccess = () => resolve(request.result); request.onerror = reject;
      });
      const tx = db.transaction('drafts', 'readwrite');
      const store = tx.objectStore('drafts');
      const all = await new Promise<Record<string, unknown>[]>(resolve => { const request = store.getAll(); request.onsuccess = () => resolve(request.result); });
      store.put({ ...all[0], hearingDistanceM: undefined, hearingDistanceBand: 'over_1km' });
      await new Promise(resolve => { tx.oncomplete = resolve; });
      db.close();
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Moje zapisy', exact: true }).click();
    await page.getByRole('button', { name: /^Dokończ zgłoszenie/ }).first().click();
    await page.getByRole('button', { name: 'Zmień: Gdzie' }).click();
    await expect(heading(page, 'Skąd słychać strzał?')).toBeVisible();
    await expect(target(page)).toHaveAttribute('data-bearing', '90');
    // The band's stored meaning is 2 km, the same figure the area maths has always used.
    await expect(target(page)).toHaveAttribute('data-distance', '2000');
    await expect(target(page)).toHaveAttribute('data-view', '3000');
    await expect(page.locator('.target .point')).toBeVisible();
  });
});

test.describe('on a desktop', () => {
  test('without a sensor the target has no beam and no sensor message, and works by mouse and keyboard', async ({ page, context }) => {
    const home = points.barn.point;
    await context.setGeolocation({ latitude: home.lat, longitude: home.lon, accuracy: 12 });
    await page.goto('/');
    await startEvent(page, 'Strzał');
    await answerNow(page);
    await expect(heading(page, 'Skąd słychać strzał?')).toBeVisible();
    await settled(page);
    await expect(page.locator('.target .beam')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/kompas|czujnik/i)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Ustaw ten kierunek' })).toHaveCount(0);
    const slider = page.getByRole('slider', { name: 'Tarcza kierunku' });
    await expect(slider).toHaveAttribute('aria-valuetext', 'Kierunek nie wybrany');

    // A click places a point; keyboard alone then reaches every state.
    const south = await onTarget(page, 180, 300, 1000);
    await page.mouse.click(south.x, south.y);
    await expect(slider).toHaveAttribute('aria-valuetext', 'na południe, 180°, około 300 m');
    await slider.focus();
    await page.keyboard.press('Home');
    await expect(slider).toHaveAttribute('aria-valuetext', 'na północ, 0°, około 300 m');
    await page.keyboard.press('ArrowLeft');
    await expect(slider).toHaveAttribute('aria-valuetext', 'na północ, 355°, około 300 m');
    await page.keyboard.press('ArrowRight');
    for (let index = 0; index < 9; index++) await page.keyboard.press('ArrowUp');
    await expect(slider).toHaveAttribute('aria-valuetext', 'na północny wschód, 45°, około 300 m');
    await page.keyboard.press('PageUp');
    await expect(slider).toHaveAttribute('aria-valuetext', 'na północny wschód, 45°, około 500 m');
    for (let index = 0; index < 3; index++) await page.keyboard.press('PageUp');
    await expect(slider).toHaveAttribute('aria-valuetext', 'na północny wschód, 45°, około 1,5 km');
    await expect(page.locator('.target')).toHaveAttribute('data-view', '3000');
    await page.keyboard.press('PageDown');
    await expect(slider).toHaveAttribute('aria-valuetext', 'na północny wschód, 45°, około 1 km');

    // The scale's zoom buttons follow the target; at 1 km "Przybliż" has nowhere to go.
    await page.keyboard.press('PageDown');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Przybliż' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('.target')).toHaveAttribute('data-view', '1000');
    await expect(page.locator('.scale-caption')).toContainText('1 km');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Oddal' })).toBeFocused();

    // A direction with no distance is a dashed ray, and the button says that was the answer.
    await page.keyboard.press('Tab');
    const far = page.getByRole('button', { name: 'Nie wiem, jak daleko' });
    await expect(far).toBeFocused();
    await expect(far).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('Enter');
    await expect(far).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.target .ray.open')).toBeVisible();
    await expect(slider).toHaveAttribute('aria-valuetext', 'na północny wschód, 45°');
    await expect(page.getByText('Wybrany kierunek: na północny wschód, odległość: nie wiem')).toBeVisible();
    await expect(page.locator('.target .point')).toHaveCount(0);
    await expect(page.locator('.target .ray')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Nie wiem, skąd' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(slider).toHaveAttribute('aria-valuetext', 'Kierunek nie wybrany');
    await expect(page.getByText('Kierunek: nie wiem')).toBeVisible();
    // Nie wiem, skąd is drawn too: the whole face takes the answer's colour.
    await expect(page.locator('.target .anywhere')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Nie wiem, skąd' })).toHaveAttribute('aria-pressed', 'true');
    await expect(footer(page)).toContainText('Pomiń kierunek i odległość');

    await slider.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('PageUp');
    await expect(slider).toHaveAttribute('aria-valuetext', 'na północ, 0°, około 100 m');
    await leaveCompass(page);
    await answerHome(page, false);
    const posted = await reportPost(page);
    await save(page);
    const location = (await posted.request).postDataJSON().incident_location;
    expect([location.hearing_bearing_deg, location.hearing_distance_m]).toEqual([0, 100]);
  });
});

const footer = (page: Page) => page.locator('.screen-foot');
const target = (page: Page) => page.locator('.target');

// OpenFreeMap tile 14/9228/5304 beside the barn, served for every tile so the suite never touches the network.
const fixtureTile = await readFile(new URL('../fixtures/openfreemap-14-9228-5304.pbf', import.meta.url));
async function serveVectorTiles(page: Page, tiles: string[], body: Buffer = fixtureTile) {
  await page.route('https://tiles.openfreemap.org/**', route => {
    const url = route.request().url();
    if (url === 'https://tiles.openfreemap.org/planet') {
      return route.fulfill({ json: { tiles: ['https://tiles.openfreemap.org/planet/fixture/{z}/{x}/{y}.pbf'] }, headers: { 'access-control-allow-origin': '*' } });
    }
    tiles.push(url);
    return route.fulfill({ status: 200, contentType: 'application/vnd.mapbox-vector-tile', body, headers: { 'access-control-allow-origin': '*' } });
  });
}

// Mapzen terrain tile 12/2307/1326 beside the barn (Copernicus EU-DEM), served for every terrain tile.
// The contour worker fetches it, so the route is on the context, which sees worker requests.
const terrainTile = await readFile(new URL('../fixtures/terrarium-12-2307-1326.png', import.meta.url));
async function serveTerrain(context: BrowserContext, asked: string[]) {
  await context.route('https://s3.amazonaws.com/**', route => {
    asked.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'image/png', body: terrainTile, headers: { 'access-control-allow-origin': '*' } });
  });
}

/** Sets the Menu switch for the map under the target. */
async function mapSwitch(page: Page, on: boolean) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('switch', { name: 'Mapa pod tarczą kierunku' }).setChecked(on);
}

async function openTarget(page: Page) {
  await page.goto('/');
  await startEvent(page, 'Strzał');
  await answerNow(page);
  await expect(heading(page, 'Skąd słychać strzał?')).toBeVisible();
  // A pointer press during the screen's view transition lands on its overlay.
  await settled(page);
  // Startup and the target share one foreground listener.
  await expect.poll(() => listeners(page)).toBe(1);
}

/** Sends phone readings, alpha counter-clockwise from north as the W3C event defines it. */
async function orient(page: Page, alphas: number[], beta = 0) {
  for (const alpha of alphas) {
    await page.evaluate(([alpha, beta]) => window.dispatchEvent(new DeviceOrientationEvent('deviceorientationabsolute',
      { alpha, beta, gamma: 0, absolute: true })), [alpha, beta]);
    await page.waitForTimeout(40);
  }
}

const listeners = (page: Page) => page.evaluate(() => (window as unknown as { liveCompassListeners(): number }).liveCompassListeners());

/** The screen position of a bearing and distance on the target in the given view. */
async function onTarget(page: Page, degrees: number, metres: number, view: number) {
  await page.locator('.target').scrollIntoViewIfNeeded();
  const box = (await page.locator('.target svg').boundingBox())!;
  const radius = metres / view * rim * box.height / side;
  return {
    x: box.x + box.width / 2 + radius * Math.sin(degrees * Math.PI / 180),
    y: box.y + box.height / 2 - radius * Math.cos(degrees * Math.PI / 180)
  };
}
