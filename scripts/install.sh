#!/usr/bin/env bash
# Install Sova (https://github.com/Naomarik/sova) into a directory of its own and put a `sova`
# launcher on PATH. Safe to pipe from curl:
#
#   curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/v0.1.0/scripts/install.sh | bash
#
# What it needs on the machine already: git, node (>= 22.19) and pnpm. Without pnpm it runs the
# version the repository pins through npx (npm ships with Node). It installs no toolchain, no
# version manager and no system package, and it never uses sudo.
#
# What it touches, and nothing else:
#   <install dir>          default ~/.local/share/sova — a clone, its node_modules and its dist/
#   <bin dir>/sova         default ~/.local/bin/sova — a launcher this script wrote
#   a staging directory beside the install dir, removed on the way out
#   pnpm's own package store and cache (and npx's cache when pnpm runs through it), as any
#   install does
#
# ~/.pi is never read or written. Sova reads the agent directory at runtime, as you, and this
# script does not link pi config or extensions into it: pi-config/install.sh would replace the
# config of a machine that already runs pi, so running it stays your decision.
#
# Re-running is safe. The install directory is replaced only when it is a clone of this
# repository with no uncommitted changes; anything else is refused and left alone. The build
# happens in staging and is promoted only after it succeeds, with the previous install kept
# until the promotion is complete and restored if it fails.
#
# Flags: --dir <path> install directory · --bin <path> directory for the launcher.
# Env for testing: SOVA_REPO (clone source), SOVA_REF (tag, branch or commit).
set -euo pipefail

repo=${SOVA_REPO:-https://github.com/Naomarik/sova.git}
ref=${SOVA_REF:-v0.1.0}
dir=${SOVA_DIR:-$HOME/.local/share/sova}
bindir=${SOVA_BIN:-$HOME/.local/bin}
node_min_major=22
node_min_minor=19
marker="# sova-launcher v1"

die() { printf 'sova install: %s\n' "$1" >&2; exit 1; }
say() { printf '%s\n' "$1"; }

while [ $# -gt 0 ]; do
	case "$1" in
		--dir) [ $# -ge 2 ] || die "--dir needs a path"; dir=$2; shift 2 ;;
		--bin) [ $# -ge 2 ] || die "--bin needs a path"; bindir=$2; shift 2 ;;
		-h|--help)
			say "usage: install.sh [--dir <install dir>] [--bin <launcher dir>]"
			say "installs Sova into ${dir} and a launcher into ${bindir}/sova"
			exit 0 ;;
		*) die "unknown argument: $1 (try --help)" ;;
	esac
done

# ---- prerequisites. Nothing below this block writes anything. ----

for cmd in git node; do
	command -v "$cmd" >/dev/null 2>&1 || die "$cmd is not installed. Install git, Node.js >= $node_min_major.$node_min_minor and pnpm, then run this again."
done
# pnpm on PATH is used as it is; otherwise npx runs pnpm (the version is read from the clone below).
if command -v pnpm >/dev/null 2>&1; then
	use_npx=false
elif command -v npx >/dev/null 2>&1; then
	use_npx=true
else
	die "pnpm is not installed, and there is no npx to run it with. Install pnpm (https://pnpm.io/installation), then run this again."
fi

node_version=$(node -v 2>/dev/null || true)         # v25.2.1
node_version=${node_version#v}
node_major=${node_version%%.*}
node_rest=${node_version#*.}
node_minor=${node_rest%%.*}
case "$node_major$node_minor" in
	'' | *[!0-9]*) die "could not read a version from 'node -v' (got '${node_version:-nothing}')" ;;
esac
if [ "$node_major" -lt "$node_min_major" ] ||
	{ [ "$node_major" -eq "$node_min_major" ] && [ "$node_minor" -lt "$node_min_minor" ]; }; then
	die "Node.js $node_version is too old; Sova needs >= $node_min_major.$node_min_minor. Upgrade Node yourself, then run this again."
fi

case "$dir" in /*) ;; *) dir=$PWD/$dir ;; esac
case "$bindir" in /*) ;; *) bindir=$PWD/$bindir ;; esac
launcher=$bindir/sova

# An existing install directory is only ours to replace if it is a clone of this repository with
# nothing uncommitted. Untracked files are ignored on purpose: dist/ and node_modules/ are
# git-ignored and always present after an install.
update=false
if [ -e "$dir" ]; then
	[ -d "$dir" ] || die "$dir exists and is not a directory. Move it, or pass --dir <path>."
	git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 ||
		die "$dir exists and is not a git clone. Move it, or pass --dir <path>."
	origin=$(git -C "$dir" remote get-url origin 2>/dev/null || true)
	case "$origin" in
		*[Ss]ova*) ;;
		*) die "$dir is a clone of '${origin:-no origin}', not Sova. Move it, or pass --dir <path>." ;;
	esac
	changes=$(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null || true)
	[ -z "$changes" ] ||
		die "$dir has uncommitted changes. Commit, stash or move them, then run this again."
	update=true
fi

# An existing launcher is only ours to replace if we wrote it.
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
	if [ ! -f "$launcher" ] || ! head -n 5 "$launcher" 2>/dev/null | grep -qF "$marker"; then
		die "$launcher exists and was not written by this script. Move it, or pass --bin <path>."
	fi
fi

# ---- build in staging ----

parent=$(dirname "$dir")
mkdir -p "$parent" "$bindir"
staging=$(mktemp -d "$parent/.sova-staging.XXXXXX")   # beside the target, so promoting is a rename
backup=
cleanup() {
	rm -rf "$staging"
	# A failure after the old install moved aside: put it back before leaving.
	if [ -n "$backup" ] && [ -d "$backup" ] && [ ! -e "$dir" ]; then
		mv "$backup" "$dir"
		say "restored the previous install at $dir"
	fi
}
trap cleanup EXIT

say "cloning $repo at $ref"
git clone --quiet --depth 1 --branch "$ref" "$repo" "$staging/sova" 2>/dev/null ||
	git clone --quiet "$repo" "$staging/sova" ||
	die "could not clone $repo"
git -C "$staging/sova" checkout --quiet "$ref" 2>/dev/null || true
commit=$(git -C "$staging/sova" rev-parse --short HEAD)

if $use_npx; then
	# The pnpm the repository pins in package.json's packageManager, or the latest without one.
	pnpm_version=$(sed -n 's/^[[:space:]]*"packageManager":[[:space:]]*"pnpm@\([^"+]*\).*/\1/p' "$staging/sova/package.json")
	pnpm=(npx --yes "pnpm@${pnpm_version:-latest}")
	say "pnpm is not installed; running ${pnpm[2]} through npx"
else
	pnpm=(pnpm)
fi

say "installing dependencies (including dev dependencies: the server runs through tsx)"
( cd "$staging/sova" && "${pnpm[@]}" install --frozen-lockfile --prod=false ) ||
	die "pnpm install failed; nothing was changed"

say "building"
( cd "$staging/sova" && "${pnpm[@]}" run build ) || die "the build failed; nothing was changed"

# ---- promote ----

if $update; then
	backup=$dir.sova-previous.$$
	mv "$dir" "$backup"
fi
mv "$staging/sova" "$dir"
if [ -n "$backup" ]; then
	rm -rf "$backup"
	backup=
fi

cat > "$launcher.$$" <<LAUNCHER
#!/usr/bin/env bash
$marker
# Runs the built Sova server from its install directory. PORT and HOST are read by the server.
set -euo pipefail
dir=$(printf '%q' "$dir")
exec "\$dir/node_modules/.bin/tsx" "\$dir/server/index.ts" "\$@"
LAUNCHER
chmod 755 "$launcher.$$"
mv "$launcher.$$" "$launcher"

say ""
say "installed $ref ($commit) in $dir"
say "launcher: $launcher"
case ":$PATH:" in
	*:"$bindir":*) say "run: sova" ;;
	*) say "$bindir is not on your PATH; run: $launcher" ;;
esac
say ""
say "It serves http://127.0.0.1:4800 — loopback only, and it has no authentication of its own."
say "Set PORT to move the port. Setting HOST=0.0.0.0 puts an unauthenticated app that can read"
say "your files and run commands as you on the network; only do that behind something that"
say "authenticates."
say ""
say "It reads the same ~/.pi/agent the pi TUI does, and this script wrote nothing there. Sessions"
say "already on the machine are listed and readable straight away. To chat from the page you need"
say "pi's provider credentials in ~/.pi/agent/auth.json — run 'pi' and '/login' once if you have"
say "not. A session open in a TUI is shown live and read-only."
