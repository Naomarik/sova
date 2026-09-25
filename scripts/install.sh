#!/usr/bin/env bash
# Install Sova (https://github.com/Naomarik/sova) into a directory of its own, put a `sova`
# launcher on PATH, link Sova's pi extensions into pi's agent directory and, if you want one,
# install a login service. Safe to pipe from curl:
#
#   curl -fsSL https://raw.githubusercontent.com/Naomarik/sova/v0.1.0/scripts/install.sh | bash
#
# What it needs on the machine already: git, node (>= 22.19) and pnpm. Without pnpm it runs the
# version the repository pins through npx (npm ships with Node). It installs no toolchain, no
# version manager and no system package, and it never uses sudo. It runs on macOS's bash 3.2 and
# BSD tools as well as on Linux.
#
# What it touches, and nothing else:
#   <install dir>          default ~/.local/share/sova — a clone, its node_modules and its dist/
#   <bin dir>/sova         default ~/.local/bin/sova — a launcher this script wrote
#   <agent dir>/extensions/<name>
#                          one symlink per extension in <install dir>/pi-config/extensions, where
#                          <agent dir> is $PI_CODING_AGENT_DIR, else ~/.pi/agent (--no-extensions
#                          skips them). Anything already at one of those paths that is not our
#                          own link is left alone and that extension is skipped.
#   <agent dir>/sova/settings.json
#                          written only when it does not exist, with the Claude Code provider
#                          switched on, so Claude Code's models are offered from the first start
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
# service's port (default 4800) · --no-extensions link no pi extensions · --reinstall rebuild
# even when the install is already at the requested commit.
# Env for testing: SOVA_REPO (clone source), SOVA_REF (tag, branch or commit).
set -euo pipefail

repo=${SOVA_REPO:-https://github.com/Naomarik/sova.git}
ref=${SOVA_REF:-v0.1.0}
dir=${SOVA_DIR:-$HOME/.local/share/sova}
bindir=${SOVA_BIN:-$HOME/.local/bin}
tty=${SOVA_TTY:-/dev/tty}
port=4800
service=ask            # ask | yes | no
extensions=true
reinstall=false
node_min_major=22
node_min_minor=19
marker="# sova-launcher v1"
service_marker="sova-service v1"
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
		--reinstall) reinstall=true; shift ;;
		-h|--help)
			say "usage: install.sh [--dir <install dir>] [--bin <launcher dir>] [--service | --no-service]"
			say "                  [--port <n>] [--no-extensions] [--reinstall]"
			say "installs Sova into ${dir} and a launcher into ${bindir}/sova"
			exit 0 ;;
		*) die "unknown argument: $1 (try --help)" ;;
	esac
done
case "$port" in '' | *[!0-9]*) die "--port needs a number, got '$port'" ;; esac

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

# The login service: launchd on macOS, a systemd user unit on Linux.
service_kind=none
case "$(uname -s)" in
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

# The commit the ref names, when the source can say so without a clone. An install already at it,
# with its dependencies and build in place, is not rebuilt.
rebuild=true
if $update && ! $reinstall; then
	want=
	while read -r sha name; do
		case "$name" in *'^{}') want=$sha; break ;; esac
		[ -n "$want" ] || want=$sha
	done <<EOF
$(git ls-remote "$repo" "refs/tags/$ref^{}" "refs/tags/$ref" "refs/heads/$ref" 2>/dev/null || true)
EOF
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
	if $same && [ -f "$dir/dist/index.html" ] && [ -x "$dir/node_modules/.bin/tsx" ]; then
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
cleanup() {
	[ -z "$staging" ] || rm -rf "$staging"
	# A failure after the old install moved aside: put it back before leaving.
	if [ -n "$backup" ] && [ -d "$backup" ] && [ ! -e "$dir" ]; then
		mv "$backup" "$dir"
		say "restored the previous install at $dir"
	fi
}
trap cleanup EXIT

if $rebuild; then
	parent=$(dirname "$dir")
	mkdir -p "$parent" "$bindir"
	staging=$(mktemp -d "$parent/.sova-staging.XXXXXX")   # beside the target, so promoting is a rename

	say "cloning $repo at $ref"
	git clone --quiet --depth 1 --branch "$ref" "$repo" "$staging/sova" 2>/dev/null ||
		git clone --quiet "$repo" "$staging/sova" ||
		die "could not clone $repo"
	git -C "$staging/sova" checkout --quiet "$ref" 2>/dev/null || true

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

write_file "$launcher" 755 <<LAUNCHER
#!/usr/bin/env bash
$marker
# Runs the built Sova server from its install directory. PORT and HOST are read by the server.
set -euo pipefail
dir=$(printf '%q' "$dir")
exec "\$dir/node_modules/.bin/tsx" "\$dir/server/index.ts" "\$@"
LAUNCHER

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

	# The Claude Code provider switch, on unless the user already has a setting of their own.
	switch=$agent/sova/settings.json
	if [ ! -e "$switch" ] && [ ! -L "$switch" ]; then
		write_file "$switch" 644 <<'JSON'
{
	"version": 1,
	"experimental": {
		"claudeCodeProvider": true
	}
}
JSON
		say "switched on the Claude Code provider in $switch"
	fi
fi

# ---- the login service ----

service_note=
if [ "$service" = yes ]; then
	# launchd and systemd start services without the login shell's PATH: give it the directories
	# the tools were found in, then the usual ones.
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
$agent_env
	</dict>
	<key>WorkingDirectory</key><string>$(xml "$HOME")</string>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
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
Restart=on-failure
RestartSec=3

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
say "It serves http://127.0.0.1:$port — loopback only, and it has no authentication of its own."
say "Set PORT to move the port. Setting HOST=0.0.0.0 puts an unauthenticated app that can read"
say "your files and run commands as you on the network; only do that behind something that"
say "authenticates."
say ""
say "It reads the agent directory the pi TUI does: $agent"
say "Sessions already on the machine are listed and readable straight away. To chat from the page"
say "with a pi provider you need its credentials in auth.json there — run 'pi' and '/login' once"
say "if you have not. A session open in a TUI is shown live and read-only."
