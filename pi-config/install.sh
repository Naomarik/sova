#!/usr/bin/env bash
# Link this repository into ~/.pi/agent so pi reads its config and extensions
# from here. Existing regular files are moved aside as *.bak; existing symlinks
# are replaced. Run it again after cloning to a new machine.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
agent=${PI_AGENT_DIR:-$HOME/.pi/agent}
mkdir -p "$agent/extensions"

link() {
	local src=$1 dst=$2
	if [ -L "$dst" ]; then
		rm "$dst"
	elif [ -e "$dst" ]; then
		mv "$dst" "$dst.bak"
		echo "moved existing $dst to $dst.bak"
	fi
	ln -s "$src" "$dst"
	echo "$dst -> $src"
}

for f in settings.json keybindings.json models.json; do
	link "$here/$f" "$agent/$f"
done
for d in "$here"/extensions/*/; do
	d=${d%/}
	link "$d" "$agent/extensions/$(basename "$d")"
done

echo
echo "Start pi once to install the pinned packages from settings.json, then run /reload."
