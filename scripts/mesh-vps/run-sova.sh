#!/usr/bin/env bash
# ON THE VPS: run Sova from ~/sova-mesh/app with ~/sova-mesh/sova-mesh.env (the user unit's ExecStart; the smoke uses it too).
# Main listener 127.0.0.1:$PORT; peer listener $SOVA_PEER_HOST:$SOVA_PEER_PORT (only while peers.json lists a peer).
# On the app's own Bun (SOVA_BUN in the env file), or on Node when the env file says SOVA_RUNTIME=node.
set -euo pipefail
BASE=${SOVA_MESH_BASE:-$HOME/sova-mesh}
set -a
. "$BASE/sova-mesh.env"
set +a
cd "$BASE/app"
exec scripts/start-server.sh
