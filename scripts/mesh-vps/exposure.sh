#!/usr/bin/env bash
# Exposure proof, from the laptop (read-only on the VPS):
#   scripts/mesh-vps/exposure.sh probe              public $VPS_PUBLIC_IP:{4800,4801,4802,4890,2089,8443,10443} must TIME OUT; $VPS_CONTROL_PORTS must connect,
#                                                   and 443 too when SHARE_FRONT is vhost, caddy or funnel (the public share front)
#                                                   With VPS_RELAY_PORT set (the opt-in dial-out relay, §mesh/lan): VPS_RELAY=off → that port
#                                                   must TIME OUT too; VPS_RELAY=on → it must connect, and a TLS probe with no client
#                                                   certificate must get no HTTP answer (the pinned handshake refuses it)
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
    controls=$VPS_CONTROL_PORTS
    case "$SHARE_FRONT" in
      vhost|caddy|funnel) case " $controls " in *" 443 "*) ;; *) controls="$controls 443" ;; esac ;;
      ''|cloudflared) ;;
      *) die "SHARE_FRONT must be empty, vhost, caddy, funnel or cloudflared (got $SHARE_FRONT)" ;;
    esac
    [ -n "$controls" ] || log "no VPS_CONTROL_PORTS: the probe has no open control port to prove it works"
    for p in $controls; do  # never 22: ssh goes over the tailnet
      r=$(connect "$VPS_PUBLIC_IP" "$p"); printf 'control  %s:%-5s %s\n' "$VPS_PUBLIC_IP" "$p" "$r"
      [ "$r" = open ] || { log "control port $p is not open: the probe itself is broken"; bad=1; }
    done
    for p in "$SOVA_PORT" "$SOVA_PEER_PORT" "$FRONTDOOR_PORT" "${CADDY_ADMIN##*:}" "$FRONTDOOR_SERVE_PORT" "$HOST_SERVE_PORT" "$SHARE_PORT"; do
      r=$(connect "$VPS_PUBLIC_IP" "$p"); printf 'public   %s:%-5s %s\n' "$VPS_PUBLIC_IP" "$p" "$r"
      [ "$r" = timeout ] || bad=1
    done
    if [ -n "${VPS_RELAY_PORT:-}" ]; then
      r=$(connect "$VPS_PUBLIC_IP" "$VPS_RELAY_PORT"); printf 'relay    %s:%-5s %s (VPS_RELAY=%s)\n' "$VPS_PUBLIC_IP" "$VPS_RELAY_PORT" "$r" "${VPS_RELAY:-off}"
      case "${VPS_RELAY:-off}" in
        off) [ "$r" = timeout ] || bad=1 ;;
        on)
          [ "$r" = open ] || { log "VPS_RELAY=on but the relay port isn't open"; bad=1; }
          code=$(curl -sk -m 6 -o /dev/null -w '%{http_code}' "https://$VPS_PUBLIC_IP:$VPS_RELAY_PORT/api/peer/hello" || true)
          printf 'relay    no-cert TLS probe: HTTP %s\n' "$code"
          [ "$code" = 000 ] || { log "the relay port answered HTTP without a pinned client certificate"; bad=1; } ;;
        *) die "VPS_RELAY must be off or on (got $VPS_RELAY)" ;;
      esac
    fi
    [ $bad = 0 ] && echo "PASS: every Sova port (incl. Caddy admin, the serve ports and the share port) times out from the public IP${SHARE_FRONT:+; the $SHARE_FRONT share front is the only public way in}" || { echo "FAIL"; exit 1; }
    ;;
  snapshot)
    out=${2:?snapshot <file>}
    [ -n "$PROD_UNITS" ] || log "PROD_UNITS is empty: the snapshot has the listening sockets only (no units check)"
    vps "ss -ltnH | awk '{print \$4}' | grep -vE ':($SOVA_PORT|$SOVA_PEER_PORT|$FRONTDOOR_PORT|$SHARE_PORT|2089${VPS_RELAY_PORT:+|$VPS_RELAY_PORT})\$' | sort -u; \
         for u in $PROD_UNITS; do printf '%s %s\n' \"\$u\" \"\$(systemctl is-active \$u 2>&1)\"; done" > "$out"
    echo "snapshot: $out ($(wc -l < "$out") lines)"
    ;;
  compare)
    diff -u "${2:?}" "${3:?}" && echo "PASS: production state identical" || { echo "FAIL: production state changed"; exit 1; }
    ;;
  *) die "usage: $0 probe | snapshot <file> | compare <a> <b>" ;;
esac
