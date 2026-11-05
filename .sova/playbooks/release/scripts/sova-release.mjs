#!/usr/bin/env node
// sova-release: Sova's own release, the mechanical parts (.sova/playbooks/release/PLAYBOOK.md). It runs from
// the repository root of the tree it works on (the release worktree, the merge copy a release check runs in,
// or a deploy's checkout). It never tags, pushes, publishes a release page or calls Sova: the release chat
// reports through its own release.step, and Sova's Publish makes the tags and the one push. Node builtins
// plus this repository's own scripts.
//
// Release chat (prepare and check steps):
//   prev                                   the previous release: the newest v* tag that is an ancestor of HEAD. Exit 1: none.
//   bump --version X.Y.Z [--check]         package.json, site/src/data/site.ts `release`, the pinned SOVA_REF=v… examples
//                                          (README.md, docs/, site/src/), and `vNEXT` in docs and site pages. Exit 0, 1 a file it couldn't change.
//   stamp landing|docs --rev <short> [--version X.Y.Z]
//                                          sets site/src/data/site.ts `verified` (landing, needs --version) or `docsVerified`
//                                          to the commit checked and today (UTC). Only after the re-check the playbook names.
//   notes-out --version X.Y.Z --out <file> the CHANGELOG.md entry's body, for the release page. Exit 1: no single dated entry.
//   live-check --commit <sha> [--url <origin>]
//                                          the live server's /api/health `head` is the commit (default origin http://localhost:4800). Exit 1: not it, 2: no answer.
// Release-only checks (the settings' release.checks; SOVA_OUT gets the report, as every merge check):
//   changelog-check   the entry for package.json's version: one heading `## vX.Y.Z — YYYY-MM-DD`, no placeholder, not empty.
//   site-check        the site's install (offline first) and build (its docs leak check included), then the built landing
//                     names the stable install command and links /releases/tag/vX.Y.Z.
//   ext-all           every pi-config extension's suite (scripts/merge-checks/ext-suites.mjs with every extension as changed).
//   spec-new          the spec check on this tree against the same check on the previous release's tree: no new finding.
//   leak-scan         scripts/merge-checks/leak-scan.mjs over everything since the previous release (--range vPREV..HEAD).
// The site deploy target (.sova/project.json deploy.targets.site):
//   env-set NAME                           exit 0 when the variable is set (an env credential's check).
//   site-video <checkout>                  copies the hero videos into <checkout>/site/public/video from $SOVA_SITE_VIDEO_DIR when
//                                          that holds them all; else leaves them out (the poster still shows) and says so. Exit 0.
//   site-pages <commit>                    the Cloudflare Pages upload of site/dist, project $SOVA_SITE_PAGES_PROJECT, production branch.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bumpText, changelogEntry, compareVersions, parseVersion } from "../../../../playbooks/release/scripts/release.mjs";
import { report, specCore } from "../../../../scripts/merge-checks/lib.mjs";

export const SITE_DATA = "site/src/data/site.ts";
export const DATED = /^## (v\d+\.\d+\.\d+\S*) — (\d{4}-\d{2}-\d{2})$/;

const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
function git(root, args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }).trim();
  } catch {
    return null;
  }
}

/** The newest numbered tag (vX.Y.Z) that is an ancestor of `rev`, skipping one at `rev` itself; null for a first release. */
export function prevRelease(root, rev = "HEAD") {
  const head = git(root, ["rev-parse", `${rev}^{commit}`]);
  const tags = (git(root, ["tag", "--list", "v[0-9]*"]) ?? "").split("\n").filter((t) => parseVersion(t.slice(1)));
  tags.sort((a, b) => compareVersions(b.slice(1), a.slice(1)));
  for (const t of tags) {
    const c = git(root, ["rev-parse", `${t}^{commit}`]);
    if (!c || c === head) continue;
    if (git(root, ["merge-base", "--is-ancestor", c, head ?? rev]) !== null) return t;
  }
  return null;
}

export const packageVersion = (root) => {
  try {
    return JSON.parse(read(join(root, "package.json")) ?? "")?.version ?? null;
  } catch {
    return null;
  }
};

// ---- bump ----------------------------------------------------------------------------------------

/** site.ts's text with `release` set to `tag`, or why not. Pure. */
export function siteRelease(text, tag) {
  const re = /^(export const release = ")(v[^"]*)(";)$/m;
  const m = text.match(re);
  if (!m) return { error: `no \`export const release = "v…";\` line` };
  return { text: text.replace(re, `$1${tag}$3`), from: m[2] };
}

/** Each file's new text for release `version`: the files the per-release edits name. Reads only. */
export function bumpPlan(root, version) {
  const tag = `v${version}`;
  const out = [];
  const pkg = read(join(root, "package.json"));
  if (pkg === null) out.push({ file: "package.json", error: "can't be read" });
  else {
    const r = bumpText(join(root, "package.json"), pkg, version);
    out.push(r.error ? { file: "package.json", error: r.error } : { file: "package.json", from: r.from, text: r.text });
  }
  const site = read(join(root, SITE_DATA));
  if (site === null) out.push({ file: SITE_DATA, error: "can't be read" });
  else {
    const r = siteRelease(site, tag);
    out.push(r.error ? { file: SITE_DATA, error: r.error } : { file: SITE_DATA, from: r.from, text: r.text });
  }
  const pinned = (git(root, ["grep", "-l", "-E", "SOVA_REF=v[0-9]", "--", "README.md", "docs", "site/src"]) ?? "").split("\n").filter(Boolean);
  const next = (git(root, ["grep", "-l", "vNEXT", "--", "README.md", "docs", "site/src"]) ?? "").split("\n").filter(Boolean);
  for (const f of [...new Set([...pinned, ...next])].sort()) {
    const text = read(join(root, f));
    if (text === null) continue;
    const t = text.replace(/SOVA_REF=v\d+\.\d+\.\d+[0-9A-Za-z.-]*/g, `SOVA_REF=${tag}`).replace(/\bvNEXT\b/g, tag);
    out.push({ file: f, text: t });
  }
  return out.map((x) => ("text" in x ? { ...x, changed: x.text !== read(join(root, x.file)) } : x));
}

export function bump(root, version, { check = false } = {}) {
  if (!parseVersion(version)) return { ok: false, results: [{ file: "-", error: `${version} is not X.Y.Z` }] };
  const results = bumpPlan(root, version);
  if (!check) for (const r of results) if (r.text !== undefined && r.changed) writeFileSync(join(root, r.file), r.text);
  return { ok: results.every((r) => !r.error), results: results.map(({ text, ...r }) => r) };
}

// ---- stamps --------------------------------------------------------------------------------------

const today = (now = new Date()) => now.toISOString().slice(0, 10);
/** site.ts's text with the landing's `verified` or the docs' `docsVerified` stamp set. Pure. */
export function stampText(text, which, { rev, version, date }) {
  if (!/^[0-9a-f]{7,40}$/.test(rev ?? "")) return { error: "--rev must be the commit checked (hex)" };
  if (which === "landing") {
    if (!parseVersion(version ?? "")) return { error: "the landing stamp needs --version X.Y.Z" };
    const re = /^export const verified = \{[^}\n]*\};$/m;
    if (!re.test(text)) return { error: "no one-line `export const verified = {…};`" };
    return { text: text.replace(re, `export const verified = { ref: "v${version}", rev: "${rev}", date: "${date}" };`) };
  }
  if (which === "docs") {
    const re = /^export const docsVerified = \{[^}\n]*\};$/m;
    if (!re.test(text)) return { error: "no one-line `export const docsVerified = {…};`" };
    return { text: text.replace(re, `export const docsVerified = { rev: "${rev}", date: "${date}" };`) };
  }
  return { error: "stamp landing or stamp docs" };
}

// ---- release checks ------------------------------------------------------------------------------

/** The changelog entry for `version`: dated once, no placeholder, not empty. Pure. → {ok, problem?, body?} */
export function changelogProblem(text, version) {
  const e = changelogEntry(text, version);
  if (!e.ok) return { ok: false, problem: e.problem };
  const m = DATED.exec(e.heading);
  if (!m || m[1] !== `v${version}`) return { ok: false, problem: `the heading must read "## v${version} — YYYY-MM-DD", is "${e.heading}"` };
  if (Number.isNaN(Date.parse(m[2]))) return { ok: false, problem: `${m[2]} is not a date` };
  return { ok: true, body: e.body, date: m[2] };
}

const OUT = process.env.SOVA_OUT || null;
function finish(name, problems, notes = []) {
  for (const n of notes) console.log(`${name}: ${n}`);
  if (problems.length) for (const p of problems) console.log(`${name}: ${p}`);
  else console.log(`${name}: ok`);
  report(OUT, { passed: problems.length ? 0 : 1, failed: problems.length ? 1 : 0, failures: problems.map((message) => ({ name, message })), ...(notes.length ? { notes } : {}) });
  return problems.length ? 1 : 0;
}
const skipped = (why) => {
  console.log(`skipped: ${why}`);
  report(OUT, { passed: 0, failed: 0, skipped: why });
  return 0;
};

export function changelogCheck(root) {
  const v = packageVersion(root);
  if (!v) return finish("release notes", ["package.json has no version"]);
  const text = read(join(root, "CHANGELOG.md"));
  if (text === null) return finish("release notes", ["CHANGELOG.md is missing"]);
  const r = changelogProblem(text, v);
  return finish("release notes", r.ok ? [] : [`v${v}: ${r.problem}`]);
}

const runInherit = (cmd, args, cwd, env = process.env) => {
  console.log(`$ ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { cwd, env, stdio: "inherit" });
  return r.status ?? (r.error ? 127 : 1);
};

/** What the built landing must hold for `tag`: the stable install command and the release page link. Pure. */
export function landingProblems(html, tag) {
  const out = [];
  if (!html.includes("/stable/scripts/install.sh")) out.push("the built landing has no /stable/scripts/install.sh command");
  if (!html.includes(`/releases/tag/${tag}`)) out.push(`the built landing doesn't link /releases/tag/${tag}`);
  return out;
}

export function siteCheck(root) {
  const v = packageVersion(root);
  if (!v) return finish("site", ["package.json has no version"]);
  const notes = [];
  if (runInherit("pnpm", ["--dir", "site", "install", "--frozen-lockfile", "--offline"], root) !== 0) {
    notes.push("the offline install missed the store; installed from the registry");
    if (runInherit("pnpm", ["--dir", "site", "install", "--frozen-lockfile"], root) !== 0) return finish("site", ["pnpm install in site/ failed"], notes);
  }
  if (runInherit("pnpm", ["--dir", "site", "run", "build"], root) !== 0) return finish("site", ["the site build failed (its docs leak check runs in it)"], notes);
  const html = read(join(root, "site", "dist", "index.html"));
  if (html === null) return finish("site", ["site/dist/index.html is missing after the build"], notes);
  return finish("site", landingProblems(html, `v${v}`), notes);
}

/** One line per pi-config extension that has a folder, as ext-suites' changed-paths list. */
export function allExtensions(root) {
  const dir = join(root, "pi-config", "extensions");
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch {}
  return names;
}

export function extAll(root) {
  const exts = allExtensions(root);
  if (!exts.length) return skipped("no pi-config extensions in this tree");
  const tmp = mkdtempSync(join(tmpdir(), "sova-release-ext-"));
  try {
    const list = join(tmp, "changed.txt");
    writeFileSync(list, exts.map((e) => `pi-config/extensions/${e}/.release`).join("\n") + "\n");
    const env = { ...process.env };
    delete env.SOVA_MERGE_CHANGED; // it would win over --changed
    return runInherit(process.execPath, [join(root, "scripts", "merge-checks", "ext-suites.mjs"), "--changed", list, "--base", "HEAD"], root, env);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** A finding's identity across two trees: its code and what it is about, never its wording's numbers. */
export const findingKey = (f) => `${f.code ?? ""} ${f.id ?? ""} ${f.file ?? f.path ?? ""}`.trim();
/** The findings in `now` that `before` doesn't have, by key and count. Pure. */
export function newFindings(before, now) {
  const left = new Map();
  for (const f of before) left.set(findingKey(f), (left.get(findingKey(f)) ?? 0) + 1);
  const out = [];
  for (const f of now) {
    const k = findingKey(f);
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else out.push(f);
  }
  return out;
}

function specFindings(core, root) {
  try {
    const out = execFileSync(process.execPath, [join(core, "sova-spec.mjs"), "check", "--root", root, "--json"], { cwd: root, encoding: "utf8", maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(out).findings ?? [];
  } catch (err) {
    try {
      return JSON.parse(String(err.stdout ?? "")).findings ?? null;
    } catch {
      return null;
    }
  }
}

export function specNew(root) {
  if (!existsSync(join(root, ".sova", "spec", "claims"))) return skipped("no .sova/spec in this tree");
  const prev = prevRelease(root);
  if (!prev) return skipped("no previous release to compare with");
  const core = specCore();
  if (!existsSync(join(core, "sova-spec.mjs"))) return finish("spec", [`the trusted spec tools aren't at ${core}`]);
  const tmp = mkdtempSync(join(tmpdir(), "sova-release-spec-"));
  try {
    const tar = spawnSync("sh", ["-c", 'git -C "$1" archive "$2" | tar -x -C "$3"', "sh", root, prev, tmp], { stdio: "inherit" });
    if (tar.status !== 0) return finish("spec", [`couldn't export ${prev}'s tree`]);
    const before = specFindings(core, tmp);
    const now = specFindings(core, root);
    if (!before || !now) return finish("spec", [`the spec check gave no findings list on ${!now ? "this tree" : prev}`]);
    const fresh = newFindings(before, now);
    return finish(
      "spec",
      fresh.slice(0, 20).map((f) => `new since ${prev}: ${findingKey(f)}${f.message ? `: ${f.message}` : ""}`).concat(fresh.length > 20 ? [`… and ${fresh.length - 20} more`] : []),
      [`${now.length} findings here, ${before.length} on ${prev}`],
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function leakScan(root) {
  const prev = prevRelease(root);
  if (!prev) return skipped("no previous release: the merge queue's own leak scan covered each landing");
  return runInherit(process.execPath, [join(root, "scripts", "merge-checks", "leak-scan.mjs"), "--range", `${prev}..HEAD`], root);
}

// ---- the live try-out ----------------------------------------------------------------------------

/** Two hex commit names for the same commit: one is a prefix of the other, at least 7 long. Pure. */
export const sameCommit = (a, b) => /^[0-9a-f]{7,40}$/.test(a) && /^[0-9a-f]{7,40}$/.test(b) && (a.startsWith(b) || b.startsWith(a));

export async function liveCheck(commit, origin = "http://localhost:4800") {
  let health;
  try {
    const res = await fetch(new URL("/api/health", origin), { signal: AbortSignal.timeout(10_000) });
    health = await res.json();
  } catch (err) {
    console.log(`no answer from ${origin}/api/health: ${err.message}`);
    return 2;
  }
  const head = String(health?.head ?? "");
  console.log(`live server: head ${head || "(none)"}, started ${health?.startedAt ?? "?"}`);
  return sameCommit(head, commit) ? 0 : 1;
}

// ---- the site deploy target ----------------------------------------------------------------------

export async function siteVideo(checkout) {
  const dir = process.env.SOVA_SITE_VIDEO_DIR;
  if (!dir) {
    console.error("site-video: SOVA_SITE_VIDEO_DIR is not set: the deploy stops rather than ship the site without its hero video");
    return 1;
  }
  const { addVideo } = await import(join(resolve(checkout), "site", "scripts", "screens", "add-video.mjs"));
  try {
    const names = addVideo(resolve(checkout), resolve(dir));
    console.log(`site-video: copied ${names.length} video(s)`);
  } catch (err) {
    console.error(`site-video: ${err.message}; the deploy stops rather than ship the site without its hero video`);
    return 1;
  }
  return 0;
}

export function sitePages(root, commit) {
  const project = process.env.SOVA_SITE_PAGES_PROJECT;
  if (!project) {
    console.error("site-pages: SOVA_SITE_PAGES_PROJECT is not set (the operator sets it in Sova's host.json)");
    return 2;
  }
  if (!/^[0-9a-f]{7,40}$/.test(commit ?? "")) {
    console.error("site-pages: usage: site-pages <commit>");
    return 2;
  }
  return runInherit("wrangler", ["pages", "deploy", "site/dist", "--project-name", project, "--branch", "main", "--commit-hash", commit], root);
}

// ---- CLI -----------------------------------------------------------------------------------------

/** Every subcommand, in the order the header lists them. */
export const SUBCOMMANDS = ["prev", "bump", "stamp", "notes-out", "live-check", "changelog-check", "site-check", "ext-all", "spec-new", "leak-scan", "env-set", "site-video", "site-pages"];

function opt(list, name) {
  const i = list.indexOf(name);
  return i >= 0 ? list[i + 1] : undefined;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const root = resolve(opt(rest, "--root") ?? process.cwd());
  switch (cmd) {
    case "prev": {
      const p = prevRelease(root);
      console.log(p ?? "no previous release");
      return p ? 0 : 1;
    }
    case "bump": {
      const v = opt(rest, "--version");
      const r = bump(root, v ?? "", { check: rest.includes("--check") });
      for (const x of r.results) console.log(x.error ? `${x.file}: ${x.error}` : `${x.file}: ${x.changed ? (rest.includes("--check") ? "would change" : "changed") : "already"}${x.from ? ` (was ${x.from})` : ""}`);
      return r.ok ? 0 : 1;
    }
    case "stamp": {
      const which = rest[0];
      const file = join(root, SITE_DATA);
      const text = read(file);
      if (text === null) return console.error(`${SITE_DATA} can't be read`), 2;
      const r = stampText(text, which, { rev: opt(rest, "--rev"), version: opt(rest, "--version"), date: today() });
      if (r.error) return console.error(`stamp: ${r.error}`), 1;
      writeFileSync(file, r.text);
      console.log(`${SITE_DATA}: ${which === "landing" ? "verified" : "docsVerified"} set`);
      return 0;
    }
    case "notes-out": {
      const v = opt(rest, "--version");
      const out = opt(rest, "--out");
      const text = read(join(root, "CHANGELOG.md"));
      if (!v || !out || text === null) return console.error("usage: notes-out --version X.Y.Z --out <file>"), 2;
      const r = changelogProblem(text, v);
      if (!r.ok) return console.error(`CHANGELOG.md: ${r.problem}`), 1;
      writeFileSync(out, `${r.body}\n`);
      console.log(`${out}: ${r.body.split("\n").length} lines`);
      return 0;
    }
    case "live-check": {
      const c = opt(rest, "--commit");
      if (!c) return console.error("usage: live-check --commit <sha> [--url <origin>]"), 2;
      return liveCheck(c, opt(rest, "--url"));
    }
    case "changelog-check":
      return changelogCheck(root);
    case "site-check":
      return siteCheck(root);
    case "ext-all":
      return extAll(root);
    case "spec-new":
      return specNew(root);
    case "leak-scan":
      return leakScan(root);
    case "env-set":
      return rest[0] && process.env[rest[0]] ? 0 : (console.error(`${rest[0] ?? "(no name)"} is not set`), 1);
    case "site-video":
      return siteVideo(rest[0] ?? root);
    case "site-pages":
      return sitePages(root, rest[0]);
    default:
      console.error(`usage: sova-release <${SUBCOMMANDS.join("|")}> (see this file's header)`);
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)));
