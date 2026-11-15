#!/usr/bin/env bash
# Cuts the landing's two Archivo files out of the brand's variable font (brand/src/fonts, OFL).
# The landing sets Archivo in two styles only: 850 at 80% width (headlines, step numbers) and 800 at
# normal width (section headings). Each is pinned as a static instance and cut to the Latin that
# Polish and English need, then saved as WOFF2. Needs fonttools and brotli:
#   python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
#   PYTHON=/tmp/ft/bin/python landing/scripts/subset-archivo.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
source_font="$here/../brand/src/fonts/Archivo[wdth,wght].ttf"
out="$here/src/lib/fonts"
python="${PYTHON:-python3}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$out"

# Basic Latin, Latin-1, the Polish letters, and the quotes, dashes and dots the copy uses.
unicodes='U+0020-007E,U+00A0-00FF,U+0104-0107,U+0118-0119,U+0141-0144,U+015A-015B,U+0179-017C,U+2013-2014,U+2018-201E,U+2022,U+2026,U+2032-2033'

cut() { # weight width name
  "$python" -m fontTools.varLib.instancer "$source_font" "wght=$1" "wdth=$2" --static -q -o "$tmp/$3.ttf"
  "$python" -m fontTools.subset "$tmp/$3.ttf" --unicodes="$unicodes" --layout-features='kern,liga,calt,ccmp,locl,mark,mkmk' \
    --flavor=woff2 --desubroutinize --output-file="$out/$3.woff2"
}
cut 850 80 archivo-850-80
cut 800 100 archivo-800-100
ls -l "$out"
