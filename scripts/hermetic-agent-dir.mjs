#!/usr/bin/env node
// hermetic-agent-dir: build <worktree>/.agent, a throwaway pi agent dir for testing this branch.
//
// It is `pi-config/install.sh` pointed at the worktree instead of ~/.pi/agent: every extension in
// THIS worktree's pi-config/extensions is symlinked into .agent/extensions, so a server started with
// PI_CODING_AGENT_DIR=<worktree>/.agent loads the branch's extensions (claude-code included) and
// nothing of the user's real setup. Sessions, pi-web state and settings all land inside .agent, so
// testing never touches ~/.pi.
//
//   node scripts/hermetic-agent-dir.mjs           # create or repair (idempotent)
//   node scripts/hermetic-agent-dir.mjs --check   # verify only; nonzero if anything is off
//
// No link ever points into ~/.pi: the agent dir is self-contained. settings.json is derived from
// pi-config/settings.json minus the machine-specific bits (external `packages`, changelog marker),
// so no npm/git package is fetched into the throwaway dir.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PI_CONFIG = join(ROOT, "pi-config");
const AGENT = join(ROOT, ".agent");
const HOME_PI = join(homedir(), ".pi");

/** Keys of pi-config/settings.json that are about this machine or the user's installed packages. */
const MACHINE_SPECIFIC = new Set(["packages", "lastChangelogVersion"]);

const check = process.argv[2] === "--check";
if (process.argv[2] !== undefined && !check) {
  console.error(`usage: ${process.argv[1]} [--check]`);
  process.exit(2);
}

let bad = 0;
const problem = (msg) => {
  console.log(msg);
  bad = 1;
};

/** Guard: nothing this script creates may live in, or point into, the user's real pi dir. */
function assertOutsideHomePi(path) {
  const p = resolve(path);
  if (p === HOME_PI || p.startsWith(HOME_PI + "/")) throw new Error(`refusing to touch ${p} (inside ~/.pi)`);
}

function link(src, dst) {
  assertOutsideHomePi(src);
  assertOutsideHomePi(dst);
  if (check) {
    let current = null;
    try {
      current = readlinkSync(dst);
    } catch {}
    if (current !== src) problem(`not linked: ${dst} (want -> ${src})`);
    return;
  }
  if (existsSync(dst) || isLink(dst)) rmSync(dst, { recursive: true, force: true });
  symlinkSync(src, dst);
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function dir(path) {
  assertOutsideHomePi(path);
  if (check) {
    if (!existsSync(path)) problem(`missing directory: ${path}`);
    return;
  }
  mkdirSync(path, { recursive: true });
}

/** pi-config/settings.json with the machine-specific keys dropped; `{}` if there is no source. */
function hermeticSettings() {
  let source = {};
  const path = join(PI_CONFIG, "settings.json");
  if (existsSync(path)) source = JSON.parse(readFileSync(path, "utf8"));
  const out = {};
  for (const [k, v] of Object.entries(source)) if (!MACHINE_SPECIFIC.has(k)) out[k] = v;
  return JSON.stringify(out, null, 2) + "\n";
}

dir(AGENT);
dir(join(AGENT, "extensions"));
dir(join(AGENT, "sessions"));

// Every extension of THIS worktree: loose *.ts files, and directories that actually hold one.
// pi's own rule (dist/core/extensions/loader.js, resolveExtensionEntries): a directory is an
// extension only if it has package.json with a "pi.extensions" manifest, an index.ts, or an
// index.js — anything else it skips. install.sh links every directory regardless; here we apply
// pi's rule so .agent/extensions lists exactly what the runtime will load, and a docs-only
// directory (claude-cli) or a loose file inside a directory (btw/btw.ts) does not masquerade as
// an installed extension.
const extRoot = join(PI_CONFIG, "extensions");

/** pi's resolveExtensionEntries, reduced to the yes/no this script needs. */
function isExtensionDir(dir) {
  const manifest = join(dir, "package.json");
  if (existsSync(manifest)) {
    try {
      const pi = JSON.parse(readFileSync(manifest, "utf8")).pi;
      if (Array.isArray(pi?.extensions) && pi.extensions.some((e) => existsSync(resolve(dir, e)))) return true;
    } catch {} // an unreadable manifest is not an entry point
  }
  return existsSync(join(dir, "index.ts")) || existsSync(join(dir, "index.js"));
}

const wanted = new Set();
for (const entry of readdirSync(extRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  const path = join(extRoot, entry.name);
  const isExtension = entry.isFile() ? entry.name.endsWith(".ts") : entry.isDirectory() && isExtensionDir(path);
  if (!isExtension) continue;
  wanted.add(entry.name);
  link(path, join(AGENT, "extensions", entry.name));
}

// Prune anything a previous run linked that is no longer an extension here, so re-running after
// a rename or a removal leaves no dangling or stale entry behind.
for (const name of readdirSync(join(AGENT, "extensions"))) {
  if (wanted.has(name)) continue;
  const stale = join(AGENT, "extensions", name);
  if (check) problem(`stale, not an extension of ${extRoot}: ${stale}`);
  else { assertOutsideHomePi(stale); rmSync(stale, { recursive: true, force: true }); console.log(`removed stale ${stale}`); }
}

// The model catalogue is part of the config, not of the machine: link it so the hermetic runtime
// resolves the same model ids as the real one. vision-delegate.json likewise (an extension reads it).
for (const name of ["models.json", "vision-delegate.json", "keybindings.json"]) {
  const src = join(PI_CONFIG, name);
  if (existsSync(src)) link(src, join(AGENT, name));
}

const settingsPath = join(AGENT, "settings.json");
const wantedSettings = hermeticSettings();
if (check) {
  if (!existsSync(settingsPath)) problem(`missing: ${settingsPath}`);
  else if (isLink(settingsPath)) problem(`must be a regular file, not a symlink: ${settingsPath}`);
  else if (readFileSync(settingsPath, "utf8") !== wantedSettings) problem(`stale (rerun without --check): ${settingsPath}`);
} else {
  if (isLink(settingsPath)) rmSync(settingsPath);
  writeFileSync(settingsPath, wantedSettings);
}

if (check) {
  // Same sweep install.sh does: no stray entry, and nothing pointing outside the worktree.
  for (const entry of readdirSync(join(AGENT, "extensions"))) {
    const path = join(AGENT, "extensions", entry);
    const target = isLink(path) ? resolve(join(AGENT, "extensions"), readlinkSync(path)) : null;
    if (target === null) problem(`not a symlink into ${extRoot}: ${path}`);
    else if (!target.startsWith(extRoot + "/")) problem(`points outside ${extRoot}: ${path} -> ${target}`);
    else if (!existsSync(target)) problem(`dangling: ${path} -> ${target}`);
  }
  if (bad === 0) console.log(`ok: ${AGENT} is a hermetic agent dir for ${PI_CONFIG}`);
  process.exit(bad);
}

console.log(`${AGENT} ready (extensions -> ${extRoot})`);
console.log(`use it with:  PORT=4810 PI_CODING_AGENT_DIR=${AGENT} npm run dev:server`);
