# Shared settings for scripts/mesh-vps/*.sh (sourced, laptop side). Override any of them in the environment.
# The VPS may be a shared host that also runs other services: these scripts only ever write under ~<user>/sova-mesh (the
# user VPS_SSH logs in as), never use sudo, and never touch /etc or any running service (see README.md).
# Site-specific values (addresses, names, the laptop peer) live in the untracked local.env next to this file:
#   cp scripts/mesh-vps/local.env.example scripts/mesh-vps/local.env   (then fill it in)

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MESH_VPS_DIR="$ROOT_DIR/scripts/mesh-vps"
[ -f "$MESH_VPS_DIR/local.env" ] && . "$MESH_VPS_DIR/local.env"
need() { local v; for v in "$@"; do [ -n "${!v:-}" ] || { printf '[mesh-vps] error: %s is not set: put it in scripts/mesh-vps/local.env (see local.env.example)\n' "$v" >&2; exit 1; }; done; }

# Required, from local.env (each script checks the ones it uses with `need`): VPS_SSH (ssh over the tailnet,
# <user>@<vps-tailnet-ip>), VPS_PUBLIC_IP, VPS_TAILNET_IP, VPS_DNS (<vps>.<tailnet>.ts.net)
VPS_ID=${VPS_ID:-vps}
VPS_LABEL=${VPS_LABEL:-$VPS_ID}

# Claude Code on the VPS (the VPS user's own install): empty = `command -v claude` in that user's login shell, else a common install
# location; its directory goes on the sova-mesh unit's PATH (the claude-code extension spawns plain `claude`)
CLAUDE_BIN=${CLAUDE_BIN:-}

# The runtime Sova runs on: empty = Bun (the build mise.toml pins, installed in app/.bun by scripts/fetch-bun.sh),
# node = Node (written into sova-mesh.env as SOVA_RUNTIME=node)
SOVA_RUNTIME=${SOVA_RUNTIME:-}
case "$SOVA_RUNTIME" in ''|bun|node) ;; *) printf '[mesh-vps] error: SOVA_RUNTIME is %s: want empty (Bun) or node\n' "$SOVA_RUNTIME" >&2; exit 1 ;; esac

# Everything of ours on the VPS lives under this directory (relative to the VPS user's home)
R=${R:-sova-mesh}

# Ports (the main listener is loopback only; the peer listener binds the tailnet IP only)
SOVA_PORT=${SOVA_PORT:-4800}
SOVA_PEER_PORT=${SOVA_PEER_PORT:-4801}
FRONTDOOR_PORT=${FRONTDOOR_PORT:-4890}
CADDY_ADMIN=${CADDY_ADMIN:-127.0.0.1:2089}
# tailscale serve (set up once as root, SUDO.md; tailnet only; optional for a share-only gateway): the front door and this host
FRONTDOOR_SERVE_PORT=${FRONTDOOR_SERVE_PORT:-8443}
HOST_SERVE_PORT=${HOST_SERVE_PORT:-10443}
# The public share port (§mesh.public): Sova binds it on 127.0.0.1 when this host is the share gateway; only its
# front (SHARE_FRONT) is ever public, on 443
SHARE_PORT=${SHARE_PORT:-4802}
# The public front this VPS runs for share links: empty (none, the default) | vhost | caddy | funnel | cloudflared.
# Any front but cloudflared opens public 443, which the exposure probe then expects OPEN (cloudflared dials out)
SHARE_FRONT=${SHARE_FRONT:-}

# Node 22 LTS, official tarball, pinned by the sha256 in nodejs.org's SHASUMS256.txt, one per architecture
# (remote-setup.sh picks by `uname -m`: x86_64 -> x64, aarch64/arm64 -> arm64; anything else is refused)
NODE_VERSION=${NODE_VERSION:-v22.23.3}
NODE_SHA256_X64=${NODE_SHA256_X64:-df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de}
NODE_SHA256_ARM64=${NODE_SHA256_ARM64:-a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f}

# Caddy, official static release, pinned by the sha512 in the release's checksums.txt, one per architecture
CADDY_VERSION=${CADDY_VERSION:-2.11.4}
CADDY_SHA512_AMD64=${CADDY_SHA512_AMD64:-8220d1f013b6f27510247b2360c9e0ca9f018feebd82515f07635318b34ff9777ccc8fd0b6e6f2486ce3a33fe389fbb7db12d05baa474f4587509fb4f5ebf1c9}
CADDY_SHA512_ARM64=${CADDY_SHA512_ARM64:-d5a7c423853c24a799765e0e8210d5c7c22a8f56ed37a3cae2fb9f58be138853c02b4efd6b59d576e6d8c7c0d30b9c1592deeaa6a536ff69bcca23b8c1ea709c}

# The laptop's team server (the first peer): id, Tailscale StableID, MagicDNS name, peer-listener origin, and the
# front door's upstream for it (a user-level socat forwarder <laptop-tailnet-ip>:4872 -> the team server 127.0.0.1:4870):
# LAPTOP_ID, LAPTOP_NODE_ID, LAPTOP_DNS, LAPTOP_PEER_URL, LAPTOP_SERVE_URL (required by smoke.sh / laptop-forwarder.sh)
LAPTOP_LABEL=${LAPTOP_LABEL:-${LAPTOP_ID:-}}

# The internet relay (§mesh.vps/internet-relay): off (the default) | on. With on, each deploy bundles the accept process,
# installs it in ~/$R/accept and points Sova at the handoff socket (SOVA_RELAY_HANDOFF); its system unit is installed once
# by an admin (SUDO.md §5). VPS_RELAY_PORT is its public port (4803; 443 only if the share front doesn't hold it).
VPS_RELAY=${VPS_RELAY:-off}
case "$VPS_RELAY" in off|on) ;; *) printf '[mesh-vps] error: VPS_RELAY is %s: want off or on\n' "$VPS_RELAY" >&2; exit 1 ;; esac
VPS_RELAY_PORT=${VPS_RELAY_PORT:-4803}

# Public ports the exposure probe expects OPEN, a control that the probe itself works (e.g. "80 443"); empty = no control
VPS_CONTROL_PORTS=${VPS_CONTROL_PORTS:-}
# Units on the VPS whose state must be identical before and after anything we do; empty = the units check is skipped
PROD_UNITS=${PROD_UNITS:-}

vps() { ssh -o BatchMode=yes -o ConnectTimeout=10 "$VPS_SSH" "$@"; }
log() { printf '[mesh-vps] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
