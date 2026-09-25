#!/bin/bash
# Lab host entrypoint. One container = one Sova host:
#   - tailscaled in TUN mode joined to the lab Headscale with a pre-auth key (LAB_TAILSCALE=1)
#   - `tailscale serve` of the main listener on the tailnet (http, port LAB_SERVE_PORT)
#   - its own hermetic agent dir (/sova/.agent, a volume) built by scripts/hermetic-agent-dir.mjs,
#     with only the api_key entries of the mounted auth.json copied in, once
#   - Sova on 127.0.0.1:$PORT, supervised (restarted if it dies unless /run/lab/sova-off exists)
#   - a socat forwarder 0.0.0.0:4900 -> 127.0.0.1:$PORT, published on the laptop's loopback only
#
# Env: LAB_HOST (id), LAB_TAILSCALE (0/1), LAB_SOVA (0/1), LAB_LOGIN_SERVER, LAB_TS_HOSTNAME,
#      LAB_SERVE_PORT (default 8443; 0 = no serve), LAB_SEED (0/1), PORT, HOST.
set -u
LAB_HOST=${LAB_HOST:-$(hostname)}
LAB_TAILSCALE=${LAB_TAILSCALE:-0}
LAB_SOVA=${LAB_SOVA:-1}
LAB_SERVE_PORT=${LAB_SERVE_PORT:-8443}
LAB_SEED=${LAB_SEED:-1}
AGENT=${PI_CODING_AGENT_DIR:-/sova/.agent}
mkdir -p /run/lab /var/log/lab
echo "starting" > /run/lab/state

log() { echo "[lab:$LAB_HOST] $*"; }

# Guard: a lab container must never reach the laptop's real tailnet. Packets to tailnet ranges that
# the lab tailscaled has no route for would otherwise leave via eth0 -> docker NAT -> the laptop's
# own tailscale0. Reject them on eth0 (the lab tailnet itself is routed via tailscale0, untouched).
iptables -I OUTPUT -o eth0 -d 100.64.0.0/10 -j REJECT 2>/dev/null \
  && log "guard: 100.64.0.0/10 via eth0 rejected" || log "guard: iptables unavailable (no NET_ADMIN?)"
ip6tables -I OUTPUT -o eth0 -d fd7a:115c:a1e0::/48 -j REJECT 2>/dev/null || true
# The lab CA (Headscale's TLS, and whatever else a harness mints with `lab tls-cert`).
if [ -r /run/lab-tls/ca.pem ]; then
  cp /run/lab-tls/ca.pem /usr/local/share/ca-certificates/sova-mesh-lab-ca.crt && update-ca-certificates >/dev/null 2>&1
fi

# Every lab CA in one bundle for NODE_EXTRA_CA_CERTS (it takes a single file): the lab CA and,
# when wired, the mock token server's CA.
cat /run/lab-tls/ca.pem /run/mock-token/ca.pem 2>/dev/null > /run/lab/ca-bundle.pem
[ -r /run/mock-token/ca.pem ] && cp /run/mock-token/ca.pem /usr/local/share/ca-certificates/sova-mesh-lab-mock-ca.crt \
  && update-ca-certificates >/dev/null 2>&1
# The mock token server (sync-engineer's snippet): pi's fixed provider names -> the mock, in
# /etc/hosts, failing closed to 0.0.0.0. Must run before Sova or any pi process starts.
[ -r /run/lab-mock/hosts.sh ] && . /run/lab-mock/hosts.sh

# Sova itself never needs network admin rights: drop them from its bounding set.
SOVA_EXEC=(setpriv --bounding-set=-net_admin,-net_raw --)

if [ "$LAB_TAILSCALE" = 1 ]; then
  mkdir -p /var/lib/tailscale /var/run/tailscale
  tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock \
    --tun=tailscale0 --port=41641 --no-logs-no-support >/var/log/lab/tailscaled.log 2>&1 &
  for _ in $(seq 1 100); do [ -S /var/run/tailscale/tailscaled.sock ] && break; sleep 0.1; done
  backend() { tailscale status --json 2>/dev/null | jq -r .BackendState; }
  up_ok=0
  # A node with saved state logs itself back in. Running `tailscale up` on top of that restarts the
  # control client within seconds of its first Noise dial, and tailscale then forces the next dial
  # to port 443 ("forcing port 443 dial due to recent noise dial"), which an http:8080 control
  # server never answers. So: wait for the saved login first, and only `up` a node that needs it.
  if [ -s /var/lib/tailscale/tailscaled.state ]; then
    for _ in $(seq 1 30); do [ "$(backend)" = Running ] && { up_ok=1; break; }; sleep 0.5; done
  fi
  for attempt in $(seq 1 30); do
    [ "$up_ok" = 1 ] && break
    if tailscale up --login-server="$LAB_LOGIN_SERVER" --auth-key="file:/run/lab-secrets/authkey" \
         --hostname="${LAB_TS_HOSTNAME:-$LAB_HOST}" --accept-dns=true --timeout=20s >>/var/log/lab/tailscale-up.log 2>&1; then
      up_ok=1; break
    fi
    log "tailscale up failed (attempt $attempt), retrying"; sleep 5
    [ "$(backend)" = Running ] && { up_ok=1; break; }
  done
  if [ "$up_ok" = 1 ]; then
    log "tailnet: $(tailscale ip -4 2>/dev/null) ($(tailscale status --json 2>/dev/null | jq -r .Self.DNSName))"
    if [ "$LAB_SERVE_PORT" != 0 ] && [ "$LAB_SOVA" = 1 ]; then
      tailscale serve --bg --http="$LAB_SERVE_PORT" "http://127.0.0.1:${PORT}" >/var/log/lab/serve.log 2>&1 \
        || log "tailscale serve failed (see /var/log/lab/serve.log)"
    fi
  else
    log "tailscale up never succeeded; see /var/log/lab/tailscale-up.log"
  fi
fi

if [ "$LAB_SOVA" = 1 ]; then
  cd /sova
  node scripts/hermetic-agent-dir.mjs >/var/log/lab/agent-dir.log 2>&1 || { log "hermetic-agent-dir failed"; cat /var/log/lab/agent-dir.log; }
  # API keys only, copied once: later changes (login sync, M3) belong to the host; `lab reset` re-seeds.
  if [ ! -e "$AGENT/auth.json" ] && [ -r /run/lab-secrets/auth.json ]; then
    ( umask 077; node -e '
      const fs = require("fs");
      const src = JSON.parse(fs.readFileSync("/run/lab-secrets/auth.json", "utf8"));
      const out = Object.fromEntries(Object.entries(src).filter(([, v]) => v && v.type === "api_key"));
      fs.writeFileSync(process.argv[1] + ".tmp", JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
      fs.renameSync(process.argv[1] + ".tmp", process.argv[1]);
      console.log("[lab] auth.json: api_key entries: " + Object.keys(out).join(", "));
    ' "$AGENT/auth.json" )
  fi
  mkdir -p /root/work
  [ "$LAB_SEED" = 1 ] && node /usr/local/lib/lab/fixture-session.mjs "$AGENT" "$LAB_HOST" /root/work
  socat TCP-LISTEN:4900,fork,reuseaddr "TCP:127.0.0.1:${PORT}" &
fi

echo "ready" > /run/lab/state
trap 'log "stopping"; kill $(jobs -p) 2>/dev/null; pkill -f "[s]erver/index.ts" 2>/dev/null; exit 0' TERM INT

if [ "$LAB_SOVA" != 1 ]; then
  while :; do sleep 3600 & wait $!; done
fi

# Supervise Sova. `lab sova-stop` touches /run/lab/sova-off and kills the process; `lab sova-start`
# removes the marker. Output goes to the container log (docker logs) and /var/log/lab/sova.log.
while :; do
  if [ -e /run/lab/sova-off ]; then sleep 0.5 & wait $!; continue; fi
  log "sova starting on $HOST:$PORT"
  ( cd /sova && exec "${SOVA_EXEC[@]}" node --import tsx server/index.ts ) 2>&1 | tee -a /var/log/lab/sova.log &
  wait $! 
  log "sova exited"
  sleep 1 & wait $!
done
