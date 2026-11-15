<script lang="ts">
  import { project, tileUrl, unproject, visibleTiles, type Point } from './map-tiles';
  import type { IncidentArea } from './report';
  import { reveal } from './reveal';

  /** The place the Report keeps, drawn for the Reporter: the area itself, or the point. */
  let { area, point, mark, t } = $props<{
    area: IncidentArea | null;
    point: Point;
    /** Where the Reporter was, kept on the phone and labelled on the map only. */
    mark?: { at: Point; label: string };
    t: (text: string) => string;
  }>();

  const mapHeight = 148;
  let mapWidth = $state(0);
  let tileAttempt = $state(0);
  let loadedTiles = $state<string[]>([]);
  let failedTiles = $state<string[]>([]);

  const kept = $derived(area ? area.bounds : [point.lon, point.lat, point.lon, point.lat]);
  // The view fits the kept place alone. The Reporter's own mark is drawn where it falls and never
  // widens the view, so imagery is not requested for the phone's surroundings beyond the kept area.
  const zoom = $derived.by(() => {
    if (kept[0] === kept[2] && kept[1] === kept[3]) return 15;
    const width = Math.max(mapWidth, 240);
    for (let level = 16; level > 5; level--) {
      const corner = project({ lat: kept[3], lon: kept[2] }, level);
      const start = project({ lat: kept[1], lon: kept[0] }, level);
      if (corner.x - start.x <= width * 0.75 && start.y - corner.y <= mapHeight * 0.75) return level;
    }
    return 5;
  });
  const center = $derived.by(() => {
    const corner = project({ lat: kept[3], lon: kept[2] }, zoom);
    const start = project({ lat: kept[1], lon: kept[0] }, zoom);
    return unproject({ x: (corner.x + start.x) / 2, y: (corner.y + start.y) / 2 }, zoom);
  });
  const tiles = $derived(visibleTiles(center, zoom, tileAttempt));
  const mapUnavailable = $derived(tiles.some(tile => failedTiles.includes(tile.key)) &&
    !tiles.some(tile => loadedTiles.includes(tile.key)));
  const offset = (at: Point) => {
    const view = project(center, zoom);
    const spot = project(at, zoom);
    return { left: spot.x - view.x, top: spot.y - view.y };
  };
  const rectangle = $derived.by(() => {
    const start = offset({ lat: kept[3], lon: kept[0] });
    const end = offset({ lat: kept[1], lon: kept[2] });
    return { ...start, width: end.left - start.left, height: end.top - start.top };
  });
</script>

<figure class="kept">
  <div class="kept-map" bind:clientWidth={mapWidth} style:height={`${mapHeight}px`} role="img"
    aria-label={t('Mapa okolicy zapisanej w zgłoszeniu.')}>
    {#each tiles as tile (tile.key)}
      <img class="tile" class:failed={failedTiles.includes(tile.key)} src={tileUrl(zoom, tile.urlX, tile.y)} alt="" draggable="false" referrerpolicy="origin"
        style:left={`calc(50% + ${tile.left}px)`} style:top={`calc(50% + ${tile.top}px)`}
        onload={() => loadedTiles = [...loadedTiles, tile.key]} onerror={() => failedTiles = [...failedTiles, tile.key]} />
    {/each}
    {#if area}
      <span class="area" data-bounds={area.bounds.join(',')} style:left={`calc(50% + ${rectangle.left}px)`} style:top={`calc(50% + ${rectangle.top}px)`}
        style:width={`${rectangle.width}px`} style:height={`${rectangle.height}px`}></span>
    {:else}
      {@const pin = offset(point)}
      <span class="pin" style:left={`calc(50% + ${pin.left}px)`} style:top={`calc(50% + ${pin.top}px)`}>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>
      </span>
    {/if}
    {#if mark}
      {@const spot = offset(mark.at)}
      <span class="mark" style:left={`calc(50% + ${spot.left}px)`} style:top={`calc(50% + ${spot.top}px)`}><span>{mark.label}</span></span>
    {/if}
  </div>
  <figcaption>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap contributors</a>
  {#if mapUnavailable}
    <span class="tile-error" transition:reveal>{t('Mapa jest niedostępna. Miejsce opisano powyżej.')}
      <button type="button" class="quiet" onclick={() => { tileAttempt++; loadedTiles = []; failedTiles = []; }}>{t('Wczytaj mapę ponownie')}</button></span>
  {/if}
  </figcaption>
</figure>

<style>
  .kept { margin: 16px 0 0; }
  /* OpenStreetMap tiles stay light in every theme, so overlays use fixed map inks rather than theme colours. */
  .kept-map { --map-edge: #9e4310; --map-fill: rgb(158 67 16 / 18%); --map-ink: #1c1b18; --map-paper: #f6f7f5;
    position: relative; overflow: hidden; outline: 1px solid var(--ink); outline-offset: -1px; background: var(--soft); }
  .tile { position: absolute; width: 256px; height: 256px; max-width: none; user-select: none; pointer-events: none; }
  .tile.failed { visibility: hidden; }
  .area { position: absolute; box-sizing: border-box; border: 3px solid var(--map-edge); background: var(--map-fill); }
  .pin { position: absolute; width: 36px; height: 42px; transform: translate(-50%, -100%); }
  .pin svg { width: 100%; height: 100%; fill: var(--action); stroke: var(--on-action); stroke-width: 1.6; }
  .mark { position: absolute; width: 14px; height: 14px; transform: translate(-50%, -50%); box-sizing: border-box;
    border: 3px solid var(--map-ink); border-radius: 50%; background: var(--map-paper); }
  .mark span { position: absolute; left: 16px; top: 50%; transform: translateY(-50%); font-size: .88rem; font-weight: 700;
    color: var(--map-ink); text-shadow: 0 0 3px var(--map-paper), 0 0 3px var(--map-paper); white-space: nowrap; }
  .tile-error { display: block; }
  figcaption { margin-top: 6px; font-size: .88rem; color: var(--muted); }
  figcaption a { display: inline-flex; align-items: center; min-height: 56px; }
  figcaption .quiet { min-height: 56px; }
</style>
