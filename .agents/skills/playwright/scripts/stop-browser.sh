#!/bin/bash
# Stop the Playwright browser
#
#   PW_PORT=<port> ./stop-browser.sh   stop only YOUR browser (isolated mode)
#   ./stop-browser.sh                  stop the shared browser for this directory
#   ./stop-browser.sh --list           show every browser this skill started
#
# There is deliberately no --all: other agents' browsers look exactly like
# leaked ones, and killing theirs mid-run is the failure this design exists to
# prevent. Stop your own port; use --list to see what else is alive.

PORT_FILE="$PWD/.playwright-port"
FROM_PORT_FILE=""
# Pid files and profiles: ${TMPDIR:-/tmp} (start-browser.sh), and /tmp for browsers started
# before they moved there.
PW_TMP="${TMPDIR:-/tmp}"
PW_TMP="${PW_TMP%/}"
PW_DIRS=("$PW_TMP")
[ "$PW_TMP" != "/tmp" ] && PW_DIRS+=("/tmp")

# Alive? A browser started by another sandboxed bash call cannot be signalled from
# this one (Seatbelt allows signals only within the same sandbox): EPERM, yet alive.
pid_alive() {
    [ -n "$1" ] || return 1
    local err
    err=$(kill -0 "$1" 2>&1) && return 0
    case "$err" in *"not permitted"*) return 0 ;; esac
    return 1
}

# Close the browser over CDP (Browser.close), for when a signal is refused.
cdp_close() {
    command -v node >/dev/null 2>&1 || return 1
    node --input-type=module -e '
const port = process.argv[1];
const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
await new Promise((ok) => { ws.onclose = ok; ws.onmessage = ok; setTimeout(ok, 3000); });
process.exit(0);
' "$PW_PORT" >/dev/null 2>&1
}

if [ "$1" = "--list" ]; then
    found=""
    for pid_file in $(for d in "${PW_DIRS[@]}"; do ls "$d"/pw-browser-*.pid 2>/dev/null; done); do
        [ -f "$pid_file" ] || continue
        port=$(basename "$pid_file" | sed 's/pw-browser-\(.*\)\.pid/\1/')
        pid=$(cat "$pid_file" 2>/dev/null)
        if pid_alive "$pid"; then
            echo "port $port  pid $pid  ALIVE  ($pid_file)"
        else
            echo "port $port  pid ${pid:-?}  stale pid file"
        fi
        found="yes"
    done
    [ -z "$found" ] && echo "No browsers started by this skill."
    exit 0
fi

if [ -n "$PW_PORT" ]; then
    :
elif [ -f "$PORT_FILE" ]; then
    PW_PORT=$(cat "$PORT_FILE")
    FROM_PORT_FILE="yes"
else
    echo "Error: PW_PORT is not set and no .playwright-port file exists here."
    echo "  Nothing to stop, or you meant: PW_PORT=<your port> $0"
    exit 1
fi

PW_DIR="$PW_TMP"
for d in "${PW_DIRS[@]}"; do
    if [ -f "$d/pw-browser-$PW_PORT.pid" ]; then PW_DIR="$d"; break; fi
done
PID_FILE="$PW_DIR/pw-browser-$PW_PORT.pid"
USER_DATA_DIR="$PW_DIR/pw-profile-$PW_PORT"

# Only remove the shared port file when that's where our port came from.
# When PW_PORT was passed explicitly the file belongs to somebody else, and
# deleting it breaks every other agent working in this directory.
cleanup_files() {
    rm -f "$PID_FILE"
    rm -rf "$USER_DATA_DIR"
    [ -n "$FROM_PORT_FILE" ] && rm -f "$PORT_FILE"
    return 0
}

if [ ! -f "$PID_FILE" ]; then
    echo "No browser PID file found for port $PW_PORT"
    cleanup_files
    exit 0
fi

PID=$(cat "$PID_FILE")

if pid_alive "$PID"; then
    echo "Stopping browser on port $PW_PORT (PID: $PID)..."
    kill "$PID" 2>/dev/null || cdp_close || true
    for _ in $(seq 1 20); do
        pid_alive "$PID" || break
        sleep 0.25
    done
    kill -9 "$PID" 2>/dev/null || true
    # Still "alive" with nothing on its CDP port: a reused pid that isn't ours.
    if pid_alive "$PID" && curl -s "http://127.0.0.1:$PW_PORT/json/version" &>/dev/null; then
        echo "Error: browser $PID on port $PW_PORT did not stop; its pid file and profile are kept."
        exit 1
    fi
    cleanup_files
    if pid_alive "$PID"; then echo "Nothing on port $PW_PORT; PID $PID is not this browser (stale PID file)"; else echo "Browser stopped"; fi
else
    echo "Browser not running (stale PID file)"
    cleanup_files
fi
