#!/usr/bin/env node
// hermetic-agent-dir: build <worktree>/.agent, a throwaway pi agent dir for testing this branch.
//
// It is `pi-config/install.sh` pointed at the worktree instead of ~/.pi/agent: every extension in
// THIS worktree's pi-config/extensions is symlinked into .agent/extensions, so a server started with
// PI_CODING_AGENT_DIR=<worktree>/.agent loads the branch's extensions (claude-code included) and
// nothing of the user's real setup. Sessions, Sova state and settings all land inside .agent, so
// testing never touches ~/.pi.
//
//   node scripts/hermetic-agent-dir.mjs           # create or repair (idempotent)
//   node scripts/hermetic-agent-dir.mjs --check   # verify only; nonzero if anything is off
//   node scripts/hermetic-agent-dir.mjs --unlock-url   # also mint .agent's access token if it has
//                                                  # none, and print the URL that unlocks the page
//   node scripts/hermetic-agent-dir.mjs --copied-sessions   # the dir is about to receive copies of
//                                                  # real sessions: set it up for them (below)
//
// `pnpm run dev:hermetic` passes --unlock-url, so its first visit needs no hunting for the token.
// Without the flag the token is never printed (a deploy that builds its agent dir with this script
// keeps it out of its logs).
//
// Copied sessions: a real session copied in still holds its wake nudges, and a hermetic server
// hosting it would fire the overdue ones at once, with whatever auth the dir has. So whenever the
// dir holds (or, with --copied-sessions, will receive) copies of real sessions, the wake-nudge
// extension is left out and the scheduler's state (sova/schedules.json, sova/schedule-runs.jsonl)
// is blanked. A session counts as copied when a file of the same name is in ~/.pi/agent/sessions
// (its names are read, nothing there is touched). The mode is sticky: copied-sessions.json records
// it, so a re-run never links wake-nudge back; schedules are blanked again only when new copies
// arrive, --copied-sessions is passed, or the store holds a schedule approved in the real one
// (~/.pi/agent/sova/schedules.json, read only), so schedules made in the hermetic server itself
// survive a restart of dev:hermetic. A copied auth.json stays the user's choice.
//
// No link ever points into ~/.pi: the agent dir is self-contained. settings.json is derived from
// pi-config/settings.json minus the machine-specific bits (external `packages`, changelog marker),
// so no npm/git package is fetched into the throwaway dir.

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PI_CONFIG = join(ROOT, "pi-config");
// HERMETIC_AGENT_DIR builds another directory the same way (scripts/perf/load-experiment.mjs --agent-dir).
const AGENT = process.env.HERMETIC_AGENT_DIR ? resolve(process.env.HERMETIC_AGENT_DIR) : join(ROOT, ".agent");
const HOME_PI = join(homedir(), ".pi");

/** Keys of pi-config/settings.json that are about this machine or the user's installed packages. */
const MACHINE_SPECIFIC = new Set(["packages", "lastChangelogVersion"]);

const args = process.argv.slice(2);
const check = args.includes("--check");
const unlockUrl = args.includes("--unlock-url");
const copiedFlag = args.includes("--copied-sessions");
if (args.some((a) => !["--check", "--unlock-url", "--copied-sessions"].includes(a)) || (check && unlockUrl)) {
  console.error(`usage: ${process.argv[1]} [--check | --unlock-url] [--copied-sessions]`);
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

// --- copied sessions (see the header) ---------------------------------------------------------

/** Every session file's name under `root`, the live registry left out; empty if unreadable. */
function sessionNames(root) {
  try {
    return readdirSync(root, { recursive: true })
      .map(String)
      .filter((rel) => rel.endsWith(".jsonl") && !rel.split("/").includes("live"))
      .map((rel) => basename(rel));
  } catch {
    return [];
  }
}

const WAKE_NUDGE = "wake-nudge.ts";
const copiedMarker = join(AGENT, "copied-sessions.json");
let marked = null;
try {
  const raw = JSON.parse(readFileSync(copiedMarker, "utf8"));
  marked = new Set(Array.isArray(raw?.sessions) ? raw.sessions.filter((n) => typeof n === "string") : []);
} catch {}
const real = new Set(sessionNames(join(HOME_PI, "agent", "sessions")));
const copied = sessionNames(join(AGENT, "sessions")).filter((n) => real.has(n)).sort();
const copiedMode = copiedFlag || marked !== null || copied.length > 0;
const newCopies = copied.filter((n) => !marked?.has(n));
const BLANK_STORE = `${JSON.stringify({ version: 1, seq: 0, schedules: [], logins: {} }, null, 2)}\n`;
const scheduleFiles = [join(AGENT, "sova", "schedules.json"), join(AGENT, "sova", "schedule-runs.jsonl")];
/** A store's approved schedules, by root and approval: the same approval is the same schedule. */
function approvals(file) {
  try {
    const store = JSON.parse(readFileSync(file, "utf8"));
    return (Array.isArray(store?.schedules) ? store.schedules : []).filter((x) => x?.approved).map((x) => `${x.root}\0${x.approved.at}\0${x.approved.pin}`);
  } catch {
    return [];
  }
}
const realApprovals = new Set(approvals(join(HOME_PI, "agent", "sova", "schedules.json")));
const copiedSchedules = approvals(scheduleFiles[0]).some((k) => realApprovals.has(k));
// Blank the scheduler's state when the mode starts, new copies arrived, more are announced, or
// it holds a schedule of the real store's.
const blankSchedules = copiedMode && (copiedFlag || marked === null || newCopies.length > 0 || copiedSchedules);
if (copiedMode) {
  if (check) {
    if (marked === null) problem(`copied sessions, not set up for them (rerun without --check): ${copiedMarker}`);
    else if (newCopies.length > 0) problem(`new copied sessions since the last setup (rerun without --check): ${newCopies.join(", ")}`);
    else if (copiedSchedules) problem(`holds the real scheduler's schedules (rerun without --check): ${scheduleFiles[0]}`);
  } else {
    writeFileSync(copiedMarker, `${JSON.stringify({ v: 1, sessions: [...new Set([...(marked ?? []), ...copied])].sort() }, null, 2)}\n`);
    if (blankSchedules) {
      const [store, runs] = scheduleFiles;
      if (existsSync(store) && readFileSync(store, "utf8") !== BLANK_STORE) {
        assertOutsideHomePi(store);
        writeFileSync(store, BLANK_STORE);
        console.log(`${store}: blanked (copied sessions)`);
      }
      if (existsSync(runs)) {
        assertOutsideHomePi(runs);
        rmSync(runs, { force: true });
        console.log(`${runs}: removed (copied sessions)`);
      }
    }
  }
}

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
  if (copiedMode && entry.name === WAKE_NUDGE) continue; // never fire a copied session's nudges
  wanted.add(entry.name);
  link(path, join(AGENT, "extensions", entry.name));
}

// Tool directories pi never loads but a prompt runs from the agent dir: spec-mode.md resolves its
// trusted tools to <agent dir>/extensions/spec/core. Unlinked, a hermetic session falls back to
// ~/.pi's copy of the tools, which may be another branch's. install.sh links them like any directory.
for (const name of ["spec"]) {
  const path = join(extRoot, name);
  if (!existsSync(path)) continue;
  wanted.add(name);
  link(path, join(AGENT, "extensions", name));
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

// The sandbox policy, as install.sh does it: a real directory, each file COPIED from the template
// when absent and never overwritten (the user's edits are theirs; --check only reports drift).
// Here it sits inside the worktree, i.e. inside a sandboxed session's writable workspace: the
// hard case the sandbox must still protect.
const policySrc = join(PI_CONFIG, "sandbox-policy");
const policyDst = join(AGENT, "sandbox-policy");
if (existsSync(policySrc)) {
  if (isLink(policyDst)) {
    if (check) problem(`is a symlink, want a real directory: ${policyDst}`);
    else rmSync(policyDst);
  }
  for (const platform of readdirSync(policySrc).sort()) {
    const srcDir = join(policySrc, platform);
    if (!lstatSync(srcDir).isDirectory()) continue;
    for (const name of readdirSync(srcDir).sort()) {
      const src = join(srcDir, name);
      const dst = join(policyDst, platform, name);
      assertOutsideHomePi(dst);
      if (check) {
        if (isLink(dst)) problem(`is a symlink, want a copy: ${dst}`);
        else if (!existsSync(dst)) problem(`missing: ${dst}`);
        else if (readFileSync(dst, "utf8") !== readFileSync(src, "utf8")) console.log(`differs from the template (kept): ${dst}`);
        continue;
      }
      if (isLink(dst)) rmSync(dst);
      if (existsSync(dst)) continue;
      mkdirSync(join(policyDst, platform), { recursive: true });
      copyFileSync(src, dst);
      console.log(`${dst} <- copied from ${src}`);
    }
  }
}

// Project trust for this worktree, so a runtime on this agent dir (the test server, or a worker run
// with useWorktreeConfig) loads the tree's .pi/settings.json and skills without a trust dialog it
// cannot show. Only this tree is added; a decision already there (true or false) is kept.
const trustPath = join(AGENT, "trust.json");
const trustKey = realpathSync(ROOT);
let trust = {};
try {
  trust = JSON.parse(readFileSync(trustPath, "utf8"));
} catch {}
if (typeof trust !== "object" || trust === null || Array.isArray(trust)) trust = {};
if (check) {
  if (trust[trustKey] === undefined) problem(`not trusted in ${trustPath}: ${trustKey}`);
} else if (trust[trustKey] === undefined) {
  trust[trustKey] = true;
  const sorted = Object.fromEntries(Object.keys(trust).sort().map((k) => [k, trust[k]]));
  writeFileSync(trustPath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`${trustPath}: trusted ${trustKey}`);
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
if (copiedMode) console.log(`copied sessions (${copied.length} found): ${WAKE_NUDGE} left out, schedules blanked when copies arrive (${copiedMarker})`);
console.log(`use it with:  PORT=${process.env.SOVA_PORT || 4810} PI_CODING_AGENT_DIR=${AGENT} pnpm run dev:server`);

/** .agent's access token, as the server keeps it (server/auth.ts): 32 random bytes in base64url at
    sova/auth-token, mode 0600, created exclusively so a server minting at the same moment wins or
    loses cleanly, and never rewritten. SOVA_TOKEN, when set, is the one the server will use. */
function hermeticToken() {
  if (process.env.SOVA_TOKEN?.trim()) return process.env.SOVA_TOKEN.trim();
  const file = join(AGENT, "sova", "auth-token");
  if (!existsSync(file)) {
    mkdirSync(join(AGENT, "sova"), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
    try {
      linkSync(tmp, file);
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    } finally {
      rmSync(tmp, { force: true });
    }
  }
  return readFileSync(file, "utf8").trim();
}

if (unlockUrl) console.log(`open (unlocked):  http://127.0.0.1:${process.env.SOVA_PORT || 4810}/#t=${hermeticToken()}`);
