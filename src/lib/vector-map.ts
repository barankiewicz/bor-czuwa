import { decodeTile, type Feature, type Layer } from './vector-tile';

/** What the map under the direction target draws, bottom to top. Everything else in the tiles is left out. */
export const fills = ['wood', 'water'] as const;
export const lines = ['stream', 'river', 'road', 'track'] as const;
export type Kind = typeof fills[number] | typeof lines[number];
export type Place = { name: string; x: number; y: number; rank: number };
/** One tile's shapes as SVG path data in tile units (0 to extent), one path per kind. */
export type DrawnTile = { extent: number; paths: Partial<Record<Kind, string>>; places: Place[] };

const drawn = ['landcover', 'water', 'waterway', 'transportation', 'place'] as const;
const roads = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
// Towns before villages when names compete for room.
const placeRank: Record<string, number> = { city: 0, town: 1, village: 2 };

/** OpenMapTiles classes to the map's kinds (https://openmaptiles.org/schema/). */
export function kindOf(layer: string, feature: Feature): Kind | undefined {
  const { class: kind, brunnel } = feature.properties;
  if (brunnel === 'tunnel') return undefined;
  // Sylweta: forest and water only; wetland, settlements and minor roads stay off the map.
  if (layer === 'landcover') return kind === 'wood' ? 'wood' : undefined;
  if (layer === 'water') return kind === 'swimming_pool' ? undefined : 'water';
  // Ditches and drains criss-cross farmland and would make the map busy.
  if (layer === 'waterway') return kind === 'river' || kind === 'canal' ? 'river' : kind === 'stream' ? 'stream' : undefined;
  if (layer === 'transportation') {
    if (roads.has(String(kind))) return 'road';
    return kind === 'track' ? 'track' : undefined;
  }
  return undefined;
}

function path(feature: Feature) {
  const closed = feature.type === 3;
  return feature.geometry.map(part => {
    if (part.length < (closed ? 4 : 2)) return '';
    const points = closed ? part.slice(0, -1) : part;
    return `M${points.map(([x, y]) => `${x} ${y}`).join('L')}${closed ? 'Z' : ''}`;
  }).join('');
}

/** Decodes a tile and keeps only what the map draws. Throws on a corrupt tile. */
export function drawTile(bytes: Uint8Array): DrawnTile {
  const layers: Record<string, Layer> = decodeTile(bytes, drawn);
  const parts: Partial<Record<Kind, string[]>> = {};
  const places: Place[] = [];
  let extent = 4096;
  for (const [name, layer] of Object.entries(layers)) {
    extent = layer.extent;
    for (const feature of layer.features) {
      if (name === 'place') {
        const rank = placeRank[String(feature.properties.class)];
        const [[point] = []] = feature.geometry;
        const label = feature.properties.name;
        if (rank !== undefined && point && typeof label === 'string' && label) places.push({ name: label, x: point[0], y: point[1], rank });
        continue;
      }
      const kind = kindOf(name, feature);
      // A fill is drawn from polygons and a line from lines only, so a stray type never paints a blob.
      if (!kind || feature.type !== ((fills as readonly string[]).includes(kind) ? 3 : 2)) continue;
      (parts[kind] ??= []).push(path(feature));
    }
  }
  const paths: DrawnTile['paths'] = {};
  for (const [kind, list] of Object.entries(parts) as [Kind, string[]][]) paths[kind] = list.join('');
  return { extent, paths, places };
}

export type Box = [left: number, top: number, right: number, bottom: number];
/** Place names in view-box units; a name's box is estimated from its length, since nothing is measured. */
export const placeSize = 9.5;
export const placeBox = (place: { name: string; x: number; y: number }): Box => {
  // Spaced capitals: about 0.4 of the size a letter.
  const half = place.name.length * placeSize * .4 + 4;
  return [place.x - half, place.y - placeSize * .7, place.x + half, place.y + placeSize * .7];
};
const overlaps = (a: Box, b: Box) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** The names that fit inside the face without touching what is already there, towns first, at most a few. */
export function fitPlaces<T extends Place>(places: T[], blocked: Box[], radius: number, most = 4) {
  const taken = [...blocked];
  const shown: T[] = [];
  const seen = new Set<string>();
  for (const place of [...places].sort((a, b) => a.rank - b.rank || Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y))) {
    if (shown.length >= most || seen.has(place.name)) continue;
    const box = placeBox(place);
    const inside = [[box[0], box[1]], [box[2], box[1]], [box[0], box[3]], [box[2], box[3]]].every(([x, y]) => Math.hypot(x, y) <= radius);
    if (!inside || taken.some(other => overlaps(box, other))) continue;
    seen.add(place.name);
    taken.push(box);
    shown.push(place);
  }
  return shown;
}

/** OpenFreeMap's TileJSON names the current tile set; its tiles change URL with each weekly build. */
export const tileJson = 'https://tiles.openfreemap.org/planet';
const tileHost = 'https://tiles.openfreemap.org/';
// No Referer and no cookies: a tile request says which area is on screen and nothing about the Report.
const request: RequestInit = { referrerPolicy: 'no-referrer', credentials: 'omit' };
let template: Promise<string> | undefined;

async function tiles() {
  const response = await fetch(tileJson, request);
  const url = response.ok ? (await response.json())?.tiles?.[0] : undefined;
  if (typeof url !== 'string' || !url.startsWith(tileHost)) throw new Error('No vector tile source');
  return url;
}

/** One tile, decoded; undefined offline, on any failure and on a corrupt tile, so the face stays rings on paper. */
export async function loadTile(z: number, x: number, y: number, signal?: AbortSignal): Promise<DrawnTile | undefined> {
  try {
    // Shared by every tile, so leaving one tile early never cancels the lookup for the rest.
    const source = template ??= tiles();
    const url = (await source).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    const response = await fetch(url, { ...request, signal });
    if (!response.ok) return undefined;
    return await decodeAway(await response.arrayBuffer());
  } catch {
    // A failed lookup is asked again by the next Report rather than remembered for the session.
    template = undefined;
    return undefined;
  }
}

// Decoding a zoom 12 tile takes the Pixel long enough that nine of them arriving during a scale change
// dropped frames, so tiles are decoded in one long-lived worker; without workers, here.
let decoder: Worker | undefined;
const waiting = new Map<number, (tile: DrawnTile | undefined) => void>();
let nextJob = 0;
function decodeAway(bytes: ArrayBuffer): Promise<DrawnTile | undefined> {
  if (typeof Worker === 'undefined') return Promise.resolve(drawTile(new Uint8Array(bytes)));
  if (!decoder) {
    decoder = new Worker(new URL('./tile-worker.ts', import.meta.url), { type: 'module' });
    decoder.onmessage = (event: MessageEvent<{ job: number; tile: DrawnTile | null }>) => {
      waiting.get(event.data.job)?.(event.data.tile ?? undefined);
      waiting.delete(event.data.job);
    };
  }
  const job = nextJob++;
  return new Promise(resolve => {
    waiting.set(job, resolve);
    decoder!.postMessage({ job, bytes }, [bytes]);
  });
}
