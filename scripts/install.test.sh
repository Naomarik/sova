#!/usr/bin/env bash
# Tests for scripts/install.sh. Every case runs in its own temporary HOME with a sandboxed PATH:
# git is the real one (the installer clones a local seed repository), node, pnpm and npx are stubs,
# so nothing is downloaded and nothing outside the temporary directory is touched.
#
# Run: scripts/install.test.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
root=$(cd "$here/.." && pwd -P)
installer=$root/scripts/install.sh

tmp=$(mktemp -d)
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
for c in bash env cat chmod cp dirname grep head mkdir mktemp mv printf rm sed sort touch uname wc; do
	for d in "$sandbox" "$nogit" "$nopnpm" "$nopm"; do ln -sf "$(command -v "$c")" "$d/$c"; done
done
for d in "$sandbox" "$nopnpm" "$nopm"; do ln -sf "$(command -v git)" "$d/git"; done  # $nogit has no git

cat > "$sandbox/node" <<'STUB'
#!/usr/bin/env bash
[ "${1:-}" = "-v" ] && { printf 'v%s\n' "${NODE_FAKE_VERSION:-25.2.1}"; exit 0; }
printf 'node stub: %s\n' "$*"
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
chmod 755 "$sandbox/node" "$stubs/pnpm" "$stubs/npx"
for d in "$nogit" "$nopnpm" "$nopm"; do cp "$sandbox/node" "$d/node"; done
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
printf 'node_modules/\ndist/\n' > "$seed/.gitignore"
git -C "$seed" init --quiet -b master
git -C "$seed" -c user.email=t@t -c user.name=t add -A
git -C "$seed" -c user.email=t@t -c user.name=t commit --quiet -m seed
git -C "$seed" tag v0.1.0

# ---- one case = one fresh HOME, whose path has a space in it ----

home=
run_install() {          # run_install <case name> [args...]; sets `status` and `out`
	local name=$1; shift
	home="$tmp/$name/fake home"
	mkdir -p "$home/.pi/agent"
	printf '{"marker":"do not touch"}\n' > "$home/.pi/agent/settings.json"
	pi_before=$(cd "$home/.pi" && find . -type f -exec cat {} + | sort)
	set +e
	out=$(HOME="$home" PATH="${CASE_PATH:-$sandbox}" SOVA_REPO="file://$seed" SOVA_REF="${CASE_REF:-v0.1.0}" \
		bash "$installer" "$@" 2>&1)
	status=$?
	set -e
}

fresh_home() {           # a home with a ~/.pi to guard, and no install in it
	home="$tmp/$1/fake home"
	mkdir -p "$home/.pi/agent"
	printf '{"marker":"do not touch"}\n' > "$home/.pi/agent/settings.json"
	pi_before=$(cd "$home/.pi" && find . -type f -exec cat {} + | sort)
}

pi_untouched() {
	local after
	after=$(cd "$home/.pi" && find . -type f -exec cat {} + | sort)
	[ "$after" = "$pi_before" ]
}

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
	bash "$installer" 2>&1)
status=$?
set -e
check "$([ "$status" -ne 0 ] && echo true || echo false)" "failed build: exits nonzero"
check "$([ -f "$good_home/.local/share/sova/NOTES.txt" ] && echo true || echo false)" \
	"failed build: the previous install is untouched"
check "$([ "$before_launcher" = "$(cat "$good_home/.local/bin/sova")" ] && echo true || echo false)" \
	"failed build: the launcher is untouched"
check "$([ -z "$(ls -d "$good_home/.local/share/sova.sova-previous."* 2>/dev/null)" ] && echo true || echo false)" \
	"failed build: left no backup directory behind"

# 5. Re-running on our own clean clone updates it and keeps working.
home=$good_home
set +e
out=$(HOME="$home" PATH="$sandbox" SOVA_REPO="file://$seed" SOVA_REF=v0.1.0 bash "$installer" 2>&1)
status=$?
set -e
check "$([ "$status" -eq 0 ] && echo true || echo false)" "rerun: exits 0"
check "$([ -f "$home/.local/share/sova/dist/index.html" ] && echo true || echo false)" "rerun: the build is in place"
check "$([ -x "$home/.local/bin/sova" ] && echo true || echo false)" "rerun: the launcher is in place"
check "$([ -z "$(ls -d "$home/.local/share/sova.sova-previous."* 2>/dev/null)" ] && echo true || echo false)" \
	"rerun: removed the previous install after promoting"

# 6. An install directory that is not our clone is refused, with its contents left alone.
fresh_home foreign-dir
mkdir -p "$home/.local/share/sova"
printf 'someone else lives here\n' > "$home/.local/share/sova/IMPORTANT.txt"
set +e
out=$(HOME="$home" PATH="$sandbox" SOVA_REPO="file://$seed" SOVA_REF=v0.1.0 bash "$installer" 2>&1)
status=$?
set -e
check "$([ "$status" -ne 0 ] && echo true || echo false)" "foreign dir: exits nonzero"
check "$(printf '%s' "$out" | grep -q 'not a git clone' && echo true || echo false)" "foreign dir: says why"
check "$([ "$(cat "$home/.local/share/sova/IMPORTANT.txt")" = 'someone else lives here' ] && echo true || echo false)" \
	"foreign dir: the file is untouched"

# 7. A clone with uncommitted changes is refused.
run_install dirty-clone
git -C "$home/.local/share/sova" -c user.email=t@t -c user.name=t commit --quiet --allow-empty -m x
printf 'export const server = 1;\n' > "$home/.local/share/sova/server/index.ts"
set +e
out=$(HOME="$home" PATH="$sandbox" SOVA_REPO="file://$seed" SOVA_REF=v0.1.0 bash "$installer" 2>&1)
status=$?
set -e
check "$([ "$status" -ne 0 ] && echo true || echo false)" "dirty clone: exits nonzero"
check "$(printf '%s' "$out" | grep -q 'uncommitted changes' && echo true || echo false)" "dirty clone: says why"
check "$([ "$(cat "$home/.local/share/sova/server/index.ts")" = 'export const server = 1;' ] && echo true || echo false)" \
	"dirty clone: the edit survives"

# 8. A launcher we did not write is refused, and survives.
fresh_home foreign-launcher
mkdir -p "$home/.local/bin"
printf '#!/bin/sh\necho someone elses sova\n' > "$home/.local/bin/sova"
chmod 755 "$home/.local/bin/sova"
set +e
out=$(HOME="$home" PATH="$sandbox" SOVA_REPO="file://$seed" SOVA_REF=v0.1.0 bash "$installer" 2>&1)
status=$?
set -e
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

printf '\n%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
