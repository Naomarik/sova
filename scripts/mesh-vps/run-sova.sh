#!/usr/bin/env bash
# ON THE VPS: run Sova from ~/sova-mesh/app with ~/sova-mesh/sova-mesh.env (the user unit's ExecStart; the smoke uses it too).
# Main listener 127.0.0.1:$PORT; peer listener $SOVA_PEER_HOST:$SOVA_PEER_PORT (only while peers.json lists a peer).
set -euo pipefail
BASE=${SOVA_MESH_BASE:-$HOME/sova-mesh}
set -a
. "$BASE/sova-mesh.env"
set +a
cd "$BASE/app"
exec node --import tsx server/index.ts
