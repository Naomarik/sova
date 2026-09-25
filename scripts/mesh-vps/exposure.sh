#!/usr/bin/env bash
# Exposure proof, from the laptop (read-only on the VPS):
#   scripts/mesh-vps/exposure.sh probe              public $VPS_PUBLIC_IP:{4800,4801,4890,2089,8443,10443} must TIME OUT; $VPS_CONTROL_PORTS must connect
#   scripts/mesh-vps/exposure.sh snapshot <file>    the production state: listening sockets + `systemctl is-active` of $PROD_UNITS (skipped if empty)
#   scripts/mesh-vps/exposure.sh compare <a> <b>    identical, or print the difference and fail
# A TCP connect that neither connects nor is refused within 6 s counts as a timeout (the firewall drops it on the public interface).
set -euo pipefail
. "$(dirname "$0")/config.sh"
need VPS_SSH VPS_PUBLIC_IP

connect() { # host port -> open | refused | timeout
  local rc=0
  timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null || rc=$?
  case $rc in 0) echo open ;; 124) echo timeout ;; *) echo refused ;; esac
}

case "${1:-}" in
  probe)
    bad=0
    [ -n "$VPS_CONTROL_PORTS" ] || log "no VPS_CONTROL_PORTS: the probe has no open control port to prove it works"
    for p in $VPS_CONTROL_PORTS; do  # never 22: ssh goes over the tailnet
      r=$(connect "$VPS_PUBLIC_IP" "$p"); printf 'control  %s:%-5s %s\n' "$VPS_PUBLIC_IP" "$p" "$r"
      [ "$r" = open ] || { log "control port $p is not open: the probe itself is broken"; bad=1; }
    done
    for p in "$SOVA_PORT" "$SOVA_PEER_PORT" "$FRONTDOOR_PORT" "${CADDY_ADMIN##*:}" "$FRONTDOOR_SERVE_PORT" "$HOST_SERVE_PORT"; do
      r=$(connect "$VPS_PUBLIC_IP" "$p"); printf 'public   %s:%-5s %s\n' "$VPS_PUBLIC_IP" "$p" "$r"
      [ "$r" = timeout ] || bad=1
    done
    [ $bad = 0 ] && echo "PASS: every Sova port (incl. Caddy admin and the serve ports) times out from the public IP" || { echo "FAIL"; exit 1; }
    ;;
  snapshot)
    out=${2:?snapshot <file>}
    [ -n "$PROD_UNITS" ] || log "PROD_UNITS is empty: the snapshot has the listening sockets only (no units check)"
    vps "ss -ltnH | awk '{print \$4}' | grep -vE ':($SOVA_PORT|$SOVA_PEER_PORT|$FRONTDOOR_PORT|2089)\$' | sort -u; \
         for u in $PROD_UNITS; do printf '%s %s\n' \"\$u\" \"\$(systemctl is-active \$u 2>&1)\"; done" > "$out"
    echo "snapshot: $out ($(wc -l < "$out") lines)"
    ;;
  compare)
    diff -u "${2:?}" "${3:?}" && echo "PASS: production state identical" || { echo "FAIL: production state changed"; exit 1; }
    ;;
  *) die "usage: $0 probe | snapshot <file> | compare <a> <b>" ;;
esac
