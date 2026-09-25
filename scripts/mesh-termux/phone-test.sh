#!/usr/bin/env bash
# Laptop-side test loop for the Termux installer against a real phone over ssh (key auth, Termux sshd on 8022).
#   scripts/mesh-termux/phone-test.sh tarball              source tarball of HEAD + the working copy of scripts/mesh-termux
#   scripts/mesh-termux/phone-test.sh install [args…]      push the tarball + install.sh, run `sh -s -- --source-url file://…`
#   scripts/mesh-termux/phone-test.sh install-http [args…] the same through curl | sh, both served from this laptop's
#                                                          tailnet IP for the run only (python http.server)
#   scripts/mesh-termux/phone-test.sh check                health, listeners, exposure, runit restart after a kill
#   scripts/mesh-termux/phone-test.sh uninstall [--keep-ssh]
#   scripts/mesh-termux/phone-test.sh snapshot <name>      packages, files, services, processes → $OUT/<name>/
#   scripts/mesh-termux/phone-test.sh diff <a> <b>         what changed between two snapshots
#   scripts/mesh-termux/phone-test.sh loop [args…]         snapshot pre, install, check, uninstall --keep-ssh, snapshot post,
#                                                          diff pre post (must be empty), install again, check
# Env: PHONE (ssh target, default 100.64.0.3), PHONE_PORT (8022), OUT (~/.cache/sova-mesh/termux-engineer/phone),
#      LAPTOP_IP (tailnet IP for install-http, default 100.64.0.4), HTTP_PORT (4879).
set -euo pipefail
PHONE=${PHONE:-100.64.0.3}
PHONE_PORT=${PHONE_PORT:-8022}
OUT=${OUT:-$HOME/.cache/sova-mesh/termux-engineer/phone}
LAPTOP_IP=${LAPTOP_IP:-100.64.0.4}
HTTP_PORT=${HTTP_PORT:-4879}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HERE="$ROOT/scripts/mesh-termux"
TARBALL="$OUT/src/sova-src.tar.gz"
PHONE_TGZ='$PREFIX/tmp/sova-src.tar.gz'
mkdir -p "$OUT/src"
log() { printf '[phone-test] %s\n' "$*" >&2; }
die() { log "FAIL: $*"; exit 1; }
ph() { ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -p "$PHONE_PORT" "$PHONE" "$@"; }

tarball() {
  local stage="$OUT/src/stage"
  rm -rf "$stage" && mkdir -p "$stage"
  git -C "$ROOT" archive --format=tar --prefix=sova-test/ HEAD > "$stage/src.tar"
  # overlay the working copy of this directory (not committed yet while it is being written)
  mkdir -p "$stage/sova-test/scripts/mesh-termux"
  cp "$HERE"/* "$stage/sova-test/scripts/mesh-termux/"
  tar -C "$stage" -rf "$stage/src.tar" sova-test/scripts/mesh-termux
  gzip -9 -c "$stage/src.tar" > "$TARBALL"
  rm -rf "$stage"
  log "tarball: $TARBALL ($(du -h "$TARBALL" | cut -f1), HEAD $(git -C "$ROOT" rev-parse --short HEAD) + working scripts/mesh-termux)"
}

install_ssh() {
  [ -f "$TARBALL" ] || tarball
  ph "cat > $PHONE_TGZ" < "$TARBALL"
  local t0=$SECONDS rc=0
  ph "sh -s -- --source-url file://$PHONE_TGZ $(printf '%q ' "$@")" < "$HERE/install.sh" 2>&1 | tee "$OUT/install.log" || rc=$?
  ph "rm -f $PHONE_TGZ"
  log "install exit ${PIPESTATUS[0]:-$rc} after $((SECONDS - t0)) s"
  grep -q 'Sova is running' "$OUT/install.log" || die "install did not finish"
}

install_http() {
  [ -f "$TARBALL" ] || tarball
  local dir="$OUT/src/http"
  rm -rf "$dir" && mkdir -p "$dir"
  cp "$TARBALL" "$dir/sova-src.tar.gz"
  cp "$HERE/install.sh" "$dir/install.sh"
  python3 -m http.server --bind "$LAPTOP_IP" --directory "$dir" "$HTTP_PORT" > "$OUT/http.log" 2>&1 &
  local srv=$!
  trap 'kill $srv 2>/dev/null || true; rm -rf "$dir"' RETURN
  sleep 1
  local t0=$SECONDS
  ph "curl -fsSL http://$LAPTOP_IP:$HTTP_PORT/install.sh | sh -s -- --source-url http://$LAPTOP_IP:$HTTP_PORT/sova-src.tar.gz $(printf '%q ' "$@")" 2>&1 | tee "$OUT/install.log"
  log "install (curl | sh) after $((SECONDS - t0)) s"
  grep -q 'Sova is running' "$OUT/install.log" || die "install did not finish"
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

cmd=${1:-}; shift || true
case "$cmd" in
  tarball) tarball ;;
  install) install_ssh "$@" ;;
  install-http) install_http "$@" ;;
  check) check ;;
  uninstall) ph "sh -s -- $*" < "$HERE/uninstall.sh" 2>&1 | tee "$OUT/uninstall.log" ;;
  snapshot) snapshot "$@" ;;
  diff) diffsnap "$@" ;;
  loop)
    tarball
    snapshot pre
    install_ssh "$@"; check
    ph "sh -s -- --keep-ssh" < "$HERE/uninstall.sh" 2>&1 | tee "$OUT/uninstall.log"
    snapshot post
    diffsnap pre post
    install_ssh "$@"; check
    echo "LOOP PASS"
    ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
