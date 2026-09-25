#!/usr/bin/env bash
# Tests for scripts/install.sh. Every case runs in its own temporary HOME with a sandboxed PATH:
# git is the real one (the installer clones a local seed repository); node, pnpm, npx, uname,
# systemctl and launchctl are stubs, so nothing is downloaded, no real service manager is asked
# anything, and nothing outside the temporary directory is touched. No case can see a terminal
# unless it hands the installer one (SOVA_TTY).
#
# Run: scripts/install.test.sh   (TMPDIR picks where the temporary directory goes;
#      TEST_BASH=/bin/bash runs the installer under another bash, e.g. macOS's 3.2)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$here/.." && pwd -P)
installer=$root/scripts/install.sh

tmp=$(mktemp -d "${TMPDIR:-/tmp}/sova-install-test.XXXXXX")
test_bash=${TEST_BASH:-bash}
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
no() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }
check() { if [ "$1" = true ]; then ok "$2"; else no "$2"; fi; }

# ---- the sandbox PATH: real coreutils and git, stubbed node, pnpm and npx ----

sandbox=$tmp/sandbox
nogit=$tmp/sandbox-nogit
nopnpm=$tmp/sandbox-nopnpm       # npx but no pnpm: the installer runs pnpm through npx
nopm=$tmp/sandbox-nopm           # neither pnpm nor npx
stubs=$tmp/stubs                 # not on any PATH; the pnpm stub lives here so npx can reach it
mkdir -p "$sandbox" "$nogit" "$nopnpm" "$nopm" "$stubs"
for c in basename bash cat chmod cmp cp dirname env grep head id ln mkdir mktemp mv printf readlink rm sed sleep sort touch wc; do
	for d in "$sandbox" "$nogit" "$nopnpm" "$nopm"; do ln -sf "$(command -v "$c")" "$d/$c"; done
done
for d in "$sandbox" "$nopnpm" "$nopm"; do ln -sf "$(command -v git)" "$d/git"; done  # $nogit has no git

# node -e is the installer's port probe: busy when NODE_FAKE_PORT_BUSY=1.
cat > "$sandbox/node" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-v" ] && { printf 'v%s\n' "${NODE_FAKE_VERSION:-25.2.1}"; exit 0; }
[ "${1:-}" = "-e" ] && { [ "${NODE_FAKE_PORT_BUSY:-}" = 1 ]; exit; }
printf 'node stub: %s\n' "$*"
STUB
# uname -s answers FAKE_UNAME (default Linux), which picks the service manager.
cat > "$sandbox/uname" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_UNAME:-Linux}"
STUB
# The service managers log every call to $SVC_LOG and keep the service's state in $SVC_STATE.
cat > "$sandbox/systemctl" <<'STUB'
#!/usr/bin/env bash
printf 'systemctl %s\n' "$*" >> "$SVC_LOG"
[ "${1:-}" = --user ] || exit 1
shift
while [ "${1:-}" = --quiet ]; do shift; done
case "${1:-}" in
	show-environment) [ "${FAKE_NO_USER_MANAGER:-}" != 1 ] ;;
	daemon-reload) ;;
	is-enabled) [ -e "$SVC_STATE.enabled" ] ;;
	enable) touch "$SVC_STATE.enabled" ;;
	is-active) [ -e "$SVC_STATE.active" ] ;;
	start|restart) touch "$SVC_STATE.active" ;;
	*) exit 1 ;;
esac
STUB
cat > "$sandbox/launchctl" <<'STUB'
#!/usr/bin/env bash
printf 'launchctl %s\n' "$*" >> "$SVC_LOG"
case "${1:-}" in
	print) case "${2:-}" in */*/*) [ -e "$SVC_STATE.loaded" ] ;; *) exit 0 ;; esac ;;
	bootstrap) touch "$SVC_STATE.loaded" ;;
	bootout) rm -f "$SVC_STATE.loaded" ;;
	kickstart) ;;
	*) exit 1 ;;
esac
STUB

# `pnpm install` makes a node_modules with a tsx the launcher can exec; `pnpm run build` makes a
# dist. Both refuse the flags the installer must not drop.
cat > "$stubs/pnpm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
	install)
		case " $* " in *" --frozen-lockfile "*) ;; *) printf 'pnpm stub: no --frozen-lockfile\n' >&2; exit 1 ;; esac
		case " $* " in *" --prod=false "*) ;; *) printf 'pnpm stub: no --prod=false\n' >&2; exit 1 ;; esac
		[ -z "${PNPM_LOG:-}" ] || printf 'install\n' >> "$PNPM_LOG"
		mkdir -p node_modules/.bin
		printf '#!/usr/bin/env bash\nprintf "tsx stub ran: %%s\\n" "$*"\n' > node_modules/.bin/tsx
		chmod 755 node_modules/.bin/tsx
		printf 'pnpm stub: installed (%s)\n' "$*"
		;;
	run)
		[ "${PNPM_FAIL_BUILD:-}" = 1 ] && { printf 'pnpm stub: build failed on purpose\n' >&2; exit 1; }
		mkdir -p dist && printf '<!doctype html>\n' > dist/index.html
		printf 'pnpm stub: built\n'
		;;
	*) printf 'pnpm stub: %s\n' "$*" ;;
esac
STUB
# `npx --yes pnpm@<version> …` records the version it was asked for, then runs the pnpm stub.
cat > "$stubs/npx" <<STUB
#!/usr/bin/env bash
set -euo pipefail
[ "\${1:-}" = --yes ] || { printf 'npx stub: no --yes\n' >&2; exit 1; }
shift
case "\${1:-}" in
	pnpm@*) printf '%s\n' "\$1" >> "$tmp/npx.log"; shift; exec "$stubs/pnpm" "\$@" ;;
	*) printf 'npx stub: %s\n' "\$*" >&2; exit 1 ;;
esac
STUB
chmod 755 "$sandbox/node" "$sandbox/uname" "$sandbox/systemctl" "$sandbox/launchctl" "$stubs/pnpm" "$stubs/npx"
for d in "$nogit" "$nopnpm" "$nopm"; do cp "$sandbox/node" "$sandbox/uname" "$d/"; done
ln -sf "$stubs/pnpm" "$sandbox/pnpm"
ln -sf "$stubs/pnpm" "$nogit/pnpm"
ln -sf "$stubs/npx" "$nopnpm/npx"

# ---- the seed repository, cloned by every case (its name has to read as Sova) ----

seed=$tmp/sova-src
mkdir -p "$seed/server" "$seed/scripts"
cp "$installer" "$seed/scripts/install.sh"
cat > "$seed/package.json" <<'JSON'
{
  "name": "sova",
  "version": "0.1.0",
  "packageManager": "pnpm@12.6.0",
  "engines": { "node": ">=22.19" },
  "scripts": { "build": "true", "start": "tsx server/index.ts" }
}
JSON
printf 'export const server = null;\n' > "$seed/server/index.ts"
# pi-config: two extensions (a directory and a single file), a non-extension file, and the
# personal config the installer must not install.
mkdir -p "$seed/pi-config/extensions/alpha" "$seed/pi-config/extensions/gamma"
printf 'export default function () {}\n' > "$seed/pi-config/extensions/alpha/index.ts"
printf 'export default function () {}\n' > "$seed/pi-config/extensions/gamma/index.ts"
printf 'export default function () {}\n' > "$seed/pi-config/extensions/beta.ts"
printf 'notes, not an extension\n' > "$seed/pi-config/extensions/NOTES.md"
for f in settings.json models.json keybindings.json vision-delegate.json; do
	printf '{"personal":true}\n' > "$seed/pi-config/$f"
done
printf 'node_modules/\ndist/\n' > "$seed/.gitignore"
git -C "$seed" init --quiet -b master
git -C "$seed" -c user.email=t@t -c user.name=t add -A
git -C "$seed" -c user.email=t@t -c user.name=t commit --quiet -m seed
git -C "$seed" tag v0.1.0

# ---- one case = one fresh HOME, whose path has a space in it ----

home=
# Every case runs as `inst`: the sandbox PATH, a fresh or kept HOME, no terminal, and the service
# managers' logs and state beside that HOME. Nothing the caller's environment names reaches it:
# PI_CODING_AGENT_DIR, XDG_CONFIG_HOME and MISE_DATA_DIR would point it at real directories.
unset PI_CODING_AGENT_DIR PI_AGENT_DIR XDG_CONFIG_HOME MISE_DATA_DIR
inst() {                 # inst [args...] in the current $home; sets `status` and `out`
	local case_dir
	case_dir=$(dirname "$home")
	set +e
	out=$(env -u PI_CODING_AGENT_DIR ${CASE_AGENT_DIR:+PI_CODING_AGENT_DIR="$CASE_AGENT_DIR"} \
		HOME="$home" PATH="${CASE_PATH:-$sandbox}" SOVA_REPO="file://$seed" SOVA_REF="${CASE_REF:-v0.1.0}" \
		SOVA_TTY="${CASE_TTY:-$tmp/.no-tty}" SVC_LOG="$case_dir/svc.log" SVC_STATE="$case_dir/svc" \
		PNPM_LOG="$case_dir/pnpm.log" "$test_bash" "$installer" "$@" 2>&1)
	status=$?
	set -e
}

run_install() {          # run_install <case name> [args...]: a fresh home, then inst
	local name=$1; shift
	fresh_home "$name"
	inst "$@"
}

fresh_home() {           # a home with a ~/.pi to guard, and no install in it
	home="$tmp/$1/fake home"
	mkdir -p "$home/.pi/agent"
	printf '{"marker":"do not touch"}\n' > "$home/.pi/agent/settings.json"
	pi_before=$(pi_files)
}

# Every regular file under ~/.pi except the one the installer may create (the provider switch).
# Links are not followed, so the extension links are not in it.
pi_files() {
	(cd "$home/.pi" && find . -type f ! -path ./agent/sova/settings.json -exec cat {} + | sort)
}

pi_untouched() {
	[ "$(pi_files)" = "$pi_before" ]
}

yes_if() { if "$@"; then echo true; else echo false; fi; }
said() { printf '%s' "$out" | grep -qF "$1"; }

printf 'install.sh\n'

# 1. A missing prerequisite exits nonzero and changes nothing.
CASE_PATH=$nogit run_install missing-git
unset CASE_PATH
check "$([ "$status" -ne 0 ] && echo true || echo false)" "missing git: exits nonzero"
check "$(printf '%s' "$out" | grep -q 'git is not installed' && echo true || echo false)" "missing git: says which command"
check "$([ ! -e "$home/.local/share/sova" ] && [ ! -e "$home/.local/bin/sova" ] && echo true || echo false)" \
	"missing git: no install dir, no launcher"
check "$(pi_untouched && echo true || echo false)" "missing git: ~/.pi untouched"

# 2. Node below the floor exits nonzero and changes nothing.
NODE_FAKE_VERSION=22.18.0 run_install old-node
unset NODE_FAKE_VERSION
check "$([ "$status" -ne 0 ] && echo true || echo false)" "old node: exits nonzero"
check "$(printf '%s' "$out" | grep -q 'too old' && echo true || echo false)" "old node: says the version is too old"
check "$([ ! -e "$home/.local/share/sova" ] && [ ! -e "$home/.local/bin/sova" ] && echo true || echo false)" \
	"old node: no install dir, no launcher"

# 3. A clean install, into a home whose path contains a space.
run_install success
check "$([ "$status" -eq 0 ] && echo true || echo false)" "success: exits 0"
check "$([ -f "$home/.local/share/sova/package.json" ] && echo true || echo false)" "success: the clone is in place"
check "$([ -f "$home/.local/share/sova/dist/index.html" ] && echo true || echo false)" "success: the build is in place"
check "$([ -x "$home/.local/bin/sova" ] && echo true || echo false)" "success: the launcher is executable"
check "$(printf '%s' "$out" | grep -q '127.0.0.1:4800' && echo true || echo false)" "success: prints the URL"
check "$(printf '%s' "$out" | grep -q 'no authentication' && echo true || echo false)" "success: says there is no auth"
check "$(pi_untouched && echo true || echo false)" "success: ~/.pi untouched"
check "$([ ! -e "$home/.local/share/sova/.pi" ] && echo true || echo false)" "success: wrote no .pi into the install dir"
check "$([ -z "$(ls -d "$home/.local/share/.sova-staging."* 2>/dev/null)" ] && echo true || echo false)" \
	"success: cleaned up its staging dir"
launch=$(PATH="$sandbox" "$home/.local/bin/sova" --check 2>&1 || true)
check "$(printf '%s' "$launch" | grep -q 'tsx stub ran' && echo true || echo false)" \
	"success: the launcher runs the server from the install dir, with a spaced path"

# 4. A failed build leaves the previous install and the launcher exactly as they were.
good_home=$home
printf 'a file the user left here\n' > "$good_home/.local/share/sova/NOTES.txt"
before_launcher=$(cat "$good_home/.local/bin/sova")
set +e
out=$(HOME="$good_home" PATH="$sandbox" SOVA_REPO="file://$seed" SOVA_REF=v0.1.0 PNPM_FAIL_BUILD=1 \
	SOVA_TTY="$tmp/.no-tty" "$test_bash" "$installer" --reinstall 2>&1)
status=$?
set -e
check "$([ "$status" -ne 0 ] && echo true || echo false)" "failed build: exits nonzero"
check "$([ -f "$good_home/.local/share/sova/NOTES.txt" ] && echo true || echo false)" \
	"failed build: the previous install is untouched"
check "$([ "$before_launcher" = "$(cat "$good_home/.local/bin/sova")" ] && echo true || echo false)" \
	"failed build: the launcher is untouched"
check "$([ -z "$(ls -d "$good_home/.local/share/sova.sova-previous."* 2>/dev/null)" ] && echo true || echo false)" \
	"failed build: left no backup directory behind"

# 5. Re-running on our own clean clone with --reinstall rebuilds it and keeps working.
home=$good_home
inst --reinstall
check "$([ "$status" -eq 0 ] && echo true || echo false)" "rerun: exits 0"
check "$([ -f "$home/.local/share/sova/dist/index.html" ] && echo true || echo false)" "rerun: the build is in place"
check "$([ -x "$home/.local/bin/sova" ] && echo true || echo false)" "rerun: the launcher is in place"
check "$([ -z "$(ls -d "$home/.local/share/sova.sova-previous."* 2>/dev/null)" ] && echo true || echo false)" \
	"rerun: removed the previous install after promoting"

# 6. An install directory that is not our clone is refused, with its contents left alone.
fresh_home foreign-dir
mkdir -p "$home/.local/share/sova"
printf 'someone else lives here\n' > "$home/.local/share/sova/IMPORTANT.txt"
inst
check "$([ "$status" -ne 0 ] && echo true || echo false)" "foreign dir: exits nonzero"
check "$(printf '%s' "$out" | grep -q 'not a git clone' && echo true || echo false)" "foreign dir: says why"
check "$([ "$(cat "$home/.local/share/sova/IMPORTANT.txt")" = 'someone else lives here' ] && echo true || echo false)" \
	"foreign dir: the file is untouched"

# 7. A clone with uncommitted changes is refused.
run_install dirty-clone
git -C "$home/.local/share/sova" -c user.email=t@t -c user.name=t commit --quiet --allow-empty -m x
printf 'export const server = 1;\n' > "$home/.local/share/sova/server/index.ts"
inst
check "$([ "$status" -ne 0 ] && echo true || echo false)" "dirty clone: exits nonzero"
check "$(printf '%s' "$out" | grep -q 'uncommitted changes' && echo true || echo false)" "dirty clone: says why"
check "$([ "$(cat "$home/.local/share/sova/server/index.ts")" = 'export const server = 1;' ] && echo true || echo false)" \
	"dirty clone: the edit survives"

# 8. A launcher we did not write is refused, and survives.
fresh_home foreign-launcher
mkdir -p "$home/.local/bin"
printf '#!/bin/sh\necho someone elses sova\n' > "$home/.local/bin/sova"
chmod 755 "$home/.local/bin/sova"
inst
check "$([ "$status" -ne 0 ] && echo true || echo false)" "foreign launcher: exits nonzero"
check "$(printf '%s' "$out" | grep -q 'not written by this script' && echo true || echo false)" \
	"foreign launcher: says why"
check "$(grep -q 'someone elses sova' "$home/.local/bin/sova" && echo true || echo false)" \
	"foreign launcher: survives"
check "$([ ! -e "$home/.local/share/sova" ] && echo true || echo false)" "foreign launcher: installed nothing"

# 9. --dir and --bin are honored, including paths with spaces.
run_install custom-dirs --dir "$tmp/custom-dirs/my apps/sova" --bin "$tmp/custom-dirs/my bin"
check "$([ "$status" -eq 0 ] && echo true || echo false)" "--dir/--bin: exits 0"
check "$([ -f "$tmp/custom-dirs/my apps/sova/package.json" ] && echo true || echo false)" "--dir: installs there"
check "$([ -x "$tmp/custom-dirs/my bin/sova" ] && echo true || echo false)" "--bin: launcher there"
check "$([ ! -e "$home/.local/share/sova" ] && echo true || echo false)" "--dir: nothing in the default location"

# 10. Without pnpm, npx runs the pnpm version the clone pins.
rm -f "$tmp/npx.log"
CASE_PATH=$nopnpm run_install npx-fallback
unset CASE_PATH
check "$([ "$status" -eq 0 ] && echo true || echo false)" "npx fallback: exits 0"
check "$([ "$(cat "$tmp/npx.log" 2>/dev/null | sort -u)" = 'pnpm@12.6.0' ] && echo true || echo false)" \
	"npx fallback: every pnpm call ran the pinned pnpm@12.6.0 through npx"
check "$([ "$(wc -l < "$tmp/npx.log" 2>/dev/null)" -eq 2 ] && echo true || echo false)" \
	"npx fallback: both install and build went through npx"
check "$(printf '%s' "$out" | grep -q 'running pnpm@12.6.0 through npx' && echo true || echo false)" \
	"npx fallback: says so"
check "$([ -f "$home/.local/share/sova/dist/index.html" ] && [ -x "$home/.local/bin/sova" ] && echo true || echo false)" \
	"npx fallback: the build and the launcher are in place"

# 11. Neither pnpm nor npx exits nonzero and changes nothing.
CASE_PATH=$nopm run_install missing-pnpm
unset CASE_PATH
check "$([ "$status" -ne 0 ] && echo true || echo false)" "missing pnpm: exits nonzero"
check "$(printf '%s' "$out" | grep -q 'pnpm is not installed' && echo true || echo false)" "missing pnpm: says which command"
check "$([ ! -e "$home/.local/share/sova" ] && [ ! -e "$home/.local/bin/sova" ] && echo true || echo false)" \
	"missing pnpm: no install dir, no launcher"
check "$(pi_untouched && echo true || echo false)" "missing pnpm: ~/.pi untouched"

# 12. Extensions are linked by default: each extension directory and single-file extension, as a
#     link into the installed clone; nothing else from pi-config, and pi's own settings untouched.
run_install extensions
ext=$home/.pi/agent/extensions
src=$home/.local/share/sova/pi-config/extensions
check "$([ "$status" -eq 0 ] && echo true || echo false)" "extensions: exits 0"
check "$(yes_if [ "$(readlink "$ext/alpha")" = "$src/alpha" ])" "extensions: a directory extension links into the clone"
check "$(yes_if [ "$(readlink "$ext/beta.ts")" = "$src/beta.ts" ])" "extensions: a single-file extension links into the clone"
check "$(yes_if [ -f "$ext/gamma/index.ts" ])" "extensions: the links resolve"
check "$(yes_if [ ! -e "$ext/NOTES.md" ])" "extensions: a file that is not an extension is not linked"
check "$(yes_if pi_untouched)" "extensions: pi's settings.json untouched, no other file written"
for f in models.json keybindings.json vision-delegate.json; do
	check "$(yes_if [ ! -e "$home/.pi/agent/$f" ])" "extensions: no personal $f"
done
check "$(yes_if [ ! -e "$home/.local/bin/pi-sessions" ])" "extensions: no pi-sessions command"
check "$(yes_if grep -q '"claudeCodeProvider": true' "$home/.pi/agent/sova/settings.json")" \
	"extensions: the Claude Code provider switch is on"
check "$(yes_if grep -q '"version": 1' "$home/.pi/agent/sova/settings.json")" \
	"extensions: the switch file has the version Sova reads"
check "$(yes_if said 'claude CLI on PATH')" "extensions: says Claude Code's models need the claude CLI"

# 13. Anything already at an extension's path that is not our link is kept, and that extension
#     is skipped: a directory, and a link to somewhere else. An existing provider setting is kept.
fresh_home foreign-extensions
ext=$home/.pi/agent/extensions
mkdir -p "$ext/alpha" "$home/elsewhere" "$home/.pi/agent/sova"
printf 'mine\n' > "$ext/alpha/index.ts"
printf 'mine too\n' > "$home/elsewhere/beta.ts"
ln -s "$home/elsewhere/beta.ts" "$ext/beta.ts"
printf '{"version":1,"experimental":{"claudeCodeProvider":false}}\n' > "$home/.pi/agent/sova/settings.json"
inst
check "$([ "$status" -eq 0 ] && echo true || echo false)" "foreign extensions: exits 0"
check "$(yes_if [ ! -L "$ext/alpha" ] && [ "$(cat "$ext/alpha/index.ts")" = mine ])" \
	"foreign extensions: a directory in the way is kept"
check "$(yes_if [ "$(readlink "$ext/beta.ts")" = "$home/elsewhere/beta.ts" ])" \
	"foreign extensions: a link to elsewhere is kept"
check "$(yes_if said 'skipped the alpha extension')" "foreign extensions: names the skipped directory"
check "$(yes_if said 'skipped the beta.ts extension')" "foreign extensions: names the skipped link"
check "$(yes_if [ -L "$ext/gamma" ])" "foreign extensions: the others are still linked"
check "$(yes_if grep -q '"claudeCodeProvider":false' "$home/.pi/agent/sova/settings.json")" \
	"foreign extensions: an existing provider setting is kept"

# 14. --no-extensions links nothing and switches nothing.
run_install no-extensions --no-extensions
check "$([ "$status" -eq 0 ] && echo true || echo false)" "--no-extensions: exits 0"
check "$(yes_if [ ! -e "$home/.pi/agent/extensions" ] && [ ! -e "$home/.pi/agent/sova" ])" \
	"--no-extensions: nothing in the agent dir"

# 15. PI_CODING_AGENT_DIR is the agent dir, with a leading ~ expanded.
fresh_home agent-dir
CASE_AGENT_DIR='~/other agent' inst
check "$([ "$status" -eq 0 ] && echo true || echo false)" "agent dir: exits 0"
check "$(yes_if [ -L "$home/other agent/extensions/alpha" ])" "agent dir: extensions go to \$PI_CODING_AGENT_DIR"
check "$(yes_if [ ! -e "$home/.pi/agent/extensions" ])" "agent dir: nothing in ~/.pi/agent"

# 16. Re-running with the same inputs changes nothing: no rebuild, no file rewritten.
run_install idempotent --service
case_dir=$(dirname "$home")
: > "$case_dir/pnpm.log"
: > "$case_dir/svc.log"
touch "$case_dir/stamp"
sleep 1
inst
check "$([ "$status" -eq 0 ] && echo true || echo false)" "rerun, same inputs: exits 0"
check "$(yes_if said 'nothing to rebuild')" "rerun, same inputs: says there is nothing to rebuild"
check "$(yes_if [ ! -s "$case_dir/pnpm.log" ])" "rerun, same inputs: installed and built nothing"
check "$(yes_if [ -z "$(find "$home" -newer "$case_dir/stamp" -print)" ])" \
	"rerun, same inputs: no file or link under HOME changed"
check "$(yes_if [ -z "$(grep -E 'daemon-reload|restart|start|enable' "$case_dir/svc.log" | grep -v 'is-enabled\|is-active')" ])" \
	"rerun, same inputs: the service was not reloaded, restarted or started again"
check "$(yes_if said 'unchanged and running')" "rerun, same inputs: says the service is unchanged and running"

# 17. A new commit rebuilds, restarts the running service, and drops our link to an extension
#     that version no longer has.
git -C "$seed" -c user.email=t@t -c user.name=t rm --quiet -r pi-config/extensions/gamma
git -C "$seed" -c user.email=t@t -c user.name=t commit --quiet -m 'drop gamma'
git -C "$seed" branch --quiet next
git -C "$seed" reset --quiet --hard v0.1.0
: > "$case_dir/svc.log"
CASE_REF=next inst
check "$([ "$status" -eq 0 ] && echo true || echo false)" "new commit: exits 0"
check "$(yes_if [ -s "$case_dir/pnpm.log" ])" "new commit: rebuilt"
check "$(yes_if [ ! -e "$home/.pi/agent/extensions/gamma" ] && [ ! -L "$home/.pi/agent/extensions/gamma" ])" \
	"new commit: our link to the removed extension is gone"
check "$(yes_if [ -L "$home/.pi/agent/extensions/alpha" ])" "new commit: the other links stay"
check "$(yes_if grep -q 'restart sova.service' "$case_dir/svc.log")" "new commit: the running service restarted"

# 18. systemd: --service writes a unit with the port, a PATH that finds brew and ~/.local/bin, and
#     the launcher quoted for a spaced HOME, then enables and starts it.
run_install systemd --service --port 4899
case_dir=$(dirname "$home")
unit=$home/.config/systemd/user/sova.service
check "$([ "$status" -eq 0 ] && echo true || echo false)" "systemd: exits 0"
check "$(yes_if grep -q 'sova-service v1' "$unit")" "systemd: the unit carries our marker"
check "$(yes_if grep -qF "ExecStart=\"$home/.local/bin/sova\"" "$unit")" "systemd: ExecStart is the launcher, quoted"
check "$(yes_if grep -q '^Environment=PORT=4899$' "$unit")" "systemd: the port"
check "$(yes_if grep -q '^Environment="PATH=.*/opt/homebrew/bin.*"$' "$unit")" "systemd: PATH has Homebrew"
check "$(yes_if grep -qF "$home/.local/bin" "$unit")" "systemd: PATH has ~/.local/bin"
check "$(yes_if grep -q 'enable' "$case_dir/svc.log")" "systemd: enabled"
check "$(yes_if grep -q 'systemctl --user start sova.service' "$case_dir/svc.log")" "systemd: started"
# A changed definition is rewritten in place and reloaded; the service is not started twice.
: > "$case_dir/svc.log"
inst --port 4898
check "$(yes_if grep -q '^Environment=PORT=4898$' "$unit")" "systemd, new port: the unit is updated in place"
check "$(yes_if grep -q 'daemon-reload' "$case_dir/svc.log")" "systemd, new port: daemon-reload"
check "$(yes_if grep -q 'restart sova.service' "$case_dir/svc.log")" "systemd, new port: restarted"
check "$(yes_if [ -z "$(grep 'systemctl --user start' "$case_dir/svc.log")" ])" "systemd, new port: no second start"

# 19. launchd: --service writes a valid agent plist and bootstraps it; a rerun leaves it loaded.
FAKE_UNAME=Darwin run_install launchd --service
case_dir=$(dirname "$home")
plist=$home/Library/LaunchAgents/io.github.naomarik.sova.plist
check "$([ "$status" -eq 0 ] && echo true || echo false)" "launchd: exits 0"
check "$(yes_if grep -q 'sova-service v1' "$plist")" "launchd: the plist carries our marker"
if command -v python3 >/dev/null 2>&1; then
	parsed=$(python3 -c 'import plistlib,sys; p=plistlib.load(open(sys.argv[1],"rb")); print(p["Label"], p["ProgramArguments"][0], p["EnvironmentVariables"]["PORT"], p["KeepAlive"], p["RunAtLoad"]); print(p["EnvironmentVariables"]["PATH"])' "$plist" 2>&1 || true)
	check "$(yes_if [ "$(printf '%s\n' "$parsed" | head -n 1)" = "io.github.naomarik.sova $home/.local/bin/sova 4800 True True" ])" \
		"launchd: the plist parses, with the label, launcher, port and keep-alive"
	check "$(printf '%s' "$parsed" | grep -q '/opt/homebrew/bin' && echo true || echo false)" "launchd: PATH has Homebrew"
fi
check "$(yes_if grep -q 'launchctl bootstrap gui/' "$case_dir/svc.log")" "launchd: bootstrapped into the gui domain"
: > "$case_dir/svc.log"
FAKE_UNAME=Darwin inst
check "$(yes_if [ -z "$(grep -E 'bootstrap|bootout|kickstart' "$case_dir/svc.log")" ])" \
	"launchd rerun: not reloaded, restarted or started again"

# 20. A port someone else already serves: the service is installed, not started.
NODE_FAKE_PORT_BUSY=1 run_install port-busy --service
case_dir=$(dirname "$home")
check "$([ "$status" -eq 0 ] && echo true || echo false)" "port busy: exits 0"
check "$(yes_if [ -f "$home/.config/systemd/user/sova.service" ])" "port busy: the unit is installed"
check "$(yes_if [ -z "$(grep 'start' "$case_dir/svc.log" | grep -v 'is-active')" ])" "port busy: not started"
check "$(yes_if said 'did not start it')" "port busy: says so"

# 21. A service file we did not write is refused before anything is installed.
fresh_home foreign-service
mkdir -p "$home/.config/systemd/user"
printf '[Service]\nExecStart=/bin/true\n' > "$home/.config/systemd/user/sova.service"
inst --service
check "$([ "$status" -ne 0 ] && echo true || echo false)" "foreign service: exits nonzero"
check "$(yes_if said 'was not written by this script')" "foreign service: says why"
check "$(yes_if grep -q 'ExecStart=/bin/true' "$home/.config/systemd/user/sova.service")" "foreign service: kept"
check "$(yes_if [ ! -e "$home/.local/share/sova" ])" "foreign service: installed nothing"

# 22. With no flag and no terminal: no service, and it says how to get one.
run_install no-terminal
check "$([ "$status" -eq 0 ] && echo true || echo false)" "no terminal: exits 0"
check "$(yes_if [ ! -e "$home/.config/systemd/user/sova.service" ])" "no terminal: no service"
check "$(yes_if said 'again with --service')" "no terminal: says how to add one"

# 23. With no flag and a terminal, it asks; yes installs the service. No, then, installs none.
fresh_home ask-yes
printf 'y\n' > "$tmp/ask-yes/tty"
CASE_TTY=$tmp/ask-yes/tty inst
check "$(yes_if grep -q 'starts at login' "$tmp/ask-yes/tty")" "ask: the question goes to the terminal"
check "$(yes_if [ -f "$home/.config/systemd/user/sova.service" ])" "ask, yes: the service is installed"
fresh_home ask-no
printf 'n\n' > "$tmp/ask-no/tty"
CASE_TTY=$tmp/ask-no/tty inst
check "$(yes_if [ ! -e "$home/.config/systemd/user/sova.service" ])" "ask, no: no service"

# 24. The installer is bash 3.2 and BSD safe: it parses, and uses none of the GNU-only flags or
#     bash 4 features that break on a stock Mac.
check "$(yes_if bash -n "$installer")" "portable: parses"
check "$(yes_if [ -z "$(grep -nE 'sed -i|readlink -f|stat -c|date -d|setsid|declare -A|mapfile|readarray|\$\{[a-zA-Z_]+(,,|\^\^)|&>>|\|&' "$installer")" ])" \
	"portable: no GNU-only flags or bash 4 features"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
