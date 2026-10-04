#!/bin/sh
# Start the Sova server on Bun, or on Node when asked for (§app.server-runtime).
#
#   scripts/start-server.sh                 # what a service unit's ExecStart runs: bun
#   scripts/start-server.sh --node          # node (the server then sees SOVA_RUNTIME=node)
#   SOVA_RUNTIME=node scripts/start-server.sh
#
# Node only on --node (first argument) or SOVA_RUNTIME=node; anything else is Bun. Bun is
# $SOVA_BUN, else bun on PATH, else `mise which bun`. Bun missing is an error (exit 1), never Node.
# The decision lives in server/runtime-choice.ts, run by plain node here; SOVA_NODE names that node.
# The server replaces this shell (exec), so a service manager's main pid is the server's.
set -eu

cd "$(dirname "$0")/.."
node_bin=${SOVA_NODE:-node}

if [ "${1:-}" = --node ]; then
  shift
  SOVA_RUNTIME=node
  export SOVA_RUNTIME
fi

decision=$("$node_bin" server/runtime-choice.ts launch) || exit 1
runtime=$(printf '%s\n' "$decision" | sed -n 1p)
bun_bin=$(printf '%s\n' "$decision" | sed -n 2p)

if [ "$runtime" = bun ]; then
  exec "$bun_bin" server/index.ts "$@"
fi
exec "$node_bin" --import tsx server/index.ts "$@"
