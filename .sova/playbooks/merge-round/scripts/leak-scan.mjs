#!/usr/bin/env node
// The merge round's check before a push (PLAYBOOK.md; round.mjs push runs it): scans the commits about to be pushed
// (diff lines they add, their messages, the names of files they add) for secrets and for the
// private names in `<state root>/merge-round.json`. Node builtins only.
//
//   node scripts/leak-scan.mjs [--range origin/master..master] [--repo <dir>]
//
// Exit 0: clean. Exit 1: hits, one line each: commit, file and line, and which private name (the
// list's line number) or which secret pattern. The matched text is never printed: a transcript can
// be shared. Exit 2: can't check (no settings file, no private names, or git failed), so push
// nothing: it fails closed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const range = opt("--range", "origin/master..master");
const repo = opt("--repo", process.cwd());

function agentDir() {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (!env) return join(homedir(), ".pi", "agent");
  return env === "~" ? homedir() : env.startsWith("~/") ? join(homedir(), env.slice(2)) : env;
}
const settingsFile = join(agentDir(), "sova", "merge-round.json");

function stop(why) {
  console.error(`leak-scan: ${why} Push nothing and ask the user.`);
  process.exit(2);
}

let raw;
try {
  raw = readFileSync(settingsFile, "utf8");
} catch {
  stop(`${settingsFile} is missing, so the private names can't be checked.`);
}
let settings;
try {
  settings = JSON.parse(raw);
} catch {
  stop(`${settingsFile} isn't valid JSON.`);
}
const names = Array.isArray(settings?.privateNames) ? settings.privateNames.filter((x) => typeof x === "string" && x.trim()) : [];
if (!names.length) stop(`${settingsFile} lists no privateNames.`);
// Each name's line in the settings file, so a hit can point at it without repeating it.
const rawLines = raw.split("\n");
const listLine = (term) => {
  const i = rawLines.findIndex((l) => l.includes(JSON.stringify(term)));
  return i >= 0 ? i + 1 : null;
};
const terms = names.map((t) => ({ lower: t.trim().toLowerCase(), line: listLine(t) }));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A path as printed: every private name in it masked, so a file named after one never repeats it. */
const shown = (path) => terms.reduce((p, t, i) => p.replace(new RegExp(escape(t.lower), "gi"), `[private name #${i + 1}]`), path);

const SECRETS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["API key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["assigned secret", /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i],
];

let log;
try {
  log = execFileSync("git", ["log", "-p", "--no-color", "--no-ext-diff", "--format=@@commit %H%n%B%n@@end-message", range], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (err) {
  stop(`git log ${range} failed in ${repo} (${String(err.stderr ?? err.message).trim().split("\n")[0]}).`);
}

const hits = [];
let commit = "";
let commits = 0;
let inMessage = false;
let messageLine = 0;
let file = null;
let newLine = 0;
function check(text, where) {
  const lower = text.toLowerCase();
  for (const [i, t] of terms.entries()) if (lower.includes(t.lower)) hits.push(`${where} · private name #${i + 1}${t.line ? ` (merge-round.json line ${t.line})` : ""}`);
  for (const [label, re] of SECRETS) if (re.test(text)) hits.push(`${where} · looks like a ${label}`);
}
for (const line of log.split("\n")) {
  if (line.startsWith("@@commit ")) {
    commit = line.slice(9, 16);
    commits++;
    inMessage = true;
    messageLine = 0;
    file = null;
    continue;
  }
  if (inMessage) {
    if (line === "@@end-message") inMessage = false;
    else check(line, `commit ${commit} · message line ${++messageLine}`);
    continue;
  }
  if (line.startsWith("diff --git ")) {
    file = null;
    continue;
  }
  if (line.startsWith("+++ ")) {
    file = line === "+++ /dev/null" ? null : line.slice(6);
    if (file) check(file, `commit ${commit} · ${shown(file)} · its name`);
    continue;
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (hunk) {
    newLine = Number(hunk[1]);
    continue;
  }
  if (!file) continue;
  if (line.startsWith("+")) {
    check(line.slice(1), `commit ${commit} · ${shown(file)}:${newLine}`);
    newLine++;
  } else if (line.startsWith(" ")) newLine++;
}

// A file's name is checked once per commit that adds or changes it; keep each hit once.
const unique = [...new Set(hits)];
if (unique.length) {
  console.log(`leak-scan: ${unique.length} hit${unique.length === 1 ? "" : "s"} in ${range}. Push nothing; fix these first.`);
  for (const h of unique) console.log(`- ${h}`);
  process.exit(1);
}
console.log(`leak-scan: no private names or secrets in ${range} (${commits} commit${commits === 1 ? "" : "s"}).`);
