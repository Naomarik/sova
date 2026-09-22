#!/usr/bin/env bash
# Regenerates the PWA PNG icons in public/icons/ (needs rsvg-convert).
# "any" icons are /favicon.svg (Sova mark on dark paper, rounded) scaled up. Maskable and
# apple-touch icons are full-bleed --brand-paper-dk with the mark geometry centered well
# inside the 80% safe zone (mark ≈ 52% of the width).
set -euo pipefail
cd "$(dirname "$0")/.."
out=public/icons
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Sova mark bbox incl. stroke: x 2–30, y 5–27 → centre (16, 16). Scale 9.5 → mark 266px wide
# (≈52% of 512), centred at 256; translate = 256 − 16 × 9.5.
cat > "$tmp/full.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" fill="#1E1E26"/><g transform="translate(104 104) scale(9.5)" fill="none" stroke="#8E88FF" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7L12 25L20 7L28 25M15.6 17H24.4"/></g></svg>
SVG

for s in 192 512; do
  rsvg-convert -w "$s" -h "$s" public/favicon.svg -o "$out/pwa-$s.png"
  rsvg-convert -w "$s" -h "$s" "$tmp/full.svg" -o "$out/pwa-$s-maskable.png"
done
rsvg-convert -w 180 -h 180 "$tmp/full.svg" -o "$out/apple-touch-icon.png"
