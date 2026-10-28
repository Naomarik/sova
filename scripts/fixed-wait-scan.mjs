#!/usr/bin/env node
// Fixed waits a change adds to tests: every setTimeout / sleep / delay with a literal over 2000 ms on a
// line added to a test file since the merge base with --base (committed or not, and new untracked test
// files whole). Tests wait on the event that ends a window; a fixed wait over 2 s is only for proving an
// absence, with a comment naming the event that bounds it (agents/testing/overview.md, "Writing tests:
// wait on conditions"). This lists them so a person can check; it never fails a change. Builtins only.
//
//   node scripts/fixed-wait-scan.mjs --base <rev> [--json]
//
// Text: one line per wait (`file:line  ms`), or a line saying there is none. --json: exactly
// {"waits":[{"file":string,"line":number,"ms":number}]}. Exit 0 whatever it finds; 2 on bad usage (an
// unknown flag, no --base, a base git can't resolve, not in a git repository).
//
// Per line only: a call whose delay sits on a later line than its name is not seen. A literal is digits
// with optional `_` separators (6000, 6_000); a delay held in a constant is not seen either.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Waits over this many ms are listed. */
export const LIMIT_MS = 2000;

/** A test file, by name: `*.test.<ext>` (the integration tier's `*.integration.test.ts` among them). */
export const isTestFile = (file) => /\.test\.(?:[cm]?[jt]sx?)$/.test(file);

const num = (s) => Number(s.replace(/_/g, ""));
const LITERAL = String.raw`(\d[\d_]*)`;
/** sleep(6000), delay(6_000), Bun.sleep(6000), setTimeout(6000) (timers/promises), and a literal delay as
    setTimeout's last argument: setTimeout(r, 6000), setTimeout(() => x(), 6000). */
const PATTERNS = [
  new RegExp(String.raw`\b(?:sleep|delay)\(\s*${LITERAL}\s*[,)]`, "g"),
  new RegExp(String.raw`\bsetTimeout\(\s*${LITERAL}\s*[,)]`, "g"),
  new RegExp(String.raw`\bsetTimeout\([^;]*?,\s*${LITERAL}\s*\)`, "g"),
];

/** A line's code: string literals emptied (a call quoted in a string is no wait, and a URL's `//` no
    comment), then its `//` comment and a whole-line block comment left out. */
function codeOf(line) {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  const code = line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, (m) => m[0] + m[0]);
  return code.replace(/\/\/.*$/, "");
}

/** The fixed waits over LIMIT_MS on one line of code, each its ms, in order. */
export function waitsIn(line) {
  const code = codeOf(line);
  const found = [];
  for (const re of PATTERNS)
    for (const m of code.matchAll(re)) found.push({ at: m.index + m[0].length - m[1].length, ms: num(m[1]) });
  // The two setTimeout patterns can read one literal twice (setTimeout(6000) as a first and a last argument).
  const seen = new Set();
  return found
    .filter((w) => !seen.has(w.at) && seen.add(w.at))
    .sort((a, b) => a.at - b.at)
    .map((w) => w.ms)
    .filter((ms) => ms > LIMIT_MS);
}

/** The added lines of a `git diff -U0` text: {file, line, text}, line numbers in the new file. */
export function addedLines(diff) {
  const out = [];
  let file = null;
  let at = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) {
      const p = l.slice(4);
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      continue;
    }
    if (l.startsWith("--- ")) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      at = Number(h[1]);
      continue;
    }
    if (!file) continue;
    if (l.startsWith("+")) out.push({ file, line: at++, text: l.slice(1) });
    else if (l.startsWith(" ")) at++;
  }
  return out;
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });

/** The waits added to test files in `cwd`'s repository since its merge base with `base`. Throws when git
    can't resolve `base` or `cwd` is no repository. */
export function scan({ cwd = process.cwd(), base }) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
  const mb = git(top, ["merge-base", base, "HEAD"]).trim();
  // The work tree against the merge base: commits since, staged and unstaged edits alike.
  const diff = git(top, ["-c", "core.quotePath=off", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--diff-filter=AM", mb, "--"]);
  const lines = addedLines(diff).filter((l) => isTestFile(l.file));
  // New test files git doesn't track yet: every line is added.
  const untracked = git(top, ["-c", "core.quotePath=off", "ls-files", "--others", "--exclude-standard"]).split("\n").filter((f) => f && isTestFile(f));
  for (const file of untracked) {
    let text;
    try {
      text = readFileSync(join(top, file), "utf8");
    } catch {
      continue;
    }
    text.split("\n").forEach((t, i) => lines.push({ file, line: i + 1, text: t }));
  }
  const waits = [];
  for (const l of lines) for (const ms of waitsIn(l.text)) waits.push({ file: l.file, line: l.line, ms });
  return waits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function usage(why) {
  console.error(`fixed-wait-scan: ${why}\nusage: node scripts/fixed-wait-scan.mjs --base <rev> [--json]`);
  process.exit(2);
}

function main(argv) {
  let base = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--base") {
      base = argv[++i];
      if (!base || base.startsWith("--")) usage("--base needs a revision");
    } else if (a.startsWith("--base=")) base = a.slice(7);
    else usage(`unknown argument ${a}`);
  }
  if (!base) usage("--base <rev> is required");
  let waits;
  try {
    waits = scan({ base });
  } catch (err) {
    usage(`git could not compare with ${base}: ${String(err.stderr || err.message).trim().split("\n")[0]}`);
  }
  if (json) console.log(JSON.stringify({ waits }));
  else if (!waits.length) console.log(`fixed-wait-scan: no fixed wait over ${LIMIT_MS} ms added to a test file since ${base}`);
  else {
    console.log(`fixed-wait-scan: ${waits.length} fixed wait(s) over ${LIMIT_MS} ms added to test files since ${base} (each should prove an absence and name the event that bounds it):`);
    for (const w of waits) console.log(`  ${w.file}:${w.line}  ${w.ms} ms`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
