#!/usr/bin/env bash
# Regenerates the PWA PNG icons in public/icons/ (needs rsvg-convert).
# "any" icons are /favicon.svg (white Sova mark on the Indigo dusk gradient, rounded) scaled
# up. Maskable and apple-touch icons are the full-bleed Indigo dusk gradient (#4A43D8 → #1E1A5C,
# top-left to bottom-right) with the white mark centered well inside the 80% safe zone
# (mark ≈ 52% of the width).
set -euo pipefail
cd "$(dirname "$0")/.."
out=public/icons
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Sova mark bbox incl. stroke: x 2–30, y 5–27 → centre (16, 16). Scale 9.5 → mark 266px wide
# (≈52% of 512), centred at 256; translate = 256 − 16 × 9.5.
cat > "$tmp/full.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><defs><linearGradient id="sova-dusk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4A43D8"/><stop offset="1" stop-color="#1E1A5C"/></linearGradient></defs><rect width="512" height="512" fill="url(#sova-dusk)"/><g transform="translate(104 104) scale(9.5)" fill="none" stroke="#FFFFFF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7L12 25L20 7L28 25M15.6 17H24.4"/></g></svg>
SVG

for s in 192 512; do
  rsvg-convert -w "$s" -h "$s" public/favicon.svg -o "$out/pwa-$s.png"
  rsvg-convert -w "$s" -h "$s" "$tmp/full.svg" -o "$out/pwa-$s-maskable.png"
done
rsvg-convert -w 180 -h 180 "$tmp/full.svg" -o "$out/apple-touch-icon.png"
