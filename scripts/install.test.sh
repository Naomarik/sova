#!/usr/bin/env bash
# Tests for scripts/install.sh. Every case runs in its own temporary HOME with a sandboxed PATH:
# git is the real one (the installer clones a local seed repository); node, pnpm, npx, curl, unzip,
# uname, systemctl and launchctl are stubs, and so are the seed's scripts/fetch-bun.sh (the Bun
# download) and scripts/start-server.sh (what the launcher execs), so nothing is downloaded, no real service manager is asked
# anything, and nothing outside the temporary directory is touched. No case can see a terminal
# unless it hands the installer one (SOVA_TTY). The cases of `sova app` stub the browsers, the
# health check (curl), the openers, the notifiers, sips and iconutil: no real browser is started.
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
for c in awk basename bash cat chmod cmp cp dirname env grep head id ln mkdir mktemp mv nohup printf readlink rm rmdir sed sh sleep sort touch tr wc; do
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
# curl and unzip only have to exist (Bun's download is the seed's fetch-bun.sh stub): never called.
for c in curl unzip; do
	printf '#!/usr/bin/env bash\nprintf "%s stub: must not be called\\n" >&2\nexit 1\n' "$c" > "$sandbox/$c"
	chmod 755 "$sandbox/$c"
done
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
for d in "$nogit" "$nopnpm" "$nopm"; do cp "$sandbox/node" "$sandbox/uname" "$sandbox/curl" "$sandbox/unzip" "$d/"; done
nocurl=$tmp/sandbox-nocurl       # everything but curl
cp -P "$sandbox"/* "$nocurl/" 2>/dev/null || { mkdir -p "$nocurl" && cp -P "$sandbox"/* "$nocurl/"; }
rm -f "$nocurl/curl"
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
printf '[tools]\nnode = "25.2.1"\nbun = "1.4.2"\n' > "$seed/mise.toml"
mkdir -p "$seed/public/icons"
printf 'not really a png\n' > "$seed/public/icons/pwa-512.png"
# fetch-bun.sh <dir>: a <dir>/bin/bun that reports the pinned version, kept when it already does;
# every call logged to $BUN_LOG, and BUN_FAIL=1 fails it.
cat > "$seed/scripts/fetch-bun.sh" <<'STUB'
#!/bin/sh
[ -z "${BUN_LOG:-}" ] || printf 'fetch %s\n' "$1" >> "$BUN_LOG"
[ "${BUN_FAIL:-}" != 1 ] || { printf 'fetch-bun stub: failed on purpose\n' >&2; exit 1; }
if [ "$("$1/bin/bun" --version 2>/dev/null)" != 1.4.2 ]; then
	[ -z "${BUN_LOG:-}" ] || printf 'download\n' >> "$BUN_LOG"
	mkdir -p "$1/bin"
	printf '#!/bin/sh\n[ "$1" = --version ] && { echo 1.4.2; exit 0; }\necho "bun stub: $*"\n' > "$1/bin/bun"
	chmod 755 "$1/bin/bun"
fi
printf '%s\n' "$1/bin/bun"
STUB
# start-server.sh: says how it was asked to start the server.
cat > "$seed/scripts/start-server.sh" <<'STUB'
#!/bin/sh
printf 'start-server stub ran: SOVA_BUN=%s args=%s PORT=%s\n' "${SOVA_BUN:-}" "$*" "${PORT:-}"
STUB
chmod 755 "$seed/scripts/fetch-bun.sh" "$seed/scripts/start-server.sh"
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
# `stable`, the moving tag the installer defaults to, annotated as a release makes it.
git -C "$seed" -c user.email=t@t -c user.name=t tag -a stable -m 'stable: v0.1.0'

# ---- one case = one fresh HOME, whose path has a space in it ----

home=
# Every case runs as `inst`: the sandbox PATH, a fresh or kept HOME, no terminal, and the service
# managers' logs and state beside that HOME. Nothing the caller's environment names reaches it:
# PI_CODING_AGENT_DIR, XDG_CONFIG_HOME, XDG_DATA_HOME and MISE_DATA_DIR would point it at real directories,
# and a SOVA_BUN of the caller's would win over the install's Bun.
unset PI_CODING_AGENT_DIR PI_AGENT_DIR XDG_CONFIG_HOME XDG_DATA_HOME MISE_DATA_DIR SOVA_BUN
inst() {                 # inst [args...] in the current $home; sets `status` and `out`
	local case_dir
	case_dir=$(dirname "$home")
	set +e
	out=$(env -u PI_CODING_AGENT_DIR ${CASE_AGENT_DIR:+PI_CODING_AGENT_DIR="$CASE_AGENT_DIR"} \
		HOME="$home" PATH="${CASE_PATH:-$sandbox}" SOVA_REPO="file://$seed" SOVA_REF="${CASE_REF:-v0.1.0}" \
		SOVA_TTY="${CASE_TTY:-$tmp/.no-tty}" SVC_LOG="$case_dir/svc.log" SVC_STATE="$case_dir/svc" \
		PNPM_LOG="$case_dir/pnpm.log" BUN_LOG="$case_dir/bun.log" "$test_bash" "$installer" "$@" 2>&1)
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

# Every regular file under ~/.pi, with its path. Links are not followed, so the extension links
# are not in it.
pi_files() {
	(cd "$home/.pi" && find . -type f -print -exec cat {} + | sort)
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
check "$(yes_if [ -z "$(printf '%s' "$out" | grep 'not installed' | grep pnpm)" ])" "missing git: does not ask for pnpm, which is optional"
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
check "$(printf '%s' "$out" | grep -q "sova open" && echo true || echo false)" "success: says how to unlock the page"
check "$(pi_untouched && echo true || echo false)" "success: ~/.pi untouched"
check "$([ ! -e "$home/.local/share/sova/.pi" ] && echo true || echo false)" "success: wrote no .pi into the install dir"
check "$([ -z "$(ls -d "$home/.local/share/.sova-staging."* 2>/dev/null)" ] && echo true || echo false)" \
	"success: cleaned up its staging dir"
launch=$(PATH="$sandbox" "$home/.local/bin/sova" --check 2>&1 || true)
check "$(printf '%s' "$launch" | grep -qF "start-server stub ran: SOVA_BUN=$home/.local/share/sova/.bun/bin/bun args=--check" && echo true || echo false)" \
	"success: the launcher runs the server from the install dir on its own Bun, with a spaced path"
check "$(yes_if [ "$("$home/.local/share/sova/.bun/bin/bun" --version)" = 1.4.2 ])" "success: the pinned Bun is in the install dir"
check "$(yes_if said 'runtime: Bun 1.4.2')" "success: names the runtime"
launch=$(PATH="$sandbox" "$home/.local/bin/sova" --node 2>&1 || true)
check "$(printf '%s' "$launch" | grep -qF 'args=--node' && echo true || echo false)" "success: sova --node reaches the launcher"
launch=$(PATH="$sandbox" SOVA_BUN=/elsewhere/bun "$home/.local/bin/sova" 2>&1 || true)
check "$(printf '%s' "$launch" | grep -qF 'SOVA_BUN=/elsewhere/bun ' && echo true || echo false)" "success: a SOVA_BUN of the caller's wins"

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

# 3b. No curl to download Bun with: exits nonzero, says so, changes nothing.
CASE_PATH=$nocurl run_install missing-curl
unset CASE_PATH
check "$(yes_if [ "$status" -ne 0 ])" "missing curl: exits nonzero"
check "$(yes_if said 'curl is not installed')" "missing curl: says which command"
check "$(yes_if [ ! -e "$home/.local/share/sova" ] && [ ! -e "$home/.local/bin/sova" ])" "missing curl: no install dir, no launcher"

# 3c. A failed Bun download changes nothing.
BUN_FAIL=1 run_install bun-fails
unset BUN_FAIL
check "$(yes_if [ "$status" -ne 0 ])" "bun fails: exits nonzero"
check "$(yes_if said 'could not install Bun; nothing was changed')" "bun fails: says nothing was changed"
check "$(yes_if [ ! -e "$home/.local/share/sova" ] && [ ! -e "$home/.local/bin/sova" ])" "bun fails: no install dir, no launcher"
check "$(yes_if [ ! -e "$home/.local" ])" "bun fails: no directory left that the run created"

# 5. Re-running on our own clean clone with --reinstall rebuilds it and keeps working.
home=$good_home
inst --reinstall
check "$([ "$status" -eq 0 ] && echo true || echo false)" "rerun: exits 0"
check "$([ -f "$home/.local/share/sova/dist/index.html" ] && echo true || echo false)" "rerun: the build is in place"
check "$([ -x "$home/.local/bin/sova" ] && echo true || echo false)" "rerun: the launcher is in place"
check "$([ -z "$(ls -d "$home/.local/share/sova.sova-previous."* 2>/dev/null)" ] && echo true || echo false)" \
	"rerun: removed the previous install after promoting"
check "$(yes_if grep -qF 'export SOVA_LAUNCHER=$self' "$home/.local/bin/sova")" "rerun: the launcher tells the server its own path"

# 5b. SOVA_KEEP_PREVIOUS moves the replaced install there instead of deleting it (Settings' upgrade).
printf 'from the previous install\n' > "$home/.local/share/sova/KEPT.txt"
SOVA_KEEP_PREVIOUS="$home/kept install" inst --reinstall
check "$(yes_if [ "$status" -eq 0 ])" "keep previous: exits 0"
check "$(yes_if [ -f "$home/kept install/KEPT.txt" ])" "keep previous: the replaced install is at the path it was given"
check "$(yes_if [ ! -e "$home/.local/share/sova/KEPT.txt" ] && [ -f "$home/.local/share/sova/dist/index.html" ])" "keep previous: the new install is in place"
check "$(yes_if [ -z "$(ls -d "$home/.local/share/sova.sova-previous."* 2>/dev/null)" ])" "keep previous: no other backup left"
check "$(yes_if said 'kept the previous install at')" "keep previous: says where it kept it"
SOVA_KEEP_PREVIOUS="$home/kept install" inst --reinstall
check "$(yes_if [ "$status" -ne 0 ] && said 'already exists; nothing was changed')" "keep previous: a path that exists is refused before anything changes"
check "$(yes_if [ -f "$home/kept install/KEPT.txt" ] && [ -f "$home/.local/share/sova/dist/index.html" ])" "keep previous: the refusal left both installs alone"
rm -rf "$home/kept install"

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
check "$(yes_if [ ! -e "$home/.pi/agent/sova/settings.json" ])" \
	"extensions: no Sova settings file (the Claude Code provider needs no switch)"
check "$(yes_if said 'claude CLI on PATH')" "extensions: says Claude Code's models need the claude CLI"

# 13. Anything already at an extension's path that is not our link is kept, and that extension
#     is skipped: a directory, and a link to somewhere else. An existing Sova settings file is kept.
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
	"foreign extensions: an existing Sova settings file is kept as it was"

# 14. --no-extensions links nothing and writes nothing in the agent dir.
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
: > "$case_dir/bun.log"
: > "$case_dir/svc.log"
touch "$case_dir/stamp"
sleep 1
inst
check "$([ "$status" -eq 0 ] && echo true || echo false)" "rerun, same inputs: exits 0"
check "$(yes_if said 'nothing to rebuild')" "rerun, same inputs: says there is nothing to rebuild"
check "$(yes_if [ ! -s "$case_dir/pnpm.log" ])" "rerun, same inputs: installed and built nothing"
check "$(yes_if [ ! -s "$case_dir/bun.log" ])" "rerun, same inputs: fetched no Bun"
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
check "$(yes_if grep -q '^Restart=always$' "$unit")" "systemd: restarts whenever it exits, as the documented unit"
check "$(yes_if grep -q '^RestartSec=2$' "$unit")" "systemd: RestartSec as the documented unit"
check "$(yes_if grep -q '^TimeoutStopSec=90$' "$unit")" "systemd: a stop has 90 s to drain the workers"
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
	parsed=$(python3 -c 'import plistlib,sys; p=plistlib.load(open(sys.argv[1],"rb")); print(p["Label"], p["ProgramArguments"][0], p["EnvironmentVariables"]["PORT"], p["KeepAlive"], p["RunAtLoad"]); print(p["EnvironmentVariables"]["PATH"]); print(p["ThrottleInterval"], p["ExitTimeOut"], p["ProcessType"], p["EnvironmentVariables"]["LANG"])' "$plist" 2>/dev/null || true)
	check "$(yes_if [ "$(printf '%s\n' "$parsed" | head -n 1)" = "io.github.naomarik.sova $home/.local/bin/sova 4800 True True" ])" \
		"launchd: the plist parses, with the label, launcher, port and keep-alive"
	check "$(yes_if [ "$(printf '%s\n' "$parsed" | sed -n 3p)" = "2 60 Interactive en_US.UTF-8" ])" \
		"launchd: throttle, stop timeout, process type and LANG as the documented agent"
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

# The health check `sova app` asks: curl answers while $FAKE_UP exists, and logs every call.
up=$tmp/up
mkdir -p "$up"
cat > "$up/curl" <<'STUB'
#!/usr/bin/env bash
[ -z "${CURL_LOG:-}" ] || printf 'curl %s\n' "$*" >> "$CURL_LOG"
[ -n "${FAKE_UP:-}" ] && [ -e "$FAKE_UP" ]
STUB
chmod 755 "$up/curl"
touch "$tmp/up.always"

# 24a. The launcher's `token` prints the agent dir's token (the install's, or $PI_CODING_AGENT_DIR's)
#      and never starts the server; `open`, with the server up and no Chromium-family browser,
#      opens the page unlocked by it, on the install's port or $PORT. Before the server ever
#      minted a token, both say so and exit nonzero.
run_install launcher-token --port 4811 --no-service
opener=$tmp/launcher-token/opener
mkdir -p "$opener"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s"\n' "$tmp/launcher-token/opened" > "$opener/xdg-open"
chmod 755 "$opener/xdg-open"
sova_cmd() { set +e; launch=$(FAKE_UP="$tmp/up.always" PATH="$opener:$up:$sandbox" "$@" 2>&1); lstatus=$?; set -e; }
sova_cmd env -u PI_CODING_AGENT_DIR "$home/.local/bin/sova" token
check "$(yes_if [ "$lstatus" -ne 0 ])" "launcher token, none minted: exits nonzero"
check "$(printf '%s' "$launch" | grep -q 'start sova once' && echo true || echo false)" "launcher token, none minted: says to start sova once"
check "$(printf '%s' "$launch" | grep -q 'start-server stub ran' && echo false || echo true)" "launcher token: never starts the server"
mkdir -p "$home/.pi/agent/sova"
printf 'tok-of-the-install\n' > "$home/.pi/agent/sova/auth-token"
sova_cmd env -u PI_CODING_AGENT_DIR "$home/.local/bin/sova" token
check "$(yes_if [ "$launch" = tok-of-the-install ])" "launcher token: prints the install's agent dir token"
mkdir -p "$tmp/launcher-token/other agent/sova"
printf 'tok-of-other\n' > "$tmp/launcher-token/other agent/sova/auth-token"
sova_cmd env PI_CODING_AGENT_DIR="$tmp/launcher-token/other agent" "$home/.local/bin/sova" token
check "$(yes_if [ "$launch" = tok-of-other ])" "launcher token: \$PI_CODING_AGENT_DIR's token when set"
sova_cmd env -u PI_CODING_AGENT_DIR -u PORT "$home/.local/bin/sova" open
check "$(yes_if [ "$lstatus" -eq 0 ])" "launcher open: exits 0"
check "$(yes_if grep -qxF 'http://127.0.0.1:4811/#t=tok-of-the-install' "$tmp/launcher-token/opened")" \
	"launcher open: the install's port, unlocked in the fragment"
sova_cmd env -u PI_CODING_AGENT_DIR PORT=4999 "$home/.local/bin/sova" open
check "$(yes_if grep -qxF 'http://127.0.0.1:4999/#t=tok-of-the-install' "$tmp/launcher-token/opened")" "launcher open: \$PORT wins"
# --port without a service: plain `sova` serves on that port too, the one the summary names.
check "$(yes_if said 'It serves http://127.0.0.1:4811')" "--port, no service: the summary names the port"
sova_cmd env -u PORT "$home/.local/bin/sova"
check "$(printf '%s' "$launch" | grep -q 'start-server stub ran: .* PORT=4811$' && echo true || echo false)" \
	"--port, no service: sova serves on the install's port"
sova_cmd env PORT=4999 "$home/.local/bin/sova"
check "$(printf '%s' "$launch" | grep -q 'start-server stub ran: .* PORT=4999$' && echo true || echo false)" \
	"--port, no service: \$PORT still wins"
# With no browser opener, open says to paste the token and exits nonzero.
printf 'tok-of-the-install\n' > "$home/.pi/agent/sova/auth-token"
set +e; launch=$(env -u PI_CODING_AGENT_DIR FAKE_UP="$tmp/up.always" PATH="$up:$sandbox" "$home/.local/bin/sova" open 2>&1); lstatus=$?; set -e
check "$(yes_if [ "$lstatus" -ne 0 ])" "launcher open, no opener: exits nonzero"
check "$(printf '%s' "$launch" | grep -q "paste the token from 'sova token'" && echo true || echo false)" \
	"launcher open, no opener: says to paste the token"
rm "$home/.pi/agent/sova/auth-token"

# 27. The app entry, Linux: a .desktop file that runs `sova app` from the launcher (quoted for a
#     spaced HOME), with our marker, and the install's icon beside it.
run_install entry-linux
desktop=$home/.local/share/applications/sova.desktop
icon=$home/.local/share/icons/hicolor/512x512/apps/sova.png
check "$(yes_if [ "$status" -eq 0 ])" "entry, linux: exits 0"
check "$(yes_if grep -qxF "Exec=\"$home/.local/bin/sova\" app" "$desktop")" "entry, linux: Exec runs sova app, quoted"
check "$(yes_if grep -qxF 'X-Sova-Launcher=v1' "$desktop")" "entry, linux: carries our marker"
check "$(yes_if grep -qxF 'Icon=sova' "$desktop" && grep -qxF 'Name=Sova' "$desktop" && grep -qxF 'Terminal=false' "$desktop")" \
	"entry, linux: named Sova, with its icon, no terminal"
check "$(yes_if cmp -s "$icon" "$home/.local/share/sova/public/icons/pwa-512.png")" "entry, linux: the icon is the install's"
check "$(yes_if said "app entry: $desktop")" "entry, linux: the summary names it"
check "$(yes_if said 'an app window needs Chrome, Chromium, Brave, Edge or Vivaldi')" \
	"entry, linux: with no Chromium-family browser, the summary says what an app window needs"
# XDG_DATA_HOME moves it; a browser on PATH silences the note.
fresh_home entry-xdg
browsers=$tmp/entry-xdg/browsers
mkdir -p "$browsers"
printf '#!/bin/sh\nexit 0\n' > "$browsers/chromium"
chmod 755 "$browsers/chromium"
set +e
out=$(env HOME="$home" XDG_DATA_HOME="$home/data" PATH="$browsers:$sandbox" SOVA_REPO="file://$seed" SOVA_REF=v0.1.0 \
	SOVA_TTY="$tmp/.no-tty" SVC_LOG="$tmp/entry-xdg/svc.log" SVC_STATE="$tmp/entry-xdg/svc" "$test_bash" "$installer" 2>&1)
status=$?
set -e
check "$(yes_if [ "$status" -eq 0 ] && [ -f "$home/data/applications/sova.desktop" ] && [ -f "$home/data/icons/hicolor/512x512/apps/sova.png" ])" \
	"entry, XDG_DATA_HOME: written there"
check "$(yes_if [ -z "$(printf '%s' "$out" | grep 'an app window needs')" ])" "entry, browser found: no note about one"

# 28. A .desktop file or icon we did not write is refused before anything is installed, and kept;
#     --no-app-entry and SOVA_NO_APP_ENTRY=1 write none and install the rest.
fresh_home entry-foreign
mkdir -p "$home/.local/share/applications"
printf '[Desktop Entry]\nName=Mine\n' > "$home/.local/share/applications/sova.desktop"
inst
check "$(yes_if [ "$status" -ne 0 ])" "entry, foreign .desktop: exits nonzero"
check "$(yes_if said 'was not written by this script' && said 'or pass --no-app-entry')" "entry, foreign .desktop: says why and how to skip it"
check "$(yes_if grep -q 'Name=Mine' "$home/.local/share/applications/sova.desktop")" "entry, foreign .desktop: kept"
check "$(yes_if [ ! -e "$home/.local/share/sova" ] && [ ! -e "$home/.local/bin/sova" ])" "entry, foreign .desktop: installed nothing"
inst --no-app-entry
check "$(yes_if [ "$status" -eq 0 ] && [ -x "$home/.local/bin/sova" ])" "--no-app-entry: installs the rest"
check "$(yes_if grep -q 'Name=Mine' "$home/.local/share/applications/sova.desktop" && [ ! -e "$home/.local/share/icons" ])" \
	"--no-app-entry: the file in the way is left as it is, and no icon is written"
fresh_home entry-foreign-icon
mkdir -p "$home/.local/share/icons/hicolor/512x512/apps"
printf 'my icon\n' > "$home/.local/share/icons/hicolor/512x512/apps/sova.png"
inst
check "$(yes_if [ "$status" -ne 0 ] && grep -q 'my icon' "$home/.local/share/icons/hicolor/512x512/apps/sova.png")" \
	"entry, foreign icon: refused, kept"
fresh_home entry-env-off
set +e
out=$(env HOME="$home" SOVA_NO_APP_ENTRY=1 PATH="$sandbox" SOVA_REPO="file://$seed" SOVA_REF=v0.1.0 \
	SOVA_TTY="$tmp/.no-tty" SVC_LOG="$tmp/entry-env-off/svc.log" SVC_STATE="$tmp/entry-env-off/svc" "$test_bash" "$installer" 2>&1)
status=$?
set -e
check "$(yes_if [ "$status" -eq 0 ] && [ ! -e "$home/.local/share/applications" ] && [ -z "$(printf '%s' "$out" | grep 'app entry:')" ])" \
	"SOVA_NO_APP_ENTRY=1: no entry"

# 29. The app entry, macOS: ~/Applications/Sova.app, whose Info.plist carries our marker and
#     whose executable runs `sova app`, with an icon from sips and iconutil (stubs). A rerun
#     changes nothing; a bundle we did not write is refused; without sips there is no icon.
mac_tools=$tmp/mac-tools
mkdir -p "$mac_tools"
cat > "$mac_tools/sips" <<'STUB'
#!/usr/bin/env bash
# sips -z <h> <w> <src> --out <dst>
printf 'sips\n' >> "${SIPS_LOG:-/dev/null}"
cp "$4" "$6"
STUB
cat > "$mac_tools/iconutil" <<'STUB'
#!/usr/bin/env bash
# iconutil -c icns -o <out> <dir>.iconset
cat "$5"/*.png > "$4"
STUB
chmod 755 "$mac_tools/sips" "$mac_tools/iconutil"
FAKE_UNAME=Darwin CASE_PATH="$mac_tools:$sandbox" run_install entry-mac
app=$home/Applications/Sova.app
check "$(yes_if [ "$status" -eq 0 ])" "entry, mac: exits 0"
check "$(yes_if grep -qF '<!-- X-Sova-Launcher=v1' "$app/Contents/Info.plist")" "entry, mac: Info.plist carries our marker"
if command -v python3 >/dev/null 2>&1; then
	parsed=$(python3 -c 'import plistlib,sys; p=plistlib.load(open(sys.argv[1],"rb")); print(p["CFBundleName"], p["CFBundleIdentifier"], p["CFBundleExecutable"], p["CFBundleIconFile"])' "$app/Contents/Info.plist" 2>/dev/null || true)
	check "$(yes_if [ "$parsed" = "Sova io.github.naomarik.sova.app sova-app sova" ])" "entry, mac: Info.plist parses, with name, identifier, executable, icon"
	# A script executable starts under Rosetta, and the browser with it, unless the bundle names arm64 alone.
	archs=$(python3 -c 'import plistlib,sys; print(plistlib.load(open(sys.argv[1],"rb")).get("LSArchitecturePriority"))' "$app/Contents/Info.plist" 2>/dev/null || true)
	check "$(yes_if [ "$archs" = "['arm64']" ])" "entry, mac: the bundle runs natively on Apple silicon (arm64 only)"
fi
check "$(yes_if [ -x "$app/Contents/MacOS/sova-app" ] && grep -qF "exec $(printf '%q' "$home/.local/bin/sova") app" "$app/Contents/MacOS/sova-app")" \
	"entry, mac: the executable runs sova app"
check "$(yes_if [ -s "$app/Contents/Resources/sova.icns" ])" "entry, mac: an icon built by iconutil"
check "$(yes_if [ ! -e "$home/.local/share/applications" ])" "entry, mac: no .desktop file"
touch "$tmp/entry-mac/stamp"
sleep 1
: > "$tmp/entry-mac/sips.log"
FAKE_UNAME=Darwin CASE_PATH="$mac_tools:$sandbox" SIPS_LOG="$tmp/entry-mac/sips.log" inst
check "$(yes_if [ "$status" -eq 0 ] && [ -z "$(find "$app" -newer "$tmp/entry-mac/stamp" -print)" ])" "entry, mac rerun: the bundle is untouched"
check "$(yes_if [ ! -s "$tmp/entry-mac/sips.log" ])" "entry, mac rerun: the icon is not rebuilt"
fresh_home entry-mac-foreign
mkdir -p "$home/Applications/Sova.app/Contents"
printf '<plist>mine</plist>\n' > "$home/Applications/Sova.app/Contents/Info.plist"
FAKE_UNAME=Darwin inst
check "$(yes_if [ "$status" -ne 0 ] && grep -q mine "$home/Applications/Sova.app/Contents/Info.plist" && [ ! -e "$home/.local/share/sova" ])" \
	"entry, mac foreign bundle: refused, kept, nothing installed"
FAKE_UNAME=Darwin run_install entry-mac-nosips
check "$(yes_if [ "$status" -eq 0 ] && [ -x "$home/Applications/Sova.app/Contents/MacOS/sova-app" ] && [ ! -e "$home/Applications/Sova.app/Contents/Resources/sova.icns" ])" \
	"entry, mac without sips/iconutil: the bundle, with no icon"

# 30. `sova app` with the server up: the browser it picks, the window it opens (bare, unlocked,
#     its own profile, no debugging port), and the tab it falls back to.
run_install app-pick --port 4811 --no-service
mkdir -p "$home/.pi/agent/sova"
printf 'tok-app\n' > "$home/.pi/agent/sova/auth-token"
fake=$tmp/app-pick/fake
mkdir -p "$fake"
browsed=$tmp/app-pick/browsed
mk_browser() {      # mk_browser <path>: a browser that logs its arguments, one per line
	mkdir -p "$(dirname "$1")"
	printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$0" "$@" > "%s"\n' "$browsed" > "$1"
	chmod 755 "$1"
}
mk_browser "$fake/chrome-bin/google-chrome-stable"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "${FAKE_DEFAULT_BROWSER:-}"\n' > "$fake/xdg-settings"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s"\n' "$tmp/app-pick/opened" > "$fake/xdg-open"
chmod 755 "$fake/xdg-settings" "$fake/xdg-open"
mkdir -p "$home/.local/share/applications"
printf '[Desktop Entry]\nName=Google Chrome\nExec=%s %%U\n' "$fake/chrome-bin/google-chrome-stable" > "$home/.local/share/applications/google-chrome.desktop"
wait_for() { local i; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do [ -s "$1" ] && return 0; sleep 0.25; done; return 1; }
app_cmd() {         # app_cmd <PATH> [env...] -- runs `sova <args>` from $home with the server up
	local path=$1; shift
	rm -f "$browsed" "$tmp/app-pick/opened"
	set +e
	launch=$(env -u PI_CODING_AGENT_DIR -u PORT HOME="$home" FAKE_UP="$tmp/up.always" PATH="$path" "$@" 2>&1)
	lstatus=$?
	set -e
}
app_cmd "$fake:$up:$sandbox" FAKE_DEFAULT_BROWSER=google-chrome.desktop "$home/.local/bin/sova" app
wait_for "$browsed" || true
check "$(yes_if [ "$lstatus" -eq 0 ])" "sova app: exits 0"
check "$(yes_if [ "$(head -n 1 "$browsed" 2>/dev/null)" = "$fake/chrome-bin/google-chrome-stable" ])" \
	"sova app: the default browser, run as its .desktop file's Exec names it"
check "$(yes_if grep -qxF -- '--app=http://127.0.0.1:4811/#t=tok-app' "$browsed")" "sova app: a bare app window, unlocked, on the install's port"
check "$(yes_if grep -qxF -- "--user-data-dir=$home/.config/sova-browser" "$browsed")" "sova app: a profile of its own"
check "$(yes_if grep -qxF -- '--no-first-run' "$browsed" && grep -qxF -- '--no-default-browser-check' "$browsed")" "sova app: no first-run or default-browser prompts"
check "$(yes_if [ -z "$(grep -- '--remote-debugging' "$browsed")" ])" "sova app: no debugging port"
check "$(yes_if grep -qF '"custom_chrome_frame":false' "$home/.config/sova-browser/Default/Preferences" && [ -e "$home/.config/sova-browser/First Run" ])" \
	"sova app: a new profile uses the system title bar and skips the first-run page"
check "$(yes_if [ ! -s "$tmp/app-pick/opened" ])" "sova app: no tab as well"
printf '{"mine":true}\n' > "$home/.config/sova-browser/Default/Preferences"
app_cmd "$fake:$up:$sandbox" FAKE_DEFAULT_BROWSER=google-chrome.desktop "$home/.local/bin/sova" open
wait_for "$browsed" || true
check "$(yes_if grep -qxF -- '--app=http://127.0.0.1:4811/#t=tok-app' "$browsed")" "sova open: the same window as sova app"
check "$(yes_if grep -qF '"mine":true' "$home/.config/sova-browser/Default/Preferences")" "sova app: an existing profile is left as it is"
# The default browser is not Chromium-family (or there is no xdg-settings): the first on PATH.
mk_browser "$fake/path-bin/chromium"
app_cmd "$fake/path-bin:$fake:$up:$sandbox" FAKE_DEFAULT_BROWSER=firefox.desktop "$home/.local/bin/sova" app
wait_for "$browsed" || true
check "$(yes_if [ "$(head -n 1 "$browsed" 2>/dev/null)" = "$fake/path-bin/chromium" ])" "sova app, default is firefox: the Chromium on PATH"
app_cmd "$fake/path-bin:$up:$sandbox" "$home/.local/bin/sova" app --print-browser
check "$(yes_if [ "$launch" = "$fake/path-bin/chromium" ])" "sova app --print-browser: names it"
# No Chromium-family browser: a tab of the default browser, unlocked.
app_cmd "$fake:$up:$sandbox" FAKE_DEFAULT_BROWSER=firefox.desktop "$home/.local/bin/sova" app
check "$(yes_if [ "$lstatus" -eq 0 ] && grep -qxF 'http://127.0.0.1:4811/#t=tok-app' "$tmp/app-pick/opened")" \
	"sova app, no such browser: a tab of the default browser, unlocked"
check "$(yes_if [ ! -e "$browsed" ])" "sova app, no such browser: no browser started"

# 31. macOS: the default https handler when it is one of them, else the first bundle found; the
#     bundle's own executable, with the macOS profile folder; `open` as the tab fallback.
FAKE_UNAME=Darwin run_install app-mac --no-service
mkdir -p "$home/.pi/agent/sova"
printf 'tok-mac\n' > "$home/.pi/agent/sova/auth-token"
browsed=$tmp/app-mac/browsed
mac=$tmp/app-mac/bin
mkdir -p "$mac"
mk_browser "$home/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
mk_browser "$home/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
cat > "$mac/defaults" <<'STUB'
#!/usr/bin/env bash
case "$*" in
	*launchservices.secure*LSHandlers)
		cat <<'OUT'
(
        {
        LSHandlerContentType = "public.html";
        LSHandlerRoleAll = "com.google.chrome";
    },
        {
        LSHandlerPreferredVersions =         {
            LSHandlerRoleAll = "-";
        };
        LSHandlerRoleAll = "com.brave.browser";
        LSHandlerURLScheme = https;
    }
)
OUT
		;;
	*) exit 1 ;;
esac
STUB
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s"\n' "$tmp/app-mac/opened" > "$mac/open"
chmod 755 "$mac/defaults" "$mac/open"
mac_cmd() { set +e; rm -f "$browsed"; launch=$(env -u PI_CODING_AGENT_DIR -u PORT FAKE_UNAME=Darwin HOME="$home" FAKE_UP="$tmp/up.always" PATH="$1" "$home/.local/bin/sova" app 2>&1); lstatus=$?; set -e; }
mac_cmd "$mac:$up:$sandbox"
wait_for "$browsed" || true
check "$(yes_if [ "$lstatus" -eq 0 ] && [ "$(head -n 1 "$browsed" 2>/dev/null)" = "$home/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" ])" \
	"sova app, mac: the default https handler's bundle executable"
check "$(yes_if grep -qxF -- "--user-data-dir=$home/Library/Application Support/sova-browser" "$browsed")" "sova app, mac: the macOS profile folder"
rm "$mac/defaults"
mac_cmd "$mac:$up:$sandbox"
wait_for "$browsed" || true
check "$(yes_if [ "$(head -n 1 "$browsed" 2>/dev/null)" = "$home/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ])" \
	"sova app, mac, no default known: the first bundle found"
rm -rf "$home/Applications/Google Chrome.app" "$home/Applications/Brave Browser.app"
mac_cmd "$mac:$up:$sandbox"
check "$(yes_if [ "$lstatus" -eq 0 ] && grep -qxF 'http://127.0.0.1:4800/#t=tok-mac' "$tmp/app-mac/opened")" "sova app, mac, no such browser: open's tab"

# 32. `sova app` with the server down starts it, waits for it, then opens the window; through the
#     login service when the installer's is installed; a server that never answers, or exits,
#     is notified with where its output is, and nothing opens.
run_install app-start --no-service
case_dir=$tmp/app-start
mkdir -p "$home/.pi/agent/sova"
printf 'tok-start\n' > "$home/.pi/agent/sova/auth-token"
browsed=$case_dir/browsed
mk_browser "$case_dir/bin/chromium"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s"\n' "$case_dir/notified" > "$case_dir/bin/notify-send"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s"\n' "$case_dir/notified" > "$case_dir/bin/osascript"
chmod 755 "$case_dir/bin/notify-send" "$case_dir/bin/osascript"
# The server: answers after a moment (FAKE_START=up), never answers (hang), or exits at once.
cat > "$home/.local/share/sova/scripts/start-server.sh" <<'STUB'
#!/bin/sh
echo "start-server stub: started PORT=$PORT"
case "${FAKE_START:-}" in
	up) sleep 1; touch "$FAKE_UP"; sleep 2 ;;
	hang) sleep 4 ;;
esac
STUB
start_cmd() {       # start_cmd [env...]: `sova app` with the server down
	rm -f "$browsed" "$case_dir/notified" "$case_dir/is-up"
	set +e
	launch=$(env -u PI_CODING_AGENT_DIR -u PORT HOME="$home" FAKE_UP="$case_dir/is-up" SVC_LOG="$case_dir/svc.log" \
		SVC_STATE="$case_dir/svc" PATH="$case_dir/bin:$up:$sandbox" "$@" "$home/.local/bin/sova" app 2>&1)
	lstatus=$?
	set -e
}
start_cmd FAKE_START=up
wait_for "$browsed" || true
check "$(yes_if [ "$lstatus" -eq 0 ])" "server down: exits 0 once it answers"
check "$(yes_if grep -qF 'start-server stub: started PORT=4800' "$home/.pi/agent/sova/app-server.log")" \
	"server down: started the server in the background, its output in the agent dir"
check "$(yes_if grep -qxF -- '--app=http://127.0.0.1:4800/#t=tok-start' "$browsed")" "server down: then opened the window"
start_cmd FAKE_START=hang SOVA_APP_WAIT=1
check "$(yes_if [ "$lstatus" -ne 0 ])" "server never answers: exits nonzero"
check "$(yes_if grep -qF "$home/.pi/agent/sova/app-server.log" "$case_dir/notified")" "server never answers: notifies, naming the log"
check "$(yes_if [ ! -e "$browsed" ])" "server never answers: opens nothing"
start_cmd
check "$(yes_if [ "$lstatus" -ne 0 ] && grep -qF 'exited before it answered' "$case_dir/notified")" \
	"server exits: notified at once, nonzero"
# The installer's systemd unit: started through it.
mkdir -p "$home/.config/systemd/user"
printf '# sova-service v1\n[Service]\n' > "$home/.config/systemd/user/sova.service"
: > "$case_dir/svc.log"
start_cmd SOVA_APP_WAIT=1
check "$(yes_if grep -qF 'systemctl --user start sova.service' "$case_dir/svc.log")" "server down, systemd unit: started through it"
check "$(yes_if grep -qF 'journalctl --user -u sova.service' "$case_dir/notified")" "server down, systemd unit: the notice says where its log is"
rm "$home/.config/systemd/user/sova.service"
# The installer's launchd agent: kickstarted; the notice goes through osascript.
mkdir -p "$home/Library/LaunchAgents"
printf '<!-- sova-service v1 -->\n' > "$home/Library/LaunchAgents/io.github.naomarik.sova.plist"
: > "$case_dir/svc.log"
start_cmd FAKE_UNAME=Darwin SOVA_APP_WAIT=1
check "$(yes_if grep -qE 'launchctl kickstart gui/[0-9]+/io.github.naomarik.sova' "$case_dir/svc.log")" "server down, launchd agent: kickstarted"
check "$(yes_if [ "$lstatus" -ne 0 ] && grep -qF 'Library/Logs/sova.log' "$case_dir/notified")" \
	"server down, launchd agent, no answer: osascript notifies, naming its log"

# 25. The ref: one that is neither a tag, a branch nor a commit stops the install before anything
#     is written; the default branch is never installed in its place; the summary names the ref.
CASE_REF=mastr run_install bad-ref
check "$(yes_if [ "$status" -ne 0 ])" "bad ref: exits nonzero"
check "$(yes_if said "'mastr' is not a tag or a branch")" "bad ref: names the ref"
check "$(yes_if said 'Pass SOVA_REF=<tag, branch or commit>')" "bad ref: says to pass SOVA_REF"
check "$(yes_if [ ! -e "$home/.local" ])" "bad ref: nothing written, not even ~/.local"
check "$(yes_if pi_untouched)" "bad ref: ~/.pi untouched"
CASE_REF=deadbeef1 run_install bad-commit
check "$(yes_if [ "$status" -ne 0 ])" "bad commit: exits nonzero"
check "$(yes_if said "'deadbeef1' is not a tag, a branch or a commit")" "bad commit: says so"
check "$(yes_if said 'nothing was changed')" "bad commit: says nothing was changed"
check "$(yes_if [ ! -e "$home/.local/share/sova" ] && [ ! -e "$home/.local/bin/sova" ])" "bad commit: no install dir, no launcher"
check "$(yes_if [ -z "$(ls -d "$home/.local/share/.sova-staging."* 2>/dev/null)" ])" "bad commit: no staging dir left"
check "$(yes_if [ ! -e "$home/.local" ])" "bad commit: no directory left that the run created (not even ~/.local)"
mkdir -p "$home/.local/share/keep"
CASE_REF=deadbeef1 inst
check "$([ "$status" -ne 0 ] && [ -d "$home/.local/share/keep" ] && [ ! -e "$home/.local/bin" ] && echo true || echo false)" \
	"bad commit: directories that were there stay; no launcher directory"
# An existing install is left as it was by a bad ref.
home=$good_home
before_head=$(git -C "$home/.local/share/sova" rev-parse HEAD)
CASE_REF=mastr inst
check "$(yes_if [ "$status" -ne 0 ] && [ "$(git -C "$home/.local/share/sova" rev-parse HEAD)" = "$before_head" ])" \
	"bad ref over an install: refused, the install unchanged"
seed_master=$(git -C "$seed" rev-parse master)
CASE_REF=master run_install ref-branch
check "$(yes_if said "installed master (${seed_master:0:7})")" "ref, a branch: the summary names it and its commit"
# With no SOVA_REF, the default is the `stable` tag, whatever it points at when the run starts: a
# re-run after a release moves it installs the new commit, and one after it is moved back (a
# rollback) the old one. The first run has stable on `next`, which master is not, so installing
# master in its place would fail.
seed_next=$(git -C "$seed" rev-parse next)
seed_v010=$(git -C "$seed" rev-parse 'v0.1.0^{commit}')
move_stable() { git -C "$seed" -c user.email=t@t -c user.name=t tag -fa stable "$1" -m "stable: $1" >/dev/null; }
inst_default() {
	set +e
	out=$(env -u SOVA_REF HOME="$home" PATH="$sandbox" SOVA_REPO="file://$seed" SOVA_TTY="$tmp/.no-tty" \
		SVC_LOG="$tmp/ref-default/svc.log" SVC_STATE="$tmp/ref-default/svc" "$test_bash" "$installer" 2>&1)
	status=$?
	set -e
}
installed_head() { git -C "$home/.local/share/sova" rev-parse HEAD 2>/dev/null; }
fresh_home ref-default
move_stable next
inst_default
check "$(yes_if [ "$status" -eq 0 ] && [ "$(installed_head)" = "$seed_next" ] && [ "$seed_next" != "$seed_master" ])" \
	"ref, unset: installs the commit stable points at, not master"
check "$(yes_if said "installed stable (${seed_next:0:7})")" "ref, unset: the summary names stable and its commit"
move_stable v0.1.0
inst_default
check "$(yes_if [ "$status" -eq 0 ] && [ "$(installed_head)" = "$seed_v010" ])" \
	"ref, unset: stable moved back, a re-run installs the older commit again"
check "$(yes_if said "installed stable (${seed_v010:0:7})")" "ref, unset: the rollback re-run rebuilds and says so"
move_stable next
inst_default
check "$(yes_if [ "$status" -eq 0 ] && [ "$(installed_head)" = "$seed_next" ])" \
	"ref, unset: stable re-pointed forward, a re-run installs the new commit"
inst_default
check "$(yes_if [ "$status" -eq 0 ] && said "is already at stable (${seed_next:0:7}); nothing to rebuild")" \
	"ref, unset: stable unmoved, a re-run rebuilds nothing"
move_stable v0.1.0
CASE_REF=$seed_next run_install ref-commit
check "$(yes_if [ "$status" -eq 0 ] && [ "$(git -C "$home/.local/share/sova" rev-parse HEAD)" = "$seed_next" ])" \
	"ref, a commit: installs that commit"
check "$(yes_if said "installed $seed_next")" "ref, a commit: the summary names it"

# 26. Piped like curl | bash: a download cut short runs nothing, wherever it is cut, and an early
#     failure still reads the whole script, so the writer never sees a closed pipe (curl's "(23)").
total=$(wc -l < "$installer")
for cut in 60 330 $((total - 1)); do
	fresh_home "truncated-$cut"
	set +e
	out=$(head -n "$cut" "$installer" | env HOME="$home" PATH="$sandbox" SOVA_REPO="file://$seed" SOVA_REF=v0.1.0 \
		SOVA_TTY="$tmp/.no-tty" SVC_LOG="$tmp/truncated-$cut/svc.log" SVC_STATE="$tmp/truncated-$cut/svc" "$test_bash" 2>&1)
	set -e
	check "$(yes_if [ ! -e "$home/.local" ] && pi_untouched)" "truncated at line $cut of $total: ran nothing"
done
fresh_home piped-early-failure
# The writer pauses after the line the git check is on (a script run as it streams fails there and
# closes the pipe), then writes the rest: a closed pipe kills it (141), as it fails curl.
set +e
out=$({ head -n 120 "$installer"; sleep 1; tail -n +121 "$installer"; } |
	env HOME="$home" PATH="$nogit" SOVA_TTY="$tmp/.no-tty" "$test_bash" 2>&1
	printf 'writer status %s\n' "${PIPESTATUS[0]}")
set -e
check "$(yes_if said 'git is not installed')" "piped, early failure: says why"
check "$(yes_if said 'writer status 0')" "piped, early failure: the whole script was read (the writer saw no closed pipe)"

# 24. The installer is bash 3.2 and BSD safe: it parses, and uses none of the GNU-only flags or
#     bash 4 features that break on a stock Mac.
check "$(yes_if bash -n "$installer")" "portable: parses"
check "$(yes_if [ -z "$(grep -nE 'sed -i|readlink -f|stat -c|date -d|setsid|declare -A|mapfile|readarray|\$\{[a-zA-Z_]+(,,|\^\^)|&>>|\|&' "$installer")" ])" \
	"portable: no GNU-only flags or bash 4 features"

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
