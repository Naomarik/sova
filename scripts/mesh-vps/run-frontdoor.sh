#!/usr/bin/env bash
# ON THE VPS: run the Caddy front door on ~/sova-mesh/Caddyfile (127.0.0.1 only; see frontdoor-config.sh).
# The sova-frontdoor user unit's ExecStart. Caddy's data/config dirs stay inside ~/sova-mesh/home.
set -euo pipefail
BASE=${SOVA_MESH_BASE:-$HOME/sova-mesh}
export XDG_DATA_HOME="$BASE/home/.local/share" XDG_CONFIG_HOME="$BASE/home/.config"
exec "$BASE/bin/caddy" run --config "$BASE/Caddyfile" --adapter caddyfile
