#!/usr/bin/env bash
# ON THE VPS: write ~/sova-mesh/Caddyfile from Sova's own GET /api/mesh/front-door (Sova must be running), made
# local-only: the site listens on 127.0.0.1:$FRONTDOOR_PORT (bind 127.0.0.1) and the admin API on $CADDY_ADMIN
# (loopback). `tailscale serve` (set up by the parent) is the only way in. Validated with `caddy validate`;
# a running sova-frontdoor unit is reloaded.
set -euo pipefail
BASE=${SOVA_MESH_BASE:-$HOME/sova-mesh}
FRONTDOOR_PORT=${FRONTDOOR_PORT:-4890}
CADDY_ADMIN=${CADDY_ADMIN:-127.0.0.1:2089}
set -a
. "$BASE/sova-mesh.env"
set +a
json=$(curl -fsS -m 10 "http://127.0.0.1:$PORT/api/mesh/front-door")
node -e '
const [json, port, admin] = process.argv.slice(1);
let text = JSON.parse(json).caddyfile;
if (typeof text !== "string") { console.error("no caddyfile in the answer"); process.exit(1); }
const sites = text.match(/^:\d+ \{$/gm) || [];
if (sites.length !== 1 || !/^\tadmin [^\n]+$/m.test(text)) { console.error("unexpected Caddyfile shape (site/admin lines)"); process.exit(1); }
text = text.replace(/^\tadmin [^\n]+$/m, `\tadmin ${admin}`).replace(/^:\d+ \{$/m, `:${port} {\n\tbind 127.0.0.1`);
process.stdout.write(text);
' "$json" "$FRONTDOOR_PORT" "$CADDY_ADMIN" > "$BASE/Caddyfile.tmp"
XDG_DATA_HOME="$BASE/home/.local/share" XDG_CONFIG_HOME="$BASE/home/.config" \
  "$BASE/bin/caddy" validate --config "$BASE/Caddyfile.tmp" --adapter caddyfile >/dev/null 2>&1 \
  || { echo "caddy validate failed:" >&2; "$BASE/bin/caddy" validate --config "$BASE/Caddyfile.tmp" --adapter caddyfile >&2; exit 1; }
mv "$BASE/Caddyfile.tmp" "$BASE/Caddyfile"
echo "front door: $BASE/Caddyfile (127.0.0.1:$FRONTDOOR_PORT, admin $CADDY_ADMIN); upstreams: $(grep -m1 reverse_proxy "$BASE/Caddyfile" | sed 's/^\s*reverse_proxy //; s/ {$//')"
if systemctl --user is-active --quiet sova-frontdoor.service 2>/dev/null; then
  "$BASE/bin/caddy" reload --config "$BASE/Caddyfile" --adapter caddyfile --address "$CADDY_ADMIN" && echo "reloaded the running front door"
fi
