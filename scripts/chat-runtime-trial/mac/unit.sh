#!/bin/zsh
# The darwin unit checks of stage 5 (stage5-design.md B-F1, item G): per-chat code copies (clonefile on
# APFS, hardlinked node_modules), Sova's extensions mapped into a copy (realpaths: /var is
# /private/var), the supervisor, the writer lock and the chat host, run on a Mac.
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
  "$@"
)
echo "mac/unit.sh: $(uname -sm), $(sw_vers -productVersion 2>/dev/null || echo '?'), commit $(git rev-parse --short HEAD 2>/dev/null || cat .trial-rev 2>/dev/null || echo '?'), TMPDIR $TMPDIR"
# mise is not always on a login PATH: its usual install place, then its shims.
command -v mise >/dev/null 2>&1 || export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
if command -v mise >/dev/null 2>&1; then
  mise exec bun@1.4.2 -- node scripts/run-tests.mjs --runtime bun "${files[@]}"
else
  node scripts/run-tests.mjs --runtime bun "${files[@]}"
fi
