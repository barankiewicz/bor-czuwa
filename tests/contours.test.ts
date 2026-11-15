import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heights, intervalFor, smooth, trace } from '../src/lib/contours.ts';

test('Terrarium pixels decode to metres', () => {
  // 32768 + 150.5 m: red 128, green 150, blue 128.
  const rgba = new Uint8ClampedArray([128, 150, 128, 255, 128, 0, 0, 255]);
  assert.deepEqual([...heights(rgba)], [150.5, 0]);
});

test('the interval follows the relief: lowland every 5 m, hills every 10 or 20 m', () => {
  assert.equal(intervalFor(120, 180), 5);
  assert.equal(intervalFor(205, 368), 10);
  assert.equal(intervalFor(400, 900), 20);
});

test('smoothing leaves a flat field flat, edges included', () => {
  const flat = new Float32Array(25).fill(100);
  assert.ok(smooth(flat, 5, 5).every(value => Math.abs(value - 100) < 1e-4));
});

test('a hill traces closed rings, one per level, centred on its top', () => {
  const size = 41, grid = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) grid[y * size + x] = 100 - Math.hypot(x - 20, y - 20);
  const { minor, major } = trace(grid, size, size, 20, 20, 30, 5);
  const rings = (minor + major).split('M').filter(Boolean);
  // Levels 85, 90 and 95 lie inside the grid; 80 and below cross its edge.
  const closed = rings.filter(ring => { const points = ring.replace('L', ' ').trim().split(/\s+/).map(Number); return Math.hypot(points[0] - points.at(-2)!, points[1] - points.at(-1)!) < 1.5; });
  assert.ok(closed.length >= 3, `${closed.length} closed rings`);
  // Every fifth level is the stronger line: 100 is the top itself, so 75 is the major one inside the grid.
  assert.ok(major.length > 0);
  // The 95 m ring sits 5 cells from the top in every direction.
  const ring95 = rings.find(ring => { const [x, y] = ring.replace('L', ' ').trim().split(/\s+/).map(Number); return Math.abs(Math.hypot(x, y) - 5) < .2; });
  assert.ok(ring95, 'a ring at radius 5');
});

test('a slope traces open lines joined across cells, not one segment per cell', () => {
  const size = 30, grid = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) grid[y * size + x] = 101 + x * 2;
  const { minor, major } = trace(grid, size, size, 15, 15, 20, 10);
  const lines = (minor + major).split('M').filter(Boolean);
  // Levels 110 to 150 cross the grid from top to bottom, each as a single polyline.
  assert.equal(lines.length, 5);
  assert.ok(lines.every(line => line.split(' ').length > 40));
});

test('a saddle keeps its two lines apart', () => {
  // Two highs on one diagonal, two lows on the other.
  const grid = new Float32Array([9, 1, 1, 9]);
  const { minor, major } = trace(grid, 2, 2, 0, 0, 5, 5);
  assert.equal((minor + major).split('M').filter(Boolean).length, 2);
});
