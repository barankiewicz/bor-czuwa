import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { decodeGeometry, decodeTile, zigzag } from '../src/lib/vector-tile.ts';
import { drawTile, loadTile } from '../src/lib/vector-map.ts';

// OpenFreeMap tile 14/9228/5304, recorded 2026-11-14 beside the acceptance barn (53.43 N, 22.80 E).
// © OpenMapTiles, data © OpenStreetMap contributors (ODbL).
const fixture = new Uint8Array(await readFile(new URL('./fixtures/openfreemap-14-9228-5304.pbf', import.meta.url)));

// A minimal protobuf writer, so tiles can be built by hand.
const varint = (value: number) => { const out: number[] = []; while (value > 127) { out.push(value % 128 | 128); value = Math.floor(value / 128); } out.push(value); return out; };
const field = (number: number, wire: number) => varint(number * 8 + wire);
const bytes = (number: number, body: number[]) => [...field(number, 2), ...varint(body.length), ...body];
const text = (number: number, value: string) => bytes(number, [...new TextEncoder().encode(value)]);
const number = (number: number, value: number) => [...field(number, 0), ...varint(value)];
const packed = (number: number, values: number[]) => bytes(number, values.flatMap(varint));
const encodeZigzag = (value: number) => value < 0 ? -value * 2 - 1 : value * 2;
const command = (id: number, count: number) => id | count << 3;

function tile(name: string, features: { type: number; tags: number[]; geometry: number[] }[], keys: string[], values: number[][]) {
  const layer = [
    ...text(1, name),
    ...features.flatMap(feature => bytes(2, [...packed(2, feature.tags), ...number(3, feature.type), ...packed(4, feature.geometry)])),
    ...keys.flatMap(key => text(3, key)),
    ...values.flatMap(value => bytes(4, value)),
    ...number(5, 4096), ...number(15, 2)
  ];
  return new Uint8Array(bytes(3, layer));
}

test('zigzag decodes signed parameters', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 4095, 4096].map(zigzag), [0, -1, 1, -2, 2, -2048, 2048]);
});

test('MoveTo, LineTo and ClosePath make a closed ring from deltas', () => {
  const geometry = decodeGeometry([
    command(1, 1), encodeZigzag(3), encodeZigzag(6),
    command(2, 2), encodeZigzag(5), encodeZigzag(0), encodeZigzag(0), encodeZigzag(-4),
    command(7, 1)
  ]);
  assert.deepEqual(geometry, [[[3, 6], [8, 6], [8, 2], [3, 6]]]);
});

test('a polygon with a hole keeps both rings, the cursor carrying across them', () => {
  const geometry = decodeGeometry([
    command(1, 1), 0, 0, command(2, 3), encodeZigzag(10), 0, 0, encodeZigzag(10), encodeZigzag(-10), 0, command(7, 1),
    command(1, 1), encodeZigzag(1), encodeZigzag(-9), command(2, 3), 0, encodeZigzag(8), encodeZigzag(8), 0, 0, encodeZigzag(-8), command(7, 1)
  ]);
  assert.deepEqual(geometry, [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[1, 1], [1, 9], [9, 9], [9, 1], [1, 1]]
  ]);
});

test('a multi-line feature starts a new part at each MoveTo', () => {
  const geometry = decodeGeometry([command(1, 1), 4, 4, command(2, 1), 2, 2, command(1, 1), 2, 2, command(2, 1), 4, 4]);
  assert.deepEqual(geometry, [[[2, 2], [3, 3]], [[4, 4], [6, 6]]]);
});

test('a hand-built tile decodes its tags and only the wanted layers', () => {
  const water = tile('water', [{ type: 3, tags: [0, 0], geometry: [command(1, 1), 0, 0, command(2, 2), 8, 0, 0, 8, command(7, 1)] }], ['class'], [text(1, 'lake')]);
  const building = tile('building', [{ type: 3, tags: [], geometry: [command(1, 1), 0, 0] }], [], []);
  const decoded = decodeTile(new Uint8Array([...building, ...water]), ['water']);
  assert.deepEqual(Object.keys(decoded), ['water']);
  assert.equal(decoded.water.extent, 4096);
  assert.deepEqual(decoded.water.features[0], { type: 3, properties: { class: 'lake' }, geometry: [[[0, 0], [4, 0], [4, 4], [0, 0]]] });
});

test('the recorded tile draws forest, water, main roads and tracks, and names villages', () => {
  const drawn = drawTile(fixture);
  assert.equal(drawn.extent, 4096);
  for (const kind of ['wood', 'water', 'road', 'track'] as const) {
    assert.match(drawn.paths[kind] ?? '', /^M-?\d/, `${kind} is drawn`);
  }
  // Sylweta keeps the map to forest and water: wetland, settlements and minor roads are left out,
  // as are ditches across the farmland, buildings and house numbers.
  assert.deepEqual(Object.keys(drawn.paths).sort(), ['road', 'track', 'water', 'wood']);
  assert.ok(drawn.places.some(place => place.name === 'Jaski'));
  assert.ok(drawn.places.every(place => place.rank <= 2));
  const decoded = decodeTile(fixture, ['landcover', 'building']);
  assert.ok(decoded.building.features.length > 0, 'the tile has buildings, which the map leaves out');
  assert.ok(decoded.landcover.features.every(feature => feature.geometry.every(ring => ring.at(-1)!.join() === ring[0].join())), 'polygon rings close');
});

test('a corrupt tile throws from the decoder and loads as no tile, never an exception', async () => {
  const truncated = fixture.subarray(0, fixture.length - 100);
  assert.throws(() => decodeTile(truncated, ['landcover']), /Corrupt vector tile/);
  assert.throws(() => decodeGeometry([command(2, 1), 2]), /Corrupt vector tile/);
  assert.throws(() => decodeGeometry([command(3, 1), 2, 2]), /Corrupt vector tile/);
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    if (String(url).endsWith('/planet')) return Response.json({ tiles: ['https://tiles.openfreemap.org/planet/test/{z}/{x}/{y}.pbf'] });
    return new Response(truncated);
  }) as typeof fetch;
  try {
    assert.equal(await loadTile(14, 9228, 5304), undefined);
    assert.deepEqual(asked, ['https://tiles.openfreemap.org/planet', 'https://tiles.openfreemap.org/planet/test/14/9228/5304.pbf']);
  } finally {
    globalThis.fetch = original;
  }
});

test('a tile source on another host is refused', async () => {
  const original = globalThis.fetch;
  const asked: string[] = [];
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    return Response.json({ tiles: ['https://elsewhere.example/{z}/{x}/{y}.pbf'] });
  }) as typeof fetch;
  try {
    assert.equal(await loadTile(14, 1, 1), undefined);
    assert.deepEqual(asked, ['https://tiles.openfreemap.org/planet']);
  } finally {
    globalThis.fetch = original;
  }
});
