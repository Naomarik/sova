#!/usr/bin/env bash
# ON THE LAPTOP: the VPS front door's upstream for the laptop's team server (M5):
#   scripts/mesh-vps/laptop-forwarder.sh start|stop|status
# A user-level socat on the laptop's TAILNET IP only (LAPTOP_SERVE_URL, <laptop-tailnet-ip>:4872) -> the team server 127.0.0.1:4870. No sudo, no
# `tailscale serve` (the laptop's serve config stays untouched), stopped with `stop` (pid in ~/.cache/sova-mesh/lab-engineer).
set -euo pipefail
. "$(dirname "$0")/config.sh"
need LAPTOP_SERVE_URL
LISTEN=${LAPTOP_SERVE_URL#http://}          # <laptop-tailnet-ip>:4872
TARGET=${LAPTOP_TARGET:-127.0.0.1:4870}
PIDF=${LAPTOP_FORWARDER_PID:-$HOME/.cache/sova-mesh/lab-engineer/laptop-forwarder.pid}
running() { [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; }
case "${1:-}" in
  start)
    running && { echo "running (pid $(cat "$PIDF")): $LISTEN -> $TARGET"; exit 0; }
    mkdir -p "$(dirname "$PIDF")"
    setsid socat "TCP-LISTEN:${LISTEN##*:},bind=${LISTEN%:*},fork,reuseaddr" "TCP:$TARGET" </dev/null >/dev/null 2>&1 &
    echo $! > "$PIDF"
    sleep 0.5
    running || die "socat did not start"
    echo "started (pid $(cat "$PIDF")): $LISTEN -> $TARGET"
    ;;
  stop)
    running && kill "$(cat "$PIDF")" && echo "stopped" || echo "not running"
    rm -f "$PIDF"
    ;;
  status)
    running && echo "running (pid $(cat "$PIDF")): $LISTEN -> $TARGET" || { echo "not running"; exit 1; }
    ;;
  *) die "usage: $0 start|stop|status" ;;
esac
