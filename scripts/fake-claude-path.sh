#!/bin/sh
# Print a directory holding a `claude` shim for scripts/fake-claude.mjs, to put first on PATH:
#   PATH="$(scripts/fake-claude-path.sh):$PATH" pnpm run dev:hermetic
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bin="${TMPDIR:-/tmp}/sova-fake-claude-bin"
mkdir -p "$bin"
printf '#!/bin/sh\nexec node %s "$@"\n' "$here/fake-claude.mjs" > "$bin/claude"
chmod 755 "$bin/claude"
printf '%s\n' "$bin"
