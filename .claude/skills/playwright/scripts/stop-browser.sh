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

if [ "$1" = "--list" ]; then
    found=""
    for pid_file in /tmp/pw-browser-*.pid; do
        [ -f "$pid_file" ] || continue
        port=$(basename "$pid_file" | sed 's/pw-browser-\(.*\)\.pid/\1/')
        pid=$(cat "$pid_file" 2>/dev/null)
        if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
            echo "port $port  pid $pid  ALIVE"
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

PID_FILE="/tmp/pw-browser-$PW_PORT.pid"
USER_DATA_DIR="/tmp/pw-profile-$PW_PORT"

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

if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "Stopping browser on port $PW_PORT (PID: $PID)..."
    kill "$PID"
    for _ in $(seq 1 20); do
        kill -0 "$PID" 2>/dev/null || break
        sleep 0.25
    done
    kill -9 "$PID" 2>/dev/null || true
    cleanup_files
    echo "Browser stopped"
else
    echo "Browser not running (stale PID file)"
    cleanup_files
fi
