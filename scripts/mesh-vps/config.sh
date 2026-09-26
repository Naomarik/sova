# Shared settings for scripts/mesh-vps/*.sh (sourced, laptop side). Override any of them in the environment.
# The VPS may be a shared host that also runs other services: these scripts only ever write under ~deploy/sova-mesh, never
# use sudo, and never touch /etc or any running service (see README.md).
# Site-specific values (addresses, names, the laptop peer) live in the untracked local.env next to this file:
#   cp scripts/mesh-vps/local.env.example scripts/mesh-vps/local.env   (then fill it in)

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MESH_VPS_DIR="$ROOT_DIR/scripts/mesh-vps"
[ -f "$MESH_VPS_DIR/local.env" ] && . "$MESH_VPS_DIR/local.env"
need() { local v; for v in "$@"; do [ -n "${!v:-}" ] || { printf '[mesh-vps] error: %s is not set: put it in scripts/mesh-vps/local.env (see local.env.example)\n' "$v" >&2; exit 1; }; done; }

# Required, from local.env (each script checks the ones it uses with `need`): VPS_SSH (ssh over the tailnet,
# deploy@<vps-tailnet-ip>), VPS_PUBLIC_IP, VPS_TAILNET_IP, VPS_DNS (<vps>.<tailnet>.ts.net)
VPS_ID=${VPS_ID:-vps}
VPS_LABEL=${VPS_LABEL:-$VPS_ID}

# Claude Code on the VPS (deploy's own install): empty = `command -v claude` in deploy's login shell, else a common install
# location; its directory goes on the sova-mesh unit's PATH (the claude-code extension spawns plain `claude`)
CLAUDE_BIN=${CLAUDE_BIN:-}

# Everything of ours on the VPS lives under this directory (relative to deploy's home)
R=${R:-sova-mesh}

# Ports (the main listener is loopback only; the peer listener binds the tailnet IP only)
SOVA_PORT=${SOVA_PORT:-4800}
SOVA_PEER_PORT=${SOVA_PEER_PORT:-4801}
FRONTDOOR_PORT=${FRONTDOOR_PORT:-4890}
CADDY_ADMIN=${CADDY_ADMIN:-127.0.0.1:2089}
# tailscale serve (set up by the parent, tailnet only): the front door and this host
FRONTDOOR_SERVE_PORT=${FRONTDOOR_SERVE_PORT:-8443}
HOST_SERVE_PORT=${HOST_SERVE_PORT:-10443}

# Node 22 LTS, official tarball, pinned by the sha256 in nodejs.org's SHASUMS256.txt
NODE_VERSION=${NODE_VERSION:-v22.23.3}
NODE_SHA256=${NODE_SHA256:-df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de}

# Caddy, official static release, pinned by the sha512 in the release's checksums.txt
CADDY_VERSION=${CADDY_VERSION:-2.11.4}
CADDY_SHA512=${CADDY_SHA512:-8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9}

# The laptop's team server (the first peer): id, Tailscale StableID, MagicDNS name, peer-listener origin, and the
# front door's upstream for it (a user-level socat forwarder <laptop-tailnet-ip>:4872 -> the team server 127.0.0.1:4870):
# LAPTOP_ID, LAPTOP_NODE_ID, LAPTOP_DNS, LAPTOP_PEER_URL, LAPTOP_SERVE_URL (required by smoke.sh / laptop-forwarder.sh)
LAPTOP_LABEL=${LAPTOP_LABEL:-${LAPTOP_ID:-}}

# Public ports the exposure probe expects OPEN, a control that the probe itself works (e.g. "80 443"); empty = no control
VPS_CONTROL_PORTS=${VPS_CONTROL_PORTS:-}
# Units on the VPS whose state must be identical before and after anything we do; empty = the units check is skipped
PROD_UNITS=${PROD_UNITS:-}

vps() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$VPS_SSH" "$@"; }
log() { printf '[mesh-vps] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
