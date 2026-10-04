#!/usr/bin/env bash
# Exposure proof, from the laptop (read-only on the VPS):
#   scripts/mesh-vps/exposure.sh probe              public $VPS_PUBLIC_IP:{4800,4801,4802,4890,2089,8443,10443} must TIME OUT; $VPS_CONTROL_PORTS must connect,
#                                                   and 443 too when SHARE_FRONT is vhost, caddy or funnel (the public share front)
#                                                   The internet relay's port VPS_RELAY_PORT (default 4803, §mesh.vps/internet-relay):
#                                                   VPS_RELAY=off → it must TIME OUT too. VPS_RELAY=on → it must connect; a TLS probe with
#                                                   no client certificate gets no HTTP answer; one with a fresh, unpaired certificate gets
#                                                   no byte back; TLS 1.2 is refused; over ssh, sova-relay-accept.service is active and
#                                                   the port's listener is no process of the deploy user's (it is the accept process)
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
          [ "$code" = 000 ] || { log "the relay port answered HTTP without a pinned client certificate"; bad=1; }
          # A fresh certificate no pairing knows, on a channel's token: the accept process closes it, and not one byte
          # of application data comes back (§mesh.lan/accept-process). Made here, used once, thrown away.
          pdir=$(mktemp -d); trap 'rm -rf "$pdir"' EXIT
          openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout "$pdir/k" -out "$pdir/c" -days 1 -subj "/CN=probe" 2>/dev/null
          bytes=$(timeout 8 openssl s_client -connect "$VPS_PUBLIC_IP:$VPS_RELAY_PORT" -tls1_3 -alpn pa/1 -noservername \
                    -cert "$pdir/c" -key "$pdir/k" -quiet -ign_eof </dev/null 2>/dev/null | wc -c || true)
          printf 'relay    unpaired-certificate probe: %s byte(s) back\n' "$bytes"
          [ "$bytes" = 0 ] || { log "the relay port sent data to an unpaired certificate"; bad=1; }
          if timeout 8 openssl s_client -connect "$VPS_PUBLIC_IP:$VPS_RELAY_PORT" -tls1_2 -noservername -brief </dev/null 2>&1 | grep -q 'Protocol version: TLSv1.2'; then
            log "the relay port completed a TLS 1.2 handshake"; bad=1
          else printf 'relay    TLS 1.2 probe: refused\n'; fi
          # On the VPS: the unit runs, and the port's listener is no process of the deploy user's (ss shows a process
          # only for the caller's own sockets), so the public socket is not in Sova's process.
          act=$(vps "systemctl is-active sova-relay-accept.service" 2>/dev/null || true)
          printf 'relay    sova-relay-accept.service: %s\n' "$act"
          [ "$act" = active ] || { log "the accept process's unit isn't active (SUDO.md §5)"; bad=1; }
          own=$(vps "ss -ltnpH 'sport = :$VPS_RELAY_PORT'" 2>/dev/null || true)
          if [ -z "$own" ]; then log "nothing listens on $VPS_RELAY_PORT on the VPS (is the internet relay set on the Mesh page?)"; bad=1
          elif printf '%s' "$own" | grep -q 'users:'; then log "the relay port's listener is a process of the deploy user's, not the accept process"; bad=1
          else printf 'relay    listener on %s: not the deploy user'"'"'s (the accept process)\n' "$VPS_RELAY_PORT"; fi ;;
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
