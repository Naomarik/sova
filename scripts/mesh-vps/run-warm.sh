#!/usr/bin/env bash
# ON THE VPS: warm jiti's extension cache for ~/sova-mesh/app with ~/sova-mesh/sova-mesh.env (TMPDIR=~/sova-mesh/tmp).
# Run by remote-setup.sh after a build and by the sova-mesh unit (ExecStartPost). See warm-extensions.mjs.
set -euo pipefail
BASE=${SOVA_MESH_BASE:-$HOME/sova-mesh}
set -a
. "$BASE/sova-mesh.env"
set +a
cd "$BASE/app"
exec nice -n 10 node scripts/mesh-vps/warm-extensions.mjs
