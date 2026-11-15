<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import MapDisclosure from './MapDisclosure.svelte';
  import { shiftedBy, type PlaceReference } from './home-area';
  import { compassPoint } from './compass';
  import { apiFetch } from './api-url';
  import { reveal } from './reveal';
  import { latitudeLimit, project, tileUrl, unproject, visibleTiles, type Pixel, type Point } from './map-tiles';

  let { open = $bindable(false), initialLocation, selectedLocation, selectedReference, radiusM, label, onselect, t } = $props<{
    open?: boolean;
    initialLocation?: Point;
    selectedLocation?: Point;
    selectedReference?: PlaceReference;
    /** Drawn as a circle around the chosen point. */
    radiusM?: number;
    label: string;
    /** An accepted map or form choice writes the point straight to the Draft. */
    onselect: (point: Point, reference?: PlaceReference) => void;
    t: (text: string) => string;
  }>();
  let center = $state<Point>(untrack(() => selectedLocation ?? initialLocation ?? { lat: 52.1, lon: 19.4 }));
  let zoom = $state(untrack(() => selectedLocation && radiusM ? fitRadius(radiusM, selectedLocation.lat) : initialLocation || selectedLocation ? 14 : 6));
  let selected = $state<Point | undefined>(untrack(() => selectedLocation));
  let latitude = $state('');
  let longitude = $state('');
  let tileAttempt = $state(0);
  let loadedTiles = $state<string[]>([]);
  let failedTiles = $state<string[]>([]);
  let query = $state('');
  let reference = $state<{ name: string; lat: number; lon: number } | undefined>(untrack(() => selectedReference));
  let referenceBearing = $state(untrack(() => selectedReference ? String(selectedReference.bearing) : ''));
  let referenceDistance = $state(untrack(() => selectedReference ? String(selectedReference.distanceM) : ''));
  let referenceHeading = $state<HTMLHeadingElement>();
  let mapSurface = $state<HTMLDivElement>();
  let retryButton = $state<HTMLButtonElement>();
  const referenceValid = $derived(reference !== undefined && referenceBearing !== '' &&
    Number.isFinite(Number(referenceDistance)) && Number(referenceDistance) >= 1 && Number(referenceDistance) <= 50000);

  function placeReference() {
    if (!reference || !referenceValid) return;
    const choice = { ...reference, bearing: Number(referenceBearing), distanceM: Number(referenceDistance) };
    const point = shiftedBy(reference, choice.bearing, choice.distanceM);
    center = point;
    choose(point, choice);
  }
  let places = $state<{ name: string; lat: number; lon: number }[]>([]);
  let searchState = $state<'idle' | 'loading' | 'empty' | 'error'>('idle');
  let searchController: AbortController | undefined;
  let pendingMapCenter: Point | undefined;
  const pointers = new Map<number, Pixel>();
  let pinch: { distance: number; zoom: number } | undefined;
  let dragging: { x: number; y: number; world: Pixel; moved: boolean } | undefined;

  function centerOnLocation() {
    loadedTiles = [];
    failedTiles = [];
    if (pendingMapCenter) {
      center = pendingMapCenter;
      zoom = 14;
      pendingMapCenter = undefined;
      return;
    }
    if (selectedLocation) {
      selected = selectedLocation;
      center = selectedLocation;
      zoom = radiusM ? fitRadius(radiusM, selectedLocation.lat) : 14;
    } else if (initialLocation) {
      center = initialLocation;
      zoom = 14;
    }
  }
  onMount(() => {
    centerOnLocation();
    if (selectedLocation) { latitude = selectedLocation.lat.toFixed(5); longitude = selectedLocation.lon.toFixed(5); }
    return () => searchController?.abort();
  });

  const tiles = $derived(visibleTiles(center, zoom, tileAttempt));
  const mapUnavailable = $derived(tiles.some(tile => failedTiles.includes(tile.key)));
  const mapReady = $derived(tiles.every(tile => loadedTiles.includes(tile.key)));

  function chooseOnMap(point: Point) {
    const world = project(point, zoom);
    const tile = tiles.find(tile => tile.x === Math.floor(world.x / 256) && tile.y === Math.floor(world.y / 256));
    if (mapReady && tile && loadedTiles.includes(tile.key)) choose(point);
  }

  function trackTile(_node: HTMLImageElement, key: string) {
    return { destroy() {
      loadedTiles = loadedTiles.filter(loaded => loaded !== key);
      failedTiles = failedTiles.filter(failed => failed !== key);
    } };
  }

  function tileLoaded(key: string) {
    loadedTiles = [...loadedTiles, key];
    if (tiles.every(tile => loadedTiles.includes(tile.key)) && document.activeElement === retryButton) mapSurface?.focus();
  }

  // Web Mercator ground resolution at a latitude, in metres per CSS pixel.
  function metresPerPixel(lat: number, level: number) { return 156_543.03 * Math.cos(lat * Math.PI / 180) / 2 ** level; }
  /** The closest zoom at which the whole circle fits inside the 300 px map with a margin. */
  function fitRadius(metres: number, lat: number) {
    for (let level = 17; level > 6; level--) if (2 * metres / metresPerPixel(lat, level) <= 220) return level;
    return 6;
  }
  const circle = $derived(selected && radiusM ? 2 * radiusM / metresPerPixel(selected.lat, zoom) : 0);

  const marker = $derived.by(() => {
    if (!selected) return undefined;
    const point = project(selected, zoom);
    const view = project(center, zoom);
    return { left: point.x - view.x, top: point.y - view.y };
  });

  function choose(point: Point, reference?: PlaceReference) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon) ||
      point.lat < -latitudeLimit || point.lat > latitudeLimit || point.lon < -180 || point.lon > 180) return;
    pendingMapCenter = undefined;
    selected = { lat: Number(point.lat.toFixed(5)), lon: Number(point.lon.toFixed(5)) };
    latitude = selected.lat.toFixed(5);
    longitude = selected.lon.toFixed(5);
    onselect(selected, reference);
  }

  const coordinatesValid = $derived(latitude.trim() !== '' && longitude.trim() !== '' &&
    Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude)) &&
    Number(latitude) >= -latitudeLimit && Number(latitude) <= latitudeLimit && Number(longitude) >= -180 && Number(longitude) <= 180);

  function placeCoordinates() {
    const point = { lat: Number(latitude), lon: Number(longitude) };
    if (!coordinatesValid) return;
    center = point;
    choose(point);
  }

  function zoomBy(amount: number) { zoom = Math.max(3, Math.min(19, zoom + amount)); }
  function pan(dx: number, dy: number) {
    const world = project(center, zoom);
    center = unproject({ x: world.x + dx, y: world.y + dy }, zoom);
  }
  function keydown(event: KeyboardEvent) {
    const step = event.shiftKey ? 120 : 40;
    const offsets: Record<string, Pixel> = {
      ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step }
    };
    if (offsets[event.key]) { event.preventDefault(); pan(offsets[event.key].x, offsets[event.key].y); }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); chooseOnMap(center); }
  }

  async function search() {
    const text = query.trim();
    if (text.length < 3 || text.length > 100) return;
    searchController?.abort();
    const controller = new AbortController();
    searchController = controller;
    places = [];
    searchState = 'loading';
    try {
      const response = await apiFetch('/api/places', { method: 'POST',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: text }), signal: controller.signal });
      if (controller !== searchController) return;
      if (!response.ok) { searchState = 'error'; return; }
      const result = await response.json() as { places: typeof places };
      if (controller !== searchController) return;
      places = result.places;
      searchState = places.length ? 'idle' : 'empty';
    } catch { if (!controller.signal.aborted) searchState = 'error'; }
  }
  async function usePlace(place: { name: string; lat: number; lon: number }) {
    // A search result only moves the map; its centroid never becomes the Incident point.
    center = { lat: place.lat, lon: place.lon };
    pendingMapCenter = open ? undefined : center;
    zoom = 14;
    places = [];
    reference = place;
    referenceBearing = '';
    referenceDistance = '';
    await tick();
    referenceHeading?.focus();
  }

  function pointerDown(event: PointerEvent) {
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom };
      dragging = undefined;
    }
    if (pointers.size !== 1) return;
    const world = project(center, zoom);
    dragging = { x: event.clientX, y: event.clientY, world, moved: false };
  }

  function pointerMove(event: PointerEvent) {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinch && pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      if (pinch.distance > 0) zoom = Math.max(3, Math.min(19,
        Math.round(pinch.zoom + Math.log2(Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance))));
      return;
    }
    if (!dragging) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    dragging.moved ||= Math.abs(dx) + Math.abs(dy) > 4;
    if (dragging.moved) center = unproject({ x: dragging.world.x - dx, y: dragging.world.y - dy }, zoom);
  }

  function pointerUp(event: PointerEvent) {
    pointers.delete(event.pointerId);
    if (pinch) { pinch = undefined; dragging = undefined; return; }
    if (!dragging) return;
    const state = dragging;
    dragging = undefined;
    if (state.moved) return;
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const world = project(center, zoom);
    chooseOnMap(unproject({
      x: world.x + event.clientX - bounds.left - bounds.width / 2,
      y: world.y + event.clientY - bounds.top - bounds.height / 2
    }, zoom));
  }
</script>

<section class="picker">
  <form class="place-search" onsubmit={event => { event.preventDefault(); void search(); }}>
    <label for="place-query">{t('Szukaj miejscowości lub miejsca')}</label>
    <div class="search-row"><input id="place-query" type="search" maxlength="100" minlength="3" bind:value={query} autocomplete="off"
      oninput={() => { searchController?.abort(); searchController = undefined; searchState = 'idle'; places = []; }} />
      <button type="submit" disabled={query.trim().length < 3 || searchState === 'loading'}>{t('Szukaj')}</button></div>
  </form>
  <p class="provider-note">{t('Wyszukiwanie wysyła wpisaną nazwę do OpenStreetMap. Nie wysyła zapisanej pozycji. Nie wpisuj adresu domu.')}
    <a href="https://wiki.osmfoundation.org/wiki/Privacy_Policy" target="_blank" rel="noreferrer">{t('Zasady prywatności OpenStreetMap')}</a></p>
  {#if searchState === 'loading'}<p role="status">{t('Szukam miejsca…')}</p>{/if}
  {#if searchState === 'empty'}<p role="status">{t('Nie znaleziono miejsca. Spróbuj innej nazwy albo wskaż je na mapie.')}</p>{/if}
  {#if searchState === 'error'}<p role="alert">{t('Nie udało się wyszukać miejsca. Spróbuj ponownie albo dokończ później.')}</p>{/if}
  {#if places.length}<ul class="place-results" aria-label={t('Wyniki wyszukiwania')}>
    {#each places as place (`${place.name}-${place.lat}-${place.lon}`)}<li><button type="button" onclick={() => usePlace(place)}>{place.name}</button></li>{/each}
  </ul>{/if}
  {#if reference}
    <section class="reference-place" aria-labelledby="reference-heading">
      <h2 id="reference-heading" tabindex="-1" bind:this={referenceHeading}>{t('Miejsce względem punktu orientacyjnego')}</h2>
      <p>{reference.name}</p>
      <p class="muted">{t('Wynik wyszukiwania to punkt orientacyjny, nie miejsce zdarzenia. Podaj kierunek i odległość od tego punktu.')}</p>
      <div class="coordinates">
        <label>{t('Kierunek od punktu orientacyjnego')}
          <select bind:value={referenceBearing}>
            <option value="">{t('Wybierz kierunek')}</option>
            {#each [0, 45, 90, 135, 180, 225, 270, 315] as bearing (bearing)}<option value={String(bearing)}>{t(compassPoint(bearing))}</option>{/each}
          </select>
        </label>
        <label>{t('Odległość od punktu orientacyjnego w metrach')}
          <input type="number" min="1" max="50000" step="any" value={referenceDistance} oninput={event => referenceDistance = event.currentTarget.value} />
        </label>
      </div>
      <button type="button" disabled={!referenceValid} onclick={placeReference}>{t('Wskaż opisane miejsce')}</button>
    </section>
  {/if}
  <MapDisclosure bind:open {t} onopen={centerOnLocation}>
  <p id="map-status" role="status">{t(mapReady ? 'Mapa wczytana. Możesz wskazać miejsce.'
    : mapUnavailable ? 'Nie wczytano całej mapy. Wybór na mapie jest wyłączony.'
    : 'Mapa się wczytuje. Wybór na mapie jest wyłączony.')}</p>
  {#if !mapReady}<div transition:reveal><p>{t(selected
    ? 'Wskazane miejsce zostaje w szkicu. Bez mapy też je poprawisz: wyszukaj znane miejsce albo wpisz współrzędne. Możesz też dokończyć później.'
    : 'Bez mapy też wskażesz miejsce: wyszukaj znane miejsce albo wpisz współrzędne. Możesz też dokończyć później.')}</p>
    <button type="button" bind:this={retryButton} onclick={() => { tileAttempt++; loadedTiles = []; failedTiles = []; }}>{t('Wczytaj mapę ponownie')}</button></div>{/if}
  <div class="map-shell">
    <div class="map-canvas">
    <div class="map-surface" bind:this={mapSurface} aria-label={label} aria-describedby="map-help map-status" aria-disabled={!mapReady} role="button" tabindex="0"
      onkeydown={keydown} onpointerdown={pointerDown} onpointermove={pointerMove} onpointerup={pointerUp}
      onpointercancel={event => { pointers.delete(event.pointerId); pinch = undefined; dragging = undefined; }}
      onwheel={event => { event.preventDefault(); zoomBy(event.deltaY < 0 ? 1 : -1); }}>
      {#each tiles as tile (tile.key)}
        <img use:trackTile={tile.key} class="tile" class:failed={failedTiles.includes(tile.key)} src={tileUrl(zoom, tile.urlX, tile.y)} alt="" draggable="false" referrerpolicy="origin"
          style:left={`calc(50% + ${tile.left}px)`} style:top={`calc(50% + ${tile.top}px)`}
          onload={() => tileLoaded(tile.key)} onerror={() => failedTiles = [...failedTiles, tile.key]} />
      {/each}
      {#if marker && circle}
        <span class="radius" aria-hidden="true" style:left={`calc(50% + ${marker.left}px)`} style:top={`calc(50% + ${marker.top}px)`}
          style:width={`${circle}px`} style:height={`${circle}px`}></span>
      {/if}
      {#if marker}
        <span class="marker" aria-hidden="true" style:left={`calc(50% + ${marker.left}px)`} style:top={`calc(50% + ${marker.top}px)`}>
          <svg viewBox="0 0 24 24"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>
        </span>
      {/if}
    </div>
    <div class="map-tools" role="group" aria-label={t('Sterowanie mapą')}>
      <button type="button" aria-label={t('Powiększ mapę')} onclick={() => zoomBy(1)}>+</button>
      <button type="button" aria-label={t('Pomniejsz mapę')} onclick={() => zoomBy(-1)}>−</button>
    </div>
    </div>
  </div>
  <p id="map-help" class="sr-only">{t('Przesuń mapę palcem lub strzałkami. Dotknij miejsca albo naciśnij Enter.')}</p>
  <p class="caption">
    <small>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a></small></p>
  </MapDisclosure>
  <details class="advanced"><summary>{t('Wpisz współrzędne')}</summary>
    <div class="coordinates">
      <label>{t('Szerokość geograficzna')}
        <input type="number" min={-latitudeLimit} max={latitudeLimit} step="any" value={latitude} oninput={event => latitude = event.currentTarget.value} />
      </label>
      <label>{t('Długość geograficzna')}
        <input type="number" min="-180" max="180" step="any" value={longitude} oninput={event => longitude = event.currentTarget.value} />
      </label>
    </div>
    <button type="button" onclick={placeCoordinates} disabled={!coordinatesValid}>{t('Wskaż wpisany punkt')}</button>
  </details>
</section>

<style>
  .picker { margin: 16px 0; }
  .picker p { font-size: .88rem; }
  #map-status { min-height: 2.8em; }
  .caption { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; margin: 6px 0 0; color: var(--muted); }
  .caption small { display: inline; }
  .caption a { color: inherit; display: inline-flex; align-items: center; min-height: 56px; }
  .place-search { padding: 12px; background: var(--paper); }
  .place-search label { display: block; font-weight: 600; }
  .reference-place { margin-block: 20px; }
  .reference-place h2 { font-size: 1.3rem; }
  .reference-place p { overflow-wrap: anywhere; }
  .search-row { display: flex; gap: 8px; margin-top: 6px; }
  .search-row input { min-width: 0; flex: 1; margin: 0; }
  .search-row button { flex: none; }
  .provider-note { color: var(--muted); }
  .provider-note a { display: inline-flex; align-items: center; min-height: 56px; }
  .place-results { list-style: none; margin: 8px 0; padding: 0; }
  .place-results button { width: 100%; text-align: left; margin-bottom: 6px; overflow-wrap: anywhere; }
  .map-shell { position: relative; overflow: hidden; border: 1px solid var(--ink); background: var(--soft); }
  .map-canvas { position: relative; height: 300px; overflow: hidden; }
  .map-surface { position: absolute; inset: 0; overflow: hidden; touch-action: none; cursor: grab; }
  .map-surface:active { cursor: grabbing; }
  .map-surface:focus-visible { outline: 3px solid var(--focus); outline-offset: -3px; }
  .tile { position: absolute; width: 256px; height: 256px; max-width: none; user-select: none; pointer-events: none; }
  .tile.failed { visibility: hidden; }
  .marker { position: absolute; z-index: 1; width: 36px; height: 42px; transform: translate(-50%, -100%); filter: drop-shadow(0 1px 2px var(--paper)); pointer-events: none; }
  .marker svg { width: 100%; height: 100%; fill: var(--action); stroke: var(--on-action); stroke-width: 1.6; }
  .map-tools { position: absolute; inset-block-start: 12px; inset-inline-end: 12px; display: grid; gap: 8px; }
  /* Over the tiles, so they keep a solid paper face. */
  .map-tools button { width: 56px; min-height: 56px; padding: 0; font-size: 1.3rem; background: var(--paper); }
  .map-tools button:hover:enabled { background: var(--soft); }
  /* OpenStreetMap tiles stay light in every theme, so the circle uses fixed map inks. */
  .radius { position: absolute; transform: translate(-50%, -50%); border-radius: 50%; box-sizing: border-box;
    border: 2px dashed #9e4310; background: rgb(158 67 16 / 14%); pointer-events: none; }
  .advanced { margin-top: 8px; }
  .advanced summary { min-height: 56px; padding: 14px 0; cursor: pointer; font-weight: 600; }
  .coordinates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 12px 0; }
  .coordinates label { font-size: .88rem; }
  .coordinates input { font-variant-numeric: tabular-nums; }
  @media (orientation: landscape) and (max-height: 500px) { .map-canvas { height: 40dvh; min-height: 112px; } }
  @media (max-width: 420px) { .coordinates { grid-template-columns: 1fr; } }
</style>
