export type Point = { lat: number; lon: number };
export type Pixel = { x: number; y: number };
export type Tile = { key: string; x: number; y: number; left: number; top: number; urlX: number };

export const tileSize = 256;
export const latitudeLimit = 85.0511;
export const tileUrl = (z: number, x: number, y: number) =>
  `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

export function project(point: Point, level: number): Pixel {
  const scale = tileSize * 2 ** level;
  const lat = Math.max(-latitudeLimit, Math.min(latitudeLimit, point.lat));
  const sin = Math.sin(lat * Math.PI / 180);
  return {
    x: (point.lon + 180) / 360 * scale,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale
  };
}

export function unproject(point: Pixel, level: number): Point {
  const scale = tileSize * 2 ** level;
  return {
    lon: Math.max(-180, Math.min(180, point.x / scale * 360 - 180)),
    lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * point.y / scale))) * 180 / Math.PI
  };
}

/** The 3 × 3 tiles around a centre, positioned in pixels relative to it. */
export function visibleTiles(center: Point, zoom: number, attempt: number) {
  const world = project(center, zoom);
  const tileX = Math.floor(world.x / tileSize);
  const tileY = Math.floor(world.y / tileSize);
  const count = 2 ** zoom;
  const visible: Tile[] = [];
  for (let y = tileY - 1; y <= tileY + 1; y++) {
    if (y < 0 || y >= count) continue;
    for (let x = tileX - 1; x <= tileX + 1; x++) {
      visible.push({
        key: `${zoom}-${x}-${y}-${attempt}`, x, y,
        left: x * tileSize - world.x, top: y * tileSize - world.y,
        urlX: ((x % count) + count) % count
      });
    }
  }
  return visible;
}
