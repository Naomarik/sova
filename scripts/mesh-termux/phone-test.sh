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
#   scripts/mesh-termux/phone-test.sh deps                 every command the scripts and Sova run on the phone comes from
#                                                          install.sh's WANT or Termux's bootstrap; apt-get -s resolves WANT
#   scripts/mesh-termux/phone-test.sh uninstall [--keep-ssh]
#   scripts/mesh-termux/phone-test.sh snapshot <name>      packages, files, services, processes → $OUT/<name>/
#   scripts/mesh-termux/phone-test.sh diff <a> <b>         what changed between two snapshots
#   scripts/mesh-termux/phone-test.sh dry-packages         no phone: install.sh's package block against a fake dpkg/apt;
#                                                          a rerun must never record a package the user installed
#   scripts/mesh-termux/phone-test.sh dry-claude           no phone: install.sh's Claude Code store block against fake
#                                                          `claude` wrappers and proot rootfs trees, and uninstall.sh's restore
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
  # every non-loopback address (IPv4 and IPv6, Wi-Fi, mobile data, tun0), as node lists them on the phone. Explicit bash on
  # the phone (the login shell has no /dev/tcp), with two positive controls through the same connect: 127.0.0.1:$port
  # (Sova) and $PHONE:$PHONE_PORT (the sshd this harness uses) must read open.
  local n res open
  n=$(addrs | wc -l)
  [ "$n" -gt 0 ] || die "no addresses to probe"
  res=$( { echo "port=$port; pport=$pport; ctl=$PHONE; ctlport=$PHONE_PORT"
           echo 'c() { { : 3<>/dev/tcp/$1/$2; } 2>/dev/null && echo open || echo closed; }'
           echo 'echo "control 127.0.0.1:$port $(c 127.0.0.1 $port)"; echo "control $ctl:$ctlport $(c $ctl $ctlport)"'
           echo 'n=0; while read -r a; do n=$((n+1)); [ "$(c $a $port)" = open ] && echo "open $a:$port"; [ "$(c $a $pport)" = open ] && echo "open $a:$pport"; done; echo "probed $n"'
           addrs; } | ph "bash -s" )
  printf '%s\n' "$res" | grep '^control' | sed "s/^/[phone-test] /" >&2
  printf '%s\n' "$res" | grep -qx "control 127.0.0.1:$port open" || die "positive control failed: 127.0.0.1:$port reads closed (the probe is broken)"
  printf '%s\n' "$res" | grep -qx "control $PHONE:$PHONE_PORT open" || die "positive control failed: sshd $PHONE:$PHONE_PORT reads closed (the probe is broken)"
  [ "$(printf '%s\n' "$res" | sed -n 's/^probed //p')" = "$n" ] || die "probed $(printf '%s\n' "$res" | sed -n 's/^probed //p') of $n addresses"
  open=$(printf '%s\n' "$res" | sed -n 's/^open //p' | grep -vxF "$([ "$peers" = 0 ] || echo "$ip:$pport")" || true)
  [ -z "$open" ] || die "open on non-loopback addresses: $(echo $open)"
  log "phone: $port closed on all $n non-loopback addresses probed; $pport $([ "$peers" = 0 ] && echo "closed on all" || echo "open on $ip only")"
  # runit restarts it after a kill, and its run script takes the wake lock again
  local pid1 pid2 wl1 wl2
  wakes() { ph 'grep -c "\[run-sova\] termux-wake-lock taken" $PREFIX/var/log/sv/sova-mesh/current || true'; }
  wl1=$(wakes)
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
  sleep 1; wl2=$(wakes)
  [ "$wl2" -gt "$wl1" ] || die "the run script did not take the wake lock again after the restart ($wl1 -> $wl2 log lines)"
  log "the run script took the wake lock again ($wl1 -> $wl2 log lines)"
  # an --ssh-key install: runit's sshd, key-only
  if ph 'grep -qE "^sshd-(keyonly|config)" ~/sova-mesh/.install/added 2>/dev/null'; then keyonly_sshd; fi
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
  # sshd: its config (restored by uninstall), what it enforces, who runs it (runit or by hand)
  ph 'md5sum $PREFIX/etc/ssh/sshd_config; ls -A $PREFIX/etc/ssh/sshd_config.d; sshd -T 2>/dev/null | grep -E "^(passwordauthentication|kbdinteractiveauthentication) ";
      ps -A -o ppid=,comm= | awk "\$2==\"sshd\"{print (\$1==1 ? \"sshd by hand\" : \"sshd under a parent\")}" | sort -u' >> "$d/ssh-services.txt"
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

# ---- dry: which packages an install run records as its own (no phone) ------------------------------------------------
# install.sh's package block (its "# ---- packages" section; from $REV when set) against a fake dpkg/apt: a first install,
# then the user installs a package of their own and removes tmux, then a rerun (it needs apt for tmux), then a rerun with
# nothing missing. packages-added (what uninstall purges) must hold what the apt runs installed and never the user's package.
dry_packages() {
  local d; d=$(mktemp -d "$OUT/dry.XXXXXX")
  mkdir -p "$d/prefix/bin" "$d/base/.install"
  script "$HERE/install.sh" | sed -n '/^# ---- packages/,/^# ---- layout/p' > "$d/block.sh"
  grep -q 'packages-added' "$d/block.sh" || { rm -rf "$d"; die "no package block in install.sh"; }
  cat > "$d/run.sh" <<'EOS'
set -eu
export LC_ALL=C
D=$1; PREFIX=$D/prefix; BASE=$D/base; M=$D/base/.install; SSH_KEY=''; STATUS=$D/status
log() { printf '[dry] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
node() { return 0; }
# the fake dpkg database: "<package> <version>" lines; a package's commands are TOOLS' names for it
add() { grep -q "^$1 " "$STATUS" || echo "$1 1.0" >> "$STATUS"; sort -o "$STATUS" "$STATUS"
        for c in $(printf '%s\n' $TOOLS | awk -F: -v p="$1" '$2==p{print $1}'); do : > "$PREFIX/bin/$c"; chmod +x "$PREFIX/bin/$c"; done; }
dpkg-query() {
  if [ -n "${3:-}" ]; then grep -q "^$3 " "$STATUS" || return 1; printf 'ii '; return 0; fi
  case "$2" in *Version*) awk '{print "ii  "$1" "$2}' "$STATUS" ;; *) awk '{print "ii  "$1}' "$STATUS" ;; esac
}
apt-get() {
  case " $* " in *" update "*) return 0 ;; esac
  local p; for p in "$@"; do case "$p" in -*|*::*|install) ;; *) add "$p"; [ "$p" != nodejs-lts ] || add c-ares ;; esac; done
}
. "$D/block.sh"
EOS
  local run="bash $d/run.sh $d" boot p rc=0
  boot="apt dpkg bash curl gzip tar findutils procps diffutils coreutils termux-tools net-tools"
  : > "$d/status"; for p in $boot; do echo "$p 1.0" >> "$d/status"; done; sort -o "$d/status" "$d/status"
  # the bootstrap's commands
  ( TOOLS=$(sed -n '/^TOOLS="/,/"$/p' "$d/block.sh" | tr -d '"' | sed 's/^TOOLS=//')
    for t in $TOOLS; do case " $boot " in *" ${t#*:} "*) : > "$d/prefix/bin/${t%%:*}"; chmod +x "$d/prefix/bin/${t%%:*}" ;; esac; done )
  $run 2>"$d/run1.log" || { cat "$d/run1.log" >&2; rm -rf "$d"; die "first install run failed"; }
  echo "python 3.12" >> "$d/status"; sort -o "$d/status" "$d/status"                 # the user's own package
  sed -i '/^tmux /d' "$d/status"; rm -f "$d/prefix/bin/tmux"                           # and tmux removed by the user
  $run 2>"$d/run2.log" || { cat "$d/run2.log" >&2; rm -rf "$d"; die "rerun failed"; }
  cp "$d/base/.install/packages-added" "$d/added2"
  $run 2>"$d/run3.log" || { cat "$d/run3.log" >&2; rm -rf "$d"; die "second rerun failed"; }
  log "packages-added: $(echo $(cat "$d/base/.install/packages-added"))"
  grep -q 'packages:' "$d/run2.log" || { log "the rerun did not call apt"; rc=1; }
  grep -q 'packages:' "$d/run3.log" && { log "the rerun with nothing missing called apt"; rc=1; }
  for p in nodejs-lts c-ares ripgrep fd git tmux termux-services; do grep -qx "$p" "$d/base/.install/packages-added" || { log "missing from packages-added: $p"; rc=1; }; done
  grep -qx python "$d/base/.install/packages-added" && { log "python (the user's) is in packages-added: a full uninstall would purge it"; rc=1; }
  cmp -s "$d/added2" "$d/base/.install/packages-added" || { log "a rerun with nothing to install changed packages-added"; rc=1; }
  rm -rf "$d"
  [ $rc = 0 ] && echo "DRY PACKAGES PASS" || { echo "DRY PACKAGES FAIL"; return 1; }
}

# ---- dry: which .claude dir Sova syncs (no phone) --------------------------------------------------------------------
# install.sh's "Claude Code's store" block (from $REV when set) against fake $PREFIX/bin/claude files and proot-distro rootfs
# trees: native and missing claude keep ~/sova-mesh/home/.claude; a proot-distro wrapper maps to <rootfs><home>/.claude;
# anything unclear keeps the default with a note. On a paired host the switch copies the synced login in byte for byte and
# keeps the container's own in the manifest; a rerun changes nothing; uninstall.sh's block restores the original.
dry_claude() {
  local d; d=$(mktemp -d "$OUT/dryc.XXXXXX")
  script "$HERE/install.sh" | sed -n "/^# ---- Claude Code's store/,/^# ---- the environment/p" > "$d/block.sh"
  script "$HERE/uninstall.sh" | sed -n "/^# ---- Claude Code's store in a proot container/,/^# ---- ssh/p" > "$d/unblock.sh"
  grep -q claude_proot_dir "$d/block.sh" && grep -q claude-credentials.orig "$d/unblock.sh" || { rm -rf "$d"; die "no Claude store block in install.sh/uninstall.sh"; }
  cat > "$d/run.sh" <<'EOS'
set -eu
export LC_ALL=C
T=$1; shift; PREFIX=$T/prefix; HOME=$T/home; BASE=$HOME/sova-mesh; M=$BASE/.install; CLAUDE_DIR=${1:-}
SVC=$PREFIX/var/service/sova-mesh
mkdir -p "$M"
# runit's sv: logged with whether the container already holds the mesh's login at that moment
sv() { printf '%s %s\n' "$*" "$(cmp -s "$BASE/home/.claude/.credentials.json" "$T/container-creds" 2>/dev/null && echo copied || echo not-copied)" >> "$T/sv.log"; }
log() { printf '[dry] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
note() { grep -qxF "$1" "$M/added" 2>/dev/null || printf '%s\n' "$1" >> "$M/added"; }
. "$(dirname "$0")/block.sh"
echo "$CLAUDE_DIR" > "$T/chosen"
echo "SOVA_SYNC_CLAUDE_DIR=$CLAUDE_DIR" > "$BASE/sova-mesh.env"
EOS
  cat > "$d/unrun.sh" <<'EOS'
set -eu
T=$1; PREFIX=$T/prefix; HOME=$T/home; BASE=$HOME/sova-mesh; M=$BASE/.install
log() { printf '[dry] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
CLAUDE_DIR=$(cat "$M/claude-dir" 2>/dev/null || true)
. "$(dirname "$0")/unblock.sh"
EOS
  local rc=0 t
  # a fresh tree: Termux prefix, a debian rootfs with users claude and root, the phone's wrapper shape
  mk() {
    t="$d/t$1"; rm -rf "$t"; mkdir -p "$t/prefix/bin" "$t/home/sova-mesh/home" "$t/home/sova-mesh/agent/sova"
    local r="$t/prefix/var/lib/proot-distro/${3:-containers/debian/rootfs}"
    [ "${3:-}" = none ] || { mkdir -p "$r/etc" "$r/home/claude/.claude" "$r/root"
      printf 'root:x:0:0:root:/root:/bin/bash\nclaude:x:1000:1000::/home/claude:/bin/bash\n' > "$r/etc/passwd"
      printf '{"claudeAiOauth":{"accessToken":"container-old"}}\n' > "$r/home/claude/.claude/.credentials.json"; }
    echo '{"version":1,"self":{"id":"t"},"peers":[]}' > "$t/home/sova-mesh/agent/sova/peers.json"
    case "$2" in
      none) ;;
      native) printf '#!/usr/bin/env node\n// the npm claude\n' > "$t/prefix/cli.js"; ln -s ../cli.js "$t/prefix/bin/claude" ;;
      *) printf '%s\n' "$2" > "$t/prefix/bin/claude" ;;
    esac
  }
  W='#!/bin/bash
set -e
rootfs="$PREFIX/var/lib/proot-distro/containers/debian/rootfs"
exec proot-distro login debian --user claude --shared-tmp --work-dir "$PWD" -- \
  env HOME=/home/claude TERM="${TERM:-xterm-256color}" \
  /usr/local/bin/claude "$@"'
  C=/prefix/var/lib/proot-distro/containers/debian/rootfs/home/claude/.claude
  expect() { # case, wanted dir (relative to the tree, "default" = ~/sova-mesh/home/.claude), want a note (1/0)
    local want=$2 got; [ "$want" != default ] || want=/home/sova-mesh/home/.claude
    got=$(cat "$t/chosen" 2>/dev/null || true); got=${got#"$t"}
    [ "$got" = "$want" ] || { log "$1: synced dir ${got:-none}, want $want"; rc=1; }
    if [ "$3" = 1 ]; then grep -q 'note:' "$t/log" || { log "$1: no note"; rc=1; }
    else ! grep -q 'note:' "$t/log" || { log "$1: unexpected note: $(cat "$t/log")"; rc=1; }; fi
  }
  # POSIX mode, like Termux's sh (dash): set -e holds inside $(...) too
  go() { ln -sfn "$t$C/.credentials.json" "$t/container-creds"; bash --posix "$d/run.sh" "$t" "$@" 2>"$t/log"; }
  mk 1 none;   go; expect "no claude" default 0
  mk 2 native; go; expect "native claude (symlink)" default 0
  mk 3 "$W";   go; expect "proot wrapper" "$C" 0
  cmp -s "$t$C/.credentials.json" "$t/home/sova-mesh/.install/claude-credentials.orig" || { log "wrapper: the container's login not kept in the manifest"; rc=1; }
  grep -q 'copied' "$t/log" && { log "wrapper, unpaired: copied a login"; rc=1; }
  mk 13 "$(printf '%s\n' "$W" | sed 's|HOME=/home/claude|HOME=/opt/c|')"; mkdir -p "$t/prefix/var/lib/proot-distro/containers/debian/rootfs/opt/c"
  go; expect "wrapper HOME= over passwd" /prefix/var/lib/proot-distro/containers/debian/rootfs/opt/c/.claude 0
  mk 4 "$(printf '%s\n' "$W" | sed 's| HOME=/home/claude||')"; go; expect "wrapper without HOME= (passwd)" "$C" 0
  mk 5 "$(printf '%s\n' "$W" | sed 's|login debian|login "$DISTRO"|')"; go; expect "distro not plain" default 1
  mk 6 "$W" none; go; expect "no rootfs" default 1
  mk 7 "$W" installed-rootfs/debian; go; expect "legacy installed-rootfs" /prefix/var/lib/proot-distro/installed-rootfs/debian/home/claude/.claude 0
  mk 8 "$(printf '%s\nexport CLAUDE_CONFIG_DIR=/x\n' "$W")"; go; expect "CLAUDE_CONFIG_DIR" default 1
  mk 9 "$(printf '%s\n' "$W" | sed 's|--user claude|--user root|; s| HOME=/home/claude||')"; go; expect "root, no HOME=" /prefix/var/lib/proot-distro/containers/debian/rootfs/root/.claude 0
  mk 14 "$(printf '%s\n' "$W" | sed 's| HOME=/home/claude||')"; rm "$t/prefix/var/lib/proot-distro/containers/debian/rootfs/etc/passwd"
  go || { log "no HOME=, no passwd: the install died (rc $?)"; rc=1; }; expect "no HOME=, no passwd" default 1
  mk 15 "$(printf '%s\n' "$W" | sed 's|login debian --user claude --shared-tmp|login --user claude --shared-tmp debian|')"; go
  expect "distro after login's options" "$C" 0
  mk 10 "$(printf '%s\n%s\n' "$W" 'proot-distro login ubuntu -- true')"; go; expect "two login lines" default 1
  # the switch on a paired host: prev env = the default store holding the mesh's login
  mk 11 "$W"; local B="$t/home/sova-mesh"
  echo '{"version":1,"self":{"id":"t"},"peers":[{"id":"p"}]}' > "$B/agent/sova/peers.json"
  mkdir -p "$B/home/.claude"; printf '{"claudeAiOauth":{"accessToken":"mesh-current"}}\n' > "$B/home/.claude/.credentials.json"
  echo "SOVA_SYNC_CLAUDE_DIR=$B/home/.claude" > "$B/sova-mesh.env"
  cp "$t$C/.credentials.json" "$d/orig"
  mkdir -p "$t/prefix/var/service/sova-mesh"
  go; expect "paired switch" "$C" 0
  [ "$(cat "$t/sv.log" 2>/dev/null)" = "$(printf '%s\n' '-w 30 down sova-mesh not-copied' 'up sova-mesh copied')" ] \
    || { log "paired switch: Sova not stopped before the copy and started after it: $(cat "$t/sv.log" 2>/dev/null)"; rc=1; }
  cmp -s "$B/home/.claude/.credentials.json" "$t$C/.credentials.json" || { log "paired switch: container login is not the mesh's, byte for byte"; rc=1; }
  [ "$(stat -c %a "$t$C/.credentials.json")" = 600 ] || { log "paired switch: container login not 0600"; rc=1; }
  cmp -s "$d/orig" "$B/.install/claude-credentials.orig" || { log "paired switch: manifest does not hold the container's original"; rc=1; }
  cp -r "$B/.install" "$d/m1"; go; expect "paired rerun" "$C" 0
  grep -q copied "$t/log" && { log "paired rerun copied again"; rc=1; }
  diff -r "$d/m1" "$B/.install" >/dev/null || { log "paired rerun changed the manifest"; rc=1; }
  go "$t/other/.claude" 2>/dev/null && { log "a --claude-dir unlike the manifest's was accepted"; rc=1; }
  printf '{"claudeAiOauth":{"accessToken":"made-in-container"}}\n' > "$t$C/.credentials.json"; cp "$t$C/.credentials.json" "$d/newer"
  bash --posix "$d/unrun.sh" "$t" 2>"$t/unlog" || { cat "$t/unlog" >&2; rc=1; }
  cmp -s "$d/orig" "$t$C/.credentials.json" || { log "uninstall did not restore the container's original"; rc=1; }
  cmp -s "$d/newer" "$t$C/.credentials.json.sova-uninstall" && [ "$(stat -c %a "$t$C/.credentials.json.sova-uninstall")" = 600 ] \
    || { log "uninstall did not keep the container's current login in .credentials.json.sova-uninstall (0600)"; rc=1; }
  grep -q 'sova-uninstall' "$t/unlog" || { log "uninstall did not say where it kept the login"; rc=1; }
  # a failure after the stop still starts Sova again
  mk 16 "$W"; B="$t/home/sova-mesh"; mkdir -p "$t/prefix/var/service/sova-mesh" "$B/home/.claude"
  echo '{"version":1,"self":{"id":"t"},"peers":[{"id":"p"}]}' > "$B/agent/sova/peers.json"
  printf '{"claudeAiOauth":{"accessToken":"mesh-current"}}\n' > "$B/home/.claude/.credentials.json"
  echo "SOVA_SYNC_CLAUDE_DIR=$B/home/.claude" > "$B/sova-mesh.env"
  chmod 500 "$t$C"; go && { log "copy failure: the install went on"; rc=1; }; chmod 700 "$t$C"
  [ "$(tail -1 "$t/sv.log" 2>/dev/null | cut -d' ' -f1-2)" = "up sova-mesh" ] || { log "copy failure: Sova not started again: $(cat "$t/sv.log" 2>/dev/null)"; rc=1; }
  # no login in the container before: uninstall removes the one Sova put there, the dir stays
  mk 12 "$W"; rm "$t$C/.credentials.json"; go; expect "wrapper, no login yet" "$C" 0
  [ -f "$t/home/sova-mesh/.install/claude-credentials.none" ] || { log "no-login: not recorded"; rc=1; }
  echo '{}' > "$t$C/.credentials.json"; bash --posix "$d/unrun.sh" "$t" 2>"$t/unlog" || rc=1
  [ ! -e "$t$C/.credentials.json" ] && [ -d "$t$C" ] || { log "no-login: uninstall left the synced login or removed the dir"; rc=1; }
  [ "$(cat "$t$C/.credentials.json.sova-uninstall" 2>/dev/null)" = '{}' ] || { log "no-login: uninstall did not keep the login it removed"; rc=1; }
  rm -rf "$d"
  [ $rc = 0 ] && echo "DRY CLAUDE PASS" || { echo "DRY CLAUDE FAIL"; return 1; }
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
# a connect() to every port 1-65535 of every address, run ON the phone with explicit bash (/dev/tcp; no fork per port, so no
# phantom-process pressure): SCAN_PAR (default 4; 16 once coincided with Android killing Termux) parallel chunks per
# address. bash's connect has no timeout, so each chunk writes the port it is on and a watchdog (every 5 s) kills a chunk stuck on one port for >10 s, records "HANG <addr> <port>" and resumes the
# chunk after it. Detached on the phone (nohup; $PREFIX/tmp/sova-scan.*, removed at the end); this side polls every 10 s.
# Positive control: the sshd this harness uses ($PHONE:$PHONE_PORT) must be in the result, else the scan is broken.
scan() {
  local name=${1:?scan <name>} d="$OUT/scan"; mkdir -p "$d"
  local list; list=$(addrs | tr '\n' ' ')
  local t0=$SECONDS
  local script
  script=$(cat <<'EOS'
W=$PREFIX/tmp/sova-scan.d; mkdir -p $W
PAR=SCANPAR; SPAN=$(( (65535 + PAR - 1) / PAR ))
chunk() { # addr lo hi id
  local p
  for ((p=$2; p<=$3; p++)); do echo $p > $W/pos.$4; { : 3<>/dev/tcp/$1/$p; } 2>/dev/null && echo "$1 $p" >> $W/open.$4; done
  echo done > $W/pos.$4
}
for a in ADDRS; do
  declare -A pid last same
  for c in $(seq 0 $((PAR-1))); do lo=$((c*SPAN+1)); hi=$((lo+SPAN-1)); [ $hi -gt 65535 ] && hi=65535; hi_[$c]=$hi
    chunk $a $lo $hi $c & pid[$c]=$!; last[$c]=''; same[$c]=0; done
  while :; do
    sleep 5; alive=0
    for c in $(seq 0 $((PAR-1))); do
      kill -0 ${pid[$c]} 2>/dev/null || continue
      alive=1; p=$(cat $W/pos.$c 2>/dev/null)
      if [ "$p" = "${last[$c]}" ]; then same[$c]=$((same[$c]+1)); else same[$c]=0; last[$c]=$p; fi
      if [ ${same[$c]} -ge 2 ] && [ "$p" != done ]; then
        kill ${pid[$c]} 2>/dev/null; wait ${pid[$c]} 2>/dev/null; echo "HANG $a $p" >> $W/hang
        if [ $p -lt ${hi_[$c]} ]; then chunk $a $((p+1)) ${hi_[$c]} $c & pid[$c]=$!; fi
        last[$c]=''; same[$c]=0
      fi
    done
    [ $alive = 1 ] || break
  done
  wait
  unset pid last same
done
# confirm: a connect to one's own address can "succeed" once by connecting to itself (the kernel picked the same port as
# the source port); a real listener accepts two more connects. Only a port inside the ephemeral (source port) range can be
# a self-connect: outside it, a port that does not accept again stays in the result as "ONCE <addr> <port>"
read -r elo ehi < /proc/sys/net/ipv4/ip_local_port_range 2>/dev/null || { elo=32768; ehi=60999; }
cat $W/open.* 2>/dev/null | sort -u -k1,1 -k2,2n | while read -r a p; do
  if { : 3<>/dev/tcp/$a/$p; } 2>/dev/null && { : 3<>/dev/tcp/$a/$p; } 2>/dev/null; then echo "$a $p"
  elif [ $p -ge ${elo:-32768} ] && [ $p -le ${ehi:-60999} ]; then echo "SELF $a $p"
  else echo "ONCE $a $p"; fi
done > $W/confirmed
{ grep -v '^SELF' $W/confirmed; cat $W/hang 2>/dev/null; grep '^SELF' $W/confirmed; } > $PREFIX/tmp/sova-scan.res
rm -rf $W
touch $PREFIX/tmp/sova-scan.done
EOS
)
  local par=${SCAN_PAR:-4}; script=${script//SCANPAR/$par}
  printf '%s\n' "${script//ADDRS/$list}" | ph "cat > \$PREFIX/tmp/sova-scan.sh; rm -rf \$PREFIX/tmp/sova-scan.d \$PREFIX/tmp/sova-scan.res \$PREFIX/tmp/sova-scan.done; nohup bash \$PREFIX/tmp/sova-scan.sh > /dev/null 2>&1 < /dev/null &"
  local down=0 rc
  while :; do
    rc=0; ph 'test -e $PREFIX/tmp/sova-scan.done' 2>/dev/null || rc=$?
    [ $rc = 0 ] && break
    # ssh itself failing (255) three polls in a row: the phone's sshd is gone, stop instead of retrying for 90 min
    if [ $rc = 255 ]; then down=$((down+1)); [ $down -lt 3 ] || die "scan $name: ssh to the phone fails (sshd gone? Termux killed?)"; else down=0; fi
    sleep 10
    [ $((SECONDS - t0)) -lt 5400 ] || die "scan $name: not done within 90 min"
  done
  ph 'cat $PREFIX/tmp/sova-scan.res; rm -f $PREFIX/tmp/sova-scan.sh $PREFIX/tmp/sova-scan.res $PREFIX/tmp/sova-scan.done' > "$d/$name.txt"
  grep -qx "$PHONE $PHONE_PORT" "$d/$name.txt" || die "scan $name broken: the control (sshd $PHONE:$PHONE_PORT) is not in the result"
  log "scan $name: $(grep -vcE '^(HANG|SELF)' "$d/$name.txt") open (address, port) pairs, $(grep -c '^ONCE' "$d/$name.txt") of them accepting once only, $(grep -c '^HANG' "$d/$name.txt") hung ports, $(grep -c '^SELF' "$d/$name.txt") self-connects (ephemeral range) set aside, $(echo $list | wc -w) addresses, $par parallel, $((SECONDS - t0)) s; control $PHONE:$PHONE_PORT open"
}

# ---- after Termux was force-stopped and opened again (by hand on the phone, nothing typed) ----------------------------
# sshd (runit, key-only), Sova and the wake lock must all be back on their own.
reopen() {
  local out
  out=$(ph 'export SVDIR=$PREFIX/var/service; sv status sova-mesh; echo "uptime-runsvdir $(ps -A -o etimes=,args= | awk "/runsvdir/ && !/awk/{print \$1; exit}")";
    curl -fsS -m 5 http://127.0.0.1:4800/api/health; echo;
    grep "\[run-sova\] termux-wake-lock taken" $PREFIX/var/log/sv/sova-mesh/current | tail -1') || die "ssh to the phone failed: sshd did not come back"
  printf '%s\n' "$out" | sed 's/^/[phone] /' >&2
  grep -q '^run: sova-mesh:' <<< "$out" || die "sova-mesh is not running"
  grep -q '"ok":true' <<< "$out" || die "no health"
  grep -q 'termux-wake-lock taken' <<< "$out" || die "the run script did not take the wake lock"
  keyonly_sshd
  echo "REOPEN PASS"
}

# runit runs sshd (no sshd started by hand), sshd enforces key-only, and a password login is refused before any password
# is asked
keyonly_sshd() {
  local out pw
  out=$(ph 'SVDIR=$PREFIX/var/service sv status sshd; sshd -T 2>/dev/null | grep -E "^(passwordauthentication|kbdinteractiveauthentication) ";
    ps -A -o ppid=,comm= | awk "\$2==\"sshd\" && \$1==1{print \"sshd by hand\"}"')
  printf '%s\n' "$out" | sed 's/^/[phone] /' >&2
  grep -q '^run: sshd:' <<< "$out" || die "sshd is not running under runit"
  ! grep -q 'sshd by hand' <<< "$out" || die "an sshd started by hand still runs"
  grep -qx 'passwordauthentication no' <<< "$out" && grep -qx 'kbdinteractiveauthentication no' <<< "$out" || die "sshd allows password logins"
  pw=$(ssh -o BatchMode=yes -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive -o ConnectTimeout=10 -p "$PHONE_PORT" "$PHONE" true 2>&1 || true)
  grep -q 'Permission denied (publickey)' <<< "$pw" || die "password login not refused as key-only: $pw"
  log "sshd: runit's, key-only; a password login is refused: $(grep -o 'Permission denied (publickey)' <<< "$pw")"
}

# ---- deps: every command the phone runs comes from WANT or Termux's bootstrap -----------------------------------------
# What every Termux has from its first start: the packages (not libraries) of an older aarch64 bootstrap, all of them also
# in the current one (termux-packages bootstrap-2026.09.20: that one adds gzip, bzip2, xz-utils, lsof, ... which an older
# Termux lacks). Only the Essential ones can't be removed; any other command must be in install.sh's TOOLS.
BOOTSTRAP="apt dpkg bash ca-certificates command-not-found coreutils curl dash debianutils diffutils dos2unix ed findutils gawk
  gpgv grep inetutils less nano net-tools openssl patch procps psmisc readline sed tar termux-am termux-exec termux-keyring
  termux-licenses termux-tools unzip util-linux"
# what Sova and pi run at runtime (not visible in these scripts), and the commands phone-test itself runs on the phone
RUNTIME="node corepack rg fd git tmux bash sh uname pgrep ps kill"
PHONE_CMDS="bash node curl ifconfig dpkg-query apt-mark find ps awk sort stat md5sum timeout tr readlink seq grep sed cat head
  tail wc rm mkdir nohup sleep touch test ls cut sv termux-wake-lock"
# Words of these scripts that are never commands there (text in messages, options, file names)
NOT_CMDS="install file service dir top time more test link join users script claude"  # claude: the ~/.claude dir name
deps() {
  local want tools words out bad=0
  want=$(script "$HERE/install.sh" | sed -n 's/^WANT="\(.*\)"$/\1/p')
  tools=$(script "$HERE/install.sh" | sed -n '/^TOOLS="/,/"$/p' | tr -d '"' | sed 's/^TOOLS=//' | tr ' ' '\n' | grep : || true)
  [ -n "$want" ] && [ -n "$tools" ] || die "can't read WANT/TOOLS from install.sh"
  want="$want openssh"   # install.sh adds it with --ssh-key, the only case its ssh/sshd lines run
  # candidate command words: code only (comments dropped), then whatever of them is an executable on the phone
  words=$( { script "$HERE/install.sh"; script "$HERE/uninstall.sh"; } | sed -E 's/(^|[[:space:]])#.*$//' \
    | grep -oE '[a-zA-Z][a-zA-Z0-9_.+-]*' | sort -u | grep -vxF -f <(tr ' ' '\n' <<< "$NOT_CMDS") ; tr ' \n' '\n\n' <<< "$RUNTIME $PHONE_CMDS" | grep . )
  words=$(sort -u <<< "$words")
  out=$( { echo "WANT=\"$want\""; echo "BOOT=\"$(echo $BOOTSTRAP)\""; echo 'WORDS="'"$(echo $words)"'"'; cat <<'EOS'
closure() { apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances --no-pre-depends $1 2>/dev/null | grep -v '^ ' | grep -v '[<>]' | sort -u; }
closure "$WANT" > $PREFIX/tmp/sova-deps.want
closure "$BOOT" > $PREFIX/tmp/sova-deps.boot
dpkg-query -W -f='${Package} ${Essential}\n' | awk '$2=="yes"{print $1}' > $PREFIX/tmp/sova-deps.ess
for w in $WORDS; do
  f=$PREFIX/bin/$w; [ -e "$f" ] || { echo "absent $w"; continue; }
  o=$(dpkg -S "$(readlink -f "$f")" 2>/dev/null | head -1 | cut -d: -f1); [ -n "$o" ] || o=$(dpkg -S "$f" 2>/dev/null | head -1 | cut -d: -f1)
  if grep -qxF "$o" $PREFIX/tmp/sova-deps.want; then k=want; elif grep -qxF "$o" $PREFIX/tmp/sova-deps.ess; then k=essential
  elif grep -qxF "$o" $PREFIX/tmp/sova-deps.boot; then k=bootstrap; else k=OTHER; fi
  echo "cmd $w ${o:-?} $k"
done
echo "sim $(apt-get install -s --reinstall --no-install-recommends $WANT 2>&1 | grep -c '^Reinst\|^Inst') of $(echo $WANT | wc -w)"
for p in $WANT; do apt-cache policy $p | grep -q 'Candidate: [0-9]' && echo "candidate $p" || echo "nocandidate $p"; done
rm -f $PREFIX/tmp/sova-deps.*
EOS
  } | ph 'bash -s' )
  printf '%s\n' "$out" > "$OUT/deps.txt"
  # every TOOLS command is in $PREFIX/bin (the service's PATH) once installed: not Android's /system/bin copy
  if ph 'test -d ~/sova-mesh'; then
    local c0; for c0 in $(cut -d: -f1 <<< "$tools"); do grep -q "^cmd $c0 " <<< "$out" || { log "TOOLS command $c0 is not in \$PREFIX/bin although Sova is installed"; bad=1; }; done
  fi
  # a command whose package is neither Essential nor brought by WANT (a non-essential bootstrap package a user can remove,
  # one only newer bootstraps have, or one only this phone's user installed): install.sh must know its package (TOOLS)
  local c o k
  while read -r _ c o k; do
    grep -qxF "$c:$o" <<< "$tools" || { log "$c ($o, $k) is not in install.sh's TOOLS: a fresh Termux may lack it"; bad=1; }
  done < <(grep -E ' (bootstrap|OTHER)$' <<< "$out")
  # TOOLS names the right package for every command that is on the phone
  while IFS=: read -r c o; do
    local real; real=$(grep "^cmd $c " <<< "$out" | awk '{print $3}' || true)
    [ -z "$real" ] || [ "$real" = "$o" ] || { log "TOOLS says $c:$o, the phone says $real"; bad=1; }
  done <<< "$tools"
  if grep '^nocandidate' <<< "$out" >&2; then bad=1; fi
  local sim; sim=$(sed -n 's/^sim //p' <<< "$out")
  [ "${sim%% of*}" = "${sim##*of }" ] || { log "apt-get -s resolves $sim WANT packages"; bad=1; }
  log "deps: $(grep -c '^cmd ' <<< "$out") commands on the phone ($(grep -c ' want$' <<< "$out") from WANT, $(grep -c ' essential$' <<< "$out") essential, $(grep -cE ' (bootstrap|OTHER)$' <<< "$out") via TOOLS), $(grep -c '^absent' <<< "$out") words not a command there; apt-get -s: $sim; WANT: $want"
  [ $bad = 0 ] && echo "DEPS PASS" || { echo "DEPS FAIL"; return 1; }
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
case "$cmd" in tarball|diff|dry-packages|dry-claude|"") ;; *) need PHONE ;; esac
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
  reopen) reopen ;;
  deps) deps ;;
  placeholder) # on: mesh on with the gate's placeholder peer (listener on the tailnet IP); off: mesh off
    case "${1:-}" in
      on) [ "$(phone_put /api/mesh/peers '{"peers":[{"id":"gate-dummy","label":"gate dummy","nodeId":"nGATEDUMMY00CNTRL","name":"100.64.0.1","url":"http://100.64.0.1:4801"}]}')" = 200 ] || die "PUT placeholder" ;;
      off) [ "$(phone_put /api/mesh/peers '{"peers":[]}')" = 200 ] || die "PUT peers []" ;;
      *) die "placeholder on|off" ;;
    esac; echo; log "placeholder $1" ;;
  scan) scan "$@" ;;
  scandiff) d="$OUT/scan"; diff <(grep -v '^SELF' "$d/${1:?}.txt") <(grep -v '^SELF' "$d/${2:?}.txt") && echo "SCAN SAME: $1 == $2 (open + hung, self-connects in the ephemeral range excluded; they stay listed in the scan files)" || { echo "SCAN DIFFERS: $1 != $2"; exit 1; } ;;
  diff) diffsnap "$@" ;;
  dry-packages) dry_packages ;;
  dry-claude) dry_claude ;;
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
