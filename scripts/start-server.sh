#!/bin/sh
# Start the Sova server on the chosen runtime, Node or Bun (§app.server-runtime).
#
#   scripts/start-server.sh                 # what a service unit's ExecStart runs
#   SOVA_RUNTIME=bun scripts/start-server.sh
#
# The choice: $SOVA_RUNTIME (node|bun), else <agent dir>/sova/runtime.json {"runtime": ...},
# else node. Bun is $SOVA_BUN, else bun on PATH, else `mise which bun`. Bun missing, or three Bun
# boots in a row that never listened, start Node and write <agent dir>/sova/runtime-fallback.json.
# The decision (and its counter) lives in server/runtime-choice.ts, run by plain node here.
# The server replaces this shell (exec), so a service manager's main pid is the server's.
set -eu

cd "$(dirname "$0")/.."
node_bin=${SOVA_NODE:-node}

decision=$("$node_bin" server/runtime-choice.ts launch) || decision=node
runtime=$(printf '%s\n' "$decision" | sed -n 1p)
bun_bin=$(printf '%s\n' "$decision" | sed -n 2p)

if [ "$runtime" = bun ] && [ -n "$bun_bin" ]; then
  exec "$bun_bin" server/index.ts "$@"
fi
exec "$node_bin" --import tsx server/index.ts "$@"
