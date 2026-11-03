#!/usr/bin/env node
// release: the general Release method's mechanical reading and writing (playbooks/release/PLAYBOOK.md).
// It reads the repository and writes only what a subcommand names (a version field, a notes draft
// under the state root). It never tags, pushes, publishes, deploys, or calls Sova: a step's result
// reaches Sova only through the release chat's own release.step call. Node builtins only.
//
//   node scripts/release.mjs status [--root <checkout>] [--tag 'v${version}'] [--json]
//     the previous release (the newest tag matching the pattern), the commits since it, and a
//     suggested next version with its reason (the project's version rule wins). Exit 0; 1 when the
//     tag pattern matches no tag (a first release: say so); 2 couldn't read the repository.
//   node scripts/release.mjs notes [--root <checkout>] [--tag …] [--since <tag>] [--json]
//     the raw material for the notes since the previous release (first-parent subjects, merged
//     branches, their bodies) written to a file under the state root; the digest names it. Exit 0.
//   node scripts/release.mjs changelog --version X.Y.Z [--file CHANGELOG.md] [--heading '## v${version}'] [--out <file>] [--root …]
//     the release's entry in the changelog: present exactly once, no placeholder left. With --out,
//     the entry's body (without its heading) is written there, for a release page. Exit 0 ok, 1 not.
//   node scripts/release.mjs bump --version X.Y.Z --file <path> [--file …] [--check] [--root …]
//     sets the version field of each named file it knows (package.json, Cargo.toml, pyproject.toml,
//     mix.exs, VERSION, a file holding only a version) and nothing else. --check only reports. Exit
//     0 done/already, 1 a file it can't bump (named), 2 couldn't read.
//   node scripts/release.mjs artifact <path> [--root …] [--json]
//     an artifact's facts for release.step, as its key=value list (artifact=<path>, sha256=…, size=…): refused (exit 1) when the path
//     is tracked by git or sits inside the repository without being ignored. Exit 2: no such file.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_TAG = "v${version}";

function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
}
const git = (root, ...a) => sh("git", ["-C", root, ...a], root);
const readText = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};

export const stateRoot = () => {
  const a = process.env.PI_CODING_AGENT_DIR;
  const agent = a ? (a === "~" ? homedir() : a.startsWith("~/") ? join(homedir(), a.slice(2)) : a) : join(homedir(), ".pi", "agent");
  return join(agent, "sova");
};
/** Where this playbook keeps what it writes for a project (§chat.playbooks/bundles: state under the state root). */
export const stateDir = (root) => join(stateRoot(), "playbooks", "release", basename(root).replace(/[^A-Za-z0-9._-]/g, "_"));

// ---- versions -------------------------------------------------------------------------------------

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
export const parseVersion = (s) => {
  const m = VERSION.exec(String(s));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null, text: String(s) } : null;
};
/** Newest first; a pre-release sorts below its release. */
export function compareVersions(a, b) {
  for (const k of ["major", "minor", "patch"]) if (a[k] !== b[k]) return b[k] - a[k];
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return -1;
  if (b.pre === null) return 1;
  return a.pre < b.pre ? 1 : -1;
}

/** The tag pattern as a matcher: `v${version}` → /^v(…)$/; exactly one ${version}. */
export function tagMatcher(pattern = DEFAULT_TAG) {
  const parts = pattern.split("${version}");
  if (parts.length !== 2) throw new Error(`the tag pattern ${pattern} must hold \${version} exactly once`);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${esc(parts[0])}(.+)${esc(parts[1])}$`);
  return {
    match: (tag) => {
      const m = re.exec(tag);
      return m ? parseVersion(m[1]) : null;
    },
    tag: (version) => `${parts[0]}${version}${parts[1]}`,
  };
}

/** Every release tag in the repository, newest first. */
export function releaseTags(root, pattern = DEFAULT_TAG) {
  const out = git(root, "tag", "--list");
  if (out === null) return null;
  const m = tagMatcher(pattern);
  return out
    .split("\n")
    .filter(Boolean)
    .map((tag) => ({ tag, version: m.match(tag) }))
    .filter((t) => t.version)
    .sort((a, b) => compareVersions(a.version, b.version));
}

const FEATURE = /^(feat|feature)(\(.+\))?!?:|^Merge (branch|pull request) .*\b(feat|feature)[/-]|\badd(s|ed)?\b/i;
const BREAKING = /BREAKING[ -]CHANGE|^[a-z]+(\(.+\))?!:/m;
/** The next version a set of commits suggests: major on a breaking change (minor while 0.x), minor on a feature, else patch. */
export function suggest(prev, commits) {
  const breaking = commits.filter((c) => BREAKING.test(`${c.subject}\n${c.body}`));
  const features = commits.filter((c) => FEATURE.test(c.subject));
  const base = prev ?? { major: 0, minor: 0, patch: 0 };
  let kind, reason;
  if (!prev) (kind = "first"), (reason = "no earlier release");
  else if (breaking.length) (kind = base.major === 0 ? "minor" : "major"), (reason = `${breaking.length} breaking change(s)${base.major === 0 ? " (0.x: minor)" : ""}`);
  else if (features.length) (kind = "minor"), (reason = `${features.length} feature(s)`);
  else (kind = "patch"), (reason = "fixes only");
  const next =
    kind === "first" ? "0.1.0" : kind === "major" ? `${base.major + 1}.0.0` : kind === "minor" ? `${base.major}.${base.minor + 1}.0` : `${base.major}.${base.minor}.${base.patch + 1}`;
  return { next, kind, reason, features: features.length, breaking: breaking.length };
}

/** First-parent commits in range (subject, body), oldest last. */
export function commitsSince(root, since) {
  const range = since ? `${since}..HEAD` : "HEAD";
  const out = git(root, "log", "--first-parent", "--format=%H%x1f%s%x1f%b%x1e", range);
  if (out === null) return null;
  return out
    .split("\x1e")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [sha, subject, body] = r.split("\x1f");
      return { sha, subject: subject ?? "", body: (body ?? "").trim() };
    });
}

export function status(root, pattern = DEFAULT_TAG) {
  const tags = releaseTags(root, pattern);
  if (tags === null) return null;
  const head = git(root, "rev-parse", "HEAD")?.trim() ?? null;
  if (!head) return null;
  const prev = tags[0] ?? null;
  const commits = commitsSince(root, prev?.tag) ?? [];
  const s = suggest(prev?.version ?? null, commits);
  const m = tagMatcher(pattern);
  return {
    root,
    head,
    pattern,
    previous: prev ? { tag: prev.tag, version: prev.version.text, commit: git(root, "rev-parse", `${prev.tag}^{commit}`)?.trim() ?? null } : null,
    since: commits.length,
    merges: commits.filter((c) => /^Merge /.test(c.subject)).length,
    suggest: { version: s.next, tag: m.tag(s.next), kind: s.kind, reason: s.reason },
    taken: tags.length && tags.some((t) => t.version.text === s.next),
  };
}

// ---- notes ------------------------------------------------------------------------------------------

export function notesMaterial(root, since) {
  const commits = commitsSince(root, since);
  if (commits === null) return null;
  const lines = [`# Raw material for the release notes${since ? ` since ${since}` : ""}`, "", "Not the notes: read it, then write the entry for someone who installed the previous release.", ""];
  const merges = commits.filter((c) => /^Merge /.test(c.subject));
  const others = commits.filter((c) => !/^Merge /.test(c.subject));
  lines.push(`## Merged branches (${merges.length})`, "");
  for (const c of merges) {
    lines.push(`- ${c.subject} (${c.sha.slice(0, 9)})`);
    for (const s of (git(root, "log", "--format=%s", `${c.sha}^1..${c.sha}^2`) ?? "").split("\n").filter(Boolean).slice(0, 12)) lines.push(`  - ${s}`);
  }
  lines.push("", `## Other commits on the main line (${others.length})`, "");
  for (const c of others) lines.push(`- ${c.subject} (${c.sha.slice(0, 9)})`);
  return { text: `${lines.join("\n")}\n`, merges: merges.length, others: others.length };
}

// ---- changelog --------------------------------------------------------------------------------------

const PLACEHOLDER = /RELEASE-DATE|YYYY-MM-DD|\bTODO\b|\bTBD\b/;
/** The release's changelog entry: one heading line that starts with the expanded heading, its body until the next heading of the same level. */
export function changelogEntry(text, version, heading = "## v${version}") {
  const head = heading.replace(/\$\{version\}/g, version);
  const level = /^(#+)\s/.exec(head)?.[1] ?? "##";
  const lines = text.split("\n");
  const starts = lines.flatMap((l, i) => (l === head || l.startsWith(`${head} `) ? [i] : []));
  if (starts.length !== 1) return { ok: false, problem: starts.length ? `the heading "${head}" appears ${starts.length} times` : `no heading "${head}"` };
  const i = starts[0];
  let j = i + 1;
  const next = new RegExp(`^#{1,${level.length}}\\s`);
  while (j < lines.length && !next.test(lines[j])) j++;
  const body = lines.slice(i + 1, j).join("\n").trim();
  const headLine = lines[i];
  if (PLACEHOLDER.test(headLine)) return { ok: false, problem: `the heading still holds a placeholder: ${headLine}`, heading: headLine, body };
  if (!body) return { ok: false, problem: "the entry is empty", heading: headLine, body };
  return { ok: true, heading: headLine, body };
}

// ---- bump -------------------------------------------------------------------------------------------

/** The file's text with its version field set, or why not. Only the one field changes. */
export function bumpText(file, text, version) {
  const name = basename(file);
  const one = (re, label) => {
    const m = text.match(re);
    if (!m) return { error: `no ${label} found` };
    const out = text.replace(re, (_all, a, _old, b) => `${a}${version}${b}`);
    return { text: out, from: m[0].replace(re, "$2") };
  };
  if (name.endsWith(".json")) {
    // The top-level "version" only: the first "version" key must be the one JSON.parse sees at the top.
    let top;
    try {
      top = JSON.parse(text)?.version;
    } catch {
      return { error: "not JSON" };
    }
    if (typeof top !== "string") return { error: 'no top-level "version" field' };
    const r = one(/("version"\s*:\s*")([^"]*)(")/, '"version" field');
    if (r.error || r.from !== top) return { error: 'the first "version" key is not the top-level one: edit it by hand' };
    return r;
  }
  if (name === "Cargo.toml") return one(/^(\[package\][^[]*?\nversion\s*=\s*")([^"]*)(")/m, "[package] version");
  if (name === "pyproject.toml") return one(/^(\[(?:project|tool\.poetry)\][^[]*?\nversion\s*=\s*")([^"]*)(")/m, "[project] version");
  if (name === "mix.exs") return one(/^(\s*(?:@version\s+|version:\s*)")([^"]*)(")/m, "version");
  if (/^\s*v?\d+\.\d+\.\d+\S*\s*$/.test(text)) return one(/^(\s*v?)(\d+\.\d+\.\d+\S*)(\s*)$/, "version");
  return { error: "a file this script doesn't know how to bump: edit it by hand, or give the project's playbook a script for it" };
}

export function bump(root, files, version, { check = false } = {}) {
  const results = [];
  for (const f of files) {
    const path = resolve(root, f);
    const text = readText(path);
    if (text === null) {
      results.push({ file: f, error: "can't be read" });
      continue;
    }
    const r = bumpText(path, text, version);
    if (r.error) results.push({ file: f, error: r.error });
    else if (r.from === version) results.push({ file: f, from: r.from, changed: false });
    else {
      if (!check) writeFileSync(path, r.text);
      results.push({ file: f, from: r.from, changed: true, written: !check });
    }
  }
  return results;
}

// ---- artifacts --------------------------------------------------------------------------------------

const expandHome = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
/** Whether an artifact path inside the repository is fine: never tracked, always ignored. Pure over git's answers. */
export function artifactPlace(root, path) {
  const abs = resolve(root, expandHome(path));
  const rel = relative(root, abs);
  const inside = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  if (!inside) return { abs, inside: false, ok: true };
  const tracked = (git(root, "ls-files", "--", rel) ?? "").trim() !== "";
  if (tracked) return { abs, inside: true, ok: false, problem: `${rel} is tracked by git: an artifact is never committed` };
  let ignored = false;
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", rel], { stdio: "ignore" });
    ignored = true;
  } catch {}
  if (!ignored) return { abs, inside: true, ok: false, problem: `${rel} is inside the repository and not ignored: add it to .gitignore, or build outside the repository` };
  return { abs, inside: true, ok: true };
}

function hashPath(abs) {
  const st = statSync(abs);
  if (st.isFile()) {
    return { sha256: createHash("sha256").update(readFileSync(abs)).digest("hex"), size: st.size };
  }
  // A folder: the hash of its sorted file list with each file's hash, the size of every file.
  const h = createHash("sha256");
  let size = 0;
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (s.isFile()) {
        size += s.size;
        h.update(`${relative(abs, p).split(sep).join("/")}\0${createHash("sha256").update(readFileSync(p)).digest("hex")}\n`);
      }
    }
  };
  walk(abs);
  return { sha256: h.digest("hex"), size };
}

export function artifact(root, path) {
  const place = artifactPlace(root, path);
  if (!existsSync(place.abs)) return { ok: false, fatal: true, problem: `${place.abs} doesn't exist` };
  if (!place.ok) return { ok: false, problem: place.problem, artifact: place.abs };
  const h = hashPath(place.abs);
  return { ok: true, artifact: { path: place.abs, ...h }, facts: [`artifact=${place.abs}`, `sha256=${h.sha256}`, `size=${h.size}`] };
}

// ---- CLI --------------------------------------------------------------------------------------------

function args(list) {
  const o = { _: [], file: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === "--json" || a === "--check") o[a.slice(2)] = true;
    else if (a === "--file") o.file.push(list[++i]);
    else if (["--root", "--tag", "--since", "--version", "--heading", "--out"].includes(a)) o[a.slice(2)] = list[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else o._.push(a);
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  let o;
  try {
    o = args(rest);
  } catch (err) {
    console.error(`release: ${err.message}`);
    return 2;
  }
  const root = o.root ? resolve(o.root) : git(process.cwd(), "rev-parse", "--show-toplevel")?.trim();
  if (!root) return (console.error("release: not inside a git checkout (pass --root)"), 2);
  const print = (v, digest) => console.log(o.json ? JSON.stringify(v, null, 2) : digest(v));
  const pattern = o.tag ?? DEFAULT_TAG;

  if (cmd === "status") {
    let r;
    try {
      r = status(root, pattern);
    } catch (err) {
      return (console.error(`release: ${err.message}`), 2);
    }
    if (!r) return (console.error("release: can't read the repository's tags or HEAD"), 2);
    print(r, (x) =>
      [
        `release status: ${x.root} at ${x.head.slice(0, 12)} (tags ${x.pattern})`,
        x.previous ? `previous release: ${x.previous.tag} (${x.previous.commit?.slice(0, 12) ?? "?"})` : "previous release: none (a first release)",
        `since then: ${x.since} commit(s) on the main line, ${x.merges} merge(s)`,
        `suggested: ${x.suggest.tag} (${x.suggest.kind}: ${x.suggest.reason}); the project's version rule decides`,
        ...(x.taken ? [`problem: ${x.suggest.tag} already exists as a tag: pick another number`] : []),
      ].join("\n"),
    );
    return r.taken ? 1 : r.previous ? 0 : 1;
  }
  if (cmd === "notes") {
    let since = o.since;
    if (!since) since = releaseTags(root, pattern)?.[0]?.tag;
    const r = notesMaterial(root, since);
    if (!r) return (console.error("release: can't read the history"), 2);
    const dir = stateDir(root);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `notes-material${since ? `-since-${since.replace(/[^A-Za-z0-9._-]/g, "_")}` : ""}.md`);
    writeFileSync(file, r.text);
    print({ file, since: since ?? null, merges: r.merges, others: r.others }, (x) => `release notes: ${x.merges} merged branch(es), ${x.others} other commit(s)${x.since ? ` since ${x.since}` : ""}; material in ${x.file}`);
    return 0;
  }
  if (cmd === "changelog") {
    if (!o.version) return (console.error("release: changelog needs --version X.Y.Z"), 2);
    const file = resolve(root, o.file[0] ?? "CHANGELOG.md");
    const text = readText(file);
    if (text === null) return (console.error(`release: ${file} can't be read`), 2);
    const r = changelogEntry(text, o.version, o.heading ?? "## v${version}");
    if (r.ok && o.out) writeFileSync(resolve(o.out), `${r.body}\n`);
    print({ file, ...r, ...(o.out && r.ok ? { out: resolve(o.out) } : {}) }, (x) =>
      x.ok ? `release changelog: ${x.heading} — ${x.body.split("\n").length} line(s)${x.out ? `; body written to ${x.out}` : ""}` : `release changelog: problem: ${x.problem}`,
    );
    return r.ok ? 0 : 1;
  }
  if (cmd === "bump") {
    if (!o.version || !parseVersion(o.version)) return (console.error("release: bump needs --version X.Y.Z"), 2);
    if (!o.file.length) return (console.error("release: bump needs --file <path> for each file to bump"), 2);
    const r = bump(root, o.file, o.version, { check: !!o.check });
    print(r, (x) => x.map((f) => `release bump: ${f.file}: ${f.error ? `problem: ${f.error}` : f.changed ? `${f.from} → ${o.version}${f.written ? "" : " (not written: --check)"}` : `already ${o.version}`}`).join("\n"));
    return r.some((f) => f.error === "can't be read") ? 2 : r.some((f) => f.error) ? 1 : 0;
  }
  if (cmd === "artifact") {
    if (!o._[0]) return (console.error("release: artifact needs a path"), 2);
    const r = artifact(root, o._[0]);
    print(r, (x) => (x.ok ? `release artifact: ${x.artifact.path} · sha256 ${x.artifact.sha256} · ${x.artifact.size} bytes\nfacts for release.step: ${JSON.stringify(x.facts)}` : `release artifact: problem: ${x.problem}`));
    return r.fatal ? 2 : r.ok ? 0 : 1;
  }
  console.error("usage: release <status|notes|changelog|bump|artifact> … (see the header of scripts/release.mjs)");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().then((code) => process.exit(code));
}
