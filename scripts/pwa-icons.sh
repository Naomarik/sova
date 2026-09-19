#!/usr/bin/env bash
# Regenerates the PWA PNG icons in public/icons/ (needs rsvg-convert).
# "any" icons are /favicon.svg (mark on dark paper, rounded) scaled up. Maskable and
# apple-touch icons are full-bleed --brand-paper-dk with the favicon's mark geometry
# centered well inside the 80% safe zone (mark ≈ 52% of the width).
set -euo pipefail
cd "$(dirname "$0")/.."
out=public/icons
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# favicon mark bbox incl. stroke: x 5.75–26.25, y 9.25–25.25 → centre (16, 17.25). Scale 13 → centre at 256.
cat > "$tmp/full.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><rect width="512" height="512" fill="#1E1E26"/><g transform="translate(48 31.75) scale(13)" fill="none" stroke="#8E88FF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10.5h18"/><path d="M12.5 10.5V24"/><path d="M19.5 10.5V21a3 3 0 0 0 3 3"/></g></svg>
SVG

for s in 192 512; do
  rsvg-convert -w "$s" -h "$s" public/favicon.svg -o "$out/pwa-$s.png"
  rsvg-convert -w "$s" -h "$s" "$tmp/full.svg" -o "$out/pwa-$s-maskable.png"
done
rsvg-convert -w 180 -h 180 "$tmp/full.svg" -o "$out/apple-touch-icon.png"
