#!/usr/bin/env bash
# Install Sova (https://github.com/Naomarik/sova) into a directory of its own, put a `sova`
# launcher on PATH with an app-launcher entry that opens Sova in its own window, link Sova's pi
# extensions into pi's agent directory and, if you want one, install a login service. Safe to
# pipe from curl:
#
#   curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/stable/scripts/install.sh | bash
#
# That installs the newest stable release (the `stable` tag); SOVA_REF picks another tag, branch or
# commit, and a re-run installs the latest of whatever ref it names.
#
# The whole script is one function, main, called on its last line: bash reads all of it before any
# of it runs, so a download cut short runs nothing.
#
# What it needs on the machine already: bash, git, node (>= 22.19), pnpm, curl, and unzip or python3.
# Without pnpm it runs the version the repository pins through npx (npm ships with Node). The
# server runs on Bun: the installer downloads the Bun release the repository pins (mise.toml) from
# Bun's GitHub releases into <install dir>/.bun, checked against the sha256 the repository records
# (scripts/bun-release.txt, through scripts/fetch-bun.sh). That keeps Bun inside the install
# directory, at the version Sova is tested on, with no version manager and no edit to a shell rc
# file (as bun.sh/install would make). Beyond that it installs no toolchain, no version manager and
# no system package, and it never uses sudo. It runs on macOS's bash 3.2 and BSD tools as well as
# on Linux.
#
# What it touches, and nothing else:
#   <install dir>          default ~/.local/share/sova — a clone, its node_modules, its dist/ and
#                          the pinned Bun in .bun/bin/bun
#   <bin dir>/sova         default ~/.local/bin/sova — a launcher this script wrote
#   an app-launcher entry that runs `<bin dir>/sova app` (--no-app-entry skips it): on Linux
#                          ${XDG_DATA_HOME:-~/.local/share}/applications/sova.desktop and its icon
#                          .../icons/hicolor/512x512/apps/sova.png, on macOS ~/Applications/Sova.app.
#                          `sova app` keeps its browser profile in ~/.config/sova-browser (Linux) or
#                          ~/Library/Application Support/sova-browser (macOS).
#   <agent dir>/extensions/<name>
#                          one symlink per extension in <install dir>/pi-config/extensions, where
#                          <agent dir> is $PI_CODING_AGENT_DIR, else ~/.pi/agent (--no-extensions
#                          skips them). Anything already at one of those paths that is not our
#                          own link is left alone and that extension is skipped.
#   a login service, only if you ask for one (--service, or yes at the prompt): the launchd agent
#                          ~/Library/LaunchAgents/io.github.naomarik.sova.plist on macOS, the
#                          systemd user unit ~/.config/systemd/user/sova.service on Linux
#   a staging directory beside the install dir, removed on the way out
#   pnpm's own package store and cache (and npx's cache when pnpm runs through it), as any
#   install does
#
# It writes none of pi's own configuration: no settings.json, models.json, keybindings.json,
# auth.json or sandbox policy. pi-config/install.sh installs a whole personal pi setup and
# replaces the config of a machine that already runs pi, so running it stays your decision.
#
# Re-running is safe, and with the same inputs changes nothing: an install already at the
# requested commit is not rebuilt (--reinstall rebuilds it), and every file above is rewritten
# only when its content would change. The install directory is replaced only when it is a clone
# of this repository with no uncommitted changes; anything else is refused and left alone. The
# build happens in staging and is promoted only after it succeeds, with the previous install kept
# until the promotion is complete and restored if it fails. A service is reloaded only when its
# definition changed, restarted when the code changed, and never started twice.
#
# Flags: --dir <path> install directory · --bin <path> directory for the launcher ·
# --service / --no-service install the login service or not, without asking · --port <n> the
# service's port (default 4800) · --no-extensions link no pi extensions · --no-app-entry write
# no app-launcher entry · --reinstall rebuild even when the install is already at the requested
# commit.
# Env: SOVA_REF (tag, branch or commit to install; a name that is none of them stops the install),
# SOVA_NO_APP_ENTRY=1 (as --no-app-entry), SOVA_REPO (clone source, for testing),
# SOVA_KEEP_PREVIOUS=<path> (move the install this run replaces to <path> instead of deleting it:
# Settings → General's upgrade keeps it until the new version answers, and puts it back otherwise).
set -euo pipefail

# The body is not indented, so the here-documents below keep their text as written.
main() {

repo=${SOVA_REPO:-https://github.com/Naomarik/sova.git}
# RELEASE: the default is `stable`, the one tag that moves: each release points it at its own
# numbered tag (vX.Y.Z), and numbered tags never move. So the installer fetched from any ref, a
# numbered tag's included, installs whatever `stable` points at when it runs; pinning a release
# takes SOVA_REF=vX.Y.Z. Nothing here changes per release (.sova/playbooks/release/PLAYBOOK.md).
ref=${SOVA_REF:-stable}
dir=${SOVA_DIR:-$HOME/.local/share/sova}
bindir=${SOVA_BIN:-$HOME/.local/bin}
tty=${SOVA_TTY:-/dev/tty}
port=4800
service=ask            # ask | yes | no
extensions=true
app_entry=true
[ "${SOVA_NO_APP_ENTRY:-}" != 1 ] || app_entry=false
reinstall=false
keep_previous=${SOVA_KEEP_PREVIOUS:-}
node_min_major=22
node_min_minor=19
marker="# sova-launcher v1"
service_marker="sova-service v1"
entry_marker="X-Sova-Launcher=v1"
label=io.github.naomarik.sova

die() { printf 'sova install: %s\n' "$1" >&2; exit 1; }
say() { printf '%s\n' "$1"; }

while [ $# -gt 0 ]; do
	case "$1" in
		--dir) [ $# -ge 2 ] || die "--dir needs a path"; dir=$2; shift 2 ;;
		--bin) [ $# -ge 2 ] || die "--bin needs a path"; bindir=$2; shift 2 ;;
		--port) [ $# -ge 2 ] || die "--port needs a number"; port=$2; shift 2 ;;
		--service) service=yes; shift ;;
		--no-service) service=no; shift ;;
		--no-extensions) extensions=false; shift ;;
		--no-app-entry) app_entry=false; shift ;;
		--reinstall) reinstall=true; shift ;;
		-h|--help)
			say "usage: install.sh [--dir <install dir>] [--bin <launcher dir>] [--service | --no-service]"
			say "                  [--port <n>] [--no-extensions] [--no-app-entry] [--reinstall]"
			say "installs Sova into ${dir} and a launcher into ${bindir}/sova"
			exit 0 ;;
		*) die "unknown argument: $1 (try --help)" ;;
	esac
done
case "$port" in '' | *[!0-9]*) die "--port needs a number, got '$port'" ;; esac

# ---- prerequisites. Nothing below this block writes anything. ----

for cmd in git node; do
	command -v "$cmd" >/dev/null 2>&1 || die "$cmd is not installed. Install git and Node.js >= $node_min_major.$node_min_minor, then run this again."
done
# Bun's download (scripts/fetch-bun.sh): curl, and unzip or python3 to unpack it.
command -v curl >/dev/null 2>&1 || die "curl is not installed; it downloads Bun. Install curl, then run this again."
command -v unzip >/dev/null 2>&1 || command -v python3 >/dev/null 2>&1 ||
	die "unzip is not installed (nor python3); it unpacks Bun. Install unzip, then run this again."
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
if [ -n "$keep_previous" ]; then
	case "$keep_previous" in /*) ;; *) keep_previous=$PWD/$keep_previous ;; esac
	{ [ -e "$keep_previous" ] || [ -L "$keep_previous" ]; } &&
		die "SOVA_KEEP_PREVIOUS: $keep_previous already exists; nothing was changed"
fi
launcher=$bindir/sova

# pi's agent directory, resolved as pi resolves it: $PI_CODING_AGENT_DIR (a leading ~ expanded),
# else ~/.pi/agent.
agent=${PI_CODING_AGENT_DIR:-}
case "$agent" in
	'') agent=$HOME/.pi/agent ;;
	"~") agent=$HOME ;;
	"~/"*) agent=$HOME/${agent#"~/"} ;;
esac

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
	update=true
fi

# An existing launcher is only ours to replace if we wrote it.
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
	if [ ! -f "$launcher" ] || ! head -n 5 "$launcher" 2>/dev/null | grep -qF "$marker"; then
		die "$launcher exists and was not written by this script. Move it, or pass --bin <path>."
	fi
fi

# The app-launcher entry: a .desktop file and its icon on Linux, an app bundle on macOS. Only
# ours is replaced: a .desktop file or an Info.plist with our marker (and the icon beside our own
# .desktop file).
os=$(uname -s)
entry_kind=none
if $app_entry; then
	case "$os" in
		Linux)
			entry_kind=desktop
			xdg_data=${XDG_DATA_HOME:-$HOME/.local/share}
			entry_file=$xdg_data/applications/sova.desktop
			entry_icon=$xdg_data/icons/hicolor/512x512/apps/sova.png
			entry_ours=false
			if [ -e "$entry_file" ] || [ -L "$entry_file" ]; then
				if [ -f "$entry_file" ] && [ ! -L "$entry_file" ] && grep -qxF "$entry_marker" "$entry_file" 2>/dev/null; then
					entry_ours=true
				else
					die "$entry_file exists and was not written by this script. Move it, or pass --no-app-entry."
				fi
			fi
			if ! $entry_ours && { [ -e "$entry_icon" ] || [ -L "$entry_icon" ]; }; then
				die "$entry_icon exists and was not written by this script. Move it, or pass --no-app-entry."
			fi ;;
		Darwin)
			entry_kind=bundle
			entry_file=$HOME/Applications/Sova.app
			if [ -e "$entry_file" ] || [ -L "$entry_file" ]; then
				if [ -L "$entry_file" ] || [ ! -f "$entry_file/Contents/Info.plist" ] ||
					! grep -qF "<!-- $entry_marker" "$entry_file/Contents/Info.plist" 2>/dev/null; then
					die "$entry_file exists and was not written by this script. Move it, or pass --no-app-entry."
				fi
			fi ;;
	esac
fi

# The login service: launchd on macOS, a systemd user unit on Linux.
service_kind=none
case "$os" in
	Darwin)
		service_kind=launchd
		service_file=$HOME/Library/LaunchAgents/$label.plist ;;
	Linux)
		if command -v systemctl >/dev/null 2>&1; then
			service_kind=systemd
			service_file=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/sova.service
		fi ;;
esac
service_ours=false
if [ "$service_kind" != none ] && { [ -e "$service_file" ] || [ -L "$service_file" ]; }; then
	if [ -f "$service_file" ] && [ ! -L "$service_file" ] && grep -qF "$service_marker" "$service_file" 2>/dev/null; then
		service_ours=true
	fi
fi
if [ "$service" = ask ]; then
	if $service_ours; then
		service=yes        # installed by this script before: keep it, and keep it current
	elif [ "$service_kind" = none ]; then
		service=no
	elif (: <"$tty") 2>/dev/null; then
		if [ "$service_kind" = launchd ]; then what="a launchd agent"; else what="a systemd user service"; fi
		printf 'Run Sova as %s that starts at login, on port %s? [y/N] ' "$what" "$port" >>"$tty"
		answer=
		read -r answer <"$tty" || true
		case "$answer" in [Yy] | [Yy][Ee][Ss]) service=yes ;; *) service=no ;; esac
	else
		service=no
	fi
fi
if [ "$service" = yes ]; then
	[ "$service_kind" != none ] ||
		die "--service: this machine has neither launchd nor systemctl; run the launcher yourself (pass --no-service)."
	if { [ -e "$service_file" ] || [ -L "$service_file" ]; } && ! $service_ours; then
		die "$service_file exists and was not written by this script. Move it, or pass --no-service."
	fi
fi

# The commit the ref names, asked of the source before anything is written: a tag (its commit) or
# a branch. A name that is neither must look like a commit, checked once cloned; anything else
# stops here, so the default branch is never installed in a ref's place.
remote_refs=$(git ls-remote "$repo" "refs/tags/$ref^{}" "refs/tags/$ref" "refs/heads/$ref" 2>/dev/null) ||
	die "could not read the tags and branches of $repo (git ls-remote failed); nothing was changed"
want=
while read -r sha name; do
	case "$name" in *'^{}') want=$sha; break ;; esac
	[ -n "$want" ] || want=$sha
done <<EOF
$remote_refs
EOF
if [ -z "$want" ]; then
	case "$ref" in
		*[!0-9a-f]* | '') bad_ref=true ;;
		???????*) bad_ref=false ;;           # a commit, or not: the clone says
		*) bad_ref=true ;;
	esac
	! $bad_ref ||
		die "'$ref' is not a tag or a branch of $repo; nothing was changed. Pass SOVA_REF=<tag, branch or commit>."
fi

# An install already at that commit, with its dependencies and build in place, is not rebuilt.
rebuild=true
if $update && ! $reinstall; then
	have=$(git -C "$dir" rev-parse HEAD 2>/dev/null || true)
	same=false
	if [ -n "$want" ]; then
		[ "$want" = "$have" ] && same=true
	else
		case "$ref" in
			*[!0-9a-f]*) ;;
			???????*) case "$have" in "$ref"*) same=true ;; esac ;;
		esac
	fi
	# ... and with the Bun its mise.toml pins in place.
	bun_pin=$(sed -n 's/^[[:space:]]*bun[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$dir/mise.toml" 2>/dev/null | head -n 1)
	bun_have=$("$dir/.bun/bin/bun" --version 2>/dev/null || true)
	if $same && [ -f "$dir/dist/index.html" ] && [ -x "$dir/node_modules/.bin/tsx" ] &&
		[ -n "$bun_pin" ] && [ "$bun_have" = "$bun_pin" ]; then
		rebuild=false
	fi
fi
if $rebuild && $update; then
	changes=$(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null || true)
	[ -z "$changes" ] ||
		die "$dir has uncommitted changes. Commit, stash or move them, then run this again."
fi

# ---- build in staging ----

staging=
backup=
made_dirs=             # directories this run created for staging, deepest first
cleanup() {
	local status=$? d
	[ -z "$staging" ] || rm -rf "$staging"
	# A failure leaves no directory behind that this run created (rmdir: only while empty).
	if [ "$status" -ne 0 ] && [ -n "$made_dirs" ]; then
		while IFS= read -r d; do
			[ -z "$d" ] || rmdir "$d" 2>/dev/null || true
		done <<DIRS
$made_dirs
DIRS
	fi
	# A failure after the old install moved aside: put it back before leaving.
	if [ -n "$backup" ] && [ -d "$backup" ] && [ ! -e "$dir" ]; then
		mv "$backup" "$dir"
		say "restored the previous install at $dir"
	fi
}
trap cleanup EXIT

if $rebuild; then
	parent=$(dirname "$dir")
	d=$parent
	while [ ! -e "$d" ]; do
		made_dirs=${made_dirs:+$made_dirs
}$d
		d=$(dirname "$d")
	done
	mkdir -p "$parent"        # the launcher's directory waits for a successful build
	staging=$(mktemp -d "$parent/.sova-staging.XXXXXX")   # beside the target, so promoting is a rename

	say "cloning $repo at $ref"
	git clone --quiet --depth 1 --branch "$ref" "$repo" "$staging/sova" 2>/dev/null ||
		git clone --quiet "$repo" "$staging/sova" ||
		die "could not clone $repo; nothing was changed"
	git -C "$staging/sova" -c advice.detachedHead=false checkout --quiet "$ref" 2>/dev/null ||
		die "'$ref' is not a tag, a branch or a commit of $repo; nothing was changed. Pass SOVA_REF=<tag, branch or commit>."

	if $use_npx; then
		# The pnpm the repository pins in package.json's packageManager, or the latest without one.
		pnpm_version=$(sed -n 's/^[[:space:]]*"packageManager":[[:space:]]*"pnpm@\([^"+]*\).*/\1/p' "$staging/sova/package.json")
		pnpm=(npx --yes "pnpm@${pnpm_version:-latest}")
		say "pnpm is not installed; running ${pnpm[2]} through npx"
	else
		pnpm=(pnpm)
	fi

	# The pinned Bun: the previous install's when it is still the pinned one, else downloaded.
	if [ -x "$dir/.bun/bin/bun" ]; then
		mkdir -p "$staging/sova/.bun/bin"
		cp -p "$dir/.bun/bin/bun" "$staging/sova/.bun/bin/bun"
	fi
	sh "$staging/sova/scripts/fetch-bun.sh" "$staging/sova/.bun" >/dev/null ||
		die "could not install Bun; nothing was changed"

	say "installing dependencies (including dev dependencies: tsx runs the server on Node, sova --node)"
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
		if [ -n "$keep_previous" ]; then
			mv "$backup" "$keep_previous"
			say "kept the previous install at $keep_previous"
		else
			rm -rf "$backup"
		fi
		backup=
	fi
else
	mkdir -p "$bindir"
fi
commit=$(git -C "$dir" rev-parse --short HEAD)

# write_file <path> <mode>: stdin becomes <path>, only when it differs, so an unchanged file and
# its directory are not touched at all. Sets `wrote`.
wrote=false
write_file() {
	local path=$1 mode=$2 new
	new=$(cat; printf x)                 # the x keeps trailing newlines through $( )
	new=${new%x}
	if [ -f "$path" ] && [ ! -L "$path" ] && [ "$(cat "$path"; printf x)" = "${new}x" ]; then
		wrote=false
		return 0
	fi
	mkdir -p "$(dirname "$path")"
	printf '%s' "$new" > "$path.new.$$"
	chmod "$mode" "$path.new.$$"
	mv "$path.new.$$" "$path"
	wrote=true
}

# launchd and systemd start services without the login shell's PATH, and neither does a desktop
# start `sova app` with one: give them the directories the tools were found in, then the usual ones.
service_path=
add_path() {
	[ -n "$1" ] || return 0
	case ":$service_path:" in *":$1:"*) return 0 ;; esac
	service_path=${service_path:+$service_path:}$1
}
for cmd in node git pnpm claude; do
	found=$(command -v "$cmd" 2>/dev/null || true)
	case "$found" in /*) add_path "$(dirname "$found")" ;; esac
done
add_path "$HOME/.local/bin"
mise_shims=${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims
[ -d "$mise_shims" ] && add_path "$mise_shims"
for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do add_path "$d"; done

# The launcher: the install's paths and port first, then a body that takes them as they are.
{
cat <<LAUNCHER
#!/usr/bin/env bash
$marker
# Runs the built Sova server from its install directory, on the Bun in its .bun/ (SOVA_BUN names
# another), on PORT, else the port it was installed with. HOST is read by the server.
#   sova --node  run the server on Node instead (SOVA_RUNTIME=node does the same)
#   sova token   print this install's access token (the server mints it at its first start)
#   sova app     open the app, unlocked by the token in the URL's fragment, in a bare window of a
#                Chromium-family browser with a profile of its own (a tab of the default browser
#                when there is none), starting the server first when nothing answers on the port.
#                What the app-launcher entry runs. \`sova app --print-browser\` names the browser.
#   sova open    the same as sova app
set -euo pipefail
dir=$(printf '%q' "$dir")
self=$(printf '%q' "$launcher")
install_port=$port
tool_path=$(printf '%q' "$service_path")
agent=\${PI_CODING_AGENT_DIR:-$(printf '%q' "$agent")}
LAUNCHER
cat <<'LAUNCHER'
case "$agent" in "~") agent=$HOME ;; "~/"*) agent=$HOME/${agent#"~/"} ;; esac
port=${PORT:-$install_port}
os=$(uname)
token() {
	local f="$agent/sova/auth-token"
	[ -r "$f" ] || { echo "sova: no token at $f yet; start sova once and it mints one" >&2; exit 1; }
	cat "$f"
}
healthy() {            # the server answers its health check on the port
	if command -v curl >/dev/null 2>&1; then
		curl -fsS -m 2 -o /dev/null "http://127.0.0.1:$port/api/health" 2>/dev/null
	else
		( exec 3<>"/dev/tcp/127.0.0.1/$port" &&
			printf 'GET /api/health HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n' >&3 &&
			head -n 1 <&3 | grep -q ' 200' ) 2>/dev/null
	fi
}
notify() {             # on stderr, and as a desktop notification where there is one
	echo "sova: $1" >&2
	if [ "$os" = Darwin ]; then
		command -v osascript >/dev/null 2>&1 &&
			osascript -e 'on run argv' -e 'display notification (item 1 of argv) with title "Sova"' -e 'end run' "$1" >/dev/null 2>&1 || true
	else
		command -v notify-send >/dev/null 2>&1 && notify-send -a Sova Sova "$1" >/dev/null 2>&1 || true
	fi
}
start_server() {       # through the installer's login service when there is one, else in the background
	local unit="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/sova.service"
	local plist="$HOME/Library/LaunchAgents/io.github.naomarik.sova.plist" domain
	pid=
	if [ "$port" = "$install_port" ]; then
		if [ "$os" = Darwin ] && grep -qF 'sova-service v1' "$plist" 2>/dev/null; then
			log=~/Library/Logs/sova.log
			domain=gui/$(id -u)
			launchctl kickstart "$domain/io.github.naomarik.sova" >/dev/null 2>&1 && return 0
			launchctl bootstrap "$domain" "$plist" >/dev/null 2>&1 && return 0
		elif [ "$os" = Linux ] && grep -qF 'sova-service v1' "$unit" 2>/dev/null; then
			log="journalctl --user -u sova.service"
			systemctl --user start sova.service >/dev/null 2>&1 && return 0
		fi
	fi
	mkdir -p "$agent/sova"
	log=$agent/sova/app-server.log
	echo "sova: starting the server on port $port (output: $log)" >&2
	PATH=$PATH:$tool_path nohup "$self" >"$log" 2>&1 </dev/null &
	pid=$!
}
wait_up() {            # up to SOVA_APP_WAIT (20) seconds; a background server that exits stops it
	local i=0 limit=$(( ${SOVA_APP_WAIT:-20} * 2 ))
	while [ "$i" -lt "$limit" ]; do
		healthy && return 0
		if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
			notify "the Sova server exited before it answered on port $port; see $log"
			exit 1
		fi
		sleep 0.5
		i=$((i + 1))
	done
	healthy && return 0
	notify "Sova did not answer on port $port within ${SOVA_APP_WAIT:-20} s; see $log"
	exit 1
}
pick_browser() {       # a Chromium-family browser's executable, or nothing
	local id= d exe name want= app
	if [ "$os" = Darwin ]; then
		# The default https handler, when it is one of them.
		if command -v defaults >/dev/null 2>&1; then
			id=$(defaults read ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure LSHandlers 2>/dev/null |
				awk '/\{/ { d++ }
					/LSHandlerRoleAll = / && d == 1 { v = $3; gsub(/[";]/, "", v); role = v }
					/LSHandlerURLScheme = https;/ && d == 1 { https = 1 }
					/\}/ { if (d == 1) { if (https && role != "") { print role; exit } role = ""; https = 0 } d-- }' |
				tr 'A-Z' 'a-z' || true)
		fi
		case "$id" in
			com.google.chrome) want="Google Chrome" ;;
			org.chromium.chromium) want=Chromium ;;
			com.brave.browser) want="Brave Browser" ;;
			com.microsoft.edgemac) want="Microsoft Edge" ;;
			com.vivaldi.vivaldi) want=Vivaldi ;;
			net.imput.helium) want=Helium ;;
		esac
		for name in ${want:+"$want"} "Google Chrome" Chromium "Brave Browser" "Microsoft Edge" Vivaldi Helium; do
			for d in /Applications "$HOME/Applications"; do
				app="$d/$name.app"
				[ -d "$app" ] || continue
				exe=$(defaults read "$app/Contents/Info" CFBundleExecutable 2>/dev/null || true)
				[ -n "$exe" ] || exe=$name
				[ -x "$app/Contents/MacOS/$exe" ] && { printf '%s\n' "$app/Contents/MacOS/$exe"; return 0; }
			done
		done
		return 1
	fi
	# The default browser, when it is one of them, run as its .desktop file says.
	id=$(xdg-settings get default-web-browser 2>/dev/null || true)
	case "$id" in
		google-chrome* | chromium* | brave* | microsoft-edge* | vivaldi* | helium*)
			for d in "${XDG_DATA_HOME:-$HOME/.local/share}/applications" "$HOME/.nix-profile/share/applications" \
				/usr/local/share/applications /usr/share/applications; do
				[ -f "$d/$id" ] || continue
				exe=$(sed -n 's/^Exec=\([^ ]*\).*/\1/p' "$d/$id" | head -n 1)
				exe=$(command -v "$exe" 2>/dev/null || true)
				[ -z "$exe" ] || { printf '%s\n' "$exe"; return 0; }
				break
			done ;;
	esac
	for name in google-chrome-stable google-chrome chromium chromium-browser brave brave-browser microsoft-edge vivaldi; do
		exe=$(command -v "$name" 2>/dev/null || true)
		[ -z "$exe" ] || { printf '%s\n' "$exe"; return 0; }
	done
	return 1
}
open_app() {
	local tok url browser profile
	if ! healthy; then
		start_server
		wait_up
	fi
	tok=$(token)
	url="http://127.0.0.1:$port/#t=$tok"
	if browser=$(pick_browser); then
		if [ "$os" = Darwin ]; then
			profile="$HOME/Library/Application Support/sova-browser"
			mkdir -p "$profile"
		else
			profile="${XDG_CONFIG_HOME:-$HOME/.config}/sova-browser"
			mkdir -p "$profile"
			# A new profile: the system title bar (bare under a tiling compositor), no first-run page.
			if [ ! -e "$profile/Default/Preferences" ]; then
				mkdir -p "$profile/Default"
				printf '{"browser":{"custom_chrome_frame":false}}\n' > "$profile/Default/Preferences"
				: > "$profile/First Run"
			fi
		fi
		chmod 700 "$profile"
		nohup "$browser" --app="$url" --user-data-dir="$profile" --no-first-run --no-default-browser-check \
			>/dev/null 2>&1 </dev/null &
		exit 0
	fi
	if command -v open >/dev/null 2>&1 && [ "$os" = Darwin ]; then exec open "$url"; fi
	if command -v xdg-open >/dev/null 2>&1; then exec xdg-open "$url" >/dev/null 2>&1; fi
	echo "sova: no browser opener (open, xdg-open); paste the token from 'sova token' into the page" >&2
	exit 1
}
case "${1:-}" in
	token) token; exit 0 ;;
	app | open)
		if [ "${2:-}" = --print-browser ]; then pick_browser; exit 0; fi
		open_app ;;
esac
export SOVA_BUN=${SOVA_BUN:-$dir/.bun/bin/bun}
export PORT=$port
# The server finds the install it runs from through its launcher (Settings → General's updates).
export SOVA_LAUNCHER=$self
exec "$dir/scripts/start-server.sh" "$@"
LAUNCHER
} | write_file "$launcher" 755

# ---- the app-launcher entry: runs `sova app` ----

# copy_file <src> <dst>: <dst> becomes a copy of <src>, only when it differs. Sets `wrote`.
copy_file() {
	if [ -f "$2" ] && [ ! -L "$2" ] && cmp -s "$1" "$2"; then wrote=false; return 0; fi
	mkdir -p "$(dirname "$2")"
	cp "$1" "$2.new.$$"
	chmod 644 "$2.new.$$"
	mv "$2.new.$$" "$2"
	wrote=true
}
icon_src=$dir/public/icons/pwa-512.png
entry_note=
case "$entry_kind" in
	desktop)
		# Exec quoting, then the .desktop string escape: \ " ` $ escaped, % doubled, quoted.
		dq() {
			local s=$1
			s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//\`/\\\`}; s=${s//\$/\\\$}; s=${s//%/%%}; s=${s//\\/\\\\}
			printf '"%s"' "$s"
		}
		write_file "$entry_file" 644 <<DESKTOP
# Written by Sova's install.sh; re-running it keeps this file current.
[Desktop Entry]
Type=Application
Name=Sova
Comment=The web app for the pi coding agent, in a window of its own
Exec=$(dq "$launcher") app
Icon=sova
Terminal=false
StartupNotify=true
Categories=Development;
$entry_marker
DESKTOP
		entry_changed=$wrote
		if [ -f "$icon_src" ]; then
			copy_file "$icon_src" "$entry_icon"
			$wrote && entry_changed=true
		fi
		if $entry_changed; then
			command -v update-desktop-database >/dev/null 2>&1 &&
				{ update-desktop-database -q "$xdg_data/applications" >/dev/null 2>&1 || true; }
			command -v gtk-update-icon-cache >/dev/null 2>&1 && [ -d "$xdg_data/icons/hicolor" ] &&
				{ gtk-update-icon-cache -q -t -f "$xdg_data/icons/hicolor" >/dev/null 2>&1 || true; }
		fi
		entry_note="$entry_file" ;;
	bundle)
		xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
		write_file "$entry_file/Contents/Info.plist" 644 <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- $entry_marker: written by Sova's install.sh; re-running it keeps this bundle current. -->
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Sova</string>
	<key>CFBundleDisplayName</key><string>Sova</string>
	<key>CFBundleIdentifier</key><string>io.github.naomarik.sova.app</string>
	<key>CFBundleExecutable</key><string>sova-app</string>
	<key>CFBundleIconFile</key><string>sova</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<!-- The window is the browser's: no Dock icon of its own while sova app starts it. -->
	<key>LSUIElement</key><true/>
	<!-- The executable is a script: without this macOS starts it, and the browser it execs, under Rosetta. -->
	<key>LSArchitecturePriority</key><array><string>arm64</string></array>
</dict>
</plist>
PLIST
		entry_changed=$wrote
		write_file "$entry_file/Contents/MacOS/sova-app" 755 <<APP
#!/bin/bash
# Written by Sova's install.sh: opens Sova in its own window (sova app).
exec $(printf '%q' "$launcher") app
APP
		$wrote && entry_changed=true
		# The icon, built from the install's PNG when that changed (kept as Resources/sova.png).
		res=$entry_file/Contents/Resources
		if [ -f "$icon_src" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1 &&
			! { [ -f "$res/sova.icns" ] && cmp -s "$icon_src" "$res/sova.png"; }; then
			iconset=$(mktemp -d "${TMPDIR:-/tmp}/sova-icon.XXXXXX")
			mkdir "$iconset/sova.iconset"
			icon_ok=true
			for size in 16 32 128 256 512; do
				sips -z "$size" "$size" "$icon_src" --out "$iconset/sova.iconset/icon_${size}x${size}.png" >/dev/null 2>&1 || icon_ok=false
				double=$((size * 2))
				sips -z "$double" "$double" "$icon_src" --out "$iconset/sova.iconset/icon_${size}x${size}@2x.png" >/dev/null 2>&1 || icon_ok=false
			done
			if $icon_ok && iconutil -c icns -o "$iconset/sova.icns" "$iconset/sova.iconset" >/dev/null 2>&1; then
				copy_file "$iconset/sova.icns" "$res/sova.icns"
				copy_file "$icon_src" "$res/sova.png"
				entry_changed=true
			else
				say "could not build Sova.app's icon (sips, iconutil); it has none"
			fi
			rm -rf "$iconset"
		fi
		lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
		if $entry_changed && [ -x "$lsregister" ]; then "$lsregister" -f "$entry_file" >/dev/null 2>&1 || true; fi
		entry_note="$entry_file" ;;
esac
# The browser `sova app` would use; none means a tab of the default browser.
app_browser=
case "$os" in Linux | Darwin) app_browser=$("$launcher" app --print-browser 2>/dev/null || true) ;; esac

# ---- pi extensions: one link per extension, into the installed clone ----

linked=0
skipped=
if $extensions; then
	ext_src=$dir/pi-config/extensions
	ext_dst=$agent/extensions
	mkdir -p "$ext_dst"
	for src in "$ext_src"/*; do
		[ -e "$src" ] || continue
		name=$(basename "$src")
		if [ ! -d "$src" ]; then
			case "$name" in *.ts) ;; *) continue ;; esac
		fi
		dst=$ext_dst/$name
		if [ -L "$dst" ]; then
			current=$(readlink "$dst")
			[ "$current" = "$src" ] && continue
			case "$current" in
				"$ext_src"/*) rm -f "$dst" ;;
				*) skipped="$skipped $name"; say "kept $dst (links to $current, not to this install); skipped the $name extension"; continue ;;
			esac
		elif [ -e "$dst" ]; then
			skipped="$skipped $name"
			say "kept $dst (not a link this script made); skipped the $name extension"
			continue
		fi
		ln -s "$src" "$dst"
		linked=$((linked + 1))
	done
	# Our links to extensions this version no longer has.
	for dst in "$ext_dst"/* "$ext_dst"/.[!.]*; do
		[ -L "$dst" ] || continue
		current=$(readlink "$dst")
		case "$current" in
			"$ext_src"/*) [ -e "$dst" ] || { rm -f "$dst"; say "removed $dst (gone from this version)"; } ;;
		esac
	done
fi

# ---- the login service ----

service_note=
if [ "$service" = yes ]; then
	port_busy() {
		node -e 'const s=require("net").connect(+process.argv[1],"127.0.0.1");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),2000)' "$port" 2>/dev/null
	}

	if [ "$service_kind" = launchd ]; then
		xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
		agent_env=
		if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then
			agent_env="		<key>PI_CODING_AGENT_DIR</key><string>$(xml "$agent")</string>"
		fi
		mkdir -p "$HOME/Library/Logs"
		write_file "$service_file" 644 <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- $service_marker: written by Sova's install.sh; re-running it keeps this file current. -->
<plist version="1.0">
<dict>
	<key>Label</key><string>$label</string>
	<key>ProgramArguments</key>
	<array><string>$(xml "$launcher")</string></array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PORT</key><string>$port</string>
		<key>PATH</key><string>$(xml "$service_path")</string>
		<key>LANG</key><string>en_US.UTF-8</string>
$agent_env
	</dict>
	<key>WorkingDirectory</key><string>$(xml "$HOME")</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>2</integer>
	<!-- A stop drains hosted runtimes and their workers; 60 s is launchd's cap for an agent. -->
	<key>ExitTimeOut</key><integer>60</integer>
	<key>ProcessType</key><string>Interactive</string>
	<key>StandardOutPath</key><string>$(xml "$HOME/Library/Logs/sova.log")</string>
	<key>StandardErrorPath</key><string>$(xml "$HOME/Library/Logs/sova.log")</string>
</dict>
</plist>
PLIST
		domain=gui/$(id -u)
		launchctl print "$domain" >/dev/null 2>&1 || domain=user/$(id -u)
		loaded() { launchctl print "$domain/$label" >/dev/null 2>&1; }
		bootstrap() {
			local i
			for i in 1 2 3 4 5; do
				launchctl bootstrap "$domain" "$service_file" 2>/dev/null && return 0
				sleep 1
			done
			launchctl bootstrap "$domain" "$service_file"
		}
		if loaded; then
			if $wrote; then
				launchctl bootout "$domain/$label" 2>/dev/null || true
				for i in 1 2 3 4 5 6 7 8 9 10; do loaded || break; sleep 1; done
				bootstrap
				service_note="updated and reloaded the launchd agent $label"
			elif $rebuild; then
				launchctl kickstart -k "$domain/$label"
				service_note="restarted the launchd agent $label on the new build"
			else
				service_note="the launchd agent $label is unchanged and running"
			fi
		elif port_busy; then
			service_note="installed the launchd agent $label but did not start it: something already listens on port $port (a sova started by hand?). Stop it, then: launchctl bootstrap $domain '$service_file'"
		else
			bootstrap
			service_note="started the launchd agent $label (logs: ~/Library/Logs/sova.log)"
		fi
	else
		sd() {       # systemd's quoting: backslash and double quote escaped, % and $ doubled
			local s=$1
			s=${s//\\/\\\\}; s=${s//\"/\\\"}; s=${s//%/%%}; s=${s//\$/\$\$}
			printf '"%s"' "$s"
		}
		agent_env=
		if [ -n "${PI_CODING_AGENT_DIR:-}" ]; then agent_env="Environment=$(sd "PI_CODING_AGENT_DIR=$agent")"; fi
		write_file "$service_file" 644 <<UNIT
# $service_marker: written by Sova's install.sh; re-running it keeps this file current.
[Unit]
Description=Sova, the web app for the pi coding agent

[Service]
Type=simple
ExecStart=$(sd "$launcher")
Environment=PORT=$port
Environment=$(sd "PATH=$service_path")
$agent_env
WorkingDirectory=%h
# As docs/running-as-a-service.md: a stop you ask for stays stopped, any other exit restarts it,
# and a stop drains hosted runtimes and their workers before it exits.
Restart=always
RestartSec=2
TimeoutStopSec=90

[Install]
WantedBy=default.target
UNIT
		if ! systemctl --user show-environment >/dev/null 2>&1; then
			service_note="wrote $service_file, but there is no systemd user manager to load it (no login session?); start it with: systemctl --user enable --now sova.service"
		else
			$wrote && systemctl --user daemon-reload
			systemctl --user is-enabled --quiet sova.service 2>/dev/null || systemctl --user enable --quiet sova.service
			if systemctl --user is-active --quiet sova.service; then
				if $wrote || $rebuild; then
					systemctl --user restart sova.service
					service_note="restarted sova.service"
				else
					service_note="sova.service is unchanged and running"
				fi
			elif port_busy; then
				service_note="installed sova.service but did not start it: something already listens on port $port (a sova started by hand?). Stop it, then: systemctl --user start sova.service"
			else
				systemctl --user start sova.service
				service_note="started sova.service (logs: journalctl --user -u sova.service; it stops at logout unless lingering is on: loginctl enable-linger)"
			fi
		fi
	fi
fi

say ""
if $rebuild; then
	say "installed $ref ($commit) in $dir"
else
	say "$dir is already at $ref ($commit); nothing to rebuild"
fi
say "launcher: $launcher"
if [ -n "$entry_note" ]; then
	say "app entry: $entry_note — 'Sova' in your app launcher opens it in its own window (sova app)"
fi
if [ -z "$app_browser" ] && { [ "$os" = Linux ] || [ "$os" = Darwin ]; }; then
	say "an app window needs Chrome, Chromium, Brave, Edge or Vivaldi; until one is installed, the app"
	say "entry and 'sova open' open Sova in a tab of your default browser"
fi
say "runtime: Bun $("$dir/.bun/bin/bun" --version 2>/dev/null || echo '?') in $dir/.bun (sova --node runs it on Node instead)"
if $extensions; then
	say "pi extensions: linked from $dir/pi-config/extensions into $agent/extensions${skipped:+ (skipped:$skipped)}"
	command -v claude >/dev/null 2>&1 ||
		say "Claude Code's models need the claude CLI on PATH, logged in: https://claude.com/claude-code"
fi
if [ -n "$service_note" ]; then
	say "service: $service_note"
else
	case ":$PATH:" in
		*:"$bindir":*) say "run: sova" ;;
		*) say "$bindir is not on your PATH; run: $launcher" ;;
	esac
	[ "$service_kind" = none ] || say "to run it as a login service instead, run this again with --service"
fi
say ""
say "It serves http://127.0.0.1:$port — loopback only, and it asks every browser for this install's"
say "token once: 'sova open' (what the app entry runs) opens the app already unlocked, starting the"
say "server first when it is not running, and 'sova token' prints the token to paste on another"
say "device. Set PORT to move the port. The token is all that stands between the"
say "network and an app that can read your files and run commands as you, so think twice before"
say "setting HOST=0.0.0.0."
say ""
say "It reads the agent directory the pi TUI does: $agent"
say "Sessions already on the machine are listed and readable straight away. To chat from the page"
say "with a pi provider you need its credentials in auth.json there — run 'pi' and '/login' once"
say "if you have not. A session open in a TUI is shown live and read-only."
}

main "$@"
