#!/usr/bin/env node
// The merge round's private names (PLAYBOOK.md, step 0): collects what this machine knows that must
// never reach the public repo, and merges it into `<state root>/merge-round.json`, the list
// leak-scan.mjs checks every push against. Node builtins only.
//
//   node scripts/discover-names.mjs [--dry-run] [--show] [--repo <dir>]
//                           [--add-kind <kind> --add <value>]... [--add-file <file>]
//
// Sources, each a kind: this host's name and home path; `tailscale status --json` (skipped silently
// when it can't run); host.json, peers.json and mesh-extensions.json under the state root; the
// device names in claude-accounts.json; login emails and git's user.email (and the domain, unless a
// public mail provider's); orgs.json; the values in the repo's scripts/mesh-vps/local.env. Dropped:
// the owner in origin's GitHub URL, anything under 4 characters, generic words and path prefixes, and
// a discovered term already in more than 10 of origin/master's tracked files (too common to block on).
//
// Additive: a name is never removed. `--add` names are the user's own (kind `user` unless
// `--add-kind` precedes them); `--add-file` takes one `<kind>: <value>` or bare value per line.
// Prints kinds and counts only, and which names origin/master already has (masked). Only `--show`
// prints the values, for the captain to show the user in the local chat.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const dryRun = flag("--dry-run");
const show = flag("--show");

function agentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (!env) return join(homedir(), ".pi", "agent");
  return env === "~" ? homedir() : env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
}
const agent = agentDir();
const stateRoot = join(agent, "sova");
const settingsFile = join(stateRoot, "merge-round.json");

function run(cmd, argv, cwd) {
  try {
    return execFileSync(cmd, argv, { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
const repo = run("git", ["rev-parse", "--show-toplevel"], opt("--repo", process.cwd())) ?? opt("--repo", process.cwd());

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

// --- What is public or generic, never a private name --------------------------------------------

const originUrl = run("git", ["remote", "get-url", "origin"], repo) ?? "";
const gh = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(originUrl);
const PUBLIC = new Set(gh ? [gh[1].toLowerCase(), gh[2].toLowerCase(), `${gh[1]}/${gh[2]}`.toLowerCase()] : []);
const GENERIC = new Set(
  (
    "localhost home root user users admin default local master main origin github github.com example example.com example.org " +
    "laptop desktop server servers host peer peers device devices self none null true false undefined sova claude pi-agent " +
    "tailscale tailscaled ts.net caddy vhost funnel cloudflared linux darwin windows ubuntu debian arch"
  ).split(" "),
);
const GENERIC_PATHS = new Set(["/", "/home", "/users", "/root", "/tmp", "/var", "/opt", "/srv", "/mnt", "/media"]);
const PUBLIC_MAIL = new Set(
  "gmail.com googlemail.com outlook.com hotmail.com live.com msn.com yahoo.com ymail.com icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.de gmx.net mail.com fastmail.com hey.com zoho.com yandex.com users.noreply.github.com example.com example.org".split(" "),
);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]+:[0-9a-f:]*$/i;
const NOT_PRIVATE_IP = /^(?:127\.|0\.0\.0\.0$|255\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|::1$|::$)/;

/** Why a discovered value is not a private name, or null when it is one. */
function dropped(value) {
  const v = value.toLowerCase();
  if (v.length < 4) return "short";
  if (PUBLIC.has(v)) return "public";
  if (GENERIC.has(v) || GENERIC_PATHS.has(v.replace(/\/+$/, ""))) return "generic";
  if (/^\d+$/.test(v)) return "generic";
  if ((IPV4.test(v) || IPV6.test(v)) && NOT_PRIVATE_IP.test(v)) return "generic";
  return null;
}

// --- Collecting candidates ----------------------------------------------------------------------

/** Discovered candidates in order: {kind, value}. */
const found = [];
const droppedCount = { short: 0, public: 0, generic: 0, common: 0 };
function add(kind, raw) {
  const value = str(raw);
  if (!value) return;
  const why = dropped(value);
  if (why) droppedCount[why]++;
  else found.push({ kind, value });
}
/** An address: an IP is kind `ip`; a URL or user@host is split into its parts. */
function addAddress(kind, raw, { firstLabel = false } = {}) {
  let value = str(raw);
  if (!value) return;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      value = new URL(value).hostname.replace(/^\[|\]$/g, "");
    } catch {
      return add(kind, value);
    }
  }
  const at = value.lastIndexOf("@");
  if (at > 0) {
    if (value.slice(at + 1).includes(".") && !IPV4.test(value.slice(at + 1))) return addEmail(value);
    add(kind, value.slice(0, at));
    value = value.slice(at + 1);
  }
  value = value.replace(/\.$/, "");
  if (IPV4.test(value) || IPV6.test(value)) return add("ip", value);
  add(kind, value);
  if (firstLabel && value.includes(".")) add(kind, value.split(".")[0]);
}
function addEmail(raw) {
  const value = str(raw);
  if (!value || !value.includes("@")) return;
  add("email", value);
  const domain = value.slice(value.lastIndexOf("@") + 1).toLowerCase();
  if (domain && !PUBLIC_MAIL.has(domain)) add("email-domain", domain);
}

// This host.
add("hostname", hostname());
const home = homedir();
add("home", home);
add("home", basename(home));

// Tailscale: skipped silently when absent, logged out or sandboxed.
const ts = (() => {
  const out = run("tailscale", ["status", "--json"]);
  try {
    return out ? JSON.parse(out) : null;
  } catch {
    return null;
  }
})();
if (isObj(ts)) {
  const nodes = [ts.Self, ...(isObj(ts.Peer) ? Object.values(ts.Peer) : [])].filter(isObj);
  for (const n of nodes) {
    addAddress("tailscale-host", n.HostName);
    addAddress("tailscale-host", n.DNSName, { firstLabel: true });
    for (const ip of Array.isArray(n.TailscaleIPs) ? n.TailscaleIPs : []) add("ip", ip);
  }
  for (const suffix of [ts.MagicDNSSuffix, ts.CurrentTailnet?.MagicDNSSuffix]) {
    const s = str(suffix)?.replace(/\.$/, "");
    if (!s) continue;
    add("tailnet", s);
    if (s.endsWith(".ts.net")) add("tailnet", s.slice(0, -".ts.net".length));
  }
  const name = str(ts.CurrentTailnet?.Name);
  if (name) name.includes("@") ? addEmail(name) : add("tailnet", name);
}

// Sova's own state.
const host = readJson(join(stateRoot, "host.json"));
if (isObj(host)) for (const key of ["id", "name", "hostname", "hostName", "label"]) add("host-id", host[key]);

const peers = readJson(join(stateRoot, "peers.json"));
if (isObj(peers)) {
  for (const p of [peers.self, ...(Array.isArray(peers.peers) ? peers.peers : [])].filter(isObj)) {
    add("peer", p.id);
    add("peer", p.label);
    add("peer", p.nodeId);
    addAddress("peer", p.dnsName, { firstLabel: true });
    addAddress("peer", p.url);
    addAddress("peer", p.serveUrl);
  }
}

const mesh = readJson(join(stateRoot, "mesh-extensions.json"));
if (isObj(mesh) && isObj(mesh.peers)) {
  for (const [hostId, list] of Object.entries(mesh.peers)) {
    add("mesh-extension", hostId);
    for (const e of Array.isArray(list?.entries) ? list.entries.filter(isObj) : []) {
      add("mesh-extension", e.id);
      add("mesh-extension", e.title);
    }
  }
}

const accounts = readJson(join(agent, "claude-accounts.json"));
if (isObj(accounts)) {
  if (isObj(accounts.devices)) for (const d of Object.keys(accounts.devices)) add("device", d);
  for (const l of Array.isArray(accounts.logins) ? accounts.logins.filter(isObj) : []) {
    add("device", l.device);
    addEmail(l.identity?.email);
  }
}
// Each login's own Claude Code file, and Claude Code's own login.
const loginDirs = [process.env.CLAUDE_CONFIG_DIR, home];
try {
  for (const d of readdirSync(join(agent, "claude-accounts"))) loginDirs.push(join(agent, "claude-accounts", d));
} catch {
  // no added logins
}
for (const dir of loginDirs.filter(Boolean)) addEmail(readJson(join(dir, ".claude.json"))?.oauthAccount?.emailAddress);
addEmail(run("git", ["config", "user.email"], repo));

const orgs = readJson(join(stateRoot, "orgs.json"));
if (isObj(orgs)) {
  add("org", orgs.operator?.name);
  for (const o of Array.isArray(orgs.orgs) ? orgs.orgs.filter(isObj) : []) {
    add("org", o.id);
    add("org", o.name);
  }
}

// The mesh VPS scripts' site settings: every value that isn't also in the tracked example.
const envValues = (file) => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .map((l) => /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(.*)$/.exec(l)?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2") ?? "")
      .flatMap((v) => v.split(/\s+/))
      .filter(Boolean);
  } catch {
    return [];
  }
};
const envExample = new Set(envValues(join(repo, "scripts", "mesh-vps", "local.env.example")).map((v) => v.toLowerCase()));
for (const v of envValues(join(repo, "scripts", "mesh-vps", "local.env"))) if (!envExample.has(v.toLowerCase())) addAddress("local-env", v);

// The user's own names: never filtered, only warned about when short.
const userNames = [];
const kindOf = (k) => k.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "user";
let userKind = "user";
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--add-kind" && args[i + 1]) userKind = kindOf(args[++i]);
  else if (args[i] === "--add" && args[i + 1]) userNames.push({ kind: userKind, value: args[++i].trim() });
}
const addFile = opt("--add-file", null);
if (addFile) {
  let text;
  try {
    text = readFileSync(addFile, "utf8");
  } catch {
    console.error("discover-names: can't read the --add-file. Nothing written.");
    process.exit(2);
  }
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (!l || l.startsWith("#")) continue;
    const m = /^([A-Za-z][A-Za-z0-9 _-]*):\s+(.+)$/.exec(l);
    userNames.push(m ? { kind: kindOf(m[1]), value: m[2].trim() } : { kind: "user", value: l });
  }
}

// --- Merging into the settings file -------------------------------------------------------------

let raw = null;
try {
  raw = readFileSync(settingsFile, "utf8");
} catch {
  // none yet: made below
}
let current = {};
if (raw !== null) {
  try {
    current = JSON.parse(raw);
  } catch {
    console.error("discover-names: <state root>/merge-round.json isn't valid JSON. Nothing written; fix or move it first.");
    process.exit(2);
  }
  if (!isObj(current)) {
    console.error("discover-names: <state root>/merge-round.json isn't a JSON object. Nothing written.");
    process.exit(2);
  }
}
const names = Array.isArray(current.privateNames) ? current.privateNames.filter((x) => typeof x === "string" && x.trim()) : [];
const kinds = isObj(current.kinds) ? { ...current.kinds } : {};
const known = new Set(names.map((n) => n.trim().toLowerCase()));
// Which tracked files on origin/master hold a term: public already, or too common to block on.
const COMMON_FILES = 10;
const originChecked = Boolean(run("git", ["rev-parse", "--verify", "-q", "origin/master^{commit}"], repo));
const publicCache = new Map();
/** [{path, lines}] of origin/master's tracked files holding the term (case-insensitive), [] when unchecked. */
function publicFiles(term) {
  const key = term.toLowerCase();
  if (!originChecked) return [];
  if (!publicCache.has(key)) {
    const out = run("git", ["grep", "-I", "-i", "-F", "-c", "-e", term, "origin/master", "--"], repo) ?? "";
    publicCache.set(
      key,
      out
        .split("\n")
        .map((l) => /^origin\/master:(.*):(\d+)$/.exec(l))
        .filter(Boolean)
        .map((m) => ({ path: m[1], lines: Number(m[2]) })),
    );
  }
  return publicCache.get(key);
}
const common = (term) => publicFiles(term).length > COMMON_FILES;

/** Per kind: how many names found this run, how many of them new. */
const tally = {};
/** The user's own names that are too common: kept, and warned about by index. */
const commonUser = new Set();
for (const { kind, value, user } of [...found, ...userNames.map((u) => ({ ...u, user: true }))]) {
  if (!value) continue;
  const t = (tally[kind] ??= { found: 0, added: 0 });
  const key = value.toLowerCase();
  if (t.seen?.has(key)) continue;
  (t.seen ??= new Set()).add(key);
  if (!user && !known.has(key) && common(value)) {
    droppedCount.common++;
    continue;
  }
  t.found++;
  if (user && common(value)) commonUser.add(key);
  if (known.has(key)) continue;
  known.add(key);
  names.push(value);
  kinds[value] = kind;
  t.added++;
}
for (const n of names) kinds[n] ??= "listed";
for (const k of Object.keys(kinds)) if (!names.includes(k)) delete kinds[k];
const sources = {};
for (const n of names) sources[kinds[n]] = (sources[kinds[n]] ?? 0) + 1;
const restartSet = !str(current.restartUnit);
// privateNames first, so leak-scan's "line N of merge-round.json" points into the list.
const { v: _v, privateNames: _p, restartUnit: _r, kinds: _k, sources: _s, ...rest } = current;
const next = {
  v: 1,
  privateNames: names,
  restartUnit: str(current.restartUnit) ?? "sova-runtime.service",
  kinds,
  sources,
  ...rest,
};
const added = Object.values(tally).reduce((a, t) => a + t.added, 0);
const changed = raw === null || added > 0 || restartSet || JSON.stringify(next) !== JSON.stringify(current);
if (!dryRun && changed) {
  mkdirSync(stateRoot, { recursive: true });
  const tmp = `${settingsFile}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, settingsFile);
}
if (!dryRun && existsSync(settingsFile)) chmodSync(settingsFile, 0o600);

// --- Which names origin already has in public ---------------------------------------------------

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const label = (i) => `${kinds[names[i]]} #${i + 1}`;
/** A path as printed: every name in it masked. */
const masked = (path) => names.reduce((p, n, i) => p.replace(new RegExp(escape(n), "gi"), `[${label(i)}]`), path);
const publicHits = [];
/** Names in the list that origin already has in more than COMMON_FILES files: never removed, warned about. */
const commonHeld = [];
for (const [i, n] of names.entries()) {
  const files = publicFiles(n);
  if (!files.length) continue;
  if (files.length > COMMON_FILES) {
    commonHeld.push({ i, files: files.length, user: commonUser.has(n.toLowerCase()) });
    continue;
  }
  const shown = files.slice(0, 5).map((f) => `${masked(f.path)} (${f.lines} line${f.lines === 1 ? "" : "s"})`);
  if (files.length > 5) shown.push(`+${files.length - 5} more`);
  publicHits.push({ i, files: shown });
}

// --- The report: kinds and counts, never a value ------------------------------------------------

const out = [];
const total = Object.values(tally).reduce((a, t) => a + t.found, 0);
out.push(
  `discover-names: ${total} candidate${total === 1 ? "" : "s"} found, ${added} new; the list holds ${names.length}.${dryRun ? " Dry run: nothing written." : changed ? " Written to <state root>/merge-round.json (0600)." : " Nothing to write."}`,
);
for (const [kind, t] of Object.entries(tally).sort()) out.push(`- ${kind}: ${t.found} found, ${t.added} new`);
if (!ts) out.push("- tailscale: not available here, skipped");
const drops = Object.entries(droppedCount).filter(([, n]) => n);
if (drops.length) out.push(`Dropped: ${drops.map(([why, n]) => `${n} ${why}`).join(", ")}.`);
const short = userNames.filter((u) => u.value.length < 4).length;
if (short) out.push(`${short} of your names ${short === 1 ? "is" : "are"} under 4 characters and will match inside other words.`);
out.push(`By kind in the list: ${Object.entries(sources).sort().map(([k, n]) => `${k} ${n}`).join(", ") || "none"}.`);
if (restartSet) out.push(`restartUnit ${dryRun ? "would be" : "set to"} sova-runtime.service.`);
if (!originChecked) out.push("origin/master not found here: the public check was skipped.");
else if (!publicHits.length && !commonHeld.length) out.push("None of them is in origin/master's tracked files.");
else if (publicHits.length) {
  out.push(`Already public on origin/master: ${publicHits.length} name${publicHits.length === 1 ? "" : "s"} (the user decides what to do):`);
  for (const h of publicHits) out.push(`- ${label(h.i)}: ${h.files.join(", ")}`);
}
if (commonHeld.length) {
  out.push(`Too common to block on (in more than ${COMMON_FILES} tracked files on origin/master), kept but leak-scan will hit it on most pushes; ask the user whether to remove it by hand:`);
  for (const h of commonHeld) out.push(`- ${label(h.i)}${h.user ? " (yours)" : ""}: ${h.files} files`);
}
if (show) {
  out.push("", "The list (local chat only, never a commit):");
  const byKind = {};
  for (const n of names) (byKind[kinds[n]] ??= []).push(n);
  for (const [kind, list] of Object.entries(byKind).sort()) out.push(`- ${kind}: ${list.join(", ")}`);
}
console.log(out.join("\n"));
