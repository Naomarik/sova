#!/usr/bin/env bash
# Runs ON THE VPS as deploy (piped by deploy.sh: `ssh … bash -s`). No sudo, and nothing outside ~/$R:
#   ~/$R/node     Node $NODE_VERSION (official tarball, sha256 checked)
#   ~/$R/bin      caddy $CADDY_VERSION (official release, sha512 checked)
#   ~/$R/app      the git archive staged in ~/$R/app.new, swapped in (previous kept as app.prev),
#                 then pnpm install --frozen-lockfile + vite build (pnpm via this node's corepack)
#   ~/$R/agent    the agent dir (PI_CODING_AGENT_DIR); auth.json created EMPTY ({}, 0600) if absent, never overwritten
#   ~/$R/home     the isolated HOME for every build and run step (deploy's own dotfiles are never read)
#   ~/$R/sova-mesh.env   the environment the unit and run-sova.sh use
# Env in: R NODE_VERSION NODE_SHA256 CADDY_VERSION CADDY_SHA512 SOVA_PORT SOVA_PEER_PORT VPS_TAILNET_IP
set -euo pipefail
: "${R:?}" "${NODE_VERSION:?}" "${NODE_SHA256:?}" "${CADDY_VERSION:?}" "${CADDY_SHA512:?}" "${SOVA_PORT:?}" "${SOVA_PEER_PORT:?}" "${VPS_TAILNET_IP:?}"
BASE="$HOME/$R"
log() { printf '[vps] %s\n' "$*" >&2; }
mkdir -p "$BASE"/{node,bin,home,agent,dl}
chmod 700 "$BASE/agent" "$BASE/home"

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

# --- the app --------------------------------------------------------------------------------------
[ -f "$BASE/app.new/package.json" ] || { log "no staged app in $BASE/app.new"; exit 1; }
rm -rf "$BASE/app.prev"
[ -d "$BASE/app" ] && mv "$BASE/app" "$BASE/app.prev"
mv "$BASE/app.new" "$BASE/app"
export HOME="$BASE/home" PATH="$BASE/node/bin:/usr/bin:/bin" COREPACK_HOME="$BASE/home/.cache/corepack" COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
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
log "agent: auth.json holds $(node -e 'console.log(Object.keys(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))).length)' "$BASE/agent/auth.json") entr(y/ies)"

# --- the environment ------------------------------------------------------------------------------
cat > "$BASE/sova-mesh.env.tmp" <<EOF
PORT=$SOVA_PORT
HOST=127.0.0.1
SOVA_PEER_HOST=$VPS_TAILNET_IP
SOVA_PEER_PORT=$SOVA_PEER_PORT
PI_CODING_AGENT_DIR=$BASE/agent
HOME=$BASE/home
PATH=$BASE/node/bin:/usr/bin:/bin
EOF
mv "$BASE/sova-mesh.env.tmp" "$BASE/sova-mesh.env"
log "ready: $(cat "$BASE/app/BUILD_COMMIT" 2>/dev/null || echo 'no BUILD_COMMIT')"
