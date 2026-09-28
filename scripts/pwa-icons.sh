#!/usr/bin/env bash
# Regenerates the PWA PNG icons in public/icons/ (needs rsvg-convert).
# "any" icons are /favicon.svg (white Sova mark on the Indigo dusk gradient, rounded) scaled
# up. Maskable and apple-touch icons are the full-bleed Indigo dusk gradient (#4A43D8 → #1E1A5C,
# top-left to bottom-right) with the favicon's mark (white middle band, lavender legs shading
# toward the folds) centered well inside the 80% safe zone (mark ≈ 50% of the width). The
# notification badge (Android's status bar) is the mark alone, white on transparent, its legs
# shaded in alpha as in the sidebar: the system tints it and reads only its alpha.
set -euo pipefail
cd "$(dirname "$0")/.."
out=public/icons
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Sova mark bbox: x 2.5–29.5, y 6–26 → centre (16, 16). Scale 9.5 → mark 256.5px wide
# (≈50% of 512), centred at 256; translate = 256 − 16 × 9.5. Its farthest corner sits 160px from
# the centre, inside the safe zone's 205px radius.
cat > "$tmp/full.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><defs><linearGradient id="sova-dusk" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4A43D8"/><stop offset="1" stop-color="#1E1A5C"/></linearGradient><linearGradient id="sova-fold-l" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="26"><stop offset="0" stop-color="#ECEAFF"/><stop offset="1" stop-color="#ADA7F5"/></linearGradient><linearGradient id="sova-fold-r" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="26"><stop offset="0" stop-color="#ADA7F5"/><stop offset="1" stop-color="#ECEAFF"/></linearGradient></defs><rect width="512" height="512" fill="url(#sova-dusk)"/><g transform="translate(104 104) scale(9.5)"><g transform="translate(0.5 0)"><polygon fill="url(#sova-fold-l)" points="2,6 8,6 15,26 9,26"/><polygon fill="url(#sova-fold-r)" points="16,6 22,6 29,26 23,26"/><polygon fill="#FFFFFF" points="9,26 15,26 22,6 16,6"/></g></g></svg>
SVG

for s in 192 512; do
  rsvg-convert -w "$s" -h "$s" public/favicon.svg -o "$out/pwa-$s.png"
  rsvg-convert -w "$s" -h "$s" "$tmp/full.svg" -o "$out/pwa-$s-maskable.png"
done
rsvg-convert -w 180 -h 180 "$tmp/full.svg" -o "$out/apple-touch-icon.png"

# Badge: 96×96, the mark scaled 2.5 (≈68 px wide) and centred: translate = 48 − 16 × 2.5.
cat > "$tmp/badge.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96"><defs><linearGradient id="sova-fold-l" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="26"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".85"/><stop offset="1" stop-color="#FFFFFF" stop-opacity=".5"/></linearGradient><linearGradient id="sova-fold-r" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="26"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".5"/><stop offset="1" stop-color="#FFFFFF" stop-opacity=".85"/></linearGradient></defs><g transform="translate(8 8) scale(2.5)"><g transform="translate(0.5 0)"><polygon fill="url(#sova-fold-l)" points="2,6 8,6 15,26 9,26"/><polygon fill="url(#sova-fold-r)" points="16,6 22,6 29,26 23,26"/><polygon fill="#FFFFFF" points="9,26 15,26 22,6 16,6"/></g></g></svg>
SVG
rsvg-convert -w 96 -h 96 "$tmp/badge.svg" -o "$out/badge-96.png"
