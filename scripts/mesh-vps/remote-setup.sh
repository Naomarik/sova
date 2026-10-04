#!/usr/bin/env bash
# Runs ON THE VPS as the VPS user (piped by deploy.sh: `ssh … bash -s`). No sudo, and nothing outside ~/$R:
#   ~/$R/node     Node $NODE_VERSION (official tarball, sha256 checked)
#   ~/$R/bin      caddy $CADDY_VERSION (official release, sha512 checked)
#                 both for this host's `uname -m`: x86_64, or aarch64/arm64; any other stops before downloading
#   ~/$R/app      the git archive staged in ~/$R/app.new, built there (pnpm install --frozen-lockfile + vite build,
#                 both modes; pnpm via this node's corepack), then swapped in (previous kept as app.prev); a failed
#                 build stops before the swap. Its .bun/bin/bun is the Bun the server runs on: the build its mise.toml
#                 pins, sha256-checked against its scripts/bun-release.txt (scripts/fetch-bun.sh; the previous app's
#                 copy when it is that version), so it swaps in and out with the app
#   ~/$R/agent    the agent dir (PI_CODING_AGENT_DIR); auth.json created EMPTY ({}, 0600) if absent, never overwritten
#   ~/$R/home     the isolated HOME for every build and run step (the user's own dotfiles are never read)
#   ~/$R/tmp      TMPDIR for every build and run step (0700): nothing of ours lands in /tmp; holds jiti's extension cache,
#                 cleared and re-warmed after every build (warm-extensions.mjs) so the first session never compiles cold
#   ~/$R/sova-mesh.env   the environment the unit and run-sova.sh use
#   ~/$R/agent/sova/peers.json   seeded ONCE (only if absent) with this host's self id/label/serveUrl and no peers
#                 (mesh stays off); the self id must never change on a running host, so it is never rewritten here
#   Claude Code   not installed here: the claude-code extension spawns plain `claude`, so the directory of the user's own
#                 claude (CLAUDE_BIN, else `command -v claude` in the user's login shell, else common install locations) is
#                 appended to PATH in sova-mesh.env; not found = a warning, never a failed deploy
#   VPS_RELAY=on  the internet relay (§mesh.vps/internet-relay): the accept process bundled in app.new (stamped with the
#                 deployed commit; a failed bundle stops before the swap), then installed atomically as
#                 ~/$R/accept/relay-accept.mjs; ~/$R/relay (0750, the user's group) for Sova's handoff socket, named in
#                 sova-mesh.env as SOVA_RELAY_HANDOFF; ~/$R/sova-relay-accept.service rendered from the template for the
#                 admin to install (SUDO.md §5), with a warning when the installed one differs or the group has other members
# Env in: R NODE_VERSION NODE_SHA256_X64 NODE_SHA256_ARM64 CADDY_VERSION CADDY_SHA512_AMD64 CADDY_SHA512_ARM64 SOVA_PORT SOVA_PEER_PORT VPS_TAILNET_IP VPS_ID VPS_LABEL
#         CLAUDE_BIN (optional, the claude executable to use), SOVA_RUNTIME (optional: node = run Sova on Node),
#         VPS_RELAY (optional: on = the internet relay's accept process)
set -euo pipefail
: "${R:?}" "${NODE_VERSION:?}" "${NODE_SHA256_X64:?}" "${NODE_SHA256_ARM64:?}" "${CADDY_VERSION:?}" "${CADDY_SHA512_AMD64:?}"
: "${CADDY_SHA512_ARM64:?}" "${SOVA_PORT:?}" "${SOVA_PEER_PORT:?}" "${VPS_TAILNET_IP:?}"
: "${VPS_ID:?}" "${VPS_LABEL:?}"
BASE="$HOME/$R"
log() { printf '[vps] %s\n' "$*" >&2; }

# --- architecture: pick the builds and their pinned checksums before anything is downloaded ------------
arch=$(uname -m)
case "$arch" in
  x86_64|amd64) NODE_ARCH=x64; NODE_SHA256=$NODE_SHA256_X64; CADDY_ARCH=amd64; CADDY_SHA512=$CADDY_SHA512_AMD64 ;;
  aarch64|arm64) NODE_ARCH=arm64; NODE_SHA256=$NODE_SHA256_ARM64; CADDY_ARCH=arm64; CADDY_SHA512=$CADDY_SHA512_ARM64 ;;
  *) log "error: unsupported architecture $arch: the VPS kit supports x86_64 and aarch64"; exit 1 ;;
esac
mkdir -p "$BASE"/{node,bin,home,agent,dl,tmp}
chmod 700 "$BASE/agent" "$BASE/home" "$BASE/tmp"

# --- Node -----------------------------------------------------------------------------------------
if [ "$("$BASE/node/bin/node" -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  f="node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz"
  log "node: downloading $f"
  curl -fsSL --retry 3 -o "$BASE/dl/$f" "https://nodejs.org/dist/$NODE_VERSION/$f"
  echo "$NODE_SHA256  $BASE/dl/$f" | sha256sum -c --quiet - || { log "node: sha256 MISMATCH"; exit 1; }
  rm -rf "$BASE/node.new" && mkdir -p "$BASE/node.new"
  tar -xJf "$BASE/dl/$f" -C "$BASE/node.new" --strip-components=1
  rm -rf "$BASE/node" && mv "$BASE/node.new" "$BASE/node" && rm -f "$BASE/dl/$f"
fi
log "node: $("$BASE/node/bin/node" -v) (sha256 verified at install)"

# --- Caddy ----------------------------------------------------------------------------------------
if ! "$BASE/bin/caddy" version 2>/dev/null | grep -q "^v$CADDY_VERSION "; then
  f="caddy_${CADDY_VERSION}_linux_${CADDY_ARCH}.tar.gz"
  log "caddy: downloading $f"
  curl -fsSL --retry 3 -o "$BASE/dl/$f" "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/$f"
  echo "$CADDY_SHA512  $BASE/dl/$f" | sha512sum -c --quiet - || { log "caddy: sha512 MISMATCH"; exit 1; }
  tar -xzf "$BASE/dl/$f" -C "$BASE/dl" caddy
  mv "$BASE/dl/caddy" "$BASE/bin/caddy.new" && chmod 755 "$BASE/bin/caddy.new" && mv "$BASE/bin/caddy.new" "$BASE/bin/caddy"
  rm -f "$BASE/dl/$f"
fi
log "caddy: $("$BASE/bin/caddy" version | cut -d' ' -f1) (sha512 verified at install)"

# --- Claude Code ----------------------------------------------------------------------------------
# looked up with the user's real HOME and login PATH (before the isolated ones below); </dev/null: our stdin is this script
is_exe() { case "$1" in /*) [ -x "$1" ] && [ ! -d "$1" ] ;; *) false ;; esac; }
claude=
if [ -n "${CLAUDE_BIN:-}" ]; then
  is_exe "$CLAUDE_BIN" && claude=$CLAUDE_BIN
else
  for f in "$(bash -lc 'command -v claude' </dev/null 2>/dev/null | tail -1 || true)" "$HOME/.local/bin/claude" \
           "$HOME/.claude/local/claude" "$HOME/.npm-global/bin/claude" /usr/local/bin/claude; do
    is_exe "$f" && { claude=$f; break; }
  done
fi
SERVICE_PATH="$BASE/node/bin:/usr/bin:/bin"
if [ -n "$claude" ]; then
  log "claude: $claude ($("$claude" --version </dev/null 2>/dev/null | head -1 || true))"
  # appended, so this build's node still comes first
  d=$(cd "$(dirname "$claude")" && pwd)
  case "$d" in /usr/bin|/bin) ;; *) SERVICE_PATH="$SERVICE_PATH:$d" ;; esac
else
  log "WARNING: Claude Code not found${CLAUDE_BIN:+ (CLAUDE_BIN=$CLAUDE_BIN is not executable)}: claude-code models will fail (install it for this user, or set CLAUDE_BIN in local.env)"
fi

# --- the app --------------------------------------------------------------------------------------
# Installed and built in app.new, beside the running app, and swapped in only once both builds
# succeeded: a failed install or build (set -e) leaves app as it was, and the running service never
# sees a half-built tree. (pnpm's node_modules links are relative, so the tree survives the move, as
# on the phone, whose installer does the same.)
[ -f "$BASE/app.new/package.json" ] || { log "no staged app in $BASE/app.new"; exit 1; }
export HOME="$BASE/home" TMPDIR="$BASE/tmp" PATH="$BASE/node/bin:/usr/bin:/bin" COREPACK_HOME="$BASE/home/.cache/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
cd "$BASE/app.new"
[ -x "$BASE/app/.bun/bin/bun" ] && mkdir -p .bun/bin && cp -p "$BASE/app/.bun/bin/bun" .bun/bin/bun
sh scripts/fetch-bun.sh "$BASE/app.new/.bun" >/dev/null || { log "bun: install failed: the running app is unchanged"; exit 1; }
log "bun: $(.bun/bin/bun --version) (sha256 verified at install)"
log "pnpm: $(corepack pnpm --version) install --frozen-lockfile (in app.new)"
nice -n 10 corepack pnpm install --frozen-lockfile --reporter=append-only > "$BASE/tmp/pnpm-install.log" 2>&1 \
  || { tail -20 "$BASE/tmp/pnpm-install.log" >&2; log "pnpm install failed: the running app is unchanged"; exit 1; }
tail -5 "$BASE/tmp/pnpm-install.log" >&2
log "build: vite build + the share page, in app.new (typecheck runs on the laptop)"
nice -n 10 corepack pnpm exec vite build --logLevel warn >&2 || { log "vite build failed: the running app is unchanged"; exit 1; }
# the share page's own build (dist-share/): the share listener serves /h/ and /i/ from it
nice -n 10 corepack pnpm exec vite build --mode share --logLevel warn >&2 || { log "share build failed: the running app is unchanged"; exit 1; }
[ -f dist/index.html ] || { log "vite build produced no dist/index.html: the running app is unchanged"; exit 1; }
# the internet relay's accept process: one file, Node builtins only, stamped with the commit Sova reads from BUILD_COMMIT
# (an accept process of another build is told to exit by Sova, and its unit starts this one)
if [ "${VPS_RELAY:-off}" = on ]; then
  commit=$(node -e 'try{const c=JSON.parse(require("fs").readFileSync("BUILD_COMMIT","utf8")).commit;process.stdout.write(/^[0-9a-f]{40}$/.test(c)?c:"dev")}catch{process.stdout.write("dev")}')
  rm -rf .accept && mkdir -p .accept
  { .bun/bin/bun build server/mesh/relay-accept/main.ts --target=node --format=esm --outfile .accept/relay-accept.mjs \
      --define "__SOVA_ACCEPT_BUILD__=\"$commit\"" >&2 \
    && node --check .accept/relay-accept.mjs \
    && ! grep -oE '(from|import\() *"[^"]+"' .accept/relay-accept.mjs | grep -vqE '"node:[a-z_/]+"$'; } \
    || { log "relay accept: bundle failed: the running app is unchanged"; exit 1; }
  printf '%s\n' "$commit" > .accept/BUILD
  log "relay accept: bundled (build ${commit:0:12})"
fi
cd "$BASE"
rm -rf "$BASE/app.prev"
[ -d "$BASE/app" ] && mv "$BASE/app" "$BASE/app.prev"
mv "$BASE/app.new" "$BASE/app"
cd "$BASE/app"
log "swapped in: $(cat BUILD_COMMIT 2>/dev/null || echo 'no BUILD_COMMIT')"

# --- the agent dir --------------------------------------------------------------------------------
ln -sfn "$BASE/agent" "$BASE/app/.agent"
node scripts/hermetic-agent-dir.mjs >&2
if [ ! -e "$BASE/agent/auth.json" ]; then
  ( umask 077 && printf '{}\n' > "$BASE/agent/auth.json" )
  log "agent: auth.json created empty (keys arrive by sync)"
fi
chmod 600 "$BASE/agent/auth.json"
# Claude Code's credential store for login sync: the unit's own HOME/.claude (a hermetic agent dir syncs Claude only when
# SOVA_SYNC_CLAUDE_DIR names the store; the user's real ~/.claude is never used)
mkdir -p "$BASE/home/.claude" && chmod 700 "$BASE/home/.claude"
# this host's identity: self.id (default would be the machine hostname), label, front-door upstream
if [ ! -e "$BASE/agent/sova/peers.json" ]; then
  mkdir -p "$BASE/agent/sova"
  ( umask 077 && node -e 'const [id,label,port,file]=process.argv.slice(1);require("fs").writeFileSync(file+".tmp",JSON.stringify({version:1,self:{id,label,serveUrl:`http://127.0.0.1:${port}`},peers:[],sync:{},frontDoor:null},null,2)+"\n");require("fs").renameSync(file+".tmp",file)' \
    "$VPS_ID" "$VPS_LABEL" "$SOVA_PORT" "$BASE/agent/sova/peers.json" )
  log "agent: peers.json seeded (self $VPS_ID, no peers: mesh off)"
fi
log "agent: peers.json self.id = $(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).self?.id ?? "(default)")' "$BASE/agent/sova/peers.json")"
log "agent: auth.json holds $(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).length)' "$BASE/agent/auth.json") entr(y/ies)"

# --- the internet relay (VPS_RELAY=on) ------------------------------------------------------------
# The bundle swaps in atomically (a running accept process keeps the file it loaded); the handoff directory is Sova's own
# (Sova refuses it otherwise); the unit file is rendered for the admin, never installed from here (no sudo, ever).
RELAY_ENV=
if [ "${VPS_RELAY:-off}" = on ]; then
  mkdir -p "$BASE/accept" && chmod 755 "$BASE/accept"
  for f in relay-accept.mjs BUILD; do
    install -m 0644 "$BASE/app/.accept/$f" "$BASE/accept/$f.new" && mv -f "$BASE/accept/$f.new" "$BASE/accept/$f"
  done
  me=$(id -un); grp=$(id -gn)
  mkdir -p "$BASE/relay" && chgrp "$grp" "$BASE/relay" && chmod 750 "$BASE/relay"
  RELAY_ENV="SOVA_RELAY_HANDOFF=$BASE/relay/h.sock"
  others=$( { getent group "$grp" | cut -d: -f4 | tr ',' '\n'; getent passwd | awk -F: -v g="$(id -g)" '$4 == g { print $1 }'; } \
    | grep -vx -e "$me" -e '' | sort -u | tr '\n' ' ' || true)
  [ -z "$others" ] || log "WARNING: group $grp has other members (${others% }): they could reach Sova's handoff socket; give $me a group of its own"
  sed -e "s|@GROUP@|$grp|g" -e "s|@BASE@|$BASE|g" "$BASE/app/scripts/mesh-vps/sova-relay-accept.service.in" > "$BASE/sova-relay-accept.service.tmp"
  mv -f "$BASE/sova-relay-accept.service.tmp" "$BASE/sova-relay-accept.service"
  if [ ! -f /etc/systemd/system/sova-relay-accept.service ]; then
    log "relay accept: the system unit isn't installed: an admin runs SUDO.md §5 once"
  elif ! cmp -s "$BASE/sova-relay-accept.service" /etc/systemd/system/sova-relay-accept.service; then
    log "WARNING: the installed sova-relay-accept.service differs from this build's: run SUDO.md §5 step 2 again"
  fi
  log "relay accept: installed (build $(cut -c1-12 "$BASE/accept/BUILD")); handoff socket $BASE/relay/h.sock"
fi

# --- the environment ------------------------------------------------------------------------------
cat > "$BASE/sova-mesh.env.tmp" <<EOF
PORT=$SOVA_PORT
HOST=127.0.0.1
SOVA_PEER_HOST=$VPS_TAILNET_IP
SOVA_PEER_PORT=$SOVA_PEER_PORT
PI_CODING_AGENT_DIR=$BASE/agent
HOME=$BASE/home
SOVA_SYNC_CLAUDE_DIR=$BASE/home/.claude
TMPDIR=$BASE/tmp
PATH=$SERVICE_PATH
SOVA_BUN=$BASE/app/.bun/bin/bun
EOF
[ "${SOVA_RUNTIME:-}" != node ] || echo "SOVA_RUNTIME=node" >> "$BASE/sova-mesh.env.tmp"
# Only with VPS_RELAY=on: unset, Sova has no internet relay, and an accept process left installed never listens.
[ -z "$RELAY_ENV" ] || echo "$RELAY_ENV" >> "$BASE/sova-mesh.env.tmp"
mv "$BASE/sova-mesh.env.tmp" "$BASE/sova-mesh.env"

# --- warm the extension cache ---------------------------------------------------------------------
# a fresh cache for this build (old entries are keyed on old sources); a running Sova keeps its loaded extensions
rm -rf "$BASE/tmp/jiti"
SOVA_MESH_BASE="$BASE" "$BASE/app/scripts/mesh-vps/run-warm.sh" | tail -1 >&2 || log "warm-up failed (not fatal: the first session compiles instead)"
log "ready: $(cat "$BASE/app/BUILD_COMMIT" 2>/dev/null || echo 'no BUILD_COMMIT')"
