#!/bin/bash
# Thin wrapper for Playwright CDP client
#
# Usage:
#   ./pw.sh navigate https://example.com
#   ./pw.sh snapshot
#   ./pw.sh click e5
#   ./pw.sh type e3 "hello world"
#
# Which browser this talks to:
#   PW_PORT=<port>   explicit — your own browser, safe with concurrent agents
#   (unset)          falls back to $PWD/.playwright-port, which is SHARED by
#                    everything running in this directory
# No MCP, no SSE transport, no HTTP server. Simple command interface.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_FILE="$PWD/.playwright-port"

# Read port from PW_PORT env var, else the shared .playwright-port
if [ -n "$PW_PORT" ]; then
    :
elif [ -f "$PORT_FILE" ]; then
    PW_PORT=$(cat "$PORT_FILE")
    echo "WARNING: PW_PORT not set — falling back to the SHARED browser on port $PW_PORT" >&2
    echo "         (from .playwright-port). Anything else running in this directory" >&2
    echo "         drives the same tab. If you started your own browser, you forgot" >&2
    echo "         to prefix PW_PORT=<your port> on this command." >&2
else
    echo "Error: PW_PORT is not set and no .playwright-port file exists here."
    echo "  Start your own browser:  $SCRIPT_DIR/start-browser.sh --headless"
    echo "  then pass the port it prints on every command:  PW_PORT=<port> $(basename "$0") <command>"
    exit 1
fi

export PW_PORT

# Check if the browser we were asked for is running.
# Deliberately no "found another browser, use that one" fallback: with several
# agents in one directory that silently hijacks someone else's session.
if ! curl -s "http://localhost:$PW_PORT/json/version" &>/dev/null; then
    echo "Error: No browser running on port $PW_PORT"
    echo "  Start your own:  $SCRIPT_DIR/start-browser.sh --headless"
    echo "  (it prints a PW_PORT to pass on every subsequent command)"
    exit 1
fi

# Ensure Node can resolve the bare `playwright` / `sharp` imports in pw-client.mjs.
# ESM resolution walks up from the importing file, not $PWD, so we symlink
# $SCRIPT_DIR/node_modules to the nearest node_modules that contains playwright
# (searching upward from $PWD).
PROJECT_NM=""
dir="$PWD"
while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    if [ -d "$dir/node_modules/playwright" ]; then
        PROJECT_NM="$dir/node_modules"
        break
    fi
    dir=$(dirname "$dir")
done

if [ -z "$PROJECT_NM" ]; then
    # The skill ships its own pinned install; a project that has no playwright of its own uses
    # that one rather than being sent away to install a second copy beside it.
    if [ -d "$SCRIPT_DIR/node_modules/playwright" ]; then
        PROJECT_NM="$SCRIPT_DIR/node_modules"
    else
        echo "Error: could not find node_modules/playwright walking up from $PWD"
        echo "  Install playwright locally: npm install playwright sharp"
        exit 1
    fi
fi

# Created atomically (temp symlink + mv -T): concurrent agents would otherwise
# race between rm and ln, leaving a window where the import fails.
SCRIPT_NM="$SCRIPT_DIR/node_modules"
if [ "$PROJECT_NM" = "$SCRIPT_NM" ]; then
    : # already this skill's own install: nothing to link
elif [ -e "$SCRIPT_NM" ] && [ ! -L "$SCRIPT_NM" ]; then
    echo "Warning: $SCRIPT_NM exists and is not a symlink; leaving untouched" >&2
elif [ "$(readlink "$SCRIPT_NM" 2>/dev/null)" != "$PROJECT_NM" ]; then
    TMP_NM="$SCRIPT_DIR/.node_modules.$$"
    ln -s "$PROJECT_NM" "$TMP_NM"
    mv -T "$TMP_NM" "$SCRIPT_NM" 2>/dev/null || rm -f "$TMP_NM"
fi

# Pass all arguments to the Node.js CDP client
exec node "$SCRIPT_DIR/pw-client.mjs" "$@"
