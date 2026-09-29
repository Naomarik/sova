#!/usr/bin/env bash
# Deploy a commit of this checkout to a phone host over ssh (its Termux sshd, key auth; never git push):
#   scripts/mesh-termux/deploy.sh [--ssh <user@host>] [--ssh-port <n>] [--rev <sha>] [-- <install.sh options…>]
# The twin of scripts/mesh-vps/deploy.sh. `git archive <sha>` (which carries the commit id install.sh records in
# BUILD_COMMIT) is streamed over ssh into the phone's $PREFIX/tmp, then that commit's own install.sh runs there with
# `--source-url file://…` and the given options. install.sh remembers --node-id, --dns, --tailnet-ip, --port and
# --peer-port from the run that gave them, so none is needed here unless it changes; it builds in app.new, swaps it in,
# and restarts Sova on the phone. The phone must be awake, on the tailnet, and installed with --ssh-key (runit sshd).
# The ssh target and port default to PHONE and PHONE_PORT (8022) from the untracked local.env beside this script.
# Started by hand, or by a resync from the host menu (§mesh.peers/resync), which passes --rev with its boot commit.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
[ -f "$HERE/local.env" ] && . "$HERE/local.env"
SSH_TARGET=${PHONE:-}
SSH_PORT=${PHONE_PORT:-8022}
REV=HEAD
log() { printf '[mesh-termux] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }
usage="usage: $0 [--ssh <user@host>] [--ssh-port <n>] [--rev <sha>] [-- <install.sh options…>]"

while [ $# -gt 0 ]; do
  case "$1" in
    --ssh) SSH_TARGET=${2:?--ssh needs user@host}; shift 2 ;;
    --ssh-port) SSH_PORT=${2:?--ssh-port needs a port}; shift 2 ;;
    --rev) REV=${2:?--rev needs a commit}; shift 2 ;;
    --) shift; break ;;
    *) die "$usage" ;;
  esac
done
[ -n "$SSH_TARGET" ] || die "no ssh target: pass --ssh <user@host>, or set PHONE in scripts/mesh-termux/local.env"
case "$SSH_TARGET" in -*|*[!A-Za-z0-9._@:-]*) die "--ssh $SSH_TARGET is not user@host" ;; esac
case "$SSH_PORT" in ''|*[!0-9]*) die "--ssh-port must be a number" ;; esac
for a in "$@"; do
  case "$a" in --source-url|--source-url=*|--ref|--ref=*) die "the source is the commit this deploys: drop $a" ;; esac
done
SHA=$(git -C "$ROOT" rev-parse --verify "$REV^{commit}") || die "no such commit: $REV"
git -C "$ROOT" cat-file -e "$SHA:scripts/mesh-termux/install.sh" 2>/dev/null || die "${SHA:0:12} has no scripts/mesh-termux/install.sh"

ph() { ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -p "$SSH_PORT" "$SSH_TARGET" "$@"; }
# one word for the phone's shell, whatever it holds
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# on the phone: $PREFIX is expanded there, never here
TGZ='$PREFIX/tmp/sova-src-'"${SHA:0:12}"'.tar.gz'
args=''
for a in "$@"; do args="$args $(q "$a")"; done

log "deploying ${SHA:0:12} to $SSH_TARGET (port $SSH_PORT)"
git -C "$ROOT" archive --format=tar --prefix=sova/ "$SHA" | gzip -n -9 | ph "cat > $TGZ"
rc=0
# the commit's own installer (curl | sh style), and the source last so no option can replace it
git -C "$ROOT" show "$SHA:scripts/mesh-termux/install.sh" | ph "sh -s --$args --source-url file://$TGZ" || rc=$?
ph "rm -f $TGZ" || log "could not remove the tarball on the phone ($TGZ)"
[ "$rc" = 0 ] || die "install.sh stopped with exit $rc: the phone keeps its previous app unless the log above says it swapped"
log "deployed ${SHA:0:12}"
