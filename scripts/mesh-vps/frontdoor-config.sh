#!/usr/bin/env bash
# ON THE VPS: write ~/sova-mesh/Caddyfile from Sova's own GET /api/mesh/front-door (Sova must be running), made
# local-only: the site listens on 127.0.0.1:$FRONTDOOR_PORT and the admin API on $CADDY_ADMIN (loopback).
# `tailscale serve` (set up by the parent) is the only way in. Sova's Caddyfile takes its listen address from
# Caddy's environment (SOVA_FRONT_DOOR_BIND, SOVA_FRONT_DOOR_PORT); Caddy expands those when it ADAPTS the file,
# which for validate/adapt/reload is this process, so they are exported here as in the unit. The adapted config
# must listen on 127.0.0.1:$FRONTDOOR_PORT only; a running sova-frontdoor unit is reloaded.
set -euo pipefail
BASE=${SOVA_MESH_BASE:-$HOME/sova-mesh}
FRONTDOOR_PORT=${FRONTDOOR_PORT:-4890}
CADDY_ADMIN=${CADDY_ADMIN:-127.0.0.1:2089}
set -a
. "$BASE/sova-mesh.env"
set +a
export SOVA_FRONT_DOOR_BIND=127.0.0.1 SOVA_FRONT_DOOR_PORT=$FRONTDOOR_PORT
# Caddy keeps its data/config dirs inside ~/sova-mesh/home (for Caddy only: they would mislead other tools)
caddy() { XDG_DATA_HOME="$BASE/home/.local/share" XDG_CONFIG_HOME="$BASE/home/.config" "$BASE/bin/caddy" "$@"; }
json=$(curl -fsS -m 10 "http://127.0.0.1:$PORT/api/mesh/front-door")
node -e '
const [json, port, admin] = process.argv.slice(1);
let text = JSON.parse(json).caddyfile;
if (typeof text !== "string") { console.error("no caddyfile in the answer"); process.exit(1); }
const envSite = text.match(/^:\{\$SOVA_FRONT_DOOR_PORT:80\} \{$/gm) || [];
const portSite = text.match(/^:\d+ \{$/gm) || [];
if (envSite.length + portSite.length !== 1 || !/^\tadmin [^\n]+$/m.test(text)) { console.error("unexpected Caddyfile shape (site/admin lines)"); process.exit(1); }
if (envSite.length && !/^\tdefault_bind \{\$SOVA_FRONT_DOOR_BIND\}$/m.test(text)) { console.error("unexpected Caddyfile shape (no default_bind)"); process.exit(1); }
text = text.replace(/^\tadmin [^\n]+$/m, `\tadmin ${admin}`);
// an older Sova wrote a fixed ":80 {": rebind that site by hand
if (portSite.length) text = text.replace(/^:\d+ \{$/m, `:${port} {\n\tbind 127.0.0.1`);
process.stdout.write(text);
' "$json" "$FRONTDOOR_PORT" "$CADDY_ADMIN" > "$BASE/Caddyfile.tmp"
caddy validate --config "$BASE/Caddyfile.tmp" --adapter caddyfile >/dev/null 2>&1 \
  || { echo "caddy validate failed:" >&2; caddy validate --config "$BASE/Caddyfile.tmp" --adapter caddyfile >&2; exit 1; }
# the adapted config: every site listener and the admin API on loopback, nothing else
listen=$(caddy adapt --config "$BASE/Caddyfile.tmp" --adapter caddyfile 2>/dev/null | node -e '
const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
const l = Object.values(c.apps?.http?.servers ?? {}).flatMap((s) => s.listen ?? []);
console.log([...l, "admin=" + (c.admin?.listen ?? "")].join(" "));')
[ "$listen" = "127.0.0.1:$FRONTDOOR_PORT admin=$CADDY_ADMIN" ] || { echo "front door would listen on: $listen (want 127.0.0.1:$FRONTDOOR_PORT admin=$CADDY_ADMIN)" >&2; exit 1; }
mv "$BASE/Caddyfile.tmp" "$BASE/Caddyfile"
echo "front door: $BASE/Caddyfile (127.0.0.1:$FRONTDOOR_PORT, admin $CADDY_ADMIN); upstreams: $(grep -m1 reverse_proxy "$BASE/Caddyfile" | sed 's/^\s*reverse_proxy //; s/ {$//')"
if systemctl --user is-active --quiet sova-frontdoor.service 2>/dev/null; then
  caddy reload --config "$BASE/Caddyfile" --adapter caddyfile --address "$CADDY_ADMIN" && echo "reloaded the running front door"
fi
