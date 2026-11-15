#!/usr/bin/env python3
"""Build the Android launcher and splash resources from the layers in brand/android."""
from pathlib import Path
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / 'brand/android'
RES = ROOT / 'android/app/src/main/res'
NS = '{http://www.w3.org/2000/svg}'


def layer(name):
    """Return the drawing's size and its group transform, if any, with its paths."""
    root = ET.parse(BRAND / name).getroot()
    size = int(float(root.get('width')))
    group = root.find(f'{NS}g')
    transform = None
    if group is not None:
        numbers = lambda word: [float(v) for v in re.search(word + r'\(([^)]*)\)', group.get('transform')).group(1).split()]
        transform = (numbers('translate'), numbers('scale')[0])
    return size, transform, root.findall(f'.//{NS}path')


def vector(name):
    size, transform, paths = layer(name)
    shapes = '\n'.join(f'    <path android:pathData="{p.get("d")}" android:fillColor="{p.get("fill")}"/>' for p in paths)
    if transform:
        (x, y), scale = transform
        shapes = (f'  <group android:scaleX="{scale}" android:scaleY="{scale}" android:translateX="{x}" android:translateY="{y}">\n'
                  f'{shapes}\n  </group>')
    return (f'<vector xmlns:android="http://schemas.android.com/apk/res/android"\n'
            f'    android:width="{size}dp" android:height="{size}dp"\n'
            f'    android:viewportWidth="{size}" android:viewportHeight="{size}">\n{shapes}\n</vector>\n')


(RES / 'drawable-v24/ic_launcher_foreground.xml').write_text(vector('ic_launcher_foreground.svg'))
(RES / 'drawable-v24/ic_launcher_monochrome.xml').write_text(vector('ic_launcher_monochrome.svg'))
(RES / 'drawable/splash_icon.xml').write_text(vector('splash.svg'))
(RES / 'drawable-night').mkdir(exist_ok=True)
(RES / 'drawable-night/splash_icon.xml').write_text(vector('splash-night.svg'))

# Legacy icons (API 24-25) are cut from the 72 units an adaptive icon shows, on the paper ground.
inner = lambda name: (BRAND / name).read_text().split('>', 1)[1].rsplit('</svg>', 1)[0]
with tempfile.TemporaryDirectory(prefix='bor-czuwa-') as temporary:
    panel = Path(temporary) / 'launcher.svg'
    background = re.search(r'fill="(#[0-9a-f]{6})"', (BRAND / 'ic_launcher_background.svg').read_text()).group(1)
    panel.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72">'
                     f'<rect width="108" height="108" fill="{background}"/>'
                     + re.sub(r'<title.*?</title>', '', inner('ic_launcher_foreground.svg'), flags=re.S) + '</svg>')
    for density, pixels in [('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)]:
        directory = RES / f'mipmap-{density}'
        subprocess.run(['magick', '-density', '384', '-background', 'none', str(panel), '-resize', f'{pixels}x{pixels}',
                        '-strip', str(directory / 'ic_launcher.png')], check=True)
        subprocess.run(['magick', str(directory / 'ic_launcher.png'),
                        '(', '+clone', '-alpha', 'extract', '-fill', 'black', '-colorize', '100',
                        '-fill', 'white', '-draw', f'circle {pixels/2},{pixels/2} {pixels/2},0', ')',
                        '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', '-strip',
                        str(directory / 'ic_launcher_round.png')], check=True)
