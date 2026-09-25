# Shared settings for scripts/mesh-vps/*.sh (sourced, laptop side). Override any of them in the environment.
# The VPS may be a shared host that also runs other services: these scripts only ever write under ~deploy/sova-mesh, never
# use sudo, and never touch /etc or any running service (see README.md).

VPS_SSH=${VPS_SSH:-deploy@203.0.113.10}
VPS_PUBLIC_IP=${VPS_PUBLIC_IP:-203.0.113.10}
VPS_TAILNET_IP=${VPS_TAILNET_IP:-100.64.0.2}
VPS_ID=${VPS_ID:-vps}
VPS_LABEL=${VPS_LABEL:-vps}

# Everything of ours on the VPS lives under this directory (relative to deploy's home)
R=${R:-sova-mesh}

# Ports (the main listener is loopback only; the peer listener binds the tailnet IP only)
SOVA_PORT=${SOVA_PORT:-4800}
SOVA_PEER_PORT=${SOVA_PEER_PORT:-4801}
FRONTDOOR_PORT=${FRONTDOOR_PORT:-4890}
CADDY_ADMIN=${CADDY_ADMIN:-127.0.0.1:2089}

# Node 22 LTS, official tarball, pinned by the sha256 in nodejs.org's SHASUMS256.txt
NODE_VERSION=${NODE_VERSION:-v22.23.3}
NODE_SHA256=${NODE_SHA256:-df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de}

# Caddy, official static release, pinned by the sha512 in the release's checksums.txt
CADDY_VERSION=${CADDY_VERSION:-2.11.4}
CADDY_SHA512=${CADDY_SHA512:-8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9}

# The laptop's team server (the first peer): Tailscale StableID, MagicDNS name, peer-listener origin
LAPTOP_ID=${LAPTOP_ID:-laptop}
LAPTOP_LABEL=${LAPTOP_LABEL:-laptop}
LAPTOP_NODE_ID=${LAPTOP_NODE_ID:-nLAPTOP0000CNTRL}
LAPTOP_DNS=${LAPTOP_DNS:-laptop.<tailnet>.ts.net}
LAPTOP_PEER_URL=${LAPTOP_PEER_URL:-http://100.64.0.4:4801}

# Production units on the VPS whose state must be identical before and after anything we do
PROD_UNITS=${PROD_UNITS:-}

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MESH_VPS_DIR="$ROOT_DIR/scripts/mesh-vps"

vps() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$VPS_SSH" "$@"; }
log() { printf '[mesh-vps] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
