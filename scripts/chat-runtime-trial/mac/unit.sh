#!/bin/zsh
# The darwin unit checks of stage 5 (stage5-design.md B-F1, item G): per-chat code copies (clonefile on
# APFS, hardlinked node_modules), Sova's extensions mapped into a copy (realpaths: /var is
# /private/var), the supervisor, the writer lock, the chat host, the project-services drivers (the detached
# driver's process groups and its stop of a reused pid, the darwin ps table; its integration file runs real
# processes, detached only, no systemd) and the chat workers, run on a Mac; and from stage 6: the worker feed
# and worker sessions after the legacy registry fold (D3), a stop's own writes (#5: the writer lock's start
# time is ps's on darwin) and the test runner's cleanup when it is killed (#11b: process groups).
#   zsh -lc 'cd <scratch checkout> && scripts/chat-runtime-trial/mac/unit.sh [more test files…]'
# From a scratch checkout with its node_modules installed, never the Mac's live Sova. It runs the files
# through the repo's runner (a throwaway home per file, the tier guard) on bun 1.4.2, with a short temp
# dir under /private/tmp (socket paths stay short; os.tmpdir() on darwin is a deep /var/folders path),
# removed at the end. Nothing here names the machine. Exit status: the runner's.
set -eu
cd "$(dirname "$0")/../../.."
[ "$(uname -s)" = Darwin ] || echo "mac/unit.sh: not a Mac ($(uname -s)); running anyway" >&2
ulimit -n 8192 2>/dev/null || ulimit -n "$(ulimit -Hn)"
base=/private/tmp; [ -d "$base" ] || base=${TMPDIR:-/tmp}
scratch=$(mktemp -d "$base/sova-u.XXXXXX")
trap 'chmod -R u+w "$scratch" 2>/dev/null; rm -rf "$scratch"' EXIT INT TERM
export TMPDIR="$scratch"
files=(
  server/chat-runtime/generations.test.ts
  server/harness/pi/own-code.test.ts
  server/harness/pi/contract.test.ts
  server/chat-runtime/rollout.test.ts
  server/chat-runtime/supervisor.test.ts
  server/chat-runtime/writer-lock.test.ts
  server/chat-host.test.ts
  server/project-services/drivers.test.ts
  server/project-services/drivers.integration.test.ts
  server/chat-workers.test.ts
  server/chat-runtime/worker-feed.test.ts
  server/worker-sessions.test.ts
  server/shutdown-own-writes.test.ts
  scripts/run-tests.integration.test.ts
  "$@"
)
echo "mac/unit.sh: $(uname -sm), $(sw_vers -productVersion 2>/dev/null || echo '?'), commit $(git rev-parse --short HEAD 2>/dev/null || cat .trial-rev 2>/dev/null || echo '?'), TMPDIR $TMPDIR"
# mise is not always on a login PATH: its usual install place, then its shims.
command -v mise >/dev/null 2>&1 || export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
if command -v mise >/dev/null 2>&1; then
  run=(mise exec bun@1.4.2 -- node scripts/run-tests.mjs --runtime bun "${files[@]}")
else
  run=(node scripts/run-tests.mjs --runtime bun "${files[@]}")
fi
# The run in a process group of its own (perl setpgrp: darwin has no setsid or GNU timeout), stopped
# whole after UNIT_SH_LIMIT_S (default 900) or when this script ends: TERM first (run-tests then kills
# each file's bun group), KILL after 10 s. A timeout around this script that killed only it left a
# bun test running on before.
limit=${UNIT_SH_LIMIT_S:-900}
perl -e 'setpgrp(0, 0); exec @ARGV or die "exec: $!"' -- "${run[@]}" &
pg=$!
# /bin/kill: a group is signalled as -<pgid> (zsh's builtin may read that as a job).
stop_group() {
  /bin/kill -s TERM -- -$pg 2>/dev/null || return 0
  for _ in 1 2 3 4 5 6 7 8 9 10; do /bin/kill -0 -- -$pg 2>/dev/null || return 0; sleep 1; done
  /bin/kill -s KILL -- -$pg 2>/dev/null || true
}
# The watchdog checks each second, so it ends with the run and leaves no long sleep behind.
( i=0; while [ $i -lt "$limit" ]; do sleep 1; i=$((i + 1)); /bin/kill -0 -- -$pg 2>/dev/null || exit 0; done
  echo "mac/unit.sh: still running after $limit s; stopping the run" >&2; stop_group ) &
dog=$!
trap 'kill $dog 2>/dev/null; stop_group; chmod -R u+w "$scratch" 2>/dev/null; rm -rf "$scratch"' EXIT
trap 'exit 130' INT TERM HUP
set +e
wait $pg
code=$?
set -e
kill $dog 2>/dev/null || true
exit $code
