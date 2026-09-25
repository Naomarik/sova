#!/data/data/com.termux/files/usr/bin/sh
# Sova mesh host on Android, in native Termux (no proot). One pasted command, safe to rerun (it converges):
#
#   curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/master/scripts/mesh-termux/install.sh | sh
#
# Another ref or tag: use it in the URL and pass it on, so the source matches the script:
#   curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/<ref>/scripts/mesh-termux/install.sh | sh -s -- --ref <ref>
#
# Options (all optional):
#   --ref <ref>            git ref whose source tarball is installed (default: $SOVA_REF, else the DEFAULT_REF below)
#   --source-url <url>     the source tarball (tar.gz, one top-level dir) instead of GitHub's, e.g. one served over
#                          the tailnet for testing (curl syntax: http(s)://, file://)
#   --tailnet-ip <ip>      this phone's Tailscale IP (default: the 100.64.0.0/10 address on tun*; Termux cannot reach
#                          Tailscale's LocalAPI, so it is read from the interface)
#   --id <slug> --label <text>   this host's mesh id and label (default: phone / "Phone"); the id is only set once
#   --node-id <StableID> --dns <MagicDNS name>   this phone's Tailscale StableID and name, for its own hello
#   --port <n> --peer-port <n>   main listener 127.0.0.1:<port> (default 4800), peer listener <tailnet-ip>:<peer-port> (4801)
#   --ssh-key <public key> also keep an sshd for remote access: openssh, the key in ~/.ssh/authorized_keys, and a
#                          runit sshd service (unless an sshd already runs). `uninstall.sh --keep-ssh` keeps these.
#
# What it adds, all recorded in ~/sova-mesh/.install so uninstall.sh removes exactly that:
#   packages nodejs-lts fd tmux termux-services (+ their new dependencies; pnpm comes from node's corepack, pinned by
#   package.json), ~/sova-mesh (app, agent dir, isolated HOME, TMPDIR, env), the runit service sova-mesh,
#   ~/.termux/boot/sova-mesh (used by Termux:Boot), and a Termux wake lock.
# It never touches /sdcard, never binds 0.0.0.0, never prints a secret, and writes nothing outside $HOME and $PREFIX.
set -eu
export LC_ALL=C

DEFAULT_REF=master
REPO=Naomarik/sova

log() { printf '[sova-termux] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

# The whole body is one function, so `curl | sh` parses it completely before anything runs (no command can
# swallow the rest of the script from stdin).
main() {
# ---- arguments -------------------------------------------------------------------------------------
REF=${SOVA_REF:-$DEFAULT_REF}
SOURCE_URL=${SOVA_SOURCE_URL:-}
TAILNET_IP=${SOVA_TAILNET_IP:-}
HOST_ID='' HOST_LABEL='' NODE_ID='' DNS_NAME='' SSH_KEY=''
PORT=${SOVA_PORT:-4800}
PEER_PORT=${SOVA_PEER_PORT:-4801}
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF=${2:?}; shift 2 ;;
    --source-url) SOURCE_URL=${2:?}; shift 2 ;;
    --tailnet-ip) TAILNET_IP=${2:?}; shift 2 ;;
    --id) HOST_ID=${2:?}; shift 2 ;;
    --label) HOST_LABEL=${2:?}; shift 2 ;;
    --node-id) NODE_ID=${2:?}; shift 2 ;;
    --dns) DNS_NAME=${2:?}; shift 2 ;;
    --port) PORT=${2:?}; shift 2 ;;
    --peer-port) PEER_PORT=${2:?}; shift 2 ;;
    --ssh-key) SSH_KEY=${2:?}; shift 2 ;;
    *) die "unknown option: $1 (see the header of install.sh)" ;;
  esac
done
[ -n "$SOURCE_URL" ] || SOURCE_URL="https://codeload.github.com/$REPO/tar.gz/$REF"

# ---- preconditions ---------------------------------------------------------------------------------
[ -n "${PREFIX:-}" ] && [ -d "$PREFIX" ] && [ "$(uname -o 2>/dev/null)" = Android ] || die "run this inside Termux on Android"
case "$PREFIX" in /data/data/com.termux/files/usr) ;; *) die "unexpected \$PREFIX $PREFIX (Termux's is /data/data/com.termux/files/usr)" ;; esac
case "$HOME" in /data/data/com.termux/files/home*) ;; *) die "\$HOME must be Termux's home (never /sdcard): $HOME" ;; esac
[ "$(id -u)" != 0 ] || die "do not run as root"
command -v termux-wake-lock >/dev/null || die "termux-wake-lock is missing (package termux-tools)"
case "$PORT$PEER_PORT" in *[!0-9]*) die "ports must be numbers" ;; esac
[ "$PORT" != "$PEER_PORT" ] || die "--port and --peer-port must differ"

BASE="$HOME/sova-mesh"
M="$BASE/.install"      # the manifest uninstall.sh reads
SVC="$PREFIX/var/service/sova-mesh"
BOOT="$HOME/.termux/boot/sova-mesh"
mkdir -p "$M"
chmod 700 "$BASE"
note() { grep -qxF "$1" "$M/added" 2>/dev/null || printf '%s\n' "$1" >> "$M/added"; }  # one thing we added, once

# a Tailscale IPv4 (100.64.0.0/10) or nothing
tailnet_ipv4() {
  case "$1" in 100.*.*.*) ;; *) return 1 ;; esac
  b=$(printf '%s' "$1" | cut -d. -f2)
  case "$b" in ''|*[!0-9]*) return 1 ;; esac
  [ "$b" -ge 64 ] && [ "$b" -le 127 ]
}
if [ -z "$TAILNET_IP" ]; then
  TAILNET_IP=$(ifconfig 2>/dev/null | awk '/^[a-z]/{i=$1} i~/^tun/ && $1=="inet"{print $2}' | while read -r a; do tailnet_ipv4 "$a" && echo "$a"; done | head -1)
  [ -n "$TAILNET_IP" ] || die "no Tailscale address found on tun*: open the Tailscale app, connect, keep Termux out of its excluded apps, rerun (or pass --tailnet-ip 100.x.y.z)"
fi
tailnet_ipv4 "$TAILNET_IP" || die "--tailnet-ip $TAILNET_IP is not a Tailscale address (100.64.0.0/10)"
log "tailnet IP: $TAILNET_IP (peer listener), main listener 127.0.0.1:$PORT"

# ---- packages --------------------------------------------------------------------------------------
installed() { dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 2>/dev/null | awk '$1=="ii"{print $2}' | sort; }
versions() { dpkg-query -W -f='${db:Status-Abbrev} ${Package} ${Version}\n' 2>/dev/null | awk '$1=="ii"{print $2" "$3}' | sort; }
[ -f "$M/packages-before" ] || installed > "$M/packages-before"   # the state before the FIRST install, kept forever
WANT="nodejs-lts fd tmux termux-services"
[ -z "$SSH_KEY" ] || WANT="$WANT openssh"
missing=''
for p in $WANT; do dpkg-query -W -f='${db:Status-Abbrev}' "$p" 2>/dev/null | grep -q '^ii' || missing="$missing $p"; done
if [ -n "$missing" ]; then
  log "packages:$missing"
  mkdir -p "$BASE/dl/apt/partial"
  versions > "$M/.versions-pre"
  # debs are cached inside ~/sova-mesh; never `pkg upgrade`: only what these packages need changes
  APT="-o Dir::Cache::archives=$BASE/dl/apt -o Dpkg::Options::=--force-confold -o Dpkg::Options::=--force-confdef"
  export DEBIAN_FRONTEND=noninteractive
  # shellcheck disable=SC2086
  apt-get $APT update -qq >&2 || log "apt-get update failed; trying the cached lists"
  # shellcheck disable=SC2086
  apt-get $APT install -y -qq --no-install-recommends $missing >&2 || die "apt-get install$missing failed"
  versions > "$M/.versions-post"
  installed | comm -13 "$M/packages-before" - > "$M/.new"
  cat "$M/.new" "$M/packages-added" 2>/dev/null | sort -u > "$M/.added" && mv "$M/.added" "$M/packages-added"
  # packages that existed and were upgraded as a dependency: reported, never rolled back
  join "$M/.versions-pre" "$M/.versions-post" | awk '$2!=$3' >> "$M/packages-upgraded" || true
  rm -f "$M/.new" "$M/.versions-pre" "$M/.versions-post"
  rm -rf "$BASE/dl/apt"
fi
touch "$M/packages-added"
log "packages added by this installer: $(wc -l < "$M/packages-added" | tr -d ' ')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || die "node $(node -v) is older than Sova's >=22.19"
for t in rg fd git curl; do command -v $t >/dev/null || die "$t is missing"; done

# ---- layout ----------------------------------------------------------------------------------------
mkdir -p "$BASE/home" "$BASE/tmp" "$BASE/agent" "$BASE/dl" "$BASE/bin"
chmod 700 "$BASE/home" "$BASE/tmp" "$BASE/agent"
RUN_ENV="HOME=$BASE/home TMPDIR=$BASE/tmp COREPACK_HOME=$BASE/home/.cache/corepack COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1"
# pnpm through node's corepack (Termux has no pnpm package), cached inside ~/sova-mesh. Not the 12.x package.json
# pins: pnpm 12 is a native binary whose store lock fails on Android ("lock_shared() not supported"). pnpm 11 (plain
# JS) installs the same lockfile (v9.0) unchanged; --frozen-lockfile is the guard.
PNPM_VERSION=${SOVA_PNPM_VERSION:-11.27.1}
pnpm_() { env $RUN_ENV COREPACK_ENABLE_STRICT=0 corepack "pnpm@$PNPM_VERSION" "$@"; }
command -v corepack >/dev/null || die "corepack is missing from nodejs-lts"

# ---- the source ------------------------------------------------------------------------------------
log "source: $SOURCE_URL"
curl -fsSL --retry 3 -o "$BASE/dl/source.tar.gz.part" "$SOURCE_URL" || die "download failed: $SOURCE_URL"
mv "$BASE/dl/source.tar.gz.part" "$BASE/dl/source.tar.gz"
SUM=$(sha256sum "$BASE/dl/source.tar.gz" | cut -d' ' -f1)
COMMIT=$(gzip -dc "$BASE/dl/source.tar.gz" | git get-tar-commit-id 2>/dev/null || true)
if [ -f "$BASE/app/dist/index.html" ] && [ -f "$BASE/app/node_modules/.modules.yaml" ] && [ "$(cat "$BASE/app/.source-sha256" 2>/dev/null)" = "$SUM" ]; then
  log "app: already built from this source (${COMMIT:-sha256 $SUM})"
else
  rm -rf "$BASE/app.new" && mkdir -p "$BASE/app.new"
  tar -xzf "$BASE/dl/source.tar.gz" -C "$BASE/app.new" --strip-components=1
  [ -f "$BASE/app.new/package.json" ] && [ -f "$BASE/app.new/server/index.ts" ] || die "the tarball is not a Sova source tree"
  cd "$BASE/app.new"
  log "pnpm $PNPM_VERSION install --frozen-lockfile (a few minutes on a phone)"
  pnpm_ install --frozen-lockfile --pm-on-fail=ignore --reporter=append-only >"$BASE/tmp/pnpm-install.log" 2>&1 || { tail -20 "$BASE/tmp/pnpm-install.log" >&2; die "pnpm install failed (log: $BASE/tmp/pnpm-install.log)"; }
  log "vite build"
  env $RUN_ENV nice -n 10 node node_modules/vite/bin/vite.js build --logLevel warn >"$BASE/tmp/vite-build.log" 2>&1 || { tail -20 "$BASE/tmp/vite-build.log" >&2; die "vite build failed (log: $BASE/tmp/vite-build.log)"; }
  [ -f dist/index.html ] || die "vite build produced no dist/index.html"
  printf '%s\n' "$SUM" > .source-sha256
  printf '{"commit":"%s","ref":"%s","sha256":"%s","installedAt":"%s"}\n' "$COMMIT" "$REF" "$SUM" "$(date -u +%FT%TZ)" > BUILD_COMMIT
  cd "$BASE"
  rm -rf "$BASE/app.prev"
  [ -d "$BASE/app" ] && mv "$BASE/app" "$BASE/app.prev"
  mv "$BASE/app.new" "$BASE/app"
  NEW_APP=1
fi
rm -f "$BASE/dl/source.tar.gz"

# ---- the agent dir ---------------------------------------------------------------------------------
ln -sfn "$BASE/agent" "$BASE/app/.agent"
( cd "$BASE/app" && env $RUN_ENV node scripts/hermetic-agent-dir.mjs >/dev/null ) || die "agent dir setup failed"
if [ ! -e "$BASE/agent/auth.json" ]; then
  ( umask 077 && printf '{}\n' > "$BASE/agent/auth.json" )
  log "agent: auth.json created empty (logins arrive by mesh sync)"
fi
chmod 600 "$BASE/agent/auth.json"
# this host's identity, seeded ONCE with no peers (mesh off); the self id is never rewritten afterwards
if [ ! -e "$BASE/agent/sova/peers.json" ]; then
  mkdir -p "$BASE/agent/sova"
  ( umask 077 && node -e 'const [id,label,file]=process.argv.slice(1);const fs=require("fs");fs.writeFileSync(file+".tmp",JSON.stringify({version:1,self:{id,label},peers:[],sync:{},frontDoor:null},null,2)+"\n");fs.renameSync(file+".tmp",file)' \
    "${HOST_ID:-phone}" "${HOST_LABEL:-Phone}" "$BASE/agent/sova/peers.json" ) || die "peers.json seed failed"
  log "agent: peers.json seeded (self ${HOST_ID:-phone}, no peers: mesh off)"
fi

# ---- the environment -------------------------------------------------------------------------------
# Tailscale's LocalAPI is out of Termux's reach: the peer listener identifies a caller by its tailnet source IP
# (SOVA_MESH_IDENTITY=addresses; every peers.json entry must carry its StableID and its tailnet IP).
{
  echo "PORT=$PORT"
  echo "HOST=127.0.0.1"
  echo "SOVA_PEER_HOST=$TAILNET_IP"
  echo "SOVA_PEER_PORT=$PEER_PORT"
  echo "SOVA_MESH_IDENTITY=addresses"
  [ -z "$NODE_ID" ] || echo "SOVA_SELF_NODE_ID=$NODE_ID"
  [ -z "$DNS_NAME" ] || echo "SOVA_SELF_DNS=$DNS_NAME"
  echo "PI_CODING_AGENT_DIR=$BASE/agent"
  echo "HOME=$BASE/home"
  echo "TMPDIR=$BASE/tmp"
  echo "PATH=$PREFIX/bin"
} > "$BASE/sova-mesh.env.tmp"
if cmp -s "$BASE/sova-mesh.env.tmp" "$BASE/sova-mesh.env"; then rm "$BASE/sova-mesh.env.tmp"; else mv "$BASE/sova-mesh.env.tmp" "$BASE/sova-mesh.env"; NEW_ENV=1; fi

cat > "$BASE/bin/run-sova" <<EOF
#!$PREFIX/bin/sh
# runit's ./run for sova-mesh (written by install.sh): Sova on 127.0.0.1:$PORT, peer listener $TAILNET_IP:$PEER_PORT
# (only while peers.json lists a peer). The extension cache is warmed beside the boot so the first session doesn't stall.
set -a
. "$BASE/sova-mesh.env"
set +a
cd "$BASE/app"
( sleep 2; exec nice -n 10 node scripts/mesh-vps/warm-extensions.mjs > "$BASE/tmp/warm.log" 2>&1 ) &
exec node --import tsx server/index.ts
EOF
chmod 700 "$BASE/bin/run-sova"
cp "$BASE/app/scripts/mesh-termux/uninstall.sh" "$BASE/uninstall.sh" 2>/dev/null && chmod 700 "$BASE/uninstall.sh" || true

# ---- the runit service -----------------------------------------------------------------------------
[ -d "$SVC" ] || note "service $SVC"
[ -d "$PREFIX/var/log/sv" ] || note "dir $PREFIX/var/log/sv"
mkdir -p "$SVC/log" "$PREFIX/var/log/sv/sova-mesh"
note "dir $PREFIX/var/log/sv/sova-mesh"
printf '#!%s/bin/sh\nexec 2>&1\nexec "%s/bin/run-sova"\n' "$PREFIX" "$BASE" > "$SVC/run.tmp" && chmod 700 "$SVC/run.tmp" && mv "$SVC/run.tmp" "$SVC/run"
ln -sfn "$PREFIX/share/termux-services/svlogger" "$SVC/log/run"
export SVDIR="$PREFIX/var/service"
# runsvdir (termux-services' service-daemon) normally starts with a login shell; start it now if it isn't up.
# Starting it makes runsv create supervise/ dirs in services that were already there: recorded for uninstall.
if ! pgrep -f "runsvdir $SVDIR" >/dev/null 2>&1; then
  log "starting termux-services' service daemon"
  for d in "$SVDIR"/*/ "$SVDIR"/*/log/; do [ -d "$d" ] && [ ! -e "${d}supervise" ] && note "dir ${d}supervise"; done
  # and their loggers start (a log/ service has no down file) and write $PREFIX/var/log/sv/<service>
  for d in "$SVDIR"/*/log/; do n=${d%/log/}; n=${n##*/}; [ -d "$d" ] && [ ! -e "$PREFIX/var/log/sv/$n" ] && note "dir $PREFIX/var/log/sv/$n"; done
  [ -d "$PREFIX/var/run" ] || note "dir $PREFIX/var/run"
  [ -e "$PREFIX/var/run/service-daemon.pid" ] || note "file $PREFIX/var/run/service-daemon.pid"
  # the environment termux-services' profile.d/start-services.sh gives it (svlogger needs LOGDIR)
  LOGDIR="$PREFIX/var/log" service-daemon start >/dev/null 2>&1 || true
  i=0; while [ $i -lt 20 ] && ! [ -p "$SVC/supervise/control" ]; do sleep 0.5; i=$((i+1)); done
fi
[ -p "$SVC/supervise/control" ] || die "runit did not pick up $SVC (is service-daemon running?)"
rm -f "$SVC/down"

# ---- ssh (only with --ssh-key) ---------------------------------------------------------------------
if [ -n "$SSH_KEY" ]; then
  case "$SSH_KEY" in ssh-*' '*|ecdsa-*' '*|sk-*' '*) ;; *) die "--ssh-key must be an OpenSSH public key line" ;; esac
  [ -d "$HOME/.ssh" ] || { mkdir -p "$HOME/.ssh"; note "dir $HOME/.ssh"; }
  chmod 700 "$HOME/.ssh"
  [ -f "$HOME/.ssh/authorized_keys" ] || note "file $HOME/.ssh/authorized_keys"
  if ! grep -qxF "$SSH_KEY" "$HOME/.ssh/authorized_keys" 2>/dev/null; then
    printf '%s\n' "$SSH_KEY" >> "$HOME/.ssh/authorized_keys"
    printf '%s\n' "$SSH_KEY" > "$M/ssh-key"
  fi
  chmod 600 "$HOME/.ssh/authorized_keys"
  if [ -f "$SVDIR/sshd/down" ] && ! pgrep -x sshd >/dev/null; then
    rm -f "$SVDIR/sshd/down"; sv up sshd >/dev/null 2>&1 || true; note "sshd-service"
  fi
fi

# ---- start at boot, wake lock ----------------------------------------------------------------------
[ -d "$HOME/.termux" ] || note "dir $HOME/.termux"
[ -d "$HOME/.termux/boot" ] || note "dir $HOME/.termux/boot"
mkdir -p "$HOME/.termux/boot"
printf '#!%s/bin/sh\n# Termux:Boot: start Sova'"'"'s runit services after a reboot (written by sova-mesh install.sh)\ntermux-wake-lock\n. %s/etc/profile.d/start-services.sh\n' "$PREFIX" "$PREFIX" > "$BOOT"
chmod 700 "$BOOT"
note "file $BOOT"
termux-wake-lock
note "wake-lock"

# ---- (re)start and verify --------------------------------------------------------------------------
if [ -n "${NEW_APP:-}${NEW_ENV:-}" ]; then sv restart sova-mesh >/dev/null; else sv up sova-mesh >/dev/null; fi
log "waiting for http://127.0.0.1:$PORT/api/health"
i=0
until curl -fsS -m 2 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; do
  i=$((i+1)); [ $i -lt 120 ] || { tail -20 "$PREFIX/var/log/sv/sova-mesh/current" >&2 2>/dev/null; die "no health within 120 s (log: $PREFIX/var/log/sv/sova-mesh/current)"; }
  sleep 1
done
log "health ok: $(sv status sova-mesh | cut -d';' -f1)"
# exposure: the main port answers on loopback only; the peer port only on the tailnet IP, and not at all while the mesh is
# off. Proven by connecting to every non-loopback address of every interface (Wi-Fi, mobile data, tun0; IPv4 and IPv6),
# as node lists them: Android denies apps ifconfig's IPv6 view and ss/netstat.
open_on() { # port -> the non-loopback addresses that accept a connection on it
  node -e '
    const net = require("net"), port = +process.argv[1];
    const addrs = Object.entries(require("os").networkInterfaces()).flatMap(([n, a]) =>
      a.filter((x) => !x.internal).map((x) => (x.family === "IPv6" && x.address.startsWith("fe80:") ? `${x.address}%${n}` : x.address)));
    Promise.all(addrs.map((host) => new Promise((ok) => {
      const s = net.connect({ host, port, timeout: 3000 });
      s.on("connect", () => { s.destroy(); ok(host); });
      s.on("error", () => ok(null));
      s.on("timeout", () => { s.destroy(); ok(null); });
    }))).then((r) => r.filter(Boolean).forEach((h) => console.log(h)));' "$1"
}
peers=$(node -e 'try{console.log((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).peers??[]).length)}catch{console.log(0)}' "$BASE/agent/sova/peers.json")
bad=$(open_on "$PORT")
[ -z "$bad" ] || die "the main port answers on $(echo $bad) :$PORT (must be loopback only)"
bad=$(open_on "$PEER_PORT" | grep -vxF "$([ "$peers" = 0 ] || echo "$TAILNET_IP")" || true)
[ -z "$bad" ] || die "the peer port answers on $(echo $bad) :$PEER_PORT"
log "exposure ok on $(node -e 'console.log(Object.values(require("os").networkInterfaces()).flat().filter((x)=>!x.internal).length)') addresses: 127.0.0.1:$PORT only; peer port $([ "$peers" = 0 ] && echo "closed (mesh off)" || echo "on $TAILNET_IP only")"

upgraded=''
[ ! -s "$M/packages-upgraded" ] || upgraded="Existing packages upgraded as dependencies: $(wc -l < "$M/packages-upgraded" | tr -d ' ') (see ~/sova-mesh/.install/packages-upgraded)."
cat >&2 <<EOF

Sova is running: http://127.0.0.1:$PORT (on this phone). Version: $(cat "$BASE/app/BUILD_COMMIT")
Service: sv status|restart sova-mesh   Log: $PREFIX/var/log/sv/sova-mesh/current   Uninstall: sh ~/sova-mesh/uninstall.sh
$upgraded

Do these on the phone by hand (Termux can't):
  1. Settings > Developer options > "Disable child process restrictions" ON (Android 14+). Without it Android kills
     Sova's worker processes (signal 9). Android 12L/13: adb shell settings put global settings_enable_monitor_phantom_procs false
  2. Settings > Apps > Termux > Battery > Unrestricted. Same for Tailscale.
  3. Tailscale app > Settings > Split tunneling / Excluded apps: Termux must NOT be excluded.
  4. For start after reboot: install Termux:Boot from the same source as Termux and open it once.
To join the mesh: add this phone on another host (its StableID, url http://$TAILNET_IP:$PEER_PORT), and add that host
here with its StableID (nodeId) AND its tailnet IP as the url host, e.g. url http://100.x.y.z:4801. This phone has no
Tailscale LocalAPI, so it knows callers by tailnet IP: a MagicDNS name alone never matches, and refusals are logged.
EOF
}

main "$@"
