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
#   --claude-dir <dir>     the .claude dir the `claude` on PATH reads, as seen from Termux (default: detected; see
#                          "Claude Code's store" below; a native claude reads ~/sova-mesh/home/.claude)
#   --ssh-key <public key> also keep an sshd for remote access: openssh, the key in ~/.ssh/authorized_keys, and a
#                          runit sshd service (unless an sshd already runs). `uninstall.sh --keep-ssh` keeps these.
#
# What it adds, all recorded in ~/sova-mesh/.install so uninstall.sh removes exactly that:
#   packages nodejs-lts ripgrep fd git tmux termux-services, plus the package of any other command it or Sova runs that
#   is missing (+ their new dependencies; pnpm comes from node's corepack, pinned by package.json), ~/sova-mesh (app, agent dir, isolated HOME, TMPDIR, env), the runit service sova-mesh,
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
HOST_ID='' HOST_LABEL='' NODE_ID='' DNS_NAME='' SSH_KEY='' CLAUDE_DIR=''
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
    --claude-dir) CLAUDE_DIR=${2:?}; shift 2 ;;
    *) die "unknown option: $1 (see the header of install.sh)" ;;
  esac
done
[ -n "$SOURCE_URL" ] || SOURCE_URL="https://codeload.github.com/$REPO/tar.gz/$REF"

# ---- preconditions ---------------------------------------------------------------------------------
[ -n "${PREFIX:-}" ] && [ -d "$PREFIX" ] && [ "$(uname -o 2>/dev/null)" = Android ] || die "run this inside Termux on Android"
case "$PREFIX" in /data/data/com.termux/files/usr) ;; *) die "unexpected \$PREFIX $PREFIX (Termux's is /data/data/com.termux/files/usr)" ;; esac
case "$HOME" in /data/data/com.termux/files/home*) ;; *) die "\$HOME must be Termux's home (never /sdcard): $HOME" ;; esac
[ "$(id -u)" != 0 ] || die "do not run as root"
# what this script runs before apt can install anything (Termux's essential packages: a normal Termux has them all)
for t in dpkg-query:dpkg apt-get:apt uname:coreutils id:coreutils cut:coreutils sort:coreutils head:coreutils comm:coreutils \
         join:coreutils awk:gawk grep:grep sed:sed termux-wake-lock:termux-tools; do
  [ -x "$PREFIX/bin/${t%%:*}" ] || die "${t%%:*} is missing (package ${t#*:}): run 'pkg install ${t#*:}' and rerun"
done
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
  [ -x "$PREFIX/bin/ifconfig" ] || die "ifconfig is missing (package net-tools): run 'pkg install net-tools' and rerun, or pass --tailnet-ip 100.x.y.z"
  TAILNET_IP=$(ifconfig 2>/dev/null | awk '/^[a-z]/{i=$1} i~/^tun/ && $1=="inet"{print $2}' | while read -r a; do tailnet_ipv4 "$a" && echo "$a"; done | head -1)
  [ -n "$TAILNET_IP" ] || die "no Tailscale address found on tun*: open the Tailscale app, connect, keep Termux out of its excluded apps, rerun (or pass --tailnet-ip 100.x.y.z)"
fi
tailnet_ipv4 "$TAILNET_IP" || die "--tailnet-ip $TAILNET_IP is not a Tailscale address (100.64.0.0/10)"
log "tailnet IP: $TAILNET_IP (peer listener), main listener 127.0.0.1:$PORT"

# ---- packages --------------------------------------------------------------------------------------
installed() { dpkg-query -W -f='${db:Status-Abbrev} ${Package}\n' 2>/dev/null | awk '$1=="ii"{print $2}' | sort; }
versions() { dpkg-query -W -f='${db:Status-Abbrev} ${Package} ${Version}\n' 2>/dev/null | awk '$1=="ii"{print $2" "$3}' | sort; }
# the packages before the FIRST install (for the record: what counts as added is decided per apt run, below)
[ -f "$M/packages-before" ] || installed > "$M/packages-before"
# Beyond Termux's bootstrap (termux-packages scripts/generate-bootstraps.sh), Sova needs these: node, rg and fd (pi's
# grep/find tools and Sova's own file tools), git (worktrees, diffs, the source's commit id), tmux, runit + service-daemon.
WANT="nodejs-lts ripgrep fd git tmux termux-services"
[ -z "$SSH_KEY" ] || WANT="$WANT openssh"
# Every command install.sh, the service, the boot script, uninstall.sh and Sova's runtime call, with its package. Those
# outside WANT come with Termux's bootstrap; one that is missing anyway (a user removed it) is installed with the rest.
# Looked up in $PREFIX/bin, the service's whole PATH: Android's /system/bin toybox copies (gzip) don't count.
TOOLS="node:nodejs-lts corepack:nodejs-lts rg:ripgrep fd:fd git:git tmux:tmux sv:runit runsv:runit svlogd:runit
  service-daemon:termux-services bash:bash curl:curl gzip:gzip tar:tar find:findutils xargs:findutils pgrep:procps
  ps:procps cmp:diffutils sha256sum:coreutils nice:coreutils env:coreutils termux-wake-unlock:termux-tools
  ifconfig:net-tools"
[ -z "$SSH_KEY" ] || TOOLS="$TOOLS sshd:openssh"
missing=''
for p in $WANT; do dpkg-query -W -f='${db:Status-Abbrev}' "$p" 2>/dev/null | grep -q '^ii' || missing="$missing $p"; done
for t in $TOOLS; do
  [ -x "$PREFIX/bin/${t%%:*}" ] && continue
  case " $missing " in *" ${t#*:} "*) ;; *) missing="$missing ${t#*:}" ;; esac
done
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
  # added = what THIS apt run newly installed (never a package the user installed since an earlier run)
  cut -d' ' -f1 "$M/.versions-pre" > "$M/.pre"
  cut -d' ' -f1 "$M/.versions-post" | comm -13 "$M/.pre" - > "$M/.new"
  cat "$M/.new" "$M/packages-added" 2>/dev/null | sort -u > "$M/.added" && mv "$M/.added" "$M/packages-added"
  # packages that existed and were upgraded as a dependency: reported, never rolled back
  join "$M/.versions-pre" "$M/.versions-post" | awk '$2!=$3' >> "$M/packages-upgraded" || true
  rm -f "$M/.new" "$M/.pre" "$M/.versions-pre" "$M/.versions-post"
  rm -rf "$BASE/dl/apt"
fi
touch "$M/packages-added"
log "packages added by this installer: $(wc -l < "$M/packages-added" | tr -d ' ')"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)' \
  || die "node $(node -v) is older than Sova's >=22.19"
for t in $TOOLS; do [ -x "$PREFIX/bin/${t%%:*}" ] || die "${t%%:*} is missing after installing its package ${t#*:}"; done

# ---- layout ----------------------------------------------------------------------------------------
mkdir -p "$BASE/home" "$BASE/tmp" "$BASE/agent" "$BASE/dl" "$BASE/bin" "$BASE/home/.claude"
chmod 700 "$BASE/home" "$BASE/tmp" "$BASE/agent" "$BASE/home/.claude"
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

# ---- Claude Code's store ---------------------------------------------------------------------------
# Sova syncs the Claude Code login in the .claude dir that the `claude` on PATH reads. A native claude reads Sova's HOME:
# $BASE/home/.claude. A proot-distro wrapper ($PREFIX/bin/claude, a short script that execs `proot-distro login <distro>
# [--user <user>] ... -- env HOME=<home> ...`) runs Claude inside the container, which reads <rootfs><home>/.claude.
# Anything the wrapper leaves unclear keeps $BASE/home/.claude and prints a note naming --claude-dir.
claude_note() { log "note: $PREFIX/bin/claude looks like a proot-distro wrapper, but $1: Sova syncs the Claude Code login in $BASE/home/.claude, which that claude may not read. Rerun with --claude-dir <the .claude dir it reads, as seen from Termux>"; }
claude_proot_dir() { # the container's .claude as seen from Termux, or nothing
  w="$PREFIX/bin/claude"
  [ -f "$w" ] && [ "$(wc -c < "$w")" -le 8192 ] && grep -q 'proot-distro' "$w" || return 0
  # logical lines (backslash continuations joined), comments dropped; exactly one must run `proot-distro login`
  lines=$(sed -e ':a' -e '/\\$/{N;s/\\\n/ /;ta' -e '}' "$w" | grep -v '^[[:space:]]*#' | grep -E '(^|[[:space:];&|])proot-distro[[:space:]]+login[[:space:]]' || true)
  [ "$(printf '%s\n' "$lines" | grep -c .)" = 1 ] || { claude_note "it has no single 'proot-distro login' line"; return 0; }
  ! grep -q CLAUDE_CONFIG_DIR "$w" || { claude_note "it sets CLAUDE_CONFIG_DIR"; return 0; }
  # distro, --user and HOME= only as plain words (no variables, quotes or globs)
  set -f
  # the distro is login's first non-option word; login's options that take a value skip it
  distro='' user=root home='' prev='' seen='' after=''
  for t in $lines; do
    case "$prev" in --user) user=$t ;; esac
    if [ -n "$after" ] && [ -z "$distro" ]; then
      case "$prev" in --user|--bind|--work-dir|--env|--kernel|--hostname) ;; *)
        case "$t" in --) after='' ;; -*) ;; *) distro=$t ;; esac ;;
      esac
    fi
    case "$t" in proot-distro) seen=1 ;; login) [ -z "$seen" ] || [ -n "$distro" ] || after=1 ;; HOME=*) home=${t#HOME=} ;; --user=*) user=${t#--user=} ;; esac
    prev=$t
  done
  set +f
  printf '%s' "$distro" | grep -qE '^[A-Za-z0-9._-]+$' || { claude_note "its distro is not a plain name"; return 0; }
  printf '%s' "$user" | grep -qE '^[a-z_][a-z0-9_-]*$' || { claude_note "its --user is not a plain name"; return 0; }
  rootfs=''
  for r in "$PREFIX/var/lib/proot-distro/containers/$distro/rootfs" "$PREFIX/var/lib/proot-distro/installed-rootfs/$distro"; do
    [ -d "$r/etc" ] && { rootfs=$r; break; }
  done
  [ -n "$rootfs" ] || { claude_note "its distro $distro has no rootfs"; return 0; }
  # no HOME= in the wrapper: the user's home from the container's passwd
  [ -n "$home" ] || home=$(awk -F: -v u="$user" '$1==u{print $6; exit}' "$rootfs/etc/passwd" 2>/dev/null || true)
  printf '%s' "$home" | grep -qE '^/[A-Za-z0-9._/-]*$' && ! printf '%s' "$home" | grep -q '\.\.' || { claude_note "its HOME is not a plain path"; return 0; }
  [ -d "$rootfs$home" ] || { claude_note "its HOME $home does not exist in the container"; return 0; }
  printf '%s\n' "${rootfs}${home%/}/.claude"
}
CLAUDE_DEFAULT="$BASE/home/.claude"
if [ -n "$CLAUDE_DIR" ]; then
  case "$CLAUDE_DIR" in /*) ;; *) die "--claude-dir must be an absolute path" ;; esac
  CLAUDE_DIR=${CLAUDE_DIR%/}
  [ -d "${CLAUDE_DIR%/*}" ] || die "--claude-dir: ${CLAUDE_DIR%/*} does not exist"
else
  CLAUDE_DIR=$(claude_proot_dir)
  [ -n "$CLAUDE_DIR" ] || CLAUDE_DIR=$CLAUDE_DEFAULT
fi
if [ "$CLAUDE_DIR" != "$CLAUDE_DEFAULT" ]; then
  # a store outside ~/sova-mesh belongs to the user: its original login is kept in the manifest, restored by uninstall.sh
  if [ -f "$M/claude-dir" ]; then
    [ "$(cat "$M/claude-dir")" = "$CLAUDE_DIR" ] || die "the Claude Code store was $(cat "$M/claude-dir") and is now $CLAUDE_DIR: rerun with --claude-dir $(cat "$M/claude-dir"), or uninstall first"
  else
    [ -d "$CLAUDE_DIR" ] || { mkdir -p "$CLAUDE_DIR"; note "dir $CLAUDE_DIR"; }
    if [ -f "$CLAUDE_DIR/.credentials.json" ]; then
      ( umask 077 && cp "$CLAUDE_DIR/.credentials.json" "$M/claude-credentials.orig" ) || die "could not keep $CLAUDE_DIR/.credentials.json"
    else
      : > "$M/claude-credentials.none"
    fi
    printf '%s\n' "$CLAUDE_DIR" > "$M/claude-dir"
  fi
  # switching stores on a paired host: the mesh's current login goes in first, byte for byte, so Sova never meets the
  # container's own (older) login as a new one. Unpaired, the container's login stays and joins sync once paired.
  PREV_CLAUDE_DIR=$(sed -n 's/^SOVA_SYNC_CLAUDE_DIR=//p' "$BASE/sova-mesh.env" 2>/dev/null || true)
  npeers=$(node -e 'try{console.log((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).peers??[]).length)}catch{console.log(0)}' "$BASE/agent/sova/peers.json")
  if [ -n "$PREV_CLAUDE_DIR" ] && [ "$PREV_CLAUDE_DIR" != "$CLAUDE_DIR" ] && [ "$npeers" != 0 ] && [ -f "$PREV_CLAUDE_DIR/.credentials.json" ]; then
    # the running Sova stops first, so no refresh lands between the copy and the switch; it starts again at the end,
    # and on any failure from here on (the EXIT trap)
    if [ -d "$SVC" ]; then
      trap 'SVDIR="$PREFIX/var/service" sv up sova-mesh >/dev/null 2>&1 || true' EXIT
      SVDIR="$PREFIX/var/service" sv -w 30 down sova-mesh >/dev/null 2>&1 || true
    fi
    ( umask 077 && cp "$PREV_CLAUDE_DIR/.credentials.json" "$CLAUDE_DIR/.credentials.json.sova-tmp" ) \
      && chmod 600 "$CLAUDE_DIR/.credentials.json.sova-tmp" && mv "$CLAUDE_DIR/.credentials.json.sova-tmp" "$CLAUDE_DIR/.credentials.json" \
      || die "could not copy the synced Claude Code login into $CLAUDE_DIR"
    log "Claude Code: the mesh's current login copied into $CLAUDE_DIR (the container's own is kept in the manifest)"
  fi
  log "Claude Code: $PREFIX/bin/claude runs in a proot container; its login syncs in $CLAUDE_DIR"
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
  # Claude Code's store for login sync (the Claude Code login syncs like every other): Sova syncs it only when told
  # where, since its agent dir is not the default one; Claude Code's own place under this HOME, or the container's
  echo "SOVA_SYNC_CLAUDE_DIR=$CLAUDE_DIR"
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
trap - EXIT
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
probe() { # port -> "probed <n>", "loopback open|closed", then "open <address>" per non-loopback address that accepts
  node -e '
    const net = require("net"), port = +process.argv[1];
    const addrs = Object.entries(require("os").networkInterfaces()).flatMap(([n, a]) =>
      a.filter((x) => !x.internal).map((x) => (x.family === "IPv6" && x.address.startsWith("fe80:") ? `${x.address}%${n}` : x.address)));
    const connects = (host) => new Promise((ok) => {
      const s = net.connect({ host, port, timeout: 3000 });
      s.on("connect", () => { s.destroy(); ok(true); });
      s.on("error", () => ok(false));
      s.on("timeout", () => { s.destroy(); ok(false); });
    });
    (async () => {
      console.log(`probed ${addrs.length}`);
      for (const a of addrs) console.log(`addr ${a}`);
      console.log(`loopback ${(await connects("127.0.0.1")) ? "open" : "closed"}`);
      for (const [i, ok] of (await Promise.all(addrs.map(connects))).entries()) if (ok) console.log(`open ${addrs[i]}`);
    })();' "$1"
}
peers=$(node -e 'try{console.log((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).peers??[]).length)}catch{console.log(0)}' "$BASE/agent/sova/peers.json")
main=$(probe "$PORT") || die "the exposure probe failed (node)"
n=$(printf '%s\n' "$main" | sed -n 's/^probed //p')
[ "${n:-0}" -gt 0 ] || die "the exposure probe found no network addresses (node's os.networkInterfaces() is empty here): cannot prove exposure"
printf '%s\n' "$main" | grep -qxF "addr $TAILNET_IP" || die "the exposure probe does not see $TAILNET_IP among this phone's addresses"
# the positive control: the same connect reaches the main port on loopback, so a closed answer elsewhere means closed
printf '%s\n' "$main" | grep -qx 'loopback open' || die "positive control failed: 127.0.0.1:$PORT does not accept a connection"
bad=$(printf '%s\n' "$main" | sed -n 's/^open //p')
[ -z "$bad" ] || die "the main port answers on $(echo $bad) :$PORT (must be loopback only)"
peer=$(probe "$PEER_PORT") || die "the exposure probe failed (node)"
bad=$(printf '%s\n' "$peer" | sed -n 's/^open //p' | grep -vxF "$([ "$peers" = 0 ] || echo "$TAILNET_IP")" || true)
[ -z "$bad" ] || die "the peer port answers on $(echo $bad) :$PEER_PORT"
log "exposure ok on the $n addresses probed (control: 127.0.0.1:$PORT open): main port loopback only; peer port $([ "$peers" = 0 ] && echo "closed everywhere (mesh off)" || echo "on $TAILNET_IP only")"

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
