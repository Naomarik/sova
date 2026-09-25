#!/usr/bin/env bash
# Laptop-side test loop for the Termux installer against a real phone over ssh (key auth, Termux sshd on 8022).
#   scripts/mesh-termux/phone-test.sh tarball              source tarball of HEAD + the working copy of scripts/mesh-termux
#   scripts/mesh-termux/phone-test.sh install [args…]      push the tarball + install.sh, run `sh -s -- --source-url file://…`
#   scripts/mesh-termux/phone-test.sh install-http [args…] the same through curl | sh, both served from this laptop's
#                                                          tailnet IP for the run only (python http.server)
#   scripts/mesh-termux/phone-test.sh install-github [args…] the real one-liner from GitHub (GH_REF, default master)
#   scripts/mesh-termux/phone-test.sh gate                 mesh on with a placeholder peer: non-peer tailnet node, the phone
#                                                          itself and a Wi-Fi source are refused; back to mesh off
#   scripts/mesh-termux/phone-test.sh check                health, listeners, exposure, runit restart after a kill
#   scripts/mesh-termux/phone-test.sh uninstall [--keep-ssh]
#   scripts/mesh-termux/phone-test.sh snapshot <name>      packages, files, services, processes → $OUT/<name>/
#   scripts/mesh-termux/phone-test.sh diff <a> <b>         what changed between two snapshots
#   scripts/mesh-termux/phone-test.sh loop [args…]         snapshot pre, install, check, uninstall --keep-ssh, snapshot post,
#                                                          diff pre post (must be empty), install again, check
# Env: PHONE (ssh target, required), PHONE_PORT (8022), OUT (~/.cache/sova-mesh/termux-engineer/phone),
#      LAPTOP_IP (tailnet IP for install-http, required there), HTTP_PORT (4879).
# Site-specific values (PHONE, LAPTOP_IP, the pairing ids below) live in the untracked scripts/mesh-termux/local.env:
#   cp scripts/mesh-termux/local.env.example scripts/mesh-termux/local.env   (then fill it in)
set -euo pipefail
[ -f "$(dirname "$0")/local.env" ] && . "$(dirname "$0")/local.env"
PHONE=${PHONE:-}
PHONE_PORT=${PHONE_PORT:-8022}
OUT=${OUT:-$HOME/.cache/sova-mesh/termux-engineer/phone}
LAPTOP_IP=${LAPTOP_IP:-}
HTTP_PORT=${HTTP_PORT:-4879}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/scripts/mesh-termux"
TARBALL="$OUT/src/sova-src.tar.gz"
PHONE_TGZ='$PREFIX/tmp/sova-src.tar.gz'
mkdir -p "$OUT/src"
log() { printf '[phone-test] %s\n' "$*" >&2; }
die() { log "FAIL: $*"; exit 1; }
need() { local v; for v in "$@"; do [ -n "${!v:-}" ] || die "$v is not set: put it in scripts/mesh-termux/local.env (see local.env.example)"; done; }
ph() { ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -p "$PHONE_PORT" "$PHONE" "$@"; }

tarball() {
  local stage="$OUT/src/stage" sha
  sha=$(git -C "$ROOT" rev-parse --verify "${REV:-HEAD}^{commit}") || die "no such commit: ${REV:-HEAD}"
  rm -rf "$stage" && mkdir -p "$stage"
  # git archive of a commit carries its id (git get-tar-commit-id), which install.sh records in BUILD_COMMIT
  git -C "$ROOT" archive --format=tar --prefix=sova-test/ "$sha" > "$stage/src.tar"
  if [ -z "${REV:-}" ]; then
    # HEAD: overlay the working copy of this directory (uncommitted while it is being written)
    mkdir -p "$stage/sova-test/scripts/mesh-termux"
    find "$HERE" -maxdepth 1 -type f ! -name local.env -exec cp {} "$stage/sova-test/scripts/mesh-termux/" \;   # never local.env
    tar -C "$stage" -rf "$stage/src.tar" sova-test/scripts/mesh-termux
  fi
  gzip -9 -c "$stage/src.tar" > "$TARBALL"
  rm -rf "$stage"
  log "tarball: $TARBALL ($(du -h "$TARBALL" | cut -f1), ${sha:0:12}$([ -n "${REV:-}" ] || echo ' + working scripts/mesh-termux'))"
}

# a script of this directory: the working copy, or the one in $REV
script() { if [ -n "${REV:-}" ]; then git -C "$ROOT" show "$REV:scripts/mesh-termux/${1##*/}"; else cat "$1"; fi; }

install_ssh() {
  [ -f "$TARBALL" ] || tarball
  ph "cat > $PHONE_TGZ" < "$TARBALL"
  local t0=$SECONDS rc=0
  script "$HERE/install.sh" | ph "sh -s -- --source-url file://$PHONE_TGZ $(printf '%q ' "$@")" 2>&1 | tee "$OUT/install.log" || rc=$?
  ph "rm -f $PHONE_TGZ"
  log "install exit ${PIPESTATUS[0]:-$rc} after $((SECONDS - t0)) s"
  grep -q 'Sova is running' "$OUT/install.log" || die "install did not finish"
}

install_http() {
  [ -f "$TARBALL" ] || tarball
  local dir="$OUT/src/http"
  rm -rf "$dir" && mkdir -p "$dir"
  cp "$TARBALL" "$dir/sova-src.tar.gz"
  script "$HERE/install.sh" > "$dir/install.sh"
  python3 -m http.server --bind "$LAPTOP_IP" --directory "$dir" "$HTTP_PORT" > "$OUT/http.log" 2>&1 &
  local srv=$!
  trap 'kill $srv 2>/dev/null || true; rm -rf "$dir"' RETURN
  sleep 1
  local t0=$SECONDS
  ph "curl -fsSL http://$LAPTOP_IP:$HTTP_PORT/install.sh | sh -s -- --source-url http://$LAPTOP_IP:$HTTP_PORT/sova-src.tar.gz $(printf '%q ' "$@")" 2>&1 | tee "$OUT/install.log"
  log "install (curl | sh) after $((SECONDS - t0)) s"
  grep -q 'Sova is running' "$OUT/install.log" || die "install did not finish"
}

# the real one-liner from GitHub (GH_REF, default master): nothing from this laptop but the ssh session
GH_REPO=${GH_REPO:-Naomarik/sova}
install_github() {
  local ref=${GH_REF:-master} t0=$SECONDS
  local url="https://raw.githubusercontent.com/$GH_REPO/$ref/scripts/mesh-termux/install.sh"
  local extra=''; [ "$ref" = master ] || extra="--ref $ref"
  ph "curl -fsSL $url | sh -s -- $extra $(printf '%q ' "$@")" 2>&1 | tee "$OUT/install.log"
  log "install (GitHub $ref one-liner) after $((SECONDS - t0)) s"
  grep -q 'Sova is running' "$OUT/install.log" || die "install did not finish"
}

# install.sh options from local.env (id, label, StableID, MagicDNS name) and the phone's own first ssh key
default_args() {
  need PHONE_ID PHONE_NODE_ID PHONE_DNS
  ARGS=(--id "$PHONE_ID" --label "$PHONE_LABEL" --node-id "$PHONE_NODE_ID" --dns "$PHONE_DNS" --ssh-key "$(ph 'head -1 ~/.ssh/authorized_keys')")
}

check() {
  local ip port pport
  ip=$(ph '. ~/sova-mesh/sova-mesh.env; echo $SOVA_PEER_HOST'); port=$(ph '. ~/sova-mesh/sova-mesh.env; echo $PORT'); pport=$(ph '. ~/sova-mesh/sova-mesh.env; echo $SOVA_PEER_PORT')
  ph "grep -E '^(HOST|SOVA_PEER_HOST)=' ~/sova-mesh/sova-mesh.env" | grep -q '0\.0\.0\.0' && die "env binds 0.0.0.0"
  ph "curl -fsS -m 5 http://127.0.0.1:$port/api/health" | grep -q '"ok":true' || die "no health on 127.0.0.1:$port"
  log "health ok on the phone's 127.0.0.1:$port"
  ph "curl -fsS -m 5 http://127.0.0.1:$port/ | grep -q '<div id=\"root\"\\|<script'" || die "the SPA is not served"
  log "SPA served"
  # the phone has no ss/netstat for apps (no /proc/net/tcp, no netlink): prove listeners by connecting
  local wl
  wl=$(ph "ifconfig 2>/dev/null | awk '/^[a-z]/{i=\$1} \$1==\"inet\" && i!~/^(lo|tun)/{print \$2}'")
  for a in "$ip" $wl; do
    ph "curl -s -m 3 -o /dev/null http://$a:$port/" && die "main port answers on $a:$port" || log "phone: $a:$port refused (ok)"
  done
  local peers
  peers=$(ph "node -e 'console.log((JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).peers??[]).length)' ~/sova-mesh/agent/sova/peers.json")
  if [ "$peers" = 0 ]; then
    for a in "$ip" $wl; do ph "curl -s -m 3 -o /dev/null http://$a:$pport/" && die "mesh off, peer port answers on $a:$pport" || log "phone: $a:$pport refused (ok, mesh off)"; done
  fi
  for p in "$port" "$pport"; do
    timeout 6 bash -c "exec 3<>/dev/tcp/$ip/$p" 2>/dev/null && die "laptop reaches $ip:$p over the tailnet" || log "laptop: $ip:$p closed (ok)"
  done
  # every non-loopback address (IPv4 and IPv6, Wi-Fi, mobile data, tun0), as node lists them on the phone
  local n open
  n=$(addrs | wc -l)
  open=$(addrs | ph "while read -r a; do { : 3<>/dev/tcp/\$a/$port; } 2>/dev/null && echo \"\$a:$port\"; { : 3<>/dev/tcp/\$a/$pport; } 2>/dev/null && echo \"\$a:$pport\"; done; true" | grep -vxF "$([ "$peers" = 0 ] || echo "$ip:$pport")" || true)
  [ -z "$open" ] || die "open on non-loopback addresses: $(echo $open)"
  log "phone: $port closed on all $n non-loopback addresses; $pport $([ "$peers" = 0 ] && echo "closed on all" || echo "open on $ip only")"
  # runit restarts it after a kill
  local pid1 pid2
  pid1=$(ph 'SVDIR=$PREFIX/var/service sv status sova-mesh' | sed -n 's/^run: [^(]*(pid \([0-9]*\)).*/\1/p')
  [ -n "$pid1" ] || die "sova-mesh is not running under runit"
  ph "kill -9 $pid1"
  local ok=0
  for _ in $(seq 1 90); do
    sleep 1
    pid2=$(ph 'SVDIR=$PREFIX/var/service sv status sova-mesh' | sed -n 's/^run: [^(]*(pid \([0-9]*\)).*/\1/p')
    if [ -n "$pid2" ] && [ "$pid2" != "$pid1" ] && ph "curl -fsS -m 2 http://127.0.0.1:$port/api/health" 2>/dev/null | grep -q '"ok":true'; then ok=1; break; fi
  done
  [ $ok = 1 ] || die "not restarted after kill -9 $pid1"
  log "runit restarted it after kill -9 (pid $pid1 -> $pid2) and health is back"
  ph 'SVDIR=$PREFIX/var/service sv status sova-mesh; ls -la ~/.termux/boot; cat ~/sova-mesh/app/BUILD_COMMIT; stat -c "%a %n" ~/sova-mesh ~/sova-mesh/agent ~/sova-mesh/agent/auth.json ~/sova-mesh/tmp'
  ph 'SVDIR=$PREFIX/var/service sv status sova-mesh/log' | grep -q '^run:' || die "the runit logger for sova-mesh is not running"
  ph 'test -s $PREFIX/var/log/sv/sova-mesh/current' || die "no service log"
  log "runit logger up; log $(ph 'wc -l < $PREFIX/var/log/sv/sova-mesh/current') lines"
  echo "CHECK PASS"
}

snapshot() {
  local d="$OUT/snap/${1:?snapshot <name>}"
  mkdir -p "$d"
  ph 'dpkg-query -W -f="\${db:Status-Abbrev} \${Package} \${Version}\n" | sort' > "$d/packages.txt"
  ph 'apt-mark showmanual | sort' > "$d/manual.txt"
  # files: all of $HOME except the user's big trees, and the parts of $PREFIX we may touch (var/service, var/log/sv, etc)
  ph 'cd ~ && find . -path ./.oh-my-zsh -prune -o -path ./escapement -prune -o -path ./webapps -prune -o -path ./.zsh_history -prune -o -print | sort;
      echo "## PREFIX"; cd $PREFIX && find var/service var/log var/run etc bin lib/node_modules share/termux-services -maxdepth 3 2>/dev/null | grep -v "^var/log/apt" | sort' > "$d/files.txt"
  ph 'ps -A -o comm,args 2>/dev/null | grep -vE "^(ps|sshd-session|sh|zsh|bash|sort|grep) " | sort' > "$d/procs.txt" || true
  ph 'cat ~/.ssh/authorized_keys | awk "{print \$1, \$3}"; ls -A $PREFIX/var/service/*/ 2>/dev/null' > "$d/ssh-services.txt"
  log "snapshot $1: $(wc -l < "$d/packages.txt") packages, $(wc -l < "$d/files.txt") paths"
}

diffsnap() {
  local a="$OUT/snap/${1:?}" b="$OUT/snap/${2:?}" bad=0
  for f in packages.txt manual.txt files.txt procs.txt ssh-services.txt; do
    if ! diff -u "$a/$f" "$b/$f" > "$OUT/snap/diff-$1-$2-$f" 2>&1; then
      log "DIFF $f:"; sed -n '3,60p' "$OUT/snap/diff-$1-$2-$f" | grep '^[-+]' >&2; bad=1
    fi
  done
  [ $bad = 0 ] && echo "DIFF CLEAN: $1 == $2" || { echo "DIFF: $1 != $2"; return 1; }
}

# ---- full port scans (L2) --------------------------------------------------------------------------------------------
# Every non-loopback address of the phone, from node's os.networkInterfaces() (the phone denies ifconfig/ip IPv6 to apps:
# /proc/net/if_inet6 and netlink are EACCES). Without node (not installed) the last list saved in $OUT/addrs.txt is used.
addrs() {
  if ph 'command -v node >/dev/null'; then
    ph 'node -e "for(const [n,a] of Object.entries(require(\"os\").networkInterfaces()))for(const x of a)if(!x.internal)console.log(x.family===\"IPv6\"&&x.address.startsWith(\"fe80:\")?x.address+\"%\"+n:x.address)"' > "$OUT/addrs.txt"
  fi
  [ -s "$OUT/addrs.txt" ] || die "no address list (install once so node can list them)"
  cat "$OUT/addrs.txt"
}
# a connect() to every port 1-65535 of every address, run ON the phone (bash /dev/tcp: no forks per port, so no phantom
# process pressure; 16 parallel chunks per address). bash's connect has no timeout: a port whose connect hangs (a
# listener with a full accept queue) holds its chunk until the kernel gives up (slow, not wrong).
# Detached on the phone (nohup, $PREFIX/tmp/sova-scan.*, removed at the end); this side polls every 10 s.
scan() {
  local name=${1:?scan <name>} d="$OUT/scan"; mkdir -p "$d"
  local list; list=$(addrs | tr '\n' ' ')
  local t0=$SECONDS
  ph "cat > \$PREFIX/tmp/sova-scan.sh; rm -f \$PREFIX/tmp/sova-scan.out \$PREFIX/tmp/sova-scan.done; nohup bash \$PREFIX/tmp/sova-scan.sh > \$PREFIX/tmp/sova-scan.out 2>/dev/null < /dev/null &" <<EOS
for a in $list; do
  for c in \$(seq 0 15); do
    ( lo=\$((c*4096+1)); hi=\$((lo+4095)); [ \$hi -gt 65535 ] && hi=65535
      for p in \$(seq \$lo \$hi); do { : 3<>/dev/tcp/\$a/\$p; } 2>/dev/null && echo "\$a \$p"; done ) &
  done
  wait
done | sort -k1,1 -k2,2n > \$PREFIX/tmp/sova-scan.res
touch \$PREFIX/tmp/sova-scan.done
EOS
  until ph 'test -e $PREFIX/tmp/sova-scan.done'; do
    sleep 10
    [ $((SECONDS - t0)) -lt 3600 ] || die "scan $name: not done within an hour"
  done
  ph 'cat $PREFIX/tmp/sova-scan.res; rm -f $PREFIX/tmp/sova-scan.sh $PREFIX/tmp/sova-scan.out $PREFIX/tmp/sova-scan.res $PREFIX/tmp/sova-scan.done' > "$d/$name.txt"
  log "scan $name: $(wc -l < "$d/$name.txt") open (address, port) pairs over $(echo $list | wc -w) addresses in $((SECONDS - t0)) s"
}

# ---- pairing (only with PAIR_GO=1: coordinator-2's go) ---------------------------------------------------------
# The phone knows callers by tailnet IP (SOVA_MESH_IDENTITY=addresses): its entry for the laptop carries the laptop's
# StableID AND its tailnet IP as the url host. The laptop's team server (4870, LocalAPI whois) lists the phone by StableID.
LAPTOP_API=${LAPTOP_API:-http://127.0.0.1:4870}
# Required for gate/pair/unpair (local.env): LAPTOP_ID, LAPTOP_NODE_ID, LAPTOP_PEER_URL, PHONE_ID, PHONE_NODE_ID, PHONE_DNS
PHONE_LABEL=${PHONE_LABEL:-${PHONE_ID:-}}
PHONE_PEER_URL=${PHONE_PEER_URL:-http://$PHONE:4801}
LAPTOP_PEERS_FILE=${LAPTOP_PEERS_FILE:-$ROOT/.agent/sova/peers.json}
go() { [ "${PAIR_GO:-}" = 1 ] || die "pairing needs coordinator-2's go: rerun with PAIR_GO=1"; }
pairing_vars() { need LAPTOP_ID LAPTOP_NODE_ID LAPTOP_PEER_URL PHONE_ID PHONE_NODE_ID PHONE_DNS; }
phone_put() { # path json -> http code
  printf '%s' "$2" | ph "curl -sS -m 10 -o \$PREFIX/tmp/sova-put.json -w '%{http_code}' -X PUT -H 'content-type: application/json' --data-binary @- http://127.0.0.1:4800$1; cat \$PREFIX/tmp/sova-put.json >&2; rm -f \$PREFIX/tmp/sova-put.json"
}
laptop_put() { printf '%s' "$2" | curl -sS -m 10 -o "$OUT/put.json" -w '%{http_code}' -X PUT -H 'content-type: application/json' --data-binary @- "$LAPTOP_API$1"; }
code_from_laptop() { curl -s -m 8 -o /dev/null -w '%{http_code}' "$PHONE_PEER_URL$1" || true; }
phone_log_tail() { ph 'tail -n 40 $PREFIX/var/log/sv/sova-mesh/current' | grep -E '\[mesh\]' | tail -"${1:-8}" >&2 || true; }

# the gate with a placeholder peer (an unused tailnet IP, a fake StableID): mesh on, but the laptop is NOT a peer yet
# (not pairing: nothing outside the phone changes, so no PAIR_GO; the phone is back to mesh off afterwards)
gate() {
  local dummy='{"peers":[{"id":"gate-dummy","label":"gate dummy","nodeId":"nGATEDUMMY00CNTRL","name":"100.64.0.1","url":"http://100.64.0.1:4801"}]}'
  [ "$(phone_put /api/mesh/peers "$dummy")" = 200 ] || die "phone PUT peers (placeholder)"
  local ok=0 c
  for _ in $(seq 1 20); do c=$(code_from_laptop /api/peer/hello); [ "$c" != 000 ] && { ok=1; break; }; sleep 0.5; done
  [ $ok = 1 ] || die "the phone's peer listener did not come up on $PHONE_PEER_URL"
  [ "$c" = 403 ] || die "a tailnet node that is not a peer (the laptop) got $c, want 403"
  log "gate: laptop (tailnet, not a peer) -> $c"
  c=$(ph "curl -s -m 5 -o /dev/null -w '%{http_code}' $PHONE_PEER_URL/api/peer/hello" || true)
  [ "$c" = 403 ] || die "the phone calling itself got $c, want 403"
  log "gate: the phone itself -> $c"
  # a non-tailnet source: the phone's Wi-Fi address as the source of a connection to the tun0 IP
  local wl; wl=$(ph "ifconfig 2>/dev/null | awk '/^wlan/{i=1} i&&\$1==\"inet\"{print \$2; exit}'")
  if [ -n "$wl" ]; then
    c=$(ph "curl -s -m 5 --interface $wl -o /dev/null -w '%{http_code}' $PHONE_PEER_URL/api/peer/hello" || true)
    case "$c" in 403|000) log "gate: non-tailnet source $wl -> $c (403 = refused by the gate, 000 = no route)";; *) die "non-tailnet source $wl got $c";; esac
    c=$(ph "curl -s -m 5 -o /dev/null -w '%{http_code}' http://$wl:4801/api/peer/hello" || true)
    [ "$c" = 000 ] || die "the peer port answers on the Wi-Fi address $wl ($c)"
    log "gate: $wl:4801 not bound"
  fi
  c=$(ph "curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:4801/api/peer/hello" || true)
  [ "$c" = 000 ] || die "the peer port answers on loopback ($c)"
  timeout 6 bash -c "exec 3<>/dev/tcp/$PHONE/4800" 2>/dev/null && die "main port reachable over the tailnet"
  local refused
  refused=$(ph 'grep -c "\[mesh\] refused" $PREFIX/var/log/sv/sova-mesh/current' || true)
  [ "${refused:-0}" -ge 2 ] || { phone_log_tail 12; die "no '[mesh] refused' lines in the phone's log"; }
  ph 'grep -E "\[mesh\] (refused|peer listener)" $PREFIX/var/log/sv/sova-mesh/current | tail -6' >&2
  # back to mesh off: the listener closes
  [ "$(phone_put /api/mesh/peers '{"peers":[]}')" = 200 ] || die "phone PUT peers []"
  sleep 1
  timeout 6 bash -c "exec 3<>/dev/tcp/$PHONE/4801" 2>/dev/null && die "peer port still open after the placeholder was removed"
  log "gate: placeholder removed, mesh off, $PHONE:4801 closed"
  echo "GATE PASS"
}

pair() {
  go
  [ -f "$LAPTOP_PEERS_FILE" ] || die "no $LAPTOP_PEERS_FILE"
  cp "$LAPTOP_PEERS_FILE" "$OUT/laptop-peers.before.json"
  # the laptop: its current peers plus the phone (PUT replaces the list)
  local body
  body=$(node -e 'const [f,id,label,nodeId,dns,url]=process.argv.slice(1);const c=JSON.parse(require("fs").readFileSync(f,"utf8"));const peers=(c.peers||[]).filter(p=>p.id!==id).map(({dnsName,...p})=>({...p,name:dnsName}));peers.push({id,label,nodeId,name:dns,url});console.log(JSON.stringify({peers}))' \
    "$LAPTOP_PEERS_FILE" "$PHONE_ID" "$PHONE_LABEL" "$PHONE_NODE_ID" "$PHONE_DNS" "$PHONE_PEER_URL")
  [ "$(laptop_put /api/mesh/peers "$body")" = 200 ] || { cat "$OUT/put.json" >&2; die "laptop PUT peers"; }
  local lip=${LAPTOP_PEER_URL#http://}; lip=${lip%%:*}
  body=$(printf '{"peers":[{"id":"%s","label":"%s","nodeId":"%s","name":"%s","url":"%s"}]}' "$LAPTOP_ID" "$LAPTOP_ID" "$LAPTOP_NODE_ID" "$lip" "$LAPTOP_PEER_URL")
  [ "$(phone_put /api/mesh/peers "$body")" = 200 ] || die "phone PUT peers"
  local ok=0 a b
  for _ in $(seq 1 40); do
    a=$(ph 'curl -s -m 5 http://127.0.0.1:4800/api/mesh/hello >/dev/null; curl -s -m 5 http://127.0.0.1:4800/api/mesh' | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=m.peers.find(p=>p.id===process.argv[1]);console.log(p?.state??"none")' "$LAPTOP_ID" || true)
    b=$(curl -s -m 5 "$LAPTOP_API/api/mesh/hello" >/dev/null; curl -s -m 5 "$LAPTOP_API/api/mesh" | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=m.peers.find(p=>p.id===process.argv[1]);console.log(p?.state??"none")' "$PHONE_ID" || true)
    [ "$a" = up ] && [ "$b" = up ] && { ok=1; break; }
    sleep 1
  done
  log "phone sees $LAPTOP_ID: $a; laptop sees $PHONE_ID: $b"
  [ $ok = 1 ] || { phone_log_tail 12; die "hello not up both ways"; }
  local c
  c=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$LAPTOP_API/peer/$PHONE_ID/api/health"); [ "$c" = 200 ] || die "/peer/$PHONE_ID/api/health via the laptop -> $c"
  log "laptop /peer/$PHONE_ID/api/health -> 200"
  c=$(code_from_laptop /api/peer/hello); [ "$c" = 200 ] || die "the laptop (now a peer) calling the phone directly -> $c"
  log "laptop -> phone peer listener /api/peer/hello -> 200"
  c=$(ph "curl -s -m 5 -o /dev/null -w '%{http_code}' $PHONE_PEER_URL/api/peer/hello" || true)
  [ "$c" = 403 ] || die "the phone calling itself got $c after pairing, want 403"
  curl -s -m 5 "$LAPTOP_API/api/mesh/sessions" | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify(m.peers.map(p=>({id:p.id,state:p.state,sessions:p.sessions?.length}))))'
  ph 'curl -s -m 5 http://127.0.0.1:4800/api/mesh' | node -e 'const m=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify({enabled:m.enabled,self:m.self,peers:m.peers.map(p=>({id:p.id,state:p.state,error:p.error})),sync:m.sync}))'
  phone_log_tail 8
  echo "PAIR PASS"
}

unpair() {
  [ -f "$OUT/laptop-peers.before.json" ] || die "no saved laptop peers list"
  local body
  body=$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(JSON.stringify({peers:(c.peers||[]).map(({dnsName,...p})=>({...p,name:dnsName}))}))' "$OUT/laptop-peers.before.json")
  [ "$(laptop_put /api/mesh/peers "$body")" = 200 ] || die "laptop PUT peers (restore)"
  [ "$(phone_put /api/mesh/peers '{"peers":[]}')" = 200 ] || die "phone PUT peers []"
  sleep 1
  timeout 6 bash -c "exec 3<>/dev/tcp/$PHONE/4801" 2>/dev/null && die "phone peer port still open after unpair"
  echo "UNPAIRED (laptop peers restored, phone mesh off)"
}

cmd=${1:-}; shift || true
case "$cmd" in tarball|diff|"") ;; *) need PHONE ;; esac
case "$cmd" in install-http) need LAPTOP_IP ;; pair|unpair) pairing_vars ;; esac
case "$cmd" in
  tarball) tarball ;;
  install) install_ssh "$@" ;;
  install-github) install_github "$@" ;;
  install-http) install_http "$@" ;;
  check) check ;;
  uninstall) script "$HERE/uninstall.sh" | ph "sh -s -- $*" 2>&1 | tee "$OUT/uninstall.log" ;;
  gate) gate ;;
  pair) pair ;;
  unpair) unpair ;;
  snapshot) snapshot "$@" ;;
  addrs) addrs ;;
  scan) scan "$@" ;;
  diff) diffsnap "$@" ;;
  loop)
    # INSTALL=ssh (tarball of HEAD/REV over ssh, default) | github (the real one-liner); UNINSTALL=keep-ssh (default) | full.
    # A full uninstall releases the Termux wake lock, which this ssh loop needs: it is taken again right after, in the same
    # ssh session (the baseline had one too), and recorded in the log.
    [ $# -gt 0 ] && ARGS=("$@") || default_args
    inst() { if [ "${INSTALL:-ssh}" = github ]; then install_github "${ARGS[@]}"; else install_ssh "${ARGS[@]}"; fi; }
    unin() {
      if [ "${UNINSTALL:-keep-ssh}" = full ]; then
        script "$HERE/uninstall.sh" | ph 'sh -s --; rc=$?; termux-wake-lock; echo "[phone-test] wake lock taken again for the ssh loop"; exit $rc' 2>&1 | tee "$OUT/uninstall.log"
      else
        script "$HERE/uninstall.sh" | ph "sh -s -- --keep-ssh" 2>&1 | tee "$OUT/uninstall.log"
      fi
      grep -q 'removed ~/sova-mesh' "$OUT/uninstall.log" || die "uninstall did not finish"
    }
    [ "${INSTALL:-ssh}" = github ] || tarball
    if ph 'test -d ~/sova-mesh'; then log "installed: uninstalling first, so 'pre' is the uninstalled baseline"; unin; fi
    snapshot pre
    inst; check; gate
    unin
    snapshot post
    diffsnap pre post
    inst; check
    echo "LOOP PASS ($(ph 'cat ~/sova-mesh/app/BUILD_COMMIT'))"
    ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
