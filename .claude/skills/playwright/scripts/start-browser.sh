#!/bin/bash
# Start Chromium with CDP (Chrome DevTools Protocol) enabled
#
# Two modes:
#
#   (default)    Isolated. A fresh port for THIS caller only; nothing is written
#                to the working directory, so any number of agents can run
#                concurrently in the same cwd without touching each other.
#                The port is printed — pass it back as PW_PORT on every command.
#
#   --shared     Opt in to the legacy shared browser: the port lives in
#                $PWD/.playwright-port and every caller in this directory drives
#                the SAME browser and the SAME tab. Convenient solo, actively
#                broken with concurrent agents. Isolation is the default
#                precisely because it must not depend on remembering a flag.
#
# Usage:
#   ./start-browser.sh --headless              # isolated (recommended)
#   ./start-browser.sh                         # isolated, GUI
#   ./start-browser.sh --shared --headless     # legacy shared browser
#   ./stop-browser.sh --list                   # list every browser this skill started
#
# Pid files and profiles live in ${TMPDIR:-/tmp}. Inside a macOS Seatbelt sandbox
# (Sova's), where a literal /tmp is not writable, --headless runs Playwright's
# chrome-headless-shell with --no-sandbox; nothing else can run there.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT_FILE="$PWD/.playwright-port"
# Pid files and profiles: the caller's TMPDIR (a sandbox's own tmp), else /tmp as before.
PW_TMP="${TMPDIR:-/tmp}"
PW_TMP="${PW_TMP%/}"

# Confined in a macOS Seatbelt sandbox? Seatbelt cannot nest, so there even an
# allow-everything sandbox-exec fails (sandbox_apply: Operation not permitted).
SANDBOXED=""
if [ "$(uname -s)" = "Darwin" ] && [ -x /usr/bin/sandbox-exec ] \
    && ! /usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true 2>/dev/null; then
    SANDBOXED="yes"
fi

# Parse arguments
HEADLESS=""
SHARED="${PW_SHARED:-}"
for arg in "$@"; do
    case $arg in
        --headless) HEADLESS="yes" ;;
        --shared)   SHARED="yes" ;;
        --isolated) ;;  # now the default; accepted so old invocations still work
    esac
done

# Isolated unless the caller explicitly opted into the shared browser, or named
# a port to (re)use with PW_PORT.
ISOLATED="yes"
[ -n "$SHARED" ] && ISOLATED=""
[ -n "$PW_PORT" ] && ISOLATED=""

# Alive? A browser started by an earlier sandboxed bash call cannot be signalled
# from this one (Seatbelt allows signals only within the same sandbox): EPERM, yet alive.
pid_alive() {
    [ -n "$1" ] || return 1
    local err
    err=$(kill -0 "$1" 2>&1) && return 0
    case "$err" in *"not permitted"*) return 0 ;; esac
    return 1
}

# Is something already listening on this port?
port_in_use() {
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- && return 0
    return 1
}

# Claim a port by atomically creating its pid file. Returns 1 if another live
# browser already owns it, so concurrent callers can never pick the same port.
claim_port() {
    local port="$1" pid_file="$PW_TMP/pw-browser-$1.pid"
    if [ -f "$pid_file" ]; then
        local old
        old=$(cat "$pid_file" 2>/dev/null)
        if pid_alive "$old"; then
            return 1
        fi
    fi
    port_in_use "$port" && return 1
    # noclobber makes this create-or-fail, so two racing shells can't both win
    ( set -o noclobber; echo "claiming-$$" > "$pid_file" ) 2>/dev/null || return 1
    return 0
}

if [ -n "$SANDBOXED" ] && [ -z "$HEADLESS" ]; then
    echo "Error: inside a sandbox only the headless shell can run; use --headless."
    exit 1
fi

# With --headless, prefer Playwright's chrome-headless-shell (no app bundle, so no
# GUI-session services): the newest numeric revision installed, macOS or Linux.
HEADLESS_SHELL=""
if [ -z "$CHROMIUM_BIN" ] && [ -n "$HEADLESS" ]; then
    CHROMIUM_BIN=$(
        ls -d "$HOME/Library/Caches/ms-playwright/chromium_headless_shell-"*/chrome-headless-shell-mac-*/chrome-headless-shell \
              "$HOME/.cache/ms-playwright/chromium_headless_shell-"*/chrome-headless-shell-linux64/chrome-headless-shell \
              "$HOME/.cache/ms-playwright/chromium_headless_shell-"*/chrome-linux/headless_shell \
              2>/dev/null | sed -E 's#^(.*/chromium_headless_shell-([0-9]+)/.*)$#\2 \1#' | sort -rn | cut -d' ' -f2- |
        while IFS= read -r candidate; do
            [ -x "$candidate" ] && { echo "$candidate"; break; }
        done
    )
fi
case "$CHROMIUM_BIN" in
    */chrome-headless-shell|*/headless_shell) HEADLESS_SHELL="yes" ;;
esac

# Find chromium binary. Prefer an explicit CHROMIUM_BIN, then Playwright's
# bundled Chrome for Testing (so we don't hijack the user's main Chrome),
# then PATH, and finally macOS's installed Google Chrome as a last resort.
# The cache holds every revision ever installed, and a glob expands them in
# string order — so the naive loop picks chromium-1200 while 1234 sits beside
# it. Sort numerically by revision, newest first: an old build silently lacks
# CSS the pages under test rely on, and nothing about that failure says "your
# browser is four releases behind".
#
# `chrome-linux64` is the current Linux layout; `chrome-linux` is what older
# revisions used. Both are listed, newest revision winning across both.
if [ -z "$CHROMIUM_BIN" ]; then
    for candidate in $(
        ls -d "$HOME/.cache/ms-playwright/chromium-"*/chrome-linux64/chrome \
              "$HOME/.cache/ms-playwright/chromium-"*/chrome-linux/chrome \
              2>/dev/null | sort -t- -k2 -Vr
    ) \
        "$HOME/Library/Caches/ms-playwright/chromium-"*/chrome-mac-arm64/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
        "$HOME/Library/Caches/ms-playwright/chromium-"*/chrome-mac/"Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"; do
        if [ -x "$candidate" ]; then
            CHROMIUM_BIN="$candidate"
            break
        fi
    done
fi

if [ -z "$CHROMIUM_BIN" ]; then
    CHROMIUM_BIN=$(which chromium 2>/dev/null || which chromium-browser 2>/dev/null || which google-chrome 2>/dev/null || true)
fi

if [ -z "$CHROMIUM_BIN" ] && [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
    CHROMIUM_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi

if [ -z "$CHROMIUM_BIN" ]; then
    echo "Error: Could not find a Chromium binary."
    echo "  Tried: \$CHROMIUM_BIN, Playwright cache, PATH (chromium/chromium-browser/google-chrome), /Applications/Google Chrome.app"
    echo "  Fix: run 'npx playwright install chromium' or set CHROMIUM_BIN=/path/to/chrome"
    exit 1
fi

# An app-bundle Chrome needs the GUI session's services: inside a sandbox it
# crashes and raises a macOS "quit unexpectedly" dialog. Never start one there.
if [ -n "$SANDBOXED" ] && case "$CHROMIUM_BIN" in *.app/*) true ;; *) false ;; esac; then
    echo "Error: inside a sandbox only Playwright's chrome-headless-shell can run, not $CHROMIUM_BIN."
    echo "  Fix (outside the sandbox): npx playwright install chromium-headless-shell"
    exit 1
fi

# ---------------------------------------------------------------- port choice

if [ -n "$SHARED" ] && [ -n "$PW_PORT" ]; then
    echo "Error: --shared reads the port from .playwright-port; do not also set PW_PORT."
    exit 1
fi

if [ -n "$ISOLATED" ]; then
    # Fresh port, claimed atomically. Never written to the working directory.
    PW_PORT=""
    for _ in $(seq 1 40); do
        candidate=$((9300 + RANDOM % 700))
        if claim_port "$candidate"; then
            PW_PORT="$candidate"
            break
        fi
    done
    if [ -z "$PW_PORT" ]; then
        echo "Error: could not find a free CDP port in 9300-9999 after 40 tries."
        echo "  Too many browsers running? List them: ls $PW_TMP/pw-browser-*.pid"
        exit 1
    fi
elif [ -n "$PW_PORT" ]; then
    : # Explicit port provided by the caller
elif [ -f "$PORT_FILE" ]; then
    PW_PORT=$(cat "$PORT_FILE")
else
    PW_PORT=""
    for _ in $(seq 1 40); do
        candidate=$((9300 + RANDOM % 700))
        if claim_port "$candidate"; then
            PW_PORT="$candidate"
            break
        fi
    done
    if [ -z "$PW_PORT" ]; then
        echo "Error: could not find a free CDP port in 9300-9999 after 40 tries."
        exit 1
    fi
    echo "$PW_PORT" > "$PORT_FILE"
    echo "Generated new port $PW_PORT (saved to .playwright-port)"
    echo "WARNING: --shared means every caller in this directory drives this same"
    echo "         browser and the same tab. Concurrent agents will clobber each"
    echo "         other. Drop --shared to get your own browser instead."
fi

PID_FILE="$PW_TMP/pw-browser-$PW_PORT.pid"
USER_DATA_DIR="$PW_TMP/pw-profile-$PW_PORT"

# Already running on this port? (Only reachable in shared / explicit-PW_PORT
# mode — an isolated port was just claimed and is by definition free.)
if [ -z "$ISOLATED" ] && [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    case "$OLD_PID" in
        claiming-*) ;;
        *)
            if pid_alive "$OLD_PID"; then
                echo "Browser already running on port $PW_PORT (PID: $OLD_PID)"
                echo "  Reuse it with: PW_PORT=$PW_PORT $SCRIPT_DIR/pw.sh <command>"
                exit 0
            fi
            rm -f "$PID_FILE"
            ;;
    esac
fi

if [ -n "$HEADLESS" ]; then
    echo "Starting Chromium with CDP (headless)..."
else
    echo "Starting Chromium with CDP..."
fi
echo "  Port: $PW_PORT"
echo "  Profile: $USER_DATA_DIR"
echo "  Binary: $CHROMIUM_BIN"
[ -n "$SANDBOXED" ] && echo "  Sandboxed: yes (--no-sandbox)"

CHROME_FLAGS=(
    --remote-debugging-port="$PW_PORT"
    --user-data-dir="$USER_DATA_DIR"
    --no-first-run
    --no-default-browser-check
)

if [ -n "$HEADLESS_SHELL" ]; then
    CHROME_FLAGS+=(--disable-gpu)  # always headless; it takes no --headless=new
elif [ -n "$HEADLESS" ]; then
    CHROME_FLAGS+=(--headless=new --disable-gpu)
fi
# Seatbelt cannot nest Chrome's own sandbox; Playwright passes the same flag by default.
[ -n "$SANDBOXED" ] && CHROME_FLAGS+=(--no-sandbox)

"$CHROMIUM_BIN" "${CHROME_FLAGS[@]}" &>/dev/null &

BROWSER_PID=$!
echo "$BROWSER_PID" > "$PID_FILE"

# Wait for CDP endpoint to be ready
echo -n "Waiting for CDP endpoint..."
for i in {1..30}; do
    if curl -s "http://localhost:$PW_PORT/json/version" &>/dev/null; then
        echo " ready!"
        echo ""
        if [ -n "$HEADLESS" ]; then
            echo "Chromium started with CDP enabled (headless)!"
        else
            echo "Chromium started with CDP enabled!"
        fi
        echo "  PID: $BROWSER_PID"
        echo "  CDP: http://localhost:$PW_PORT"
        echo ""
        if [ -n "$ISOLATED" ]; then
            echo "PW_PORT=$PW_PORT   <-- this browser is yours alone."
            echo "Pass it on EVERY command (shell env does not persist between calls):"
            echo "  PW_PORT=$PW_PORT $SCRIPT_DIR/pw.sh navigate https://example.com"
            echo "  PW_PORT=$PW_PORT $SCRIPT_DIR/pw.sh snapshot"
            echo ""
            echo "Stop it when done (leaking browsers is expensive):"
            echo "  PW_PORT=$PW_PORT $SCRIPT_DIR/stop-browser.sh"
        else
            echo "Run commands with:"
            echo "  $SCRIPT_DIR/pw.sh navigate https://example.com"
            echo "  $SCRIPT_DIR/pw.sh snapshot"
            echo ""
            echo "Stop with:"
            echo "  $SCRIPT_DIR/stop-browser.sh"
        fi
        exit 0
    fi
    pid_alive "$BROWSER_PID" || break
    echo -n "."
    sleep 0.5
done

if pid_alive "$BROWSER_PID"; then echo " timeout!"; else echo " the browser exited."; fi
echo "Error: CDP endpoint not responding at http://localhost:$PW_PORT/json/version"
if [ -n "$SANDBOXED" ]; then
    echo "  In Sova's macOS sandbox this needs the policy's \"browser\": \"headless-shell\" (ask the user),"
    echo "  and under On no TCP port can be opened: launch Playwright yourself within one bash call."
fi
kill "$BROWSER_PID" 2>/dev/null || true
rm -f "$PID_FILE"
exit 1
