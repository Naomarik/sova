#!/usr/bin/env bash
# Link this repository into ~/.pi/agent so pi reads its config and extensions
# from here. Existing regular files are moved aside as *.bak; existing symlinks
# are replaced. Run it again after cloning to a new machine.
#
# install.sh --check changes nothing: it exits nonzero if any expected link is
# missing or points elsewhere, or if any entry in the agent's extensions/
# directory is not a symlink into this repository.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
agent=${PI_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}
check=false
case "${1:-}" in
	"") ;;
	--check) check=true ;;
	*) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac
bad=0

link() {
	local src=$1 dst=$2
	if $check; then
		if [ "$(readlink "$dst" 2>/dev/null)" != "$src" ]; then
			echo "not linked: $dst (want -> $src)"
			bad=1
		fi
		return
	fi
	if [ -L "$dst" ]; then
		rm "$dst"
	elif [ -e "$dst" ]; then
		mv "$dst" "$dst.bak"
		echo "moved existing $dst to $dst.bak"
	fi
	ln -s "$src" "$dst"
	echo "$dst -> $src"
}

$check || mkdir -p "$agent/extensions"
for f in settings.json keybindings.json models.json; do
	link "$here/$f" "$agent/$f"
done
for d in "$here"/extensions/*/; do
	d=${d%/}
	link "$d" "$agent/extensions/$(basename "$d")"
done
for f in "$here"/extensions/*.ts; do
	[ -e "$f" ] || continue
	link "$f" "$agent/extensions/$(basename "$f")"
done
$check || mkdir -p "$HOME/.local/bin"
link "$here/extensions/sessions/bin/pi-sessions.ts" "$HOME/.local/bin/pi-sessions"

if $check; then
	for e in "$agent"/extensions/* "$agent"/extensions/.[!.]*; do
		[ -e "$e" ] || [ -L "$e" ] || continue
		target=$(readlink -f "$e" 2>/dev/null || true)
		if [ ! -L "$e" ] || [ ! -e "$e" ] || [ "${target#"$here"/}" = "$target" ]; then
			echo "not a symlink into $here: $e"
			bad=1
		fi
	done
	[ "$bad" = 0 ] && echo "ok: $agent is linked to $here"
	exit "$bad"
fi

echo
echo "Start pi once to install the pinned packages from settings.json, then run /reload."
