#!/usr/bin/env python3
"""Build every Bór czuwa brand file.

    python3 brand/src/build.py

Needs fontTools (`pip install fonttools`) for the logotype outlines and ImageMagick's `magick`
for the PNG and ICO exports. Everything under brand/ except src/ and README.md is output; edit
the generators, never the SVGs.

The symbol: four grain lines parting around a round knot. Each line is a straight run, a fillet
arc, an arc over the knot, a fillet arc and a straight run. All lines are offsets of one reference
curve, so the arcs over the knot share the knot's centre and the fillets share two more. The three
centres sit on a 3-4-5 triangle.

The logotype: BÓR over CZUWA in Archivo (SIL OFL), line 1 at width 125 and line 2 at the narrower
width that makes both lines measure the same. The Ó is the O's outer contour filled solid, a round
eye, and an accent drawn here instead of the font's.
"""
import math
import re
import subprocess
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

BRAND = Path(__file__).resolve().parent.parent
FONT = BRAND / 'src/fonts/Archivo[wdth,wght].ttf'

# The app's tokens (src/routes/page.css). ink and action per theme, and the ground each sits on.
THEMES = {
    '': dict(ink='#1c1b18', eye='#9e4310', ground='#f6f7f5', light=False),
    '-reversed': dict(ink='#efece4', eye='#e88a4e', ground='#1b1a17', light=True),
    '-noc': dict(ink='#c6c2b8', eye='#bda276', ground='#121110', light=True, open_o=True),
    '-black': dict(ink='#000000', eye=None, ground='#ffffff', light=False),
    '-white': dict(ink='#ffffff', eye=None, ground='#000000', light=True),
}


def n(v):
    return ('%.2f' % v).rstrip('0').rstrip('.')


def circle(r, cx, cy):
    return f"M{n(cx-r)} {n(cy)}A{n(r)} {n(r)} 0 1 0 {n(cx+r)} {n(cy)}A{n(r)} {n(r)} 0 1 0 {n(cx-r)} {n(cy)}Z"


# ---------------------------------------------------------------- symbol

def _edge(s, cx, cy, y_ref, R_ref, f_ref, a, xl, xr):
    y, R, f = y_ref - s, R_ref + s, f_ref - s
    ux, uy = a / (R_ref + f_ref), (cy - (y_ref - f_ref)) / (R_ref + f_ref)
    return dict(y=y, R=R, f=f, pl=(cx - ux * R, cy - uy * R), pr=(cx + ux * R, cy - uy * R),
                xa=cx - a, xb=cx + a, xl=xl, xr=xr)


def _band(s0, s1, flip, **g):
    o, i = _edge(s1, **g), _edge(s0, **g)
    Y = (lambda v: 2 * g['cy'] - v) if flip else (lambda v: v)
    a0, a1 = (1, 0) if flip else (0, 1)
    arc = lambda r, sweep, p: f"A{n(r)} {n(r)} 0 0 {sweep} {n(p[0])} {n(Y(p[1]))}"
    return (f"M{n(o['xl'])} {n(Y(o['y']))}H{n(o['xa'])}" + arc(o['f'], a0, o['pl']) + arc(o['R'], a1, o['pr'])
            + arc(o['f'], a0, (o['xb'], o['y'])) + f"H{n(o['xr'])}V{n(Y(i['y']))}H{n(i['xb'])}"
            + arc(i['f'], a1, i['pr']) + arc(i['R'], a0, i['pl']) + arc(i['f'], a1, (i['xa'], i['y'])) + f"H{n(i['xl'])}Z")


def grain(bands, R_ref, y_ref, f_ref, xl, xr, cx=128, cy=128):
    a = math.sqrt((R_ref + f_ref) ** 2 - (cy - y_ref + f_ref) ** 2)
    g = dict(cx=cx, cy=cy, y_ref=y_ref, R_ref=R_ref, f_ref=f_ref, a=a, xl=xl, xr=xr)
    return ''.join(_band(s0, s1, flip, **g) for (s0, s1) in bands for flip in (False, True))


# Full symbol on a 256 box: inner lines 26, outer 18, gaps 20, knot radius 24. Centres 102-136-170.
FULL = dict(lines=dict(bands=[(0, 26), (46, 64)], R_ref=44, y_ref=118, f_ref=126, xl=18, xr=238), knot=24)
# Light on dark looks heavier, so each line loses 1 unit (4 to 5 percent) and the knot 1 unit.
FULL_LIGHT = dict(lines=dict(bands=[(0.5, 25.5), (46.5, 63.5)], R_ref=44, y_ref=118, f_ref=126, xl=18, xr=238), knot=23)
# Small cut for 16 to 31 px: two lines of 32 units (2 px at 16), knot radius 30. Centres 120-160-200.
SMALL = dict(lines=dict(bands=[(0, 32)], R_ref=56, y_ref=112, f_ref=144, xl=8, xr=248), knot=30)
SYMBOL_BOX = (18, 28, 238, 228)      # painted bounds of the full symbol
LINE_ENDS = (54, 202)                # top and bottom of the straight line ends
KNOT_D = 48                          # the unit for gaps and clear space


def symbol_parts(theme, geometry=None):
    t = THEMES[theme]
    g = geometry or (FULL_LIGHT if t['light'] else FULL)
    lines, knot = grain(**g['lines']), circle(g['knot'], 128, 128)
    return [(t['ink'], lines + knot)] if t['eye'] is None else [(t['ink'], lines), (t['eye'], knot)]


# ---------------------------------------------------------------- logotype

_fonts = {}


def _font(wdth, wght):
    key = (wdth, wght)
    if key not in _fonts:
        f = instancer.instantiateVariableFont(TTFont(FONT), dict(wdth=wdth, wght=wght), inplace=False)
        _fonts[key] = (f, f.getGlyphSet(), f.getBestCmap(), _pair_kerning(f))
    return _fonts[key]


def _pair_kerning(f):
    """GPOS pair kerning as a lookup function (glyph, glyph) -> font units."""
    singles, classes = {}, []
    table = f['GPOS'].table
    lookups = {i for fr in table.FeatureList.FeatureRecord if fr.FeatureTag == 'kern' for i in fr.Feature.LookupListIndex}
    for i in sorted(lookups):
        lookup = table.LookupList.Lookup[i]
        for st in lookup.SubTable:
            st = st.ExtSubTable if lookup.LookupType == 9 else st
            if getattr(st, 'Format', None) == 1 and hasattr(st, 'PairSet'):
                for g1, pairs in zip(st.Coverage.glyphs, st.PairSet):
                    for pv in pairs.PairValueRecord:
                        singles.setdefault((g1, pv.SecondGlyph), getattr(pv.Value1, 'XAdvance', 0) or 0)
            elif getattr(st, 'Format', None) == 2 and hasattr(st, 'Class1Record'):
                classes.append((set(st.Coverage.glyphs), st.ClassDef1.classDefs, st.ClassDef2.classDefs, st))

    def kern(g1, g2):
        if (g1, g2) in singles:
            return singles[(g1, g2)]
        for coverage, c1, c2, st in classes:
            if g1 in coverage:
                value = st.Class1Record[c1.get(g1, 0)].Class2Record[c2.get(g2, 0)].Value1
                if value is not None and getattr(value, 'XAdvance', 0):
                    return value.XAdvance
        return 0
    return kern


def _bounds(d):
    xs, ys, x, y = [], [], 0.0, 0.0
    for cmd, args in re.findall(r'([MLHVQCZ])([^MLHVQCZ]*)', d):
        v = [float(t) for t in re.findall(r'-?\d+\.?\d*', args)]
        if cmd == 'H':
            for t in v:
                x = t; xs.append(x); ys.append(y)
        elif cmd == 'V':
            for t in v:
                y = t; xs.append(x); ys.append(y)
        else:
            for k in range(0, len(v) - 1, 2):
                x, y = v[k], v[k + 1]; xs.append(x); ys.append(y)
    return min(xs), min(ys), max(xs), max(ys)


def _contours(font, ch, size, x, y):
    f, glyphs, cmap, _ = font
    pen = SVGPathPen(glyphs, ntos=n)
    s = size / f['head'].unitsPerEm
    glyphs[cmap[ord(ch)]].draw(TransformPen(pen, (s, 0, 0, -s, x, y)))
    return ['M' + p for p in pen.getCommands().split('M') if p]


def _line(font, text, size, x=0.0, y=0.0, hand=None, track=0.0, skip=()):
    """Outline one line. Returns path data, bounds, and the x of each glyph."""
    f, glyphs, cmap, kern = font
    s = size / f['head'].unitsPerEm
    d, xs, prev = [], [], None
    for i, ch in enumerate(text):
        name = cmap[ord(ch)]
        if prev is not None:
            x += kern(cmap[ord(prev)], name) * s + (hand or {}).get(prev + ch, 0) * size / 1000 + track
        xs.append(x)
        if i not in skip:
            d += _contours(font, ch, size, x, y)
        x += glyphs[name].width * s
        prev = ch
    d = ''.join(d)
    return d, _bounds(d), xs


# Hand kerning in thousandths of the type size, added to the font's own pairs. The solid Ó reads
# heavier than an open O, so R sits a touch closer to it than the font sets it.
KERN_1 = {'OR': -10}
KERN_2 = {}
WEIGHT_1, WEIGHT_2 = 820, 900   # the wide line is set lighter so its stems are 1.15x the condensed line's, not 1.33x
LEAD = 0.14                     # gap between the lines, in cap heights
EYE = 0.25                      # eye radius, as a share of the O's height


def _fit_width():
    """Width-axis value for CZUWA that makes it as wide as BÓR at the same size."""
    wide = _line(_font(125, WEIGHT_1), 'BOR', 1000, hand=KERN_1)[1]
    target, lo, hi = wide[2] - wide[0], 62.0, 125.0
    for _ in range(9):
        mid = (lo + hi) / 2
        b = _line(_font(mid, WEIGHT_2), 'CZUWA', 1000, hand=KERN_2)[1]
        lo, hi = (lo, mid) if b[2] - b[0] > target else (mid, hi)
    return round((lo + hi) / 2, 2)


def logotype(height):
    """The two lines with cap top of BÓR at y=0, baseline of CZUWA at y=height, left edge at x=0."""
    f1, f2 = _font(125, WEIGHT_1), _font(_fit_width(), WEIGHT_2)
    cap = f1[0]['OS/2'].sCapHeight
    size = f1[0]['head'].unitsPerEm * height / (cap * (2 + LEAD))
    base1 = cap * size / f1[0]['head'].unitsPerEm
    d1, b1, xs = _line(f1, 'BOR', size, 0, base1, hand=KERN_1, skip=(1,))
    outer = max(_contours(f1, 'O', size, xs[1], base1), key=lambda p: _bounds(p)[2] - _bounds(p)[0])
    ob = _bounds(outer)
    ocx, ocy, eye_r = (ob[0] + ob[2]) / 2, (ob[1] + ob[3]) / 2, EYE * (ob[3] - ob[1])
    sb = _bounds(''.join(_contours(f1, 'I', size, 0, 0)))
    stem = sb[2] - sb[0]
    # The accent: a bar with flat top and bottom like the ends of the grain lines, leaning 30 degrees.
    ah, aw, gap = 0.19 * base1, 0.72 * stem, 0.075 * base1
    lean = ah * math.tan(math.radians(30))
    ax, ay = ocx - aw / 2 - lean * 0.25, ob[1] - gap
    accent = f"M{n(ax)} {n(ay)}H{n(ax+aw)}L{n(ax+aw+lean)} {n(ay-ah)}H{n(ax+lean)}Z"
    left, width = b1[0], b1[2] - b1[0]
    _, b2, _ = _line(f2, 'CZUWA', size, 0, height, hand=KERN_2)
    d2, b2, _ = _line(f2, 'CZUWA', size, left - b2[0], height, hand=KERN_2, track=(width - (b2[2] - b2[0])) / 4)
    return dict(letters=d1 + accent + d2, o=outer, eye=circle(eye_r, ocx, ocy), x0=left, width=width,
                top=ay - ah, bottom=max(b2[3], height), height=height)


def logotype_parts(theme, L):
    t = THEMES[theme]
    # One colour, and noc (whose action colour is 1.4:1 against its ink): the eye is a hole in the O.
    if t['eye'] is None or t.get('open_o'):
        return [(t['ink'], L['letters'], None), (t['ink'], L['o'] + L['eye'], 'evenodd')]
    return [(t['ink'], L['letters'] + L['o'], None), (t['eye'], L['eye'], None)]


# ---------------------------------------------------------------- files

def paths(parts, dx=0.0, dy=0.0):
    out = []
    for part in parts:
        fill, d = part[0], part[1]
        rule = ' fill-rule="evenodd"' if len(part) > 2 and part[2] else ''
        move = f' transform="translate({n(dx)} {n(dy)})"' if dx or dy else ''
        out.append(f'<path fill="{fill}"{rule}{move} d="{d}"/>')
    return out


def write(rel, box, body, title='Bór czuwa', ground=None):
    x, y = math.floor(box[0]), math.floor(box[1])
    w, h = math.ceil(box[0] + box[2]) - x, math.ceil(box[1] + box[3]) - y
    bg = f'  <rect x="{n(x)}" y="{n(y)}" width="{n(w)}" height="{n(h)}" fill="{ground}"/>\n' if ground else ''
    path = BRAND / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{n(x)} {n(y)} {n(w)} {n(h)}" width="{n(w)}" height="{n(h)}" '
                    f'role="img" aria-labelledby="t">\n  <title id="t">{title}</title>\n{bg}'
                    + ''.join(f'  {p}\n' for p in body) + '</svg>\n')
    return path


def png(svg, rel, width, height=None):
    out = BRAND / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(['magick', '-background', 'none', '-density', '384', str(svg), '-resize', f'{width}x{height or width}',
                    '-strip', str(out)], check=True)


def horizontal(theme, L):
    """Symbol, a knot's width of space, then the logotype between the line ends. Returns body and painted box."""
    x0, y0, x1, y1 = SYMBOL_BOX
    body = paths(symbol_parts(theme)) + paths(logotype_parts(theme, L), x1 + KNOT_D - L['x0'], LINE_ENDS[0])
    return body, (x0, y0, x1 + KNOT_D + L['width'] - x0, y1 - y0)


def stacked(theme, L):
    """Symbol above, a knot's width of space, then the logotype at the symbol's width."""
    x0, y0, x1, y1 = SYMBOL_BOX
    body = paths(symbol_parts(theme)) + paths(logotype_parts(theme, L), x0 - L['x0'], y1 + KNOT_D - L['top'])
    return body, (x0, y0, x1 - x0, y1 + KNOT_D + (L['bottom'] - L['top']) - y0)


def padded(box, pad=KNOT_D):
    x, y, w, h = box
    return (x - pad, y - pad, w + 2 * pad, h + 2 * pad)


def placed(parts_body, box, into, scale_to):
    """Centre a painted box inside a canvas (w, h) at a given width; returns one <g>."""
    x, y, w, h = box
    k = scale_to / w
    tx, ty = (into[0] - w * k) / 2 - x * k, (into[1] - h * k) / 2 - y * k
    return [f'<g transform="translate({n(tx)} {n(ty)}) scale({n(k)})">' + ''.join(parts_body) + '</g>']


def main():
    row = logotype(LINE_ENDS[1] - LINE_ENDS[0])
    probe = logotype(100)
    col = logotype(100 * (SYMBOL_BOX[2] - SYMBOL_BOX[0]) / probe['width'])
    for theme in THEMES:
        write(f'symbol/symbol{theme}.svg', (0, 0, 256, 256), paths(symbol_parts(theme)))
        write(f'logotype/logotype{theme}.svg', padded((row['x0'], row['top'], row['width'], row['bottom'] - row['top']), 12),
              paths(logotype_parts(theme, row)))
        body, box = horizontal(theme, row)
        write(f'lockup/horizontal{theme}.svg', padded(box), body)
        body, box = stacked(theme, col)
        write(f'lockup/stacked{theme}.svg', padded(box), body)
    for theme in ('', '-reversed', '-noc', '-black', '-white'):
        write(f'symbol/symbol-small{theme}.svg', (0, 0, 256, 256), paths(symbol_parts(theme, SMALL)), 'Bór czuwa, small size')

    light, dark = THEMES[''], THEMES['-reversed']
    sym = paths(symbol_parts(''))
    sym_small = paths(symbol_parts('', SMALL))
    sbox = (SYMBOL_BOX[0], SYMBOL_BOX[1], 220, 200)

    # Web icons. The favicon is the small cut on a paper tile so it holds on dark browser chrome.
    fav = write('icons/favicon.svg', (0, 0, 256, 256),
                [f'<rect width="256" height="256" rx="48" fill="{light["ground"]}"/>'] + placed(sym_small, (8, 40, 240, 176), (256, 256), 200))
    subprocess.run(['magick', '-background', 'none', '-density', '384', str(fav), '-define', 'icon:auto-resize=48,32,16',
                    str(BRAND / 'icons/favicon.ico')], check=True)
    icon = write('icons/icon.svg', (0, 0, 512, 512), [f'<rect width="512" height="512" fill="{light["ground"]}"/>'] + placed(sym, sbox, (512, 512), 330))
    for size in (192, 512):
        png(icon, f'icons/icon-{size}.png', size)
    png(icon, 'icons/apple-touch-icon.png', 180)
    mask = write('icons/maskable.svg', (0, 0, 512, 512), [f'<rect width="512" height="512" fill="{light["ground"]}"/>'] + placed(sym, sbox, (512, 512), 270))
    png(mask, 'icons/maskable-512.png', 512)

    # Android adaptive icon, 108 dp canvas, 66 dp safe circle: the symbol's diagonal fits inside it.
    write('android/ic_launcher_foreground.svg', (0, 0, 108, 108), placed(sym, sbox, (108, 108), 48))
    write('android/ic_launcher_background.svg', (0, 0, 108, 108), [f'<rect width="108" height="108" fill="{light["ground"]}"/>'])
    write('android/ic_launcher_monochrome.svg', (0, 0, 108, 108), placed(paths(symbol_parts('-black')), sbox, (108, 108), 48))
    # Android 12 splash: 288 dp canvas, icon inside the 192 dp circle.
    for name, theme in (('splash', ''), ('splash-night', '-reversed')):
        s = write(f'android/{name}.svg', (0, 0, 288, 288), placed(paths(symbol_parts(theme)), sbox, (288, 288), 132))
        png(s, f'android/{name}.png', 1152)

    # Store and sharing.
    png(icon, 'store/play-icon-512.png', 512)
    body, box = horizontal('-reversed', row)
    feature = write('store/feature-graphic.svg', (0, 0, 1024, 500), [f'<rect width="1024" height="500" fill="{dark["ground"]}"/>'] + placed(body, box, (1024, 500), 620))
    png(feature, 'store/feature-graphic-1024x500.png', 1024, 500)
    body, box = horizontal('', row)
    share = write('store/share.svg', (0, 0, 1200, 630), [f'<rect width="1200" height="630" fill="{light["ground"]}"/>'] + placed(body, box, (1200, 630), 700))
    png(share, 'store/share-1200x630.png', 1200, 630)
    print('line 2 width axis:', _fit_width())


if __name__ == '__main__':
    main()
