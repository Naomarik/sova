#!/usr/bin/env bash
# Link this repository into ~/.pi/agent so pi reads its config and extensions
# from here. Existing regular files are moved aside as *.bak; existing symlinks
# are replaced. Run it again after cloning to a new machine.
#
# settings.json is the exception: it is not linked, because pi writes runtime
# state into it (the model last picked in the TUI, lastChangelogVersion, ...)
# and that must never land in this repository. Instead the tracked
# settings.json is a seed, deep-merged over the live $agent/settings.json and
# written there as a regular file: the seed wins for every key it declares,
# every other live key is kept untouched. Arrays (packages) are replaced, not
# concatenated. If the merge changes the live content, the previous content is
# copied to settings.json.bak first. An existing symlink (from older versions
# of this script) is replaced by the merged file; its target is never written.
#
# The sandbox policy (sandbox-policy/<platform>/{policy.json,CLAUDE.md}) is a
# second exception: it is COPIED into $agent/sandbox-policy when absent and
# never overwritten, and --check reports how it differs from the template.
#
# install.sh --check changes nothing: it exits nonzero if any expected link is
# missing or points elsewhere, if any entry in the agent's extensions/
# directory is not a symlink into this repository, or if $agent/settings.json
# is not a regular file holding every seed-declared key with the seed's value.
#
# install.sh --save copies the live values of the keys the seed declares back
# into the seed, so a deliberate change made in the TUI or by `pi install`
# reaches this repository. Keys the seed does not declare stay out of it.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd -P)
agent=${PI_AGENT_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}}
mode=install
case "${1:-}" in
	"") ;;
	--check) mode=check ;;
	--save) mode=save ;;
	*) echo "usage: $0 [--check|--save]" >&2; exit 2 ;;
esac
check=false
[ "$mode" = check ] && check=true
bad=0

# settings MODE: merge the seed into the live file (install), compare them
# (check), or promote live values of seed-declared keys into the seed (save).
settings_js=$(cat <<'EOF'
const fs = require("fs");
const path = require("path");
const { MODE: mode, SEED: seedPath, LIVE: live } = process.env;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]`
	: isObj(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`
	: JSON.stringify(v);
const equal = (a, b) => canon(a) === canon(b);
const show = (v) => v === undefined ? "(missing)" : JSON.stringify(v);
const text = (v) => JSON.stringify(v, null, 2) + "\n";
function readJson(file) {
	const raw = fs.readFileSync(file, "utf8");
	let value;
	try { value = JSON.parse(raw); } catch (e) { throw new Error(`${file} is not valid JSON: ${e.message}`); }
	if (!isObj(value)) throw new Error(`${file} must hold a JSON object`);
	return { raw, value };
}
// Seed over live: seed leaves win, objects merge key by key, arrays replace.
function merge(base, seed) {
	const out = { ...base };
	for (const [k, v] of Object.entries(seed)) {
		out[k] = isObj(v) && isObj(base[k]) ? merge(base[k], v) : structuredClone(v);
	}
	return out;
}
// Seed-declared leaves whose live value differs, as dotted paths.
function drift(seed, cur, prefix = "") {
	const out = [];
	for (const [k, v] of Object.entries(seed)) {
		const p = prefix + k;
		if (isObj(v) && isObj(cur[k])) out.push(...drift(v, cur[k], p + "."));
		else if (!(k in cur) || !equal(v, cur[k])) out.push({ path: p, want: v, have: cur[k] });
	}
	return out;
}
// The seed with each declared leaf replaced by its live value, where present.
function promote(seed, cur) {
	const out = {};
	for (const [k, v] of Object.entries(seed)) {
		out[k] = !(k in cur) ? v : isObj(v) && isObj(cur[k]) ? promote(v, cur[k]) : cur[k];
	}
	return out;
}
function writeAtomic(file, content) {
	// rename() replaces a symlink at `file` itself; its target is never opened.
	const tmp = path.join(path.dirname(file), `.${path.basename(file)}.new.${process.pid}`);
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, file);
}
// pi locks settings.json with proper-lockfile, i.e. mkdir("settings.json.lock");
// take the same lock so a running pi cannot write between our read and rename.
function withLock(file, fn) {
	const lock = `${file}.lock`;
	for (let i = 0; ; i++) {
		try { fs.mkdirSync(lock); break; } catch (e) {
			if (e.code !== "EEXIST" || i >= 100) throw new Error(`cannot lock ${file}: ${e.message}`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
		}
	}
	try { return fn(); } finally { fs.rmdirSync(lock); }
}
const isLink = (file) => { try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; } };

try {
	const seed = readJson(seedPath).value;
	if (mode === "install") {
		withLock(live, () => {
			const wasLink = isLink(live);
			const cur = fs.existsSync(live) ? readJson(live) : undefined;
			const next = text(cur ? merge(cur.value, seed) : seed);
			if (cur && cur.raw !== next) {
				writeAtomic(`${live}.bak`, cur.raw);
				console.log(`copied previous ${live} to ${live}.bak`);
			}
			if (!wasLink && cur && cur.raw === next) return console.log(`${live} already up to date`);
			writeAtomic(live, next);
			console.log(`${live} <- ${cur ? "merged with" : "copied from"} ${seedPath}`);
		});
	} else if (mode === "check") {
		let ok = true;
		if (isLink(live)) { console.log(`is a symlink, want a regular file: ${live}`); ok = false; }
		if (!fs.existsSync(live)) {
			console.log(`missing: ${live}`);
			process.exit(1);
		}
		for (const d of drift(seed, readJson(live).value)) {
			console.log(`differs from seed: ${live} ${d.path}: want ${show(d.want)}, have ${show(d.have)}`);
			ok = false;
		}
		process.exit(ok ? 0 : 1);
	} else if (mode === "save") {
		if (!fs.existsSync(live)) {
			console.error(`no live settings file at ${live}; nothing to save`);
			process.exit(2);
		}
		const cur = readJson(live).value;
		const changed = drift(seed, cur).filter((d) => d.have !== undefined);
		if (changed.length === 0) console.log(`${seedPath} already matches ${live}`);
		else {
			writeAtomic(seedPath, text(promote(seed, cur)));
			for (const d of changed) console.log(`saved ${d.path}: ${show(d.want)} -> ${show(d.have)}`);
		}
	}
} catch (e) {
	console.error(`settings.json: ${e.message}`);
	process.exit(mode === "save" ? 2 : 1);
}
EOF
)
settings() {
	MODE=$1 SEED="$here/settings.json" LIVE="$agent/settings.json" node -e "$settings_js"
}

if [ "$mode" = save ]; then
	settings save
	exit
fi

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
if $check; then
	settings check || bad=1
else
	settings install
fi
for f in keybindings.json models.json vision-delegate.json; do
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
# The sandbox policy is COPIED, never linked: a policy inside this checkout would
# be writable whenever the checkout is a sandboxed session's workspace. A file
# already there is the user's and is never overwritten; --check reports how it
# differs from the template (informational) and fails only on a missing file or
# a symlink.
policy_src="$here/sandbox-policy"
policy_dst="$agent/sandbox-policy"
if [ -d "$policy_src" ]; then
	if $check; then
		if [ -L "$policy_dst" ]; then
			echo "is a symlink, want a real directory: $policy_dst"
			bad=1
		fi
	elif [ -L "$policy_dst" ] || { [ -e "$policy_dst" ] && [ ! -d "$policy_dst" ]; }; then
		mv "$policy_dst" "$policy_dst.bak"
		echo "moved existing $policy_dst to $policy_dst.bak"
	fi
	for src in "$policy_src"/*/*; do
		[ -f "$src" ] || continue
		rel=${src#"$policy_src"/}
		dst="$policy_dst/$rel"
		if $check; then
			if [ -L "$dst" ]; then
				echo "is a symlink, want a copy: $dst"
				bad=1
			elif [ ! -e "$dst" ]; then
				echo "missing: $dst (run install.sh to copy it from $src)"
				bad=1
			elif ! cmp -s "$src" "$dst"; then
				echo "differs from the template (kept, never overwritten): $dst vs $src"
				diff -u "$src" "$dst" | sed -n '3,$p' | sed 's/^/    /' || true
			fi
			continue
		fi
		[ -L "$dst" ] && rm "$dst"
		if [ -e "$dst" ]; then
			cmp -s "$src" "$dst" || echo "kept your $dst (differs from the template; see install.sh --check)"
			continue
		fi
		mkdir -p "$(dirname "$dst")"
		cp "$src" "$dst"
		echo "$dst <- copied from $src"
	done
fi

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
