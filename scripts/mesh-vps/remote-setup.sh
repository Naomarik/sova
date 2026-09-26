#!/usr/bin/env bash
# Runs ON THE VPS as deploy (piped by deploy.sh: `ssh … bash -s`). No sudo, and nothing outside ~/$R:
#   ~/$R/node     Node $NODE_VERSION (official tarball, sha256 checked)
#   ~/$R/bin      caddy $CADDY_VERSION (official release, sha512 checked)
#   ~/$R/app      the git archive staged in ~/$R/app.new, swapped in (previous kept as app.prev),
#                 then pnpm install --frozen-lockfile + vite build (pnpm via this node's corepack)
#   ~/$R/agent    the agent dir (PI_CODING_AGENT_DIR); auth.json created EMPTY ({}, 0600) if absent, never overwritten
#   ~/$R/home     the isolated HOME for every build and run step (deploy's own dotfiles are never read)
#   ~/$R/tmp      TMPDIR for every build and run step (0700): nothing of ours lands in /tmp; holds jiti's extension cache,
#                 cleared and re-warmed after every build (warm-extensions.mjs) so the first session never compiles cold
#   ~/$R/sova-mesh.env   the environment the unit and run-sova.sh use
#   ~/$R/agent/sova/peers.json   seeded ONCE (only if absent) with this host's self id/label/serveUrl and no peers
#                 (mesh stays off); the self id must never change on a running host, so it is never rewritten here
#   Claude Code   not installed here: the claude-code extension spawns plain `claude`, so the directory of deploy's own
#                 claude (CLAUDE_BIN, else `command -v claude` in deploy's login shell, else common install locations) is
#                 appended to PATH in sova-mesh.env; not found = a warning, never a failed deploy
# Env in: R NODE_VERSION NODE_SHA256 CADDY_VERSION CADDY_SHA512 SOVA_PORT SOVA_PEER_PORT VPS_TAILNET_IP VPS_ID VPS_LABEL
#         CLAUDE_BIN (optional, the claude executable to use)
set -euo pipefail
: "${R:?}" "${NODE_VERSION:?}" "${NODE_SHA256:?}" "${CADDY_VERSION:?}" "${CADDY_SHA512:?}" "${SOVA_PORT:?}" "${SOVA_PEER_PORT:?}" "${VPS_TAILNET_IP:?}"
: "${VPS_ID:?}" "${VPS_LABEL:?}"
BASE="$HOME/$R"
log() { printf '[vps] %s\n' "$*" >&2; }
mkdir -p "$BASE"/{node,bin,home,agent,dl,tmp}
chmod 700 "$BASE/agent" "$BASE/home" "$BASE/tmp"

# --- Node -----------------------------------------------------------------------------------------
if [ "$("$BASE/node/bin/node" -v 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  f="node-$NODE_VERSION-linux-x64.tar.xz"
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
  f="caddy_${CADDY_VERSION}_linux_amd64.tar.gz"
  log "caddy: downloading $f"
  curl -fsSL --retry 3 -o "$BASE/dl/$f" "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/$f"
  echo "$CADDY_SHA512  $BASE/dl/$f" | sha512sum -c --quiet - || { log "caddy: sha512 MISMATCH"; exit 1; }
  tar -xzf "$BASE/dl/$f" -C "$BASE/dl" caddy
  mv "$BASE/dl/caddy" "$BASE/bin/caddy.new" && chmod 755 "$BASE/bin/caddy.new" && mv "$BASE/bin/caddy.new" "$BASE/bin/caddy"
  rm -f "$BASE/dl/$f"
fi
log "caddy: $("$BASE/bin/caddy" version | cut -d' ' -f1) (sha512 verified at install)"

# --- Claude Code ----------------------------------------------------------------------------------
# looked up with deploy's real HOME and login PATH (before the isolated ones below); </dev/null: our stdin is this script
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
  log "WARNING: Claude Code not found${CLAUDE_BIN:+ (CLAUDE_BIN=$CLAUDE_BIN is not executable)}: claude-code models will fail (install it for deploy, or set CLAUDE_BIN in local.env)"
fi

# --- the app --------------------------------------------------------------------------------------
[ -f "$BASE/app.new/package.json" ] || { log "no staged app in $BASE/app.new"; exit 1; }
rm -rf "$BASE/app.prev"
[ -d "$BASE/app" ] && mv "$BASE/app" "$BASE/app.prev"
mv "$BASE/app.new" "$BASE/app"
export HOME="$BASE/home" TMPDIR="$BASE/tmp" PATH="$BASE/node/bin:/usr/bin:/bin" COREPACK_HOME="$BASE/home/.cache/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
cd "$BASE/app"
log "pnpm: $(corepack pnpm --version) install --frozen-lockfile"
nice -n 10 corepack pnpm install --frozen-lockfile --reporter=append-only 2>&1 | tail -5 >&2
log "build: vite build (typecheck runs on the laptop)"
nice -n 10 corepack pnpm exec vite build --logLevel warn >&2

# --- the agent dir --------------------------------------------------------------------------------
ln -sfn "$BASE/agent" "$BASE/app/.agent"
node scripts/hermetic-agent-dir.mjs >&2
if [ ! -e "$BASE/agent/auth.json" ]; then
  ( umask 077 && printf '{}\n' > "$BASE/agent/auth.json" )
  log "agent: auth.json created empty (keys arrive by sync)"
fi
chmod 600 "$BASE/agent/auth.json"
# Claude Code's credential store for login sync: the unit's own HOME/.claude (a hermetic agent dir syncs Claude only when
# SOVA_SYNC_CLAUDE_DIR names the store; deploy's real ~/.claude is never used)
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
EOF
mv "$BASE/sova-mesh.env.tmp" "$BASE/sova-mesh.env"

# --- warm the extension cache ---------------------------------------------------------------------
# a fresh cache for this build (old entries are keyed on old sources); a running Sova keeps its loaded extensions
rm -rf "$BASE/tmp/jiti"
SOVA_MESH_BASE="$BASE" "$BASE/app/scripts/mesh-vps/run-warm.sh" | tail -1 >&2 || log "warm-up failed (not fatal: the first session compiles instead)"
log "ready: $(cat "$BASE/app/BUILD_COMMIT" 2>/dev/null || echo 'no BUILD_COMMIT')"
