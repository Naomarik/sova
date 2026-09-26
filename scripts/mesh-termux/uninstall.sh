#!/data/data/com.termux/files/usr/bin/sh
# Remove everything scripts/mesh-termux/install.sh added to this Termux, from its manifest (~/sova-mesh/.install):
#
#   sh ~/sova-mesh/uninstall.sh [--keep-ssh]
#   curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/master/scripts/mesh-termux/uninstall.sh | sh -s -- [--keep-ssh]
#
# Removed: the runit service sova-mesh and its log, the supervise/ dirs runit created in services that were already
# there, ~/.termux/boot/sova-mesh (and the dirs install.sh created for it), the wake lock, the packages install.sh
# installed that weren't there before (never one that was, never one a remaining package still needs), and ~/sova-mesh
# (app, agent dir with its sessions and logins, HOME with the synced Claude Code login in home/.claude, TMPDIR). When
# install.sh synced Claude Code's login inside a proot-distro container, the container's .credentials.json is restored
# to what it was before (or removed if there was none), the login it held then kept beside it as
# .credentials.json.sova-uninstall (0600); nothing else in the container is touched. With
# --ssh-key installs it also removes the key line it added, the runit sshd it enabled, and openssh if it installed it.
#   --keep-ssh   keep sshd (package, runit service, the key line) and the wake lock, for remote test loops.
# Left as they were changed: apt's package lists, apt/dpkg logs, and packages that were upgraded as dependencies
# (install.sh lists those in its manifest; this script prints them).
set -eu
export LC_ALL=C

log() { printf '[sova-termux] %s\n' "$*" >&2; }
die() { log "error: $*"; exit 1; }

# One function, so `curl | sh` has parsed all of it before anything runs.
main() {
KEEP_SSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --keep-ssh) KEEP_SSH=1; shift ;;
    *) die "unknown option: $1 (usage: uninstall.sh [--keep-ssh])" ;;
  esac
done
[ -n "${PREFIX:-}" ] && [ "$PREFIX" = /data/data/com.termux/files/usr ] || die "run this inside Termux on Android"
case "$HOME" in /data/data/com.termux/files/home*) ;; *) die "unexpected \$HOME $HOME" ;; esac
[ "$(id -u)" != 0 ] || die "do not run as root"

BASE="$HOME/sova-mesh"
M="$BASE/.install"
SVC="$PREFIX/var/service/sova-mesh"
export SVDIR="$PREFIX/var/service"
[ -d "$BASE" ] || [ -d "$SVC" ] || { log "nothing to remove: no ~/sova-mesh and no sova-mesh service"; exit 0; }
[ -d "$M" ] || log "warning: no manifest in $M: removing the service, the boot script and ~/sova-mesh only"

# the manifest, read before ~/sova-mesh goes
ADDED=$(cat "$M/added" 2>/dev/null || true)
PKGS=$(cat "$M/packages-added" 2>/dev/null || true)
UPGRADED=$(cat "$M/packages-upgraded" 2>/dev/null || true)
SSH_KEY=$(cat "$M/ssh-key" 2>/dev/null || true)
CLAUDE_DIR=$(cat "$M/claude-dir" 2>/dev/null || true)
has() { printf '%s\n' "$ADDED" | grep -qxF "$1"; }

# ---- the service -----------------------------------------------------------------------------------
if [ -d "$SVC" ]; then
  if [ -p "$SVC/supervise/control" ]; then
    sv force-stop sova-mesh >/dev/null 2>&1 || true
    sv exit sova-mesh >/dev/null 2>&1 || true
    [ ! -p "$SVC/log/supervise/control" ] || sv exit "$SVC/log" >/dev/null 2>&1 || true
  fi
  rm -rf "$SVC"
  log "removed the runit service sova-mesh"
fi
# any node still running in ~/sova-mesh (the warm-up, a hand-started server): matched by working dir, not command line
base_nodes() {
  for d in /proc/[0-9]*; do
    [ "$(cat "$d/comm" 2>/dev/null)" = node ] || continue
    case "$(readlink "$d/cwd" 2>/dev/null)" in "$BASE"|"$BASE"/*) echo "${d#/proc/}" ;; esac
  done
}
pids=$(base_nodes)
if [ -n "$pids" ]; then
  kill $pids 2>/dev/null || true; sleep 2
  pids=$(base_nodes); [ -z "$pids" ] || kill -9 $pids 2>/dev/null || true
fi
rm -rf "$PREFIX/var/log/sv/sova-mesh"

# ---- Claude Code's store in a proot container (Sova is stopped: nothing writes it now) -------------------------
if [ -n "$CLAUDE_DIR" ]; then
  # the login the container holds now (it may be a newer one made inside it) is kept before it is replaced or removed
  kept=''
  if [ -f "$CLAUDE_DIR/.credentials.json" ] && { [ -f "$M/claude-credentials.orig" ] || [ -f "$M/claude-credentials.none" ]; }; then
    ( umask 077 && cp "$CLAUDE_DIR/.credentials.json" "$CLAUDE_DIR/.credentials.json.sova-uninstall" ) && chmod 600 "$CLAUDE_DIR/.credentials.json.sova-uninstall" \
      || die "could not keep $CLAUDE_DIR/.credentials.json before restoring it"
    kept=" (the login it held is kept in .credentials.json.sova-uninstall)"
  fi
  if [ -f "$M/claude-credentials.orig" ]; then
    ( umask 077 && cp "$M/claude-credentials.orig" "$CLAUDE_DIR/.credentials.json.sova-tmp" ) \
      && chmod 600 "$CLAUDE_DIR/.credentials.json.sova-tmp" && mv "$CLAUDE_DIR/.credentials.json.sova-tmp" "$CLAUDE_DIR/.credentials.json" \
      || die "could not restore $CLAUDE_DIR/.credentials.json (the original stays in $M/claude-credentials.orig)"
    log "restored the container's own Claude Code login in $CLAUDE_DIR$kept"
  elif [ -f "$M/claude-credentials.none" ]; then
    rm -f "$CLAUDE_DIR/.credentials.json"
    log "removed the Claude Code login Sova synced into $CLAUDE_DIR (there was none before)$kept"
  fi
fi

# ---- ssh -------------------------------------------------------------------------------------------
if [ $KEEP_SSH = 0 ]; then
  if has sshd-service; then
    sv down sshd >/dev/null 2>&1 || true
    touch "$SVDIR/sshd/down"
    log "runit sshd disabled"
  fi
  if [ -n "$SSH_KEY" ] && [ -f "$HOME/.ssh/authorized_keys" ]; then
    grep -vxF "$SSH_KEY" "$HOME/.ssh/authorized_keys" > "$HOME/.ssh/authorized_keys.tmp" || true
    chmod 600 "$HOME/.ssh/authorized_keys.tmp" && mv "$HOME/.ssh/authorized_keys.tmp" "$HOME/.ssh/authorized_keys"
    log "removed the ssh key install.sh added"
  fi
else
  log "--keep-ssh: sshd, its key and the wake lock stay"
  PKGS=$(printf '%s\n' "$PKGS" | grep -vxF openssh || true)
fi

# ---- boot script, wake lock ------------------------------------------------------------------------
rm -f "$HOME/.termux/boot/sova-mesh"
if [ $KEEP_SSH = 0 ] && has wake-lock; then termux-wake-unlock 2>/dev/null || true; log "wake lock released"; fi

# ---- packages --------------------------------------------------------------------------------------
if [ -n "$PKGS" ]; then
  # packages still installed that install.sh added
  list=''
  for p in $PKGS; do dpkg-query -W -f='${db:Status-Abbrev}' "$p" 2>/dev/null | grep -q '^ii' && list="$list $p"; done
  if [ -n "$list" ]; then
    if printf '%s\n' "$list" | tr ' ' '\n' | grep -qxF termux-services && pgrep -f "runsvdir $SVDIR" >/dev/null 2>&1; then
      service-daemon stop >/dev/null 2>&1 || pkill -f "runsvdir $SVDIR" 2>/dev/null || true
      rm -f "$PREFIX/var/run/service-daemon.pid"  # its own pidfile, left behind by `service-daemon stop`
    fi
    # never remove a package that was there before or that a remaining package needs: drop, from the list, whatever
    # apt would take with it and everything those need (a kept openssh keeps its dependencies)
    keep=''
    [ $KEEP_SSH = 0 ] || keep=openssh
    i=0
    while [ $i -lt 5 ]; do
      extra=$(apt-get -s purge $list 2>/dev/null | awk '/^(Purg|Remv) /{print $2}' | while read -r p; do printf '%s\n' $list | grep -qxF "$p" || echo "$p"; done)
      need=$(printf '%s\n' $keep $extra | grep . | sort -u) || true
      [ -n "$need" ] || break
      deps=$(apt-cache depends --recurse --installed --no-recommends --no-suggests --no-conflicts --no-breaks --no-replaces --no-enhances $need 2>/dev/null | awk '/^[a-z0-9]/{print $1} /Depends:/{print $2}' | tr -d '<>' | sort -u)
      new=''
      for p in $list; do printf '%s\n' $need $deps | grep -qxF "$p" || new="$new $p"; done
      [ "$new" != "$list" ] || break
      list=$new; keep=''
      i=$((i+1))
    done
    extra=$(apt-get -s purge $list 2>/dev/null | awk '/^(Purg|Remv) /{print $2}' | while read -r p; do printf '%s\n' $list | grep -qxF "$p" || echo "$p"; done)
    [ -z "$extra" ] || die "apt would also remove$(printf ' %s' $extra); stopping before any package is removed"
    if [ -n "$list" ]; then
      log "purging packages install.sh added:$list"
      DEBIAN_FRONTEND=noninteractive apt-get purge -y -qq $list >&2 </dev/null || die "apt-get purge failed"
    fi
  fi
fi

# ---- what install.sh created, deepest first ---------------------------------------------------------
printf '%s\n' "$ADDED" | tac | while IFS= read -r line; do
  case "$line" in
    "file "*) f=${line#file }
      [ "$f" != "$HOME/.ssh/authorized_keys" ] || { [ $KEEP_SSH = 0 ] && [ ! -s "$f" ]; } || continue
      rm -f "$f" ;;
    "dir "*) d=${line#dir }
      [ "$d" != "$HOME/.ssh" ] || [ $KEEP_SSH = 0 ] || continue
      case "$d" in */supervise|"$PREFIX"/var/log/sv|"$PREFIX"/var/log/sv/*) rm -rf "$d" ;; *) rmdir "$d" 2>/dev/null || true ;; esac ;;
  esac
done

rm -rf "$BASE"
log "removed ~/sova-mesh"
[ -z "$UPGRADED" ] || log "left upgraded (were installed before, upgraded as dependencies): $(printf '%s\n' "$UPGRADED" | awk '{printf "%s %s->%s; ", $1, $2, $3}')"
log "done. Left as changed: apt's package lists and logs."
}

main "$@"
