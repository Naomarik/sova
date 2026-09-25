#!/usr/bin/env bash
# Smoke test on the VPS, run from the laptop after deploy.sh (no sudo, no unit needed):
#   scripts/mesh-vps/smoke.sh [--keep-peers]
# 1. snapshot the production state; refuse if anything already listens on the Sova ports
# 2. start Sova by hand (setsid nohup run-sova.sh, as deploy); wait for 127.0.0.1:4800/api/health
# 3. mesh OFF (no peers.json): nothing on the peer port
# 4. PUT /api/mesh/peers (the laptop's team server) + /api/mesh/settings (label, serveUrl): the peer listener binds 100.64.0.2:4801 ONLY
# 5. exposure probe from the laptop while it runs: public 4800/4801/4890/2089/8443/10443 time out
# 6. stop Sova, check its ports are closed, snapshot again: production state identical
# The peers are emptied again (self kept) unless --keep-peers (then the next start comes up with the mesh on).
set -euo pipefail
. "$(dirname "$0")/config.sh"
KEEP=0
[ "${1:-}" = --keep-peers ] && KEEP=1
OUT=${SMOKE_OUT:-$HOME/.cache/sova-mesh/lab-engineer/vps-smoke}
mkdir -p "$OUT"
B="\$HOME/$R"
fail() { log "FAIL: $*"; stop || true; exit 1; }
stop() {
  vps "if [ -f $B/smoke.pid ]; then kill \$(cat $B/smoke.pid) 2>/dev/null || true; for i in \$(seq 1 30); do kill -0 \$(cat $B/smoke.pid) 2>/dev/null || break; sleep 0.5; done; rm -f $B/smoke.pid; fi"
}
listeners() { vps "ss -ltnH | awk '{print \$4}' | grep -E ':($SOVA_PORT|$SOVA_PEER_PORT|$FRONTDOOR_PORT)\$' | sort" || true; }

"$MESH_VPS_DIR/exposure.sh" snapshot "$OUT/prod-before.txt"
[ -z "$(listeners)" ] || fail "something already listens on a Sova port: $(listeners | tr '\n' ' ')"
vps "systemctl --user is-active --quiet sova-mesh.service" 2>/dev/null && fail "the sova-mesh unit is running; stop it first"
log "built: $(vps "cat $B/app/BUILD_COMMIT")"

vps "cd $B && setsid nohup $B/app/scripts/mesh-vps/run-sova.sh > $B/smoke.log 2>&1 < /dev/null & echo \$! > $B/smoke.pid"
ok=0
for i in $(seq 1 60); do
  if vps "curl -fsS -m 2 http://127.0.0.1:$SOVA_PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
  sleep 1
done
[ $ok = 1 ] || { vps "tail -20 $B/smoke.log" >&2; fail "no health on 127.0.0.1:$SOVA_PORT within 60 s"; }
log "health ok on 127.0.0.1:$SOVA_PORT"

# mesh off = peers.json absent or listing no peer (deploy seeds it with only this host's self id)
peers=$(vps "cat $B/agent/sova/peers.json 2>/dev/null || echo '{}'" | node -e 'console.log((JSON.parse(require("fs").readFileSync(0,"utf8")).peers??[]).length)')
if [ "$peers" = 0 ]; then
  L=$(listeners); echo "$L" > "$OUT/listen-mesh-off.txt"
  [ "$L" = "127.0.0.1:$SOVA_PORT" ] || fail "mesh off, expected only 127.0.0.1:$SOVA_PORT, got: $(echo $L)"
  log "mesh off: only 127.0.0.1:$SOVA_PORT listens"
fi

put() { # path json -> http code (answer in $B/smoke-put.json)
  printf '%s' "$2" | vps "curl -sS -m 10 -o $B/smoke-put.json -w '%{http_code}' -X PUT -H 'content-type: application/json' --data-binary @- http://127.0.0.1:$SOVA_PORT$1"
}
peers=$(printf '{"peers":[{"id":"%s","name":"%s","label":"%s","nodeId":"%s","url":"%s","serveUrl":"%s","priority":1}]}' \
  "$LAPTOP_ID" "$LAPTOP_DNS" "$LAPTOP_LABEL" "$LAPTOP_NODE_ID" "$LAPTOP_PEER_URL" "$LAPTOP_SERVE_URL")
code=$(put /api/mesh/peers "$peers")
[ "$code" = 200 ] || { vps "cat $B/smoke-put.json" >&2; fail "PUT /api/mesh/peers -> $code"; }
# this host's label and its front-door upstream (the front door runs on this host: loopback)
code=$(put /api/mesh/settings "$(printf '{"hostLabel":"%s","serveUrl":"http://127.0.0.1:%s"}' "$VPS_LABEL" "$SOVA_PORT")")
[ "$code" = 200 ] || { vps "cat $B/smoke-put.json" >&2; fail "PUT /api/mesh/settings -> $code"; }
ok=0
for i in $(seq 1 20); do
  L=$(listeners)
  if echo "$L" | grep -q ":$SOVA_PEER_PORT\$"; then ok=1; break; fi
  sleep 0.5
done
[ $ok = 1 ] || fail "the peer listener did not bind :$SOVA_PEER_PORT after the PUT"
echo "$L" > "$OUT/listen-mesh-on.txt"
[ "$(echo "$L" | grep ":$SOVA_PEER_PORT\$")" = "$VPS_TAILNET_IP:$SOVA_PEER_PORT" ] || fail "peer listener binds: $(echo $L)"
[ "$(echo "$L" | grep ":$SOVA_PORT\$")" = "127.0.0.1:$SOVA_PORT" ] || fail "main listener binds: $(echo $L)"
log "mesh on: main 127.0.0.1:$SOVA_PORT, peer $VPS_TAILNET_IP:$SOVA_PEER_PORT only"
vps "curl -fsS -m 5 http://127.0.0.1:$SOVA_PORT/api/mesh" | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify({enabled:m.enabled,self:m.self,peers:m.peers.map(p=>({id:p.id,state:p.state,error:p.error}))}))' | tee "$OUT/mesh.json"
[ "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).self.id)' "$OUT/mesh.json")" = "$VPS_ID" ] || fail "self.id is not $VPS_ID"
vps "curl -fsS -m 5 http://127.0.0.1:$SOVA_PORT/api/mesh/settings" | node -e 'const s=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify({loginKinds:s.loginKinds,loginKindsPinned:s.loginKindsPinned}))' | tee "$OUT/settings.json"
grep -q 'Pinned' "$OUT/settings.json" && fail "loginKinds is pinned (SOVA_SYNC_LOGIN_KINDS is set)"
grep -q '"loginKinds":"api-keys"' "$OUT/settings.json" && log "note: loginKinds is api-keys (set on this host's Mesh settings)"

"$MESH_VPS_DIR/exposure.sh" probe | tee "$OUT/exposure.txt" || fail "exposure probe"
# the tailnet side, for contrast: the peer port is reachable over the tailnet, the main port is not
printf 'tailnet  %s:%s %s\n' "$VPS_TAILNET_IP" "$SOVA_PEER_PORT" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$VPS_TAILNET_IP:$SOVA_PEER_PORT/api/peer/hello" || true)" | tee -a "$OUT/exposure.txt"
printf 'tailnet  %s:%s %s\n' "$VPS_TAILNET_IP" "$SOVA_PORT" "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$VPS_TAILNET_IP:$SOVA_PORT/api/health" || true)" | tee -a "$OUT/exposure.txt"

if [ $KEEP = 0 ]; then # back to mesh off, keeping self (id, label, serveUrl) and loginKinds
  code=$(put /api/mesh/peers '{"peers":[]}')
  [ "$code" = 200 ] || { vps "cat $B/smoke-put.json" >&2; fail "PUT /api/mesh/peers [] -> $code"; }
fi
stop
sleep 1
[ -z "$(listeners)" ] || fail "Sova's ports still open after stop: $(listeners | tr '\n' ' ')"
log "stopped; Sova ports closed"
"$MESH_VPS_DIR/exposure.sh" snapshot "$OUT/prod-after.txt"
"$MESH_VPS_DIR/exposure.sh" compare "$OUT/prod-before.txt" "$OUT/prod-after.txt"
echo "SMOKE PASS ($(vps "cat $B/app/BUILD_COMMIT"))"
