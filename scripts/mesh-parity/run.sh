#!/bin/sh
# The one command: baseline master 5e0ff37 (--base <rev> for another) vs HEAD of `mesh` (mesh off). Exit 0 = parity green; otherwise the
# diff report is under ~/.cache/sova-mesh/qa-reviewer/runs/<stamp>/report.md. Extra arguments are
# passed through (see parity.mjs: --mesh <rev>, --aa, --patch canary.diff, --only …).
# The expected mesh-ui counts are the data-mesh-ui roots the mesh UI adds per screen: the home Mesh
# card (also behind the Settings and New Session dialogs) and the Settings Mesh tab.
NODE=${NODE:-$(command -v node)} || { echo "run.sh: no node on PATH (or set NODE)" >&2; exit 1; }
exec "$NODE" "$(dirname "$0")/parity.mjs" \
  --expect-mesh-ui home-desktop=1,home-mobile=1,settings=2,new-session=1,sid-gone=1 "$@"
