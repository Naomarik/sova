#!/bin/sh
# Milestone harness entry: scripts/mesh-lab/e2e.sh m0|m1|m2|m3|m4|all  (= lab e2e <m>)
exec "$(dirname "$(readlink -f "$0")")/lab" e2e "$@"
