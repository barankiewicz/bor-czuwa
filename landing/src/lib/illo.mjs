// @ts-nocheck
// The landing drawing, copied unchanged from ticket 09's signed-off prototype (evidence/09/assets/illo.mjs).
// Its defaults are the owner's tuned values: change the drawing there and copy it again, never here.
// The direction-3 drawing, one source for the static page (gen.mjs) and the tuning panel (tune.mjs).
// Grain lines run across a 1600-wide canvas and are pushed apart around a house and a knot; a measured
// line joins the two. Each line is displaced by an amount that decays with its distance from an
// obstacle, slowly enough (falloff >= 1) that neighbouring lines never cross.
export const defaults = {
  // drawing
  firstY: 20,        // base height of the top wave (owner's tuning, round 3)
  lastY: 580,        // base height of the bottom wave
  addTop: 0,         // waves added above the top one, one spacing apart (negative removes)
  addBottom: 5,      // waves added below the bottom one
  spacing: 24,
  thick: 5, thin: 5.5, // owner, settings panel 2026-11-12
  houseX: 491, houseY: 393, houseSize: 1,
  knotX: 921, knotY: 446, knotR: 40,
  push: 12,          // clearance added around each obstacle
  falloff: 2.1,        // how slowly the push fades with distance (x the obstacle's reach); >= 1 keeps lines from crossing
  reach: 1.55,       // how far along the line the push spreads
  // character (all 0 keeps the clean drawing): a slow wave through the grain, random line widths and
  // lines that swell and thin along their length, all from one seed
  waveAmp: 3,        // units the waves wander up and down
  waveLength: 250,   // units between the wanderings' crests
  waveCorr: 345,     // units over which neighbouring lines wander alike; small = each its own way
  thickVar: 0.42,       // 0..1, how much each line's width differs from its neighbours'
  swell: 0,          // 0..1, how much a line swells and thins along its length
  swellLength: 230,  // units between swellings
  seed: 1,
  // weight at the eye: lines are thicker near the knot (the shot) and thin with distance
  eyeBoost: 1.8,        // width multiplier right at the knot; 1 is off
  eyeRadius: 80,    // units from the knot's edge over which the extra width fades
  eyeSharpness: 4.1,   // 1 fades gently and far, higher keeps the weight close to the knot
  eyeMode: 'along',  // 'along': a line swells where it passes the knot; 'line': whole lines near it are thicker
  measure: 3.5,      // measured line width; 0 hides it
  measureFromX: 67,  // where the measured line starts, from the house's centre (units, scaled with the house)
  measureFromY: 17,
  measureGap: 12,    // space left between the line's end and the knot
  viewY: 56,          // moves the drawing up or down inside its frame (canvas units)
  zoom: 1,           // >1 crops in, <1 shows more
  // layout (CSS)
  gapAbove: -10,       // px between the lead and the frame
  heightVw: 20.5, heightMin: 240, heightMax: 485,
  storeGap: 12,      // px between the frame and the buttons (round 1: clamp(28px, 4vw, 48px)); negative overlaps
  hiPad: 0.64,       // em of paper box above and below its text
  hiPadX: 1.21,      // em of paper box either side of its text
  headlineLh: 0.83,  // headline line height
  leadLh: 1.14,       // lead line height
  // text against the waves: 'box' is one paper box over the headline and lead and one over the
  // buttons and notices (owner, round 4); 'highlight' is a paper box behind each line of text; 'soft'
  // fades the waves out around the text; storeLayout 'stack' puts the two store lines under the buttons
  textMode: 'box',
  storeLayout: 'stack',
  glow: 6,           // px over which a wave fades out near text ('soft')
  glowSpread: 9      // px of fully clear paper around text before the fade starts ('soft')
};

// holes: boxes in drawing units ({ x, y, w, h }) around text; with any, the waves fade out around them
// through a blurred mask. blur is in drawing units.
// Seeded, smooth noise for the drawing's character: a hash per lattice point, eased between them.
function rand(i, j, seed) {
  let h = (i * 374761393 + j * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
  const e = t => t * t * (3 - 2 * t), u = e(fx), v = e(fy);
  const a = rand(xi, yi, seed), b = rand(xi + 1, yi, seed), c = rand(xi, yi + 1, seed), d = rand(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
const fbm = (x, y, seed) => (noise(x, y, seed) * 2 + noise(x * 2.1, y * 2.1, seed + 7)) / 3;

export function drawIllo(p = defaults, holes = [], blur = 0) {
  const W = 1600, H = 620;
  const s = p.houseSize;
  const obstacles = [
    { x: p.houseX, y: p.houseY, r: 92 * s },
    { x: p.knotX, y: p.knotY, r: p.knotR }
  ];
  const xs = [];
  for (let x = -20; x <= W + 20; x += 8) xs.push(x);
  const bases = [];
  const top = p.firstY - p.addTop * p.spacing, bottom = p.lastY + p.addBottom * p.spacing;
  for (let y0 = top; y0 <= bottom + 0.01; y0 += p.spacing) bases.push(y0);
  const rows = bases.map(y0 => xs.map(x => {
    let y = y0;
    for (const o of obstacles) {
      const m = o.r + p.push;
      const dy = y0 - o.y;
      const sg = dy >= 0 ? 1 : -1;
      const amp = sg * m * Math.exp(-Math.abs(dy) / (m * p.falloff));
      const dx = Math.max(0, Math.abs(x - o.x) - o.r * 0.6);
      y += amp * Math.exp(-(dx * dx) / (2 * (m * p.reach) ** 2));
    }
    return y;
  }));
  // Widths alternate along the base grid, so dropping a wave from either end never swaps the others.
  // The grid index also seeds each line's randomness, so adding a wave never reshuffles the rest.
  const gridK = bases.map(y0 => Math.round((y0 - 20) / p.spacing));
  const widths = gridK.map(k => {
    const w = k % 2 ? p.thin : p.thick;
    return Math.max(0.5, w * (1 + p.thickVar * 0.8 * (rand(k, 0, p.seed) * 2 - 1)));
  });
  // Weight at the eye: 1 far away, eyeBoost at the knot's edge, fading over eyeRadius.
  const eyeOn = p.eyeBoost !== 1;
  const eye = (x, y) => {
    const d = Math.max(0, Math.hypot(x - p.knotX, y - p.knotY) - p.knotR);
    return 1 + (p.eyeBoost - 1) * Math.exp(-((d / p.eyeRadius) ** p.eyeSharpness));
  };
  if (eyeOn && p.eyeMode === 'line') rows.forEach((ys, i) => {
    let best = Infinity;
    ys.forEach((y, k) => { best = Math.min(best, Math.max(0, Math.hypot(xs[k] - p.knotX, y - p.knotY) - p.knotR)); });
    widths[i] *= 1 + (p.eyeBoost - 1) * Math.exp(-((best / p.eyeRadius) ** p.eyeSharpness));
  });
  const eyeAlong = eyeOn && p.eyeMode === 'along';
  const character = p.waveAmp > 0 || p.swell > 0 || p.thickVar > 0 || eyeOn;
  if (p.waveAmp > 0) {
    rows.forEach((ys, i) => ys.forEach((y, k) => {
      // The wandering calms near the house and the knot, so their clearings stay clear.
      let calm = 1;
      for (const o of obstacles) {
        const r = o.r + p.push + p.waveAmp, d2 = (xs[k] - o.x) ** 2 + (y - o.y) ** 2;
        calm = Math.min(calm, 1 - Math.exp(-d2 / (2 * r * r)));
      }
      ys[k] = y + calm * p.waveAmp * (fbm(xs[k] / p.waveLength, bases[i] / p.waveCorr, p.seed) * 2 - 1);
    }));
  }
  const along = (i, k) => (p.swell > 0 ? Math.max(0.3, 1 + p.swell * (fbm(xs[k] / p.swellLength, gridK[i] * 7.31, p.seed + 101) * 2 - 1) * 1.2) : 1)
    * (eyeAlong ? eye(xs[k], rows[i][k]) : 1);
  // A line's vertical thickness at a column: its width there, stretched by its slope.
  const slopeAt = (ys, k) => (ys[Math.min(k + 1, ys.length - 1)] - ys[Math.max(k - 1, 0)]) / (xs[Math.min(k + 1, xs.length - 1)] - xs[Math.max(k - 1, 0)]);
  // The stretch is capped: pushing lines apart steepens them, a steeper line counts thicker and gets
  // pushed further, and uncapped that loop ran lines off to infinity at extreme settings.
  const half = (i, k) => widths[i] * along(i, k) / 2 * Math.min(2.5, Math.sqrt(1 + slopeAt(rows[i], k) ** 2));
  if (character) {
    // Keep order and air: in every column each line's upper edge sits at least 2 units below the
    // lower edge of the line above. Pushing a line changes its slopes, so the pass runs until it holds.
    for (let pass = 0; pass < 6; pass++) {
      let moved = false;
      for (let k = 0; k < xs.length; k++) for (let i = 1; i < rows.length; i++) {
        const need = rows[i - 1][k] + half(i - 1, k) + half(i, k) + 2;
        if (rows[i][k] < need - 0.01) { rows[i][k] = need; moved = true; }
      }
      if (!moved) break;
    }
  }
  // Final thicknesses, measured once on the settled lines; one last pass with exactly these values,
  // and the drawing below uses the same ones, so the air between lines holds whatever the settings.
  const thick = rows.map((_, i) => xs.map((_, k) => half(i, k)));
  if (character) for (let k = 0; k < xs.length; k++) for (let i = 1; i < rows.length; i++) {
    const need = rows[i - 1][k] + thick[i - 1][k] + thick[i][k] + 2;
    if (rows[i][k] < need) rows[i][k] = need;
  }
  const lines = rows.map((ys, i) => {
    if (p.swell <= 0 && !eyeAlong) {
      const d = ys.map((y, k) => `${k ? 'L' : 'M'}${xs[k]} ${y.toFixed(1)}`).join('');
      return `<path d="${d}" stroke-width="${+widths[i].toFixed(2)}"/>`;
    }
    // A swelling line is a filled shape: its two edges sit half its local width either side,
    // measured across the line rather than straight down.
    const up = [], down = [];
    ys.forEach((y, k) => {
      const h = thick[i][k];
      up.push(`${xs[k]} ${(y - h).toFixed(1)}`); down.push(`${xs[k]} ${(y + h).toFixed(1)}`);
    });
    return `<path class="fill" d="M${up.join('L')}L${down.reverse().join('L')}Z"/>`;
  });
  const hx = p.houseX, hy = p.houseY;
  const housePath = `M${hx - 52 * s} ${hy + 46 * s}V${hy - 8 * s}L${hx} ${hy - 56 * s}L${hx + 52 * s} ${hy - 8 * s}V${hy + 46 * s}Z`;
  const x1 = hx + p.measureFromX * s, y1 = hy + p.measureFromY * s, ang = Math.atan2(p.knotY - y1, p.knotX - x1);
  const x2 = p.knotX - Math.cos(ang) * (p.knotR + p.measureGap), y2 = p.knotY - Math.sin(ang) * (p.knotR + p.measureGap);
  const tick = (x, y) => { const nx = -Math.sin(ang) * 12, ny = Math.cos(ang) * 12; return `M${(x - nx).toFixed(1)} ${(y - ny).toFixed(1)}L${(x + nx).toFixed(1)} ${(y + ny).toFixed(1)}`; };
  const vw = W / p.zoom, vh = H / p.zoom;
  const vx = (W - vw) / 2, vy = (H - vh) / 2 + p.viewY;
  const measure = p.measure > 0 ? `<path class="measure" style="stroke-width:${p.measure}" d="M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}${tick(x1, y1)}${tick(x2, y2)}"/>` : '';
  return `<svg class="illo" viewBox="${vx.toFixed(1)} ${vy.toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
  ${holes.length ? `<defs><filter id="illo-blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(blur / 2).toFixed(1)}"/></filter><mask id="illo-mask" maskUnits="userSpaceOnUse" x="-4000" y="-4000" width="9600" height="8620"><rect x="-4000" y="-4000" width="9600" height="8620" fill="#fff"/><g filter="url(#illo-blur)">${holes.map(h => `<rect x="${h.x.toFixed(1)}" y="${h.y.toFixed(1)}" width="${h.w.toFixed(1)}" height="${h.h.toFixed(1)}" rx="${Math.min(h.h / 2, 16).toFixed(1)}" fill="#000"/>`).join('')}</g></mask></defs>` : ''}
  <g class="grain" fill="none"${holes.length ? ' mask="url(#illo-mask)"' : ''}>${lines.join('')}</g>
  <path class="house" d="${housePath}"/>
  ${measure}
  <circle class="knot" cx="${p.knotX}" cy="${p.knotY}" r="${p.knotR}"/>
</svg>`;
}

// The layout half of the settings, as CSS custom properties on the hero.
export function layoutVars(p = defaults) {
  return {
    '--illo-gap': `${p.gapAbove}px`,
    '--illo-h': `clamp(${p.heightMin}px, ${p.heightVw}vw, ${p.heightMax}px)`,
    '--store-gap': `${Math.max(0, p.storeGap)}px`,
    '--store-gap-pull': `${Math.min(0, p.storeGap)}px`,
    '--hi-pad': `${p.hiPad}em`,
    '--hi-pad-x': `${p.hiPadX}em`,
    '--hl-lh': `${p.headlineLh}`,
    '--lead-lh': `${p.leadLh}`,
  };
}
