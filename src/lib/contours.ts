import { project, tileSize, type Point } from './map-tiles.js';

/** Contour lines under the direction target, made on the phone from Terrarium elevation tiles (Mapzen's
 * terrain tiles on AWS open data; over Poland the heights are Copernicus EU-DEM). Zoom 12 is about 23 m a
 * pixel in Poland and its 3 × 3 tiles reach past 5 km, so one load serves every scale of the target. */
export const terrainZoom = 12;
export const terrainTile = (x: number, y: number) =>
  `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${terrainZoom}/${x}/${y}.png`;
/** The farthest the target ever shows, so lines are made only where they can be seen. */
const reachMetres = 5000;

export type Contours = {
  /** Path data in terrain pixels from Ty, east and south positive: ordinary lines and every fifth one. */
  minor: string; major: string;
  interval: number; metresPerPixel: number;
};

/** Terrarium packs height in metres as red × 256 + green + blue / 256 − 32768. */
export function heights(rgba: Uint8ClampedArray) {
  const out = new Float32Array(rgba.length / 4);
  for (let index = 0; index < out.length; index++) {
    out[index] = rgba[index * 4] * 256 + rgba[index * 4 + 1] + rgba[index * 4 + 2] / 256 - 32768;
  }
  return out;
}

/** Averages each 2 × 2 block, so lines are traced on 46 m cells: a quarter of the work, and still about
 * 7 px a cell at the 1 km scale. */
export function halve(grid: Float32Array, width: number, height: number) {
  const w = Math.floor(width / 2), h = Math.floor(height / 2), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 2 * y * width + 2 * x;
    out[y * w + x] = (grid[i] + grid[i + 1] + grid[i + width] + grid[i + width + 1]) / 4;
  }
  return { grid: out, width: w, height: h };
}

/** Two passes of a 1-4-6-4-1 blur each way, so a few metres of survey noise does not draw lines of its own.
 * Edges repeat their last value rather than pulling towards zero. */
export function smooth(grid: Float32Array, width: number, height: number) {
  const weights = [1, 4, 6, 4, 1];
  let from = grid;
  for (let pass = 0; pass < 4; pass++) {
    const along = pass % 2 === 0;
    const to = new Float32Array(from.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) {
        const sx = along ? Math.min(width - 1, Math.max(0, x + k)) : x;
        const sy = along ? y : Math.min(height - 1, Math.max(0, y + k));
        sum += from[sy * width + sx] * weights[k + 2];
      }
      to[y * width + x] = sum / 16;
    }
    from = to;
  }
  return from;
}

/** Lines often enough to show a lowland's few tens of metres, sparse enough that hills stay readable. */
export function intervalFor(low: number, high: number) {
  const span = high - low;
  return span <= 100 ? 5 : span <= 250 ? 10 : 20;
}

/** Marching squares at each level, the cell segments joined into polylines. Coordinates are in grid cells
 * relative to (cx, cy); only cells within reach of it are traced. */
export function trace(grid: Float32Array, width: number, height: number, cx: number, cy: number, reach: number, interval: number, tolerance = 0) {
  const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(width - 2, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(height - 2, Math.ceil(cy + reach));
  const at = (x: number, y: number) => grid[y * width + x];
  let low = Infinity, high = -Infinity;
  for (let y = y0; y <= y1 + 1; y++) for (let x = x0; x <= x1 + 1; x++) { low = Math.min(low, at(x, y)); high = Math.max(high, at(x, y)); }
  const minor: string[] = [], major: string[] = [];
  const format = (value: number) => Math.round(value * 10) / 10;
  for (let level = Math.ceil(low / interval) * interval; level <= high; level += interval) {
    // Each crossing sits on a cell edge, named by that edge, so segments meeting there join.
    const points = new Map<number, [number, number]>();
    const links = new Map<number, number[]>();
    const crossing = (id: number, point: [number, number]) => { points.set(id, point); if (!links.has(id)) links.set(id, []); return id; };
    const link = (a: number, b: number) => { links.get(a)!.push(b); links.get(b)!.push(a); };
    const across = (x: number, y: number) => (y * width + x) * 2; // the edge from (x, y) to (x + 1, y)
    const down = (x: number, y: number) => (y * width + x) * 2 + 1; // the edge from (x, y) to (x, y + 1)
    const t = (a: number, b: number) => (level - a) / (b - a);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const a = at(x, y), b = at(x + 1, y), c = at(x + 1, y + 1), d = at(x, y + 1);
      const code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const top = () => crossing(across(x, y), [x + t(a, b), y]);
      const right = () => crossing(down(x + 1, y), [x + 1, y + t(b, c)]);
      const bottom = () => crossing(across(x, y + 1), [x + t(d, c), y + 1]);
      const left = () => crossing(down(x, y), [x, y + t(a, d)]);
      if (code === 1 || code === 14) link(left(), bottom());
      else if (code === 2 || code === 13) link(bottom(), right());
      else if (code === 3 || code === 12) link(left(), right());
      else if (code === 4 || code === 11) link(top(), right());
      else if (code === 6 || code === 9) link(top(), bottom());
      else if (code === 7 || code === 8) link(left(), top());
      else if (code === 5) { link(left(), top()); link(bottom(), right()); }
      else { link(top(), right()); link(left(), bottom()); }
    }
    const out = (level / interval) % 5 === 0 ? major : minor;
    const seen = new Set<number>();
    const walk = (start: number) => {
      const line = [start];
      seen.add(start);
      for (let current = start; ;) {
        const next = links.get(current)!.find(id => !seen.has(id));
        if (next === undefined) break;
        seen.add(next); line.push(next); current = next;
      }
      return line;
    };
    // Open lines start at an end; what remains are closed loops.
    const ids = [...links.keys()];
    for (const id of [...ids.filter(id => links.get(id)!.length === 1), ...ids]) {
      if (seen.has(id)) continue;
      const line = walk(id);
      if (line.length < 2) continue;
      // Points closer than the tolerance to the last one kept add bytes and no shape.
      const kept: [number, number][] = [];
      line.forEach((key, index) => {
        const point = points.get(key)!, last = kept.at(-1);
        if (!last || index === line.length - 1 || Math.hypot(point[0] - last[0], point[1] - last[1]) >= tolerance) kept.push(point);
      });
      const coords = kept.map(([px, py]) => `${format(px - cx)} ${format(py - cy)}`);
      out.push(`M${coords[0]}L${coords.slice(1).join(' ')}`);
    }
  }
  return { minor: minor.join(''), major: major.join(''), low, high };
}

async function decode(response: Response) {
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  return heights(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
}

/** Contours within 5 km of a point, or undefined offline or on any failure. Runs in the contour worker. */
export async function buildContours(centre: Point, signal?: AbortSignal): Promise<Contours | undefined> {
  try {
    const world = project(centre, terrainZoom);
    const tileX = Math.floor(world.x / tileSize), tileY = Math.floor(world.y / tileSize);
    const size = tileSize * 3;
    const grid = new Float32Array(size * size);
    await Promise.all([-1, 0, 1].flatMap(dy => [-1, 0, 1].map(async dx => {
      const response = await fetch(terrainTile(tileX + dx, tileY + dy), { referrerPolicy: 'no-referrer', credentials: 'omit', signal });
      if (!response.ok) throw new Error('No terrain tile');
      const tile = await decode(response);
      for (let row = 0; row < tileSize; row++) {
        grid.set(tile.subarray(row * tileSize, (row + 1) * tileSize), ((dy + 1) * tileSize + row) * size + (dx + 1) * tileSize);
      }
    })));
    const metresPerPixel = 156543.03 * Math.cos(centre.lat * Math.PI / 180) / 2 ** terrainZoom;
    const reach = reachMetres / metresPerPixel + 2;
    // Only the square around Ty that the target can show is smoothed and traced.
    const left = Math.max(0, Math.floor(world.x - (tileX - 1) * tileSize - reach - 4));
    const top = Math.max(0, Math.floor(world.y - (tileY - 1) * tileSize - reach - 4));
    const side = Math.min(size - Math.max(left, top), Math.ceil(2 * reach + 9));
    const window = new Float32Array(side * side);
    for (let row = 0; row < side; row++) window.set(grid.subarray((top + row) * size + left, (top + row) * size + left + side), row * side);
    const cx = world.x - (tileX - 1) * tileSize - left, cy = world.y - (tileY - 1) * tileSize - top;
    const half = halve(smooth(window, side, side), side, side);
    // The interval follows the relief near Ty, so lowland shows its few metres and hills stay readable.
    const probe = trace(half.grid, half.width, half.height, cx / 2, cy / 2, reach / 2, 1e6);
    const interval = intervalFor(probe.low, probe.high);
    const { minor, major } = trace(half.grid, half.width, half.height, cx / 2, cy / 2, reach / 2, interval, .6);
    return { minor, major, interval, metresPerPixel: metresPerPixel * 2 };
  } catch {
    return undefined;
  }
}


/** Paints the contours for one scale of the target into an image, so a zoom scales a picture instead of
 * repainting thousands of line points every frame (on a Pixel 10a that took 50 ms a frame). The image is
 * centred on the point the lines were traced around and reaches 10% past the rim; lines fade to half
 * strength towards the rim as the map does. Ordinary lines are left out at 5 km. Runs in the worker. */
export async function drawContours(contours: Contours, view: number, size: number, pixelRatio: number, ink: string) {
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  const rimPixels = size / 2 / 1.1;
  // Device pixels per contour cell at this scale.
  const k = rimPixels / view * contours.metresPerPixel;
  context.strokeStyle = ink;
  context.lineJoin = context.lineCap = 'round';
  const stroke = (data: string, alpha: number, width: number) => {
    if (!data || alpha <= 0) return;
    const path = new Path2D();
    path.addPath(new Path2D(data), new DOMMatrix([k, 0, 0, k, size / 2, size / 2]));
    context.globalAlpha = alpha;
    context.lineWidth = width * pixelRatio;
    context.stroke(path);
  };
  stroke(view >= 5000 ? '' : contours.minor, .26, .6);
  stroke(contours.major, .42, .9);
  // Full strength to 62% of the rim, half at the rim and beyond.
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'destination-in';
  const fade = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, rimPixels);
  fade.addColorStop(0, 'rgba(0,0,0,1)'); fade.addColorStop(.62, 'rgba(0,0,0,1)'); fade.addColorStop(1, 'rgba(0,0,0,.5)');
  context.fillStyle = fade;
  context.fillRect(0, 0, size, size);
  return canvas.convertToBlob();
}

type Job = { kind: 'build'; lat: number; lon: number }
  | { kind: 'paint'; contours: Contours; view: number; size: number; pixelRatio: number; ink: string };

function inWorker<T>(job: Job, signal?: AbortSignal): Promise<T | undefined> {
  if (typeof Worker === 'undefined') return Promise.resolve(undefined);
  return new Promise(resolve => {
    const worker = new Worker(new URL('./contours-worker.ts', import.meta.url), { type: 'module' });
    const finish = (found: T | undefined) => { worker.terminate(); resolve(found); };
    worker.onmessage = event => finish(event.data ?? undefined);
    worker.onerror = () => finish(undefined);
    signal?.addEventListener('abort', () => finish(undefined), { once: true });
    worker.postMessage(job);
  });
}

/** Builds the contours off the main thread, so a slow phone never drops a frame of the sonar or a scale
 * change while it works; undefined offline, on any failure, or once the target has gone. */
export function loadContours(centre: Point, signal?: AbortSignal) {
  return inWorker<Contours>({ kind: 'build', lat: centre.lat, lon: centre.lon }, signal);
}

/** One scale's picture as an object URL, painted in the worker and decoded before it is handed back. */
export async function paintContours(contours: Contours, view: number, size: number, pixelRatio: number, ink: string, signal?: AbortSignal) {
  const blob = await inWorker<Blob>({ kind: 'paint', contours, view, size, pixelRatio, ink }, signal);
  if (!blob) return undefined;
  const url = URL.createObjectURL(blob);
  const image = new Image();
  image.src = url;
  await image.decode().catch(() => {});
  return url;
}
