#!/usr/bin/env bash
# Deploy a commit of this worktree to the VPS as deploy (no sudo, never git push):
#   scripts/mesh-vps/deploy.sh [--rev <sha>]      (default HEAD)
# `git archive <sha>` is streamed over ssh into ~/sova-mesh/app.new, then remote-setup.sh installs Node + Caddy
# (checksummed), swaps the app in, runs pnpm install --frozen-lockfile + vite build, prepares the agent dir and
# writes ~/sova-mesh/sova-mesh.env. If the sova-mesh user unit is running, it is restarted onto the new build.
set -euo pipefail
. "$(dirname "$0")/config.sh"

REV=HEAD
while [ $# -gt 0 ]; do
  case "$1" in
    --rev) REV=${2:?--rev needs a commit}; shift 2 ;;
    *) die "usage: $0 [--rev <sha>]" ;;
  esac
done
SHA=$(git -C "$ROOT_DIR" rev-parse --verify "$REV^{commit}") || die "no such commit: $REV"
log "deploying ${SHA:0:12} to $VPS_SSH:~/$R"

vps "rm -rf ~/$R/app.new && mkdir -p ~/$R/app.new"
git -C "$ROOT_DIR" archive --format=tar "$SHA" | vps "tar -x -C ~/$R/app.new"
printf '{"commit":"%s","source":"git archive","deployedAt":"%s"}\n' "$SHA" "$(date -u +%FT%TZ)" | vps "cat > ~/$R/app.new/BUILD_COMMIT"

vps "R=$R NODE_VERSION=$NODE_VERSION NODE_SHA256=$NODE_SHA256 CADDY_VERSION=$CADDY_VERSION CADDY_SHA512=$CADDY_SHA512 \
  SOVA_PORT=$SOVA_PORT SOVA_PEER_PORT=$SOVA_PEER_PORT VPS_TAILNET_IP=$VPS_TAILNET_IP VPS_ID=$VPS_ID VPS_LABEL='$VPS_LABEL' bash -s" < "$MESH_VPS_DIR/remote-setup.sh"

if vps "systemctl --user is-active --quiet sova-mesh.service" 2>/dev/null; then
  log "sova-mesh.service is running: restarting it onto ${SHA:0:12}"
  vps "systemctl --user restart sova-mesh.service"
fi
log "deployed ${SHA:0:12}"
