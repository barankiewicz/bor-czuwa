<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { prefersReducedMotion, Tween } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';
  import { fade } from 'svelte/transition';
  import { compassPoint, roundBearing, type HeadingState } from './compass';
  import { distanceSteps } from './home-area';
  import { project, tileSize, visibleTiles, type Point } from './map-tiles';
  import { fills, fitPlaces, lines, loadTile, type Box, type DrawnTile } from './vector-map';
  import { loadContours, paintContours, terrainZoom, type Contours } from './contours';
  import { compassOffered, type CompassProblem } from './platform';
  import { subscribeHeading, enableSessionCompass } from './sensor-session';
  import { reveal } from './reveal';

  type Answer = { bearing?: number; distance?: number };
  let { t, bearing, distance, centre, distanceText, onchange } = $props<{
    t: (text: string) => string;
    /** The direction the Reporter marked, or undefined; a live reading never becomes one by itself. */
    bearing: number | undefined;
    distance: number | undefined;
    /** Where the Reporter stands, for the optional map under the target. */
    centre: Point | undefined;
    distanceText: (metres: number) => string;
    onchange: (answer: Answer) => void;
  }>();

  const id = $props.id();
  // The target's face in view-box units; the centre is 0 0 and north is up.
  const rim = 118;
  // The view box: the face plus a little room for the rim's stroke; the compass letters sit inside the rim.
  const side = 256;
  const rings = [500, 1000, 2000, 3000, 4000, 5000];
  // The scales the target shows: the rim stands for 1, 3 or 5 km.
  const views = [1000, 3000, 5000];
  const viewFor = (metres: number) => views.find(item => item >= metres) ?? views.at(-1)!;
  const letters = [['Pn', 0], ['Wsch', 90], ['Pd', 180], ['Zach', 270]] as const;
  // The letters mark the four main directions, so ticks are left only on the diagonals.
  const ticks = [45, 135, 225, 315];
  const letterRadius = (degrees: number) => rim - (degrees % 180 ? 22 : 16);
  // Distance labels sit on their ring, south-east of Ty.
  const labelAngle = 135;
  const radians = Math.PI / 180;
  const at = (degrees: number, radius: number) => [radius * Math.sin(degrees * radians), -radius * Math.cos(degrees * radians)] as const;
  const normal = (degrees: number) => (degrees % 360 + 360) % 360;
  // Moves an unwrapped angle to the nearest equivalent of target, so a turn never goes the long way.
  const toward = (current: number, target: number) => current + ((target - current) % 360 + 540) % 360 - 180;
  const nearestStep = (metres: number) => distanceSteps.reduce((best, step) => Math.abs(step - metres) < Math.abs(best - metres) ? step : best);
  const words = (degrees: number) => `${t('na ')}${t(compassPoint(degrees))}`;
  const motion = (ms: number) => prefersReducedMotion.current ? 0 : ms;

  // The foreground session owns the sensor; this step only displays its reading.
  let problem = $state<CompassProblem>();
  let reading = $state<HeadingState>({});
  let unknown = $state(false);
  // Plays the gesture once when the step opens with nothing marked; any answer or key press ends it.
  let hinting = $state(false);
  // Opens at 1 km, or at 3 km for a Draft whose point lies further out.
  let view = $state<number>(untrack(() => distance === undefined ? 1000 : viewFor(distance)));
  let mapOn = $state(false);
  // Tiles by key once settled: drawn, or null when it failed, was corrupt or the phone is offline.
  let drawn = $state.raw<Record<string, DrawnTile | null>>({});
  // Contour lines and the point they were traced around; the map keeps following the Reporter's fix.
  let contours = $state.raw<Contours & { origin: Point }>();
  let contoursAsked = false;
  const requested = new Set<string>();
  const leaving = new AbortController();
  let target: HTMLDivElement | undefined;
  let answers: HTMLDivElement | undefined;
  let dragging = false;
  let stop = () => {};
  let shownBefore = untrack(() => bearing !== undefined);
  let beamShown = false;

  const live = $derived(compassOffered && !problem);
  const pointing = $derived(live && reading.pointing !== undefined ? roundBearing(reading.pointing) : undefined);
  // Units per metre. The scale change and everything drawn at a distance travel together on this one value.
  const scale = new Tween(untrack(() => rim / view), { duration: 0, easing: cubicOut });
  // The beam follows the sensor; its width shows how sure Android is of the heading.
  const beam = new Tween({ angle: 0, spread: 15 }, { duration: 0 });
  // The marked answer as drawn: snapped steps travel to their place instead of hopping there.
  const shown = new Tween(untrack(() => ({ bearing: bearing ?? 0, metres: distance ?? view })), { duration: 0 });

  // Metres per tile pixel at zoom 0 where the Reporter stands.
  const groundMetres = $derived(centre ? 156543.03 * Math.cos(centre.lat * radians) : 0);
  // The coarsest zoom whose tiles span at least 128 units, so the 3 × 3 tiles around Ty always cover the face.
  // OpenFreeMap stops at zoom 14; past it a tile is drawn larger. In Poland 1 km is zoom 14, 3 and 5 km zoom 12.
  const zoom = $derived(Math.min(14, Math.floor(Math.log2(groundMetres * rim / view)) + 1));
  // Tile layers drawn, oldest first. A new zoom's tiles fade in over the old ones, which keep scaling with
  // the rings until the new layer has settled, so the map never blanks or jumps at a scale change.
  let layers = $state<number[]>([]);
  const layerTiles = (level: number) => centre ? visibleTiles(centre, level, 0) : [];
  // The credit waits for a tile that actually drew, so offline the target stays as it was.
  const mapShown = $derived(layers.some(level => layerTiles(level).some(tile => drawn[tile.key])));
  $effect(() => {
    const level = zoom;
    if (!mapOn || !centre) { layers = []; return; }
    const next = untrack(() => layers.at(-1) === level ? layers : [...layers.filter(item => item !== level), level]);
    if (next !== untrack(() => layers)) layers = next;
  });
  $effect(() => {
    const newest = layers.at(-1);
    if (layers.length < 2 || newest === undefined) return;
    // An older layer fades out only once the newest has loaded and the scale has reached the new view, since a
    // fading layer stops scaling. Measured against the view, not the tween's target, which still holds the old
    // scale in the moment the view changes: with the new zoom's tiles already cached, the old layer would
    // otherwise start fading before the scale had moved, and the map would go pale mid-zoom.
    const settled = scale.current === rim / view;
    if (settled && layerTiles(newest).every(tile => tile.key in drawn)) layers = [newest];
  });
  $effect(() => {
    for (const level of layers) for (const tile of layerTiles(level)) {
      if (requested.has(tile.key)) continue;
      requested.add(tile.key);
      void loadTile(level, tile.urlX, tile.y, leaving.signal).then(found => {
        if (!leaving.signal.aborted) drawn = { ...drawn, [tile.key]: found ?? null };
      });
    }
  });
  $effect(() => {
    if (!mapOn || !centre || contoursAsked) return;
    contoursAsked = true;
    const origin = { ...centre };
    void loadContours(origin, leaving.signal).then(found => { if (found && !leaving.signal.aborted) contours = { ...found, origin }; });
  });
  // Contours are shown as one picture per scale, painted once, so a zoom scales pictures instead of repainting
  // every line point each frame. Like the tiles, a new scale's picture fades in over the old one, which keeps
  // scaling until the new one has settled. Each picture reaches 10% past the rim of its own scale.
  let contourPictures = $state.raw<Record<string, string>>({});
  let contourShown = $state<number[]>([]);
  let themeTick = $state(0);
  const pictureKey = (scaleView: number) => `${scaleView}-${themeTick}`;
  // Where the traced point sits from Ty in metres, east and south, now that the fix may have moved a little.
  const contourShift = $derived.by(() => {
    if (!contours || !centre) return [0, 0];
    const from = project(contours.origin, terrainZoom), to = project(centre, terrainZoom);
    const metres = 156543.03 * Math.cos(centre.lat * radians) / 2 ** terrainZoom;
    return [(from.x - to.x) * metres, (from.y - to.y) * metres];
  });
  // All three pictures are painted in the worker as soon as the lines arrive, the current scale first, so no
  // zoom ever waits on painting (on the Pixel a first zoom that painted its picture took 50 ms a frame).
  $effect(() => {
    const found = contours, tick = themeTick, first = untrack(() => view), box = target?.getBoundingClientRect();
    if (!found || !box) return;
    const ratio = window.devicePixelRatio || 1;
    const ink = getComputedStyle(target!).getPropertyValue('--ink').trim() || '#1c1b18';
    // The face's rim on screen, 10% more, at the screen's pixel density, capped for memory.
    const size = Math.min(2048, Math.round(box.width * rim / side * 2 * 1.1 * ratio));
    let cancelled = false;
    void (async () => {
      for (const scaleView of [first, ...views.filter(item => item !== first)]) {
        const key = `${scaleView}-${tick}`;
        if (cancelled || untrack(() => contourPictures[key])) continue;
        const url = await paintContours(found, scaleView, size, ratio, ink, leaving.signal);
        if (url && !cancelled && !leaving.signal.aborted) contourPictures = { ...untrack(() => contourPictures), [key]: url };
      }
    })();
    return () => { cancelled = true; };
  });
  $effect(() => {
    const scaleView = view;
    if (!contours) return;
    const next = untrack(() => contourShown.at(-1) === scaleView ? contourShown : [...contourShown.filter(item => item !== scaleView), scaleView]);
    if (next !== untrack(() => contourShown)) contourShown = next;
  });
  $effect(() => {
    const newest = contourShown.at(-1);
    if (contourShown.length < 2 || newest === undefined) return;
    if (scale.current === rim / view && contourPictures[pictureKey(newest)]) contourShown = [newest];
  });

  // Rings fade as they shrink towards Ty instead of crowding it; each label only on a ring wide enough to hold it.
  const ringOpacity = (radius: number) => Math.max(0, Math.min(1, (radius - 20) / 10));
  const labelOpacity = (radius: number) => Math.max(0, Math.min(1, (radius - 34) / 8, (rim - 12 - radius) / 8));
  // At 5 km every other kilometre is labelled, so the labels do not stack into a column.
  const labelled = (metres: number) => view < 5000 || metres % 2000 !== 0;
  // What place names must not cover at the scale being shown: Ty, the compass letters and the ring labels.
  const blocked = $derived.by(() => {
    const boxes: Box[] = [[-16, -10, 16, 30]];
    for (const [letter, degrees] of letters) {
      const [x, y] = at(degrees, letterRadius(degrees));
      const half = letter.length * 4.5 + 6;
      boxes.push([x - half, y - 9, x + half, y + 9]);
    }
    for (const metres of rings) {
      const radius = metres * rim / view;
      if (!labelled(metres) || labelOpacity(radius) === 0) continue;
      const [x, y] = at(labelAngle, radius);
      const half = distanceText(metres).length * 3.4 + 6;
      boxes.push([x - half, y - 9, x + half, y + 9]);
    }
    return boxes;
  });
  /** A layer's village and town names that fit at the scale being shown, in metres from Ty. */
  function placesFor(level: number) {
    if (!centre) return [];
    const metres = groundMetres / 2 ** level;
    const middle = project(centre, level);
    const units = rim / view;
    const found = layerTiles(level).flatMap(tile => {
      const tileDrawn = drawn[tile.key];
      return tileDrawn ? tileDrawn.places.map(place => {
        const east = ((tile.x + place.x / tileDrawn.extent) * tileSize - middle.x) * metres;
        const south = ((tile.y + place.y / tileDrawn.extent) * tileSize - middle.y) * metres;
        return { ...place, east, south, x: east * units, y: south * units };
      }) : [];
    });
    return fitPlaces(found, blocked, rim - 6);
  }

  // A ray with no distance reaches the rim of the current view.
  $effect(() => {
    const next = { bearing: bearing ?? untrack(() => shown.target.bearing), metres: distance ?? view };
    untrack(() => {
      // A new mark appears where it lands; one already drawn travels to its new place.
      const drawn = shownBefore;
      void shown.set({ ...next, bearing: toward(shown.current.bearing, next.bearing) }, { duration: drawn ? motion(dragging ? 90 : 160) : 0 });
    });
    shownBefore = bearing !== undefined;
  });
  $effect(() => { void scale.set(rim / view, { duration: motion(240) }); });
  $effect(() => {
    const { pointing: angle, spread = 15 } = reading;
    if (angle === undefined || !live) { beamShown = false; return; }
    untrack(() => {
      // The first reading after none places the beam where it points, under its fade; later ones turn it there.
      void beam.set({ angle: toward(beam.current.angle, angle), spread }, { duration: beamShown ? motion(120) : 0 });
    });
    beamShown = true;
  });

  // The sonar: 30° arcs leave Ty every 850 ms and take 3.2 s to pass the rim. They follow the phone; once
  // there is an answer they run along it instead, and flash orange as they cross its point.
  const sonar = { travel: 3200, gap: 850, width: 30, from: 14 };
  const sonarSource = $derived(bearing !== undefined ? 'answer' : pointing !== undefined ? 'phone' : undefined);
  const sonarAngle = $derived(sonarSource === 'answer' ? shown.current.bearing : beam.current.angle);
  // Following the phone the arcs are as wide as Android's doubt: 30° normally, 80° when it reports poor accuracy.
  const sonarWidth = $derived(sonarSource === 'phone' ? 2 * beam.current.spread : sonar.width);
  let waves = $state.raw<number[]>([]);
  let clock = $state(0);
  $effect(() => {
    const source = sonarSource;
    // A new source starts empty, so waves in flight never jump to the new direction; the old group fades.
    untrack(() => { waves = []; });
    if (!source || prefersReducedMotion.current) return;
    let frame = 0, last = -Infinity;
    const step = (now: number) => {
      clock = now;
      const alive = waves.filter(born => now - born < sonar.travel);
      if (now - last >= sonar.gap) { alive.push(now); last = now; }
      waves = alive;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  });
  const arc = (radius: number, width: number) => {
    const [x1, y1] = at(-width / 2, radius), [x2, y2] = at(width / 2, radius);
    return `M${x1} ${y1}A${radius} ${radius} 0 0 1 ${x2} ${y2}`;
  };
  /** One wave now: it fades in over its first 12% and out as it crosses the rim, and thins as it grows. */
  function wave(born: number) {
    const progress = Math.max(0, (clock - born) / sonar.travel);
    const radius = sonar.from + (rim + 14 - sonar.from) * progress;
    const strength = Math.min(1, progress / .12) * Math.max(0, Math.min(1, (rim + 14 - radius) / 36));
    return { radius, progress, strength, width: 3.2 - 1.8 * progress };
  }

  function start() {
    stop();
    if (!compassOffered) return;
    stop = subscribeHeading((next, found) => { reading = next; problem = found; });
  }
  async function enable() {
    await enableSessionCompass();
    await tick();
    target?.focus({ preventScroll: true });
  }
  function answer(next: Answer) {
    unknown = false;
    hinting = false;
    if (next.distance !== undefined && next.distance > view) view = viewFor(next.distance);
    onchange({ bearing: next.bearing === undefined ? undefined : normal(next.bearing), distance: next.distance });
  }
  /** Marks where the phone points now; a distance already marked stays. */
  function markFront() {
    if (pointing !== undefined) answer({ bearing: pointing, distance });
  }
  function underFinger(event: PointerEvent) {
    const box = (event.currentTarget as Element).getBoundingClientRect();
    const units = side / box.height;
    const x = (event.clientX - box.left - box.width / 2) * units;
    const y = (event.clientY - box.top - box.height / 2) * units;
    // Measured against the scale as drawn, so the point stays under the finger while the scale changes.
    const metres = Math.hypot(x, y) / scale.current;
    // Past the rim the next scale out takes over, one step at a time.
    if (metres > view) view = views[Math.min(views.length - 1, views.indexOf(view) + 1)];
    return { bearing: roundBearing(normal(Math.atan2(x, -y) / radians)), distance: nearestStep(Math.min(metres, views.at(-1)!)) };
  }
  function press(event: PointerEvent) {
    dragging = true;
    (event.currentTarget as Element).setPointerCapture(event.pointerId);
    answer(underFinger(event));
  }
  function drag(event: PointerEvent) {
    if (dragging) answer(underFinger(event));
  }
  /** After a touch, the answer buttons under the target come into view if the screen hides them, once the
   * Nie wiem, jak daleko row has finished opening. Never during a drag, which would move the target. */
  function release() {
    if (!dragging) return;
    dragging = false;
    setTimeout(() => answers?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion.current ? 'auto' : 'smooth' }), motion(220));
  }
  function key(event: KeyboardEvent) {
    const turn = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[event.key];
    const reach = { PageUp: 1, PageDown: -1 }[event.key];
    if (!turn && !reach && event.key !== 'Home') return;
    event.preventDefault();
    if (reach) {
      const index = distance === undefined ? -1 : distanceSteps.indexOf(nearestStep(distance));
      answer({ bearing, distance: distanceSteps[Math.max(0, Math.min(distanceSteps.length - 1, index + reach))] });
      return;
    }
    const from = bearing ?? pointing;
    answer({ bearing: event.key === 'Home' || from === undefined ? 0 : from + turn!, distance });
  }
  function farUnknown() { if (distance !== undefined) onchange({ bearing, distance: undefined }); }
  function notKnown() {
    unknown = true;
    hinting = false;
    if (bearing !== undefined || distance !== undefined) onchange({ bearing: undefined, distance: undefined });
  }
  function zoomBy(step: number) {
    view = views[Math.max(0, Math.min(views.length - 1, views.indexOf(view) + step))];
  }

  const valueText = $derived([
    bearing === undefined ? t('Kierunek nie wybrany') : `${words(bearing)}, ${bearing}°`,
    ...(distance === undefined ? [] : [`${t('około ')}${distanceText(distance)}`])
  ].join(', '));
  const end = $derived(at(shown.current.bearing, Math.min(shown.current.metres * scale.current, rim)));
  const pointShown = $derived(distance !== undefined && distance * scale.current <= rim + 1);
  // How far out the marked point is drawn, for the sonar's orange flash; none for an open ray.
  const pingRadius = $derived(sonarSource === 'answer' && pointShown ? shown.current.metres * scale.current : undefined);

  onMount(() => {
    // On unless the Reporter turned it off in Menu; without a network the tiles simply never arrive.
    try { mapOn = localStorage.getItem('direction-map') !== 'off'; } catch { mapOn = true; }
    hinting = bearing === undefined && distance === undefined && !prefersReducedMotion.current;
    start();
    // Contour pictures carry the theme's ink, so a theme change paints them again.
    const themes = new MutationObserver(() => { themeTick++; });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      stop(); leaving.abort(); themes.disconnect();
      for (const url of Object.values(contourPictures)) if (url) URL.revokeObjectURL(url);
    };
  });
</script>

<div class="direction">
  {#if problem === 'permission' || problem === 'denied'}
    <p role="alert">{problem === 'permission' ? t('Włącz kompas, żeby telefon mógł podać kierunek.') : t('Przeglądarka blokuje czujniki ruchu dla tej strony.')}</p>
  {/if}
  <div class="target-box">
  <div bind:this={target} class="target" role="slider" tabindex="0"
    data-bearing={bearing} data-distance={distance} data-pointing={pointing} data-spread={pointing === undefined ? undefined : reading.spread} data-view={view}
    aria-label={t('Tarcza kierunku')} aria-valuemin={0} aria-valuemax={355} aria-valuenow={bearing}
    aria-valuetext={valueText} onkeydown={key}>
    <svg viewBox="{-side / 2} {-side / 2} {side} {side}" aria-hidden="true" onpointerdown={press} onpointermove={drag}
      onpointerup={release} onpointercancel={() => { dragging = false; }}>
      <defs>
        <clipPath id="{id}-face"><circle r={rim} /></clipPath>
        <!-- The map softens into the paper towards the rim, so the letters and ring labels sit on quiet ground. -->
        <radialGradient id="{id}-fade" r={rim} cx="0" cy="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" class="fade-stop" stop-opacity="0" /><stop offset=".62" class="fade-stop" stop-opacity="0" /><stop offset="1" class="fade-stop" stop-opacity=".72" />
        </radialGradient>
      </defs>
      <circle r={rim} class="face" />
      <g clip-path="url(#{id}-face)">
        <!-- The map: vector tiles drawn in the theme's map colours. A newer zoom fades in over the older one,
             which stays whole until the new one has settled, so the map never goes pale between them.
             Strokes keep their width at every scale. -->
        {#each layers as level (level)}
          {@const metres = groundMetres / 2 ** level}{@const middle = centre ? project(centre, level) : { x: 0, y: 0 }}{@const units = metres * scale.current}
          <g class="map" out:fade={{ duration: motion(240) }}>
            {#each layerTiles(level) as tile (tile.key)}
              {@const tileDrawn = drawn[tile.key]}
              {#if tileDrawn}
                <g class="map-tile" transform="translate({(tile.x * tileSize - middle.x) * units} {(tile.y * tileSize - middle.y) * units}) scale({tileSize * units / tileDrawn.extent})">
                  {#each fills as kind (kind)}{#if tileDrawn.paths[kind]}<path d={tileDrawn.paths[kind]} class="map-{kind}" />{/if}{/each}
                  {#each lines as kind (kind)}{#if tileDrawn.paths[kind]}<path d={tileDrawn.paths[kind]} class="map-line map-{kind}" />{/if}{/each}
                </g>
              {/if}
            {/each}
          </g>
        {/each}
        {#if layers.length}<circle r={rim} fill="url(#{id}-fade)" class="fade" transition:fade={{ duration: motion(240) }} />{/if}
        <!-- Names sit above the rim fade, so they keep their contrast at the edge. -->
        {#each layers as level (level)}
          <g class="names" out:fade={{ duration: motion(240) }}>
            {#each placesFor(level) as place (place.name)}
              <text x={place.east * scale.current} y={place.south * scale.current} class="place" out:fade={{ duration: motion(200) }}>{place.name}</text>
            {/each}
          </g>
        {/each}
        {#if contours && mapShown}
          <!-- Heights every 5, 10 or 20 m by the relief around Ty; every fifth line is stronger, and at 5 km only those. -->
          <g class="contours">
            {#each contourShown as scaleView (scaleView)}
              {@const url = contourPictures[pictureKey(scaleView)]}{@const reach = scaleView * 1.1 * scale.current}
              {#if url}
                <image href={url} class="contour-picture" x={contourShift[0] * scale.current - reach} y={contourShift[1] * scale.current - reach}
                  width={2 * reach} height={2 * reach} preserveAspectRatio="none" out:fade={{ duration: motion(240) }} />
              {/if}
            {/each}
          </g>
        {/if}
        {#each rings as metres (metres)}
          <circle r={metres * scale.current} class="ring" opacity={ringOpacity(metres * scale.current)} />
        {/each}
        {#each rings as metres (metres)}
          {@const [x, y] = at(labelAngle, metres * scale.current)}
          <g class="ring-label-slot" class:skipped={!labelled(metres)}>
            <text {x} {y} class="ring-label" opacity={labelOpacity(metres * scale.current)}>{distanceText(metres)}</text>
          </g>
        {/each}
        {#if sonarSource}
          {#key sonarSource}
            <!-- Where the phone points, or the answer once there is one: drawn pointing north and turned. -->
            <g class="sonar" class:beam={sonarSource === 'phone'} style:transform="rotate({sonarAngle}deg)" transition:fade={{ duration: motion(200) }}>
              {#if prefersReducedMotion.current}
                {#each [.4, .65, .9] as part (part)}<path d={arc(rim * part, sonarWidth)} class="wave still" />{/each}
              {:else}
                {#each waves as born (born)}
                  {@const now = wave(born)}
                  <path d={arc(now.radius, sonarWidth)} class="wave" stroke-width={now.width} stroke-opacity={.55 * now.strength} />
                  {#if pingRadius !== undefined}
                    {@const flash = Math.exp(-(((now.radius - pingRadius) / 14) ** 2))}{@const core = Math.exp(-(((now.radius - pingRadius) / 9) ** 2))}
                    {@const echo = (now.radius - pingRadius) / ((rim + 14 - sonar.from) * .28)}
                    {#if flash > .02}<path d={arc(now.radius, sonar.width)} class="wave ping" stroke-width={now.width + .3} stroke-opacity={.85 * flash * now.strength} />{/if}
                    {#if core > .02}<path d={arc(now.radius, 16)} class="wave ping" stroke-width={now.width + .8} stroke-opacity={core * now.strength} />{/if}
                    {#if echo > 0 && echo < 1}<circle cy={-pingRadius} r={10 + 12 * echo} class="echo" stroke-width={2 - 1.4 * echo} stroke-opacity={.7 * Math.min(1, echo / .12) * (1 - echo)} />{/if}
                  {/if}
                {/each}
              {/if}
            </g>
          {/key}
        {/if}
      </g>
      <!-- The rose: fixed, north up. Nothing here moves with the phone. -->
      <g class="rose">
        {#each ticks as degrees (degrees)}
          {@const [x1, y1] = at(degrees, rim - 5)}{@const [x2, y2] = at(degrees, rim)}
          <line {x1} {y1} {x2} {y2} class="tick" />
        {/each}
        {#each letters as [letter, degrees] (letter)}
          {@const [x, y] = at(degrees, letterRadius(degrees))}
          <text {x} {y} class="letter" class:north={degrees === 0}>{t(letter)}</text>
        {/each}
        <circle r={rim} class="rim" class:unmarked={bearing === undefined && distance === undefined && !unknown} />
      </g>
      {#if unknown && bearing === undefined && distance === undefined}
        <!-- Nie wiem, skąd: somewhere around the Reporter, so the whole face takes the answer's colour. -->
        <circle r={rim} class="anywhere" transition:fade={{ duration: motion(200) }} />
      {/if}
      {#if distance !== undefined && bearing === undefined}
        <circle r={Math.min(distance * scale.current, rim)} class="reach" transition:fade={{ duration: motion(180) }} />
      {/if}
      {#if bearing !== undefined}
        <g class="mark" transition:fade={{ duration: motion(180) }}>
          <!-- Dashed while the distance is not known, as everything not set yet is. -->
          <line x1="0" y1="0" x2={end[0]} y2={end[1]} class="ray" class:open={distance === undefined} />
          {#if pointShown}
            <circle cx={end[0]} cy={end[1]} r="9" class="point" transition:fade={{ duration: motion(180) }} />
          {:else}
            <path d="M0 {-rim - 1} l-7 12 h14 Z" class="ray-head" style:transform="rotate({shown.current.bearing}deg)" transition:fade={{ duration: motion(180) }} />
          {/if}
        </g>
      {/if}
      {#if hinting}
        {@const [hx, hy] = at(45, 500 * scale.current)}
        <!-- Shown, not told: a point leaves Ty and travels to where a drag would put it, then fades. -->
        <g class="hint" style:--hx="{hx}px" style:--hy="{hy}px" onanimationend={() => { hinting = false; }} out:fade={{ duration: motion(150) }}>
          <line x1="0" y1="0" x2={hx} y2={hy} pathLength="1" class="hint-trail" />
          <circle r="10" class="hint-dot" />
        </g>
      {/if}
      <circle r="6" class="you" />
      <text x="0" y="20" class="you-label">{t('Ty')}</text>
    </svg>
  </div>
  <!-- The scale, on the target: map-style zoom, so it never reads as a distance answer. The current scale
       balances it on the left, so Ty stays in the middle of the screen. -->
  <div class="zoom" role="group" aria-label={t('Skala tarczy')}>
    <button type="button" aria-label={t('Przybliż')} aria-disabled={view === views[0]} onclick={() => zoomBy(-1)}>+</button>
    <button type="button" aria-label={t('Oddal')} aria-disabled={view === views.at(-1)} onclick={() => zoomBy(1)}>−</button>
  </div>
  <p class="scale-caption"><span>{t('Skala')}</span>{#key view}<strong in:fade={{ duration: motion(180) }} out:fade={{ duration: motion(140) }}>{distanceText(view)}</strong>{/key}</p>
  <!-- Its lines are always laid out, the elevation source included, so the credit fading in never moves what is below. -->
  <small class="credit" class:shown={mapShown} inert={!mapShown} aria-hidden={!mapShown}>OpenFreeMap <span>© OpenMapTiles</span> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap</a>{' · '}<span>{t('wysokości')}: Mapzen,</span> <span>Copernicus EU-DEM</span></small>
  </div>
  <div class="reading" role="status">
    <!-- Once there is an answer the beam says where the phone points, so the answer's line replaces this one.
         Both share one cell of fixed height and crossfade, so nothing below moves as they come and go. -->
    {#if pointing !== undefined && bearing === undefined && distance === undefined && !unknown}<p transition:fade={{ duration: motion(200) }}>{t('Telefon wskazuje: ')}<strong>{words(pointing)}</strong></p>{/if}
    {#if bearing !== undefined || distance !== undefined || unknown}<p class="marked" transition:fade={{ duration: motion(200) }}>
      {#if bearing !== undefined && distance !== undefined}{t('Wybrane: ')}<strong>{words(bearing)}, {t('około ')}{distanceText(distance)}</strong>
      {:else if bearing !== undefined}{t('Wybrany kierunek: ')}<strong>{words(bearing)}</strong>{t(', odległość: nie wiem')}
      {:else if distance !== undefined}{t('Wybrana odległość: ')}<strong>{t('około ')}{distanceText(distance)}</strong>{t(', kierunek: nie wiem')}
      {:else}{t('Kierunek: nie wiem')}{/if}</p>{/if}
  </div>
  {#if bearing !== undefined || distance !== undefined}
    <div class="far-unknown" transition:reveal><button type="button" aria-pressed={distance === undefined} onclick={farUnknown}>{t('Nie wiem, jak daleko')}</button></div>
  {/if}
  <!-- The sensor's slot opens and closes by width, so Nie wiem, skąd beside it travels instead of jumping. -->
  <div bind:this={answers} class="direction-actions" class:offered={live || problem === 'permission'}>
    <div class="sensor-slot">
      {#if problem === 'permission'}<button type="button" onclick={enable}>{t('Włącz kompas')}</button>
      {:else}<button type="button" class="primary" disabled={pointing === undefined} onclick={markFront}>{t('Ustaw ten kierunek')}</button>{/if}
    </div>
    <button type="button" aria-pressed={unknown && bearing === undefined && distance === undefined} onclick={notKnown}>{t('Nie wiem, skąd')}</button>
  </div>
</div>

<style>
  /* The face and, beside it, the scale's zoom column, so the buttons never crowd Wsch. */
  /* Three columns, the scale on the left and its zoom on the right, so the face sits in the middle. */
  .target-box { position: relative; width: min(100%, 444px); margin: 16px auto 0; display: grid;
    grid-template-columns: 56px minmax(0, 1fr) 56px; column-gap: 8px; align-items: center; }
  .target { grid-area: 1 / 2; }
  .zoom { grid-area: 1 / 3; }
  .scale-caption { grid-area: 1 / 1; }
  .target svg { display: block; stroke: none; fill: none; font-family: inherit; width: 100%; height: auto; overflow: visible; touch-action: none; cursor: crosshair; user-select: none; }
  .target:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  .face { fill: var(--paper); }
  .zoom { display: grid; gap: 8px; }
  .zoom button { width: 56px; min-height: 56px; padding: 0; font-size: 1.5rem; line-height: 1; }
  /* The end of the scale: the button stays focusable but drops its fill, so the usable one reads as the button. */
  .zoom button[aria-disabled="true"] { color: var(--muted); background: transparent; border-color: transparent; cursor: default; }
  .scale-caption { margin: 0; display: grid; justify-items: center; font-size: .88rem; color: var(--muted); }
  .scale-caption strong { grid-area: 2 / 1; color: var(--ink); font-weight: 700; }
  .target { position: relative; }
  /* Sylweta: forest and water as calm shapes; main roads barely there, forest tracks dotted because people aim
     along them. The orange stays with the answer. Every tile, name and contour fades in from nothing. */
  .map { pointer-events: none; }
  .map-tile, .place, .contour-picture { animation: map-in 240ms ease-out both; }
  @keyframes map-in { from { opacity: 0; } }
  .map-wood { fill: var(--map-wood); }
  .map-water { fill: var(--map-water); }
  .map-line { fill: none; vector-effect: non-scaling-stroke; stroke-linecap: round; stroke-linejoin: round; }
  .map-river { stroke: var(--map-water); stroke-width: 1.8; }
  .map-stream { stroke: var(--map-water); stroke-width: 1; }
  .map-road { stroke: var(--ink); stroke-opacity: .22; stroke-width: .8; }
  .map-track { stroke: var(--ink); stroke-opacity: .45; stroke-width: 1.1; stroke-dasharray: 0 3; }
  .fade-stop { stop-color: var(--paper); }
  .contours { pointer-events: none; }
  /* Spaced small capitals on a paper halo: 4.5:1 or more over every map fill. */
  .place { fill: var(--muted); font-size: 9.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; text-anchor: middle; dominant-baseline: central; paint-order: stroke; stroke: var(--paper); stroke-width: 2.5px; stroke-linejoin: round; }
  /* The scaffold stays in the background: thin rings, labels on their ring, small capitals, diagonal ticks. */
  .ring { fill: none; stroke: var(--ink); stroke-opacity: .5; stroke-width: .75; }
  .ring-label { fill: var(--muted); font-size: 10.5px; font-weight: 600; text-anchor: middle; dominant-baseline: central; paint-order: stroke; stroke: var(--paper); stroke-width: 3px; stroke-linejoin: round; }
  .ring-label-slot { transition: opacity 200ms ease-out; }
  .ring-label-slot.skipped { opacity: 0; }
  .tick { stroke: var(--control-border); stroke-width: 1.2; }
  .rim { fill: none; stroke: var(--control-border); stroke-width: 1.25; }
  .rim.unmarked { stroke-dasharray: 5 7; }
  /* Inside the rim, over the map too, so they carry a paper halo like the ring labels. */
  .letter { fill: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; text-anchor: middle; dominant-baseline: central; paint-order: stroke; stroke: var(--paper); stroke-width: 2.5px; stroke-linejoin: round; }
  .letter.north { fill: var(--ink); font-weight: 700; }
  .sonar { pointer-events: none; }
  .wave { fill: none; stroke: var(--ink); stroke-linecap: round; }
  .wave.still { stroke-opacity: .4; stroke-width: 1.6; }
  .wave.ping, .echo { stroke: var(--action); }
  .echo { fill: none; }
  /* The marked answer takes the chosen colour. */
  .ray { stroke: var(--action); stroke-width: 4; stroke-linecap: round; }
  .ray.open { stroke-dasharray: 8 8; stroke-linecap: butt; }
  .anywhere { fill: var(--action); fill-opacity: .12; stroke: var(--action); stroke-width: 3; }
  .ray-head, .point { fill: var(--action); }
  /* Starts 500 ms after the step settles. Each 4.5 s cycle: fade in at Ty over 270 ms, travel 900 ms,
     rest, fade out by 1.8 s, then wait out the rest before showing it again. Three cycles at most. */
  .hint { pointer-events: none; animation: hint-fade 4500ms 500ms 3 both; }
  .hint-dot { fill: var(--action); stroke: var(--paper); stroke-width: 3; animation: hint-travel 4500ms 500ms 3 both; }
  .hint-trail { stroke: var(--action); stroke-width: 4; stroke-linecap: round; stroke-dasharray: 1; stroke-opacity: .8; animation: hint-trail 4500ms 500ms 3 both; }
  @keyframes hint-fade { 0% { opacity: 0; } 6% { opacity: 1; } 32% { opacity: 1; } 40%, 100% { opacity: 0; } }
  @keyframes hint-travel { 0%, 6% { transform: translate(0, 0); animation-timing-function: cubic-bezier(.45, 0, .55, 1); } 26%, 100% { transform: translate(var(--hx), var(--hy)); } }
  @keyframes hint-trail { 0%, 6% { stroke-dashoffset: 1; animation-timing-function: cubic-bezier(.45, 0, .55, 1); } 26%, 100% { stroke-dashoffset: 0; } }
  .point { stroke: var(--paper); stroke-width: 3; }
  .reach { fill: none; stroke: var(--action); stroke-width: 4; stroke-dasharray: 8 6; }
  .you { fill: var(--ink); stroke: var(--paper); stroke-width: 3; }
  .you-label { fill: var(--ink); font-size: 14px; font-weight: 700; text-anchor: middle; dominant-baseline: central; paint-order: stroke; stroke: var(--paper); stroke-width: 3px; }
  /* The required credit, quiet, on its own line under the face in the theme's muted ink (7.1:1, the faintest
     text that still meets AA). Only the OpenStreetMap licence is a link, as in ticket 36. */
  .credit { grid-area: 2 / 1 / 3 / -1; justify-self: center; margin-top: 4px; text-align: center; color: var(--muted); font-size: .7rem;
    opacity: 0; transition: opacity 200ms ease-out; }
  .credit.shown { opacity: 1; }
  /* Each name stays whole when the line wraps at large text. */
  .credit span, .credit a { white-space: nowrap; }
  .credit a { color: inherit; }
  /* Room for the longest line wrapped once, at any width, so the lines never resize it. */
  .reading { margin: 16px auto 0; text-align: center; display: grid; align-content: center; min-height: 3.2em; min-height: 2lh; }
  .reading p { grid-area: 1 / 1; margin: 0 auto; max-width: 40ch; }
  .reading .marked { color: var(--muted); }
  .reading .marked strong { color: var(--ink); }
  .reading strong { font-weight: 700; }
  .far-unknown button { width: 100%; margin-top: 8px; }
  .direction-actions { margin-top: 8px; display: grid; grid-template-columns: 0fr 1fr; column-gap: 0;
    transition: grid-template-columns 200ms ease-out, column-gap 200ms ease-out; }
  /* With 12 px side padding, Ustaw ten kierunek and a pressed (bold) Nie wiem, skąd measure 180 and 148 px at
     17 px, 336 px with the gap, so they share a row from 20.3em; narrower, or at large text, the slot opens as
     a row of its own above. */
  .direction { container-type: inline-size; }
  .direction-actions button { padding-inline: 12px; }
  .direction-actions.offered { grid-template-columns: 1.2fr 1fr; column-gap: 8px; }
  @container (max-width: 20.3em) {
    .direction-actions { grid-template-columns: 1fr; grid-template-rows: 0fr auto; row-gap: 0;
      transition: grid-template-rows 200ms ease-out, row-gap 200ms ease-out; }
    .direction-actions.offered { grid-template-columns: 1fr; grid-template-rows: 1fr auto; row-gap: 8px; }
    .sensor-slot { min-height: 0; }
  }
  .sensor-slot { min-width: 0; overflow: hidden; visibility: hidden; opacity: 0; transition: opacity 200ms ease-out, visibility 0s 200ms; }
  .offered .sensor-slot { visibility: visible; opacity: 1; transition: opacity 200ms ease-out; }
  .sensor-slot button { width: 100%; height: 100%; white-space: nowrap; }
  @media (prefers-reduced-motion: reduce) {
    .direction-actions, .sensor-slot, .offered .sensor-slot { transition: none; }
    .map-tile, .place, .contour-picture { animation: none; }
    .credit, .ring-label-slot { transition: none; }
  }
</style>
