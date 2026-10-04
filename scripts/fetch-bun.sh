#!/bin/sh
# Install the Bun that mise.toml pins (`bun = "x.y.z"`) into <dir>/bin/bun, from the official
# GitHub release, checked against its sha256 in scripts/bun-release.txt. The installers' shared
# step (scripts/install.sh, scripts/mesh-vps/remote-setup.sh, scripts/mesh-termux/install.sh):
#
#   sh scripts/fetch-bun.sh <dir>     # prints <dir>/bin/bun on stdout, everything else on stderr
#
# A <dir>/bin/bun that already reports the pinned version is kept as it is. The build is picked
# like bun.sh/install picks it: macOS arm64 (also under Rosetta) or x64, Linux x64 or aarch64,
# -musl on a musl libc, -android in Termux, -baseline on an x64 CPU without AVX2.
# SOVA_BUN_TARGET (e.g. linux-x64-baseline) names the build instead. Needs curl, and unzip or
# python3. POSIX sh and BSD tools: it runs on macOS, Linux and Termux alike.
set -eu

die() { printf 'fetch-bun: %s\n' "$1" >&2; exit 1; }
say() { printf 'fetch-bun: %s\n' "$1" >&2; }

[ $# -eq 1 ] && [ -n "$1" ] || die "usage: sh scripts/fetch-bun.sh <dir>"
dest=$1
here=$(cd "$(dirname "$0")" && pwd)

version=$(sed -n 's/^[[:space:]]*bun[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$here/../mise.toml" | head -n 1)
[ -n "$version" ] || die "no bun version pinned in $here/../mise.toml"

target=${SOVA_BUN_TARGET:-}
if [ -z "$target" ]; then
	os=$(uname -s)
	arch=$(uname -m)
	case "$os" in
		Darwin)
			case "$arch" in
				arm64) target=darwin-aarch64 ;;
				x86_64)
					if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
						target=darwin-aarch64          # an x64 shell under Rosetta on Apple silicon
					elif sysctl -a 2>/dev/null | grep machdep.cpu | grep -q AVX2; then
						target=darwin-x64
					else
						target=darwin-x64-baseline
					fi ;;
				*) die "no Bun build for macOS on $arch" ;;
			esac ;;
		Linux)
			case "$arch" in
				x86_64 | amd64) target=linux-x64 ;;
				aarch64 | arm64) target=linux-aarch64 ;;
				*) die "no Bun build for Linux on $arch" ;;
			esac
			if [ "$(uname -o 2>/dev/null || true)" = Android ]; then
				target=$target-android
			elif [ -f /etc/alpine-release ] || ldd --version 2>&1 | grep -q musl; then
				target=$target-musl
			fi
			case "$target" in
				linux-x64*) grep -q avx2 /proc/cpuinfo 2>/dev/null || target=$target-baseline ;;
			esac ;;
		*) die "no Bun build for $os" ;;
	esac
fi

asset=bun-v$version/bun-$target.zip
want=$(awk -v a="$asset" '$2 == a { print $1 }' "$here/bun-release.txt")
[ -n "$want" ] || die "no checksum for $asset in scripts/bun-release.txt (add that release's lines from its SHASUMS256.txt)"

bin=$dest/bin/bun
if [ -x "$bin" ] && [ "$("$bin" --version 2>/dev/null || true)" = "$version" ]; then
	printf '%s\n' "$bin"
	exit 0
fi

command -v curl >/dev/null 2>&1 || die "curl is not installed"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/sova-bun.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

say "downloading $asset"
curl -fsSL --retry 3 -o "$tmp/bun.zip" "https://github.com/oven-sh/bun/releases/download/$asset" ||
	die "could not download https://github.com/oven-sh/bun/releases/download/$asset"
if command -v sha256sum >/dev/null 2>&1; then
	got=$(sha256sum "$tmp/bun.zip")
else
	got=$(shasum -a 256 "$tmp/bun.zip")
fi
got=${got%% *}
[ "$got" = "$want" ] || die "sha256 mismatch for $asset: got $got, want $want"

if command -v unzip >/dev/null 2>&1; then
	unzip -q -o "$tmp/bun.zip" -d "$tmp" || die "could not unzip $asset"
elif command -v python3 >/dev/null 2>&1; then
	python3 -m zipfile -e "$tmp/bun.zip" "$tmp" || die "could not unzip $asset"
else
	die "neither unzip nor python3 is installed, so $asset cannot be unpacked; install unzip"
fi
[ -f "$tmp/bun-$target/bun" ] || die "$asset holds no bun-$target/bun"

mkdir -p "$dest/bin"
chmod 755 "$tmp/bun-$target/bun"
mv "$tmp/bun-$target/bun" "$bin.new.$$"
mv -f "$bin.new.$$" "$bin"
got=$("$bin" --version 2>/dev/null || true)
if [ "$got" != "$version" ]; then
	rm -f "$bin"
	die "the downloaded bun-$target does not run here (bun --version said '${got:-nothing}'); SOVA_BUN_TARGET names another build"
fi
say "bun $version ($target) in $bin"
printf '%s\n' "$bin"
