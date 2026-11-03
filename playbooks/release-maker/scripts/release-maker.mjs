#!/usr/bin/env node
// release-maker: the Release playbook maker's mechanical reading and writing (playbooks/release-maker/PLAYBOOK.md).
// It reads the repository, writes the starter playbook and the settings pointer only when asked
// (init), formats, and checks. It never tags, pushes, publishes, deploys, runs a release step or a
// release script, and never calls Sova. Node builtins, plus Sova's own parsers (shared/) and the
// Project verbs driver's canonical form.
//
//   node scripts/release-maker.mjs candidates [--root <checkout>] [--json]
//     what the repository says about releasing, read and never run: release-like tags (grouped by
//     pattern) and moving tags, files holding a version, changelogs, release automation (scripts,
//     tasks, tag-triggered CI, release tooling configs), remotes, ignored build folders, the merge
//     checks it could gate on, deploy targets, and any release settings or playbook already there. Exit 0.
//   node scripts/release-maker.mjs init [--root …] [--tag-only] [--bump <file>]… [--channel <tag>]… [--no-channel]
//                                       [--tag 'v${version}'] [--scheme semver|calver|none] [--dir .sova/playbooks/release]
//     the starter (Sova's defaults, every part the project's to change): <dir>/PLAYBOOK.md and
//     <dir>/release.json, and the `release` section of .sova/project.json (the file made if absent).
//     Refuses (exit 1) when any of them already exists: change those by editing. Exit 0 written.
//   node scripts/release-maker.mjs fmt [--root …] [--check]
//     the canonical form of .sova/project.json (the Project verbs form) and of the playbook's release.json.
//   node scripts/release-maker.mjs check [--root …] [--json]
//     Sova's parsers on the settings and the manifest, then what they can't see: every step named in
//     the playbook, each script it names present, the commit step matching `commit`, no step that
//     tags, pushes, publishes a page before Publish or calls Sova, no literal address or secret, and
//     every artifact path outside the repository or ignored. Exit 0 ok, 1 problems, 2 couldn't check.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { CONTRACT_FILE, bbTasks, formatText } from "../../project-verbs/scripts/project-verbs.mjs";

export const DEFAULT_DIR = ".sova/playbooks/release";
export const MANIFEST = "release.json";

const readText = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
function sh(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
  } catch {
    return null;
  }
}
const git = (root, ...a) => sh("git", ["-C", root, ...a], root);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

async function loadShared() {
  try {
    const contract = await import(new URL("../../../shared/project-contract.ts", import.meta.url).href);
    const release = await import(new URL("../../../shared/release.ts", import.meta.url).href);
    if (typeof contract.parseDefinition !== "function" || typeof release.parseReleaseManifest !== "function") return null;
    return { contract, release };
  } catch {
    return null;
  }
}

// ---- the starter (q13: Sova's defaults, all of it the project's to change) ------------------------

/** The starter's settings section and manifest for these answers. Pure. */
export function starter({ tagOnly = false, bump = [], channels = ["stable"], tag = "v${version}", scheme = "semver", dir = DEFAULT_DIR } = {}) {
  const steps = [
    { id: "version", label: "Pick the version", phase: "prepare" },
    { id: "notes", label: "Write the release notes", phase: "prepare" },
  ];
  if (!tagOnly) {
    if (bump.length) steps.push({ id: "bump", label: "Bump the version files", phase: "prepare" });
    steps.push({ id: "commit", label: "Make the release commit", phase: "prepare" });
  }
  const release = { playbook: dir, tag, scheme, channels, commit: !tagOnly };
  return { release, manifest: { v: 1, steps }, playbook: starterPlaybook({ tagOnly, bump, tag }) };
}

/** The starter's PLAYBOOK.md: the project's additions to Sova's general method, one section per step. */
export function starterPlaybook({ tagOnly = false, bump = [], tag = "v${version}" } = {}) {
  const t = (v) => tag.replace("${version}", v);
  const lines = [
    "---",
    "title: Release (this project)",
    "description: This project's release: how its number is picked, how its notes are written, and its steps. Read after Sova's general Release method; it wins where they differ, except Sova's gates.",
    "---",
    "",
    "# Release (this project)",
    "",
    "This project's additions to Sova's general Release method, which you read first. Its steps are `release.json` in this folder, in order. Sova's starter wrote this file; every part of it is this project's to change (run the Release playbook maker again, or edit it and land it).",
    "",
    "## Version rule",
    `Semantic versions, tagged \`${t("X.Y.Z")}\`. A patch when everything since the previous release is a fix, a minor when anything adds a feature, a major when anything breaks what a user relies on (while the project is 0.x, a breaking change is a minor). Pick it yourself from the general method's \`release.mjs status\`; never ask.`,
    "",
    "## Notes",
    tagOnly
      ? "Written for someone who uses the previous release: what they get, what they must do differently. Never a list of commits. They go only to `release.notes` (Sova puts them on the numbered tag); this project keeps no changelog file."
      : "Written for someone who uses the previous release: what they get, what they must do differently, what going back costs. Never a list of commits. A new entry at the top of `CHANGELOG.md` (made if absent), headed `## " + t("X.Y.Z") + " — YYYY-MM-DD` (the release commit's date, UTC), and the same text in `release.notes`.",
    "",
    "## Steps",
    "- `version`: the number, by the version rule. Report it with its `version=` fact.",
    "- `notes`: the notes, as above; check the entry with the general method's `release.mjs changelog --version X.Y.Z`" + (tagOnly ? " (skip that check: no changelog)" : "") + ".",
  ];
  if (!tagOnly) {
    if (bump.length) lines.push(`- \`bump\`: the general method's \`release.mjs bump --version X.Y.Z\` with ${bump.map((f) => `\`--file ${f}\``).join(" ")}.`);
    lines.push(`- \`commit\`: one commit on the release branch, \`git add\` by explicit path (${[!tagOnly ? "`CHANGELOG.md`" : null, ...bump.map((f) => `\`${f}\``)].filter(Boolean).join(", ")}), message \`Release ${t("X.Y.Z")}\`. Report it with its \`version=\`, \`commit=\` and \`branch=\` facts.`);
  } else {
    lines.push("", "Tag-only: no release commit. The release is of the commit Sova started it on; Sova tags it at Publish.");
  }
  lines.push("", "## Release-only checks", "None beyond the merge queue's. Add them to the settings' `release.checks`.", "", "## After publishing", "Nothing. Add a step to `release.json` (phase `after`) and a line here for each thing this project does once a release is out.", "");
  return lines.join("\n");
}

const MANIFEST_ORDER = { top: ["v", "steps"], step: ["id", "label", "phase", "held", "artifact"] };
const sortKeys = (o, order) => Object.fromEntries([...order.filter((k) => k in o).map((k) => [k, o[k]]), ...Object.keys(o).filter((k) => !order.includes(k)).map((k) => [k, o[k]])]);
/** release.json's canonical text: keys ordered, one step per line. Throws on bad JSON. */
export function formatManifest(text) {
  const m = JSON.parse(text);
  if (!isObj(m)) return `${JSON.stringify(m)}\n`;
  const o = sortKeys(m, MANIFEST_ORDER.top);
  const steps = Array.isArray(o.steps) ? o.steps.map((s) => (isObj(s) ? sortKeys(s, MANIFEST_ORDER.step) : s)) : o.steps;
  const rest = Object.entries(o).filter(([k]) => k !== "steps");
  const head = rest.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const body = Array.isArray(steps) ? `  "steps": [${steps.length ? `\n${steps.map((s) => `    ${JSON.stringify(s).replace(/,"/g, ', "').replace(/":/g, '": ')}`).join(",\n")}\n  ` : ""}]` : `  "steps": ${JSON.stringify(steps)}`;
  return `{\n${[...head, ...(Object.prototype.hasOwnProperty.call(o, "steps") ? [body] : [])].join(",\n")}\n}\n`;
}

/** Write the starter into `root`. Refuses (returns problems, writes nothing) when any part exists. */
export function init(root, opts = {}) {
  const s = starter(opts);
  const dir = join(root, s.release.playbook);
  const defFile = join(root, CONTRACT_FILE);
  const problems = [];
  for (const f of ["PLAYBOOK.md", MANIFEST]) if (existsSync(join(dir, f))) problems.push(`${relative(root, join(dir, f))} already exists: change it by editing, never by init`);
  let def = null;
  const defText = readText(defFile);
  if (defText !== null) {
    try {
      def = JSON.parse(defText);
    } catch (err) {
      problems.push(`${CONTRACT_FILE} is not JSON: ${err.message}`);
    }
    if (isObj(def) && def.release !== undefined) problems.push(`${CONTRACT_FILE} already has a release section: change it by editing, never by init`);
  }
  if (problems.length) return { ok: false, problems, written: [] };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "PLAYBOOK.md"), s.playbook);
  writeFileSync(join(dir, MANIFEST), formatManifest(JSON.stringify(s.manifest)));
  const next = isObj(def) ? { ...def, release: s.release } : { version: 1, release: s.release };
  mkdirSync(dirname(defFile), { recursive: true });
  writeFileSync(defFile, formatText(JSON.stringify(next)));
  return { ok: true, problems: [], written: [relative(root, join(dir, "PLAYBOOK.md")), relative(root, join(dir, MANIFEST)), CONTRACT_FILE], madeDefinition: defText === null, release: s.release, manifest: s.manifest };
}

// ---- candidates (read, never run) ----------------------------------------------------------------

const VERSION_TAG = /^(.*?)(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)$/;
/** Release-like tags grouped by pattern (prefix + ${version}), newest first, and the moving tags (a non-version tag on a version tag's commit). */
export function tagCandidates(root) {
  const out = git(root, "for-each-ref", "--sort=-creatordate", "--format=%(refname:short)\t%(objecttype)\t%(*objectname)%(objectname)", "refs/tags");
  if (out === null) return { patterns: [], moving: [] };
  const rows = out.split("\n").filter(Boolean).map((l) => {
    const [tag, type, ids] = l.split("\t");
    // An annotated tag's line holds the peeled commit then the tag object; a light one only the commit.
    return { tag, annotated: type === "tag", commit: ids.slice(0, 40) };
  });
  const groups = new Map();
  const others = [];
  for (const r of rows) {
    const m = VERSION_TAG.exec(r.tag);
    if (!m || /\d$/.test(m[1])) {
      others.push(r);
      continue;
    }
    const pattern = `${m[1]}\${version}`;
    if (!groups.has(pattern)) groups.set(pattern, []);
    groups.get(pattern).push(r);
  }
  const patterns = [...groups.entries()]
    .map(([pattern, tags]) => ({ pattern, count: tags.length, newest: tags.slice(0, 3).map((t) => t.tag), annotated: tags.every((t) => t.annotated) }))
    .sort((a, b) => b.count - a.count);
  const byCommit = new Map(rows.filter((r) => !others.includes(r)).map((r) => [r.commit, r.tag]));
  const moving = others.map((o) => ({ tag: o.tag, at: byCommit.get(o.commit) ?? null })).filter((o) => o.at);
  return { patterns, moving };
}

const VERSION_FILES = [
  ["package.json", /"version"\s*:\s*"([^"]+)"/],
  ["Cargo.toml", /^\[package\][^[]*?\nversion\s*=\s*"([^"]+)"/m],
  ["pyproject.toml", /^\[(?:project|tool\.poetry)\][^[]*?\nversion\s*=\s*"([^"]+)"/m],
  ["mix.exs", /^\s*(?:@version\s+|version:\s*)"([^"]+)"/m],
  ["project.clj", /^\(defproject\s+\S+\s+"([^"]+)"/m],
  ["build.gradle", /^\s*version\s*=?\s*['"]([^'"]+)['"]/m],
  ["build.gradle.kts", /^\s*version\s*=\s*"([^"]+)"/m],
  ["pom.xml", /<\/parent>[\s\S]*?<version>([^<]+)<\/version>|^\s{2,4}<version>([^<]+)<\/version>/m],
  ["VERSION", /^\s*v?(\d+\.\d+\.\d+\S*)\s*$/],
  ["version.txt", /^\s*v?(\d+\.\d+\.\d+\S*)\s*$/],
  ["build.clj", /\(def\s+version\s+"([^"]+)"/m],
];
const CHANGELOGS = ["CHANGELOG.md", "CHANGES.md", "NEWS.md", "HISTORY.md", "RELEASES.md", "CHANGELOG", "NEWS"];
const RELEASE_WORD = /\b(release|publish|version|bump|changeset|tag)\b/i;
const RELEASE_CONFIGS = [".goreleaser.yml", ".goreleaser.yaml", ".releaserc", ".releaserc.json", ".releaserc.yml", "release.config.js", "release.config.cjs", "release-please-config.json", ".release-please-manifest.json", "cliff.toml", ".changeset/config.json", ".versionrc", ".versionrc.json", "lerna.json"];
const BUILD_DIRS = ["dist", "build", "target", "out", "release", "releases", "artifacts", "bin"];

export function candidates(root) {
  const head = git(root, "rev-parse", "HEAD")?.trim();
  if (!head) return null;
  const files = (git(root, "ls-files") ?? "").split("\n").filter(Boolean);
  const has = new Set(files);
  const at = (f) => (has.has(f) ? readText(join(root, f)) : null);

  const versions = [];
  for (const [name, re] of VERSION_FILES)
    for (const f of files.filter((x) => x === name || x.endsWith(`/${name}`)).filter((x) => x.split("/").length <= 3 && !/node_modules\//.test(x))) {
      const m = re.exec(at(f) ?? "");
      if (m) versions.push({ file: f, version: m[1] ?? m[2] });
    }
  for (const f of files.filter((x) => /(^|\/)(__init__|_version|version)\.py$/.test(x)).slice(0, 5)) {
    const m = /__version__\s*=\s*["']([^"']+)["']/.exec(at(f) ?? "");
    if (m) versions.push({ file: f, version: m[1] });
  }

  const changelogs = [];
  for (const f of CHANGELOGS) {
    const text = at(f);
    if (text === null) continue;
    const heads = text.split("\n").filter((l) => /^#{1,3}\s/.test(l)).slice(0, 3);
    changelogs.push({ file: f, headings: heads });
  }

  const automation = [];
  const pkg = at("package.json");
  if (pkg) {
    try {
      const p = JSON.parse(pkg);
      for (const [k, v] of Object.entries(p.scripts ?? {})) if (RELEASE_WORD.test(k) || /\b(npm|pnpm|yarn) publish\b|semantic-release|changeset|standard-version|release-it/.test(String(v))) automation.push(`package.json script ${k}: ${v}`);
      if (p.private !== true && p.name) automation.push(`package.json is publishable to a registry (name ${p.name}${p.publishConfig ? ", publishConfig set" : ""})`);
    } catch {}
  }
  const bb = at("bb.edn");
  if (bb) for (const t of bbTasks(bb)) if (RELEASE_WORD.test(t.name) || (t.doc && RELEASE_WORD.test(t.doc))) automation.push(`bb ${t.name}${t.doc ? ` — ${t.doc}` : ""}`);
  for (const mf of ["Makefile", "justfile"]) {
    const text = at(mf);
    if (!text) continue;
    for (const m of text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gm)) if (RELEASE_WORD.test(m[1])) automation.push(`${mf === "Makefile" ? "make" : "just"} ${m[1]}`);
  }
  for (const f of files) if (/(^|\/)[^/]*(release|publish|bump|version)[^/]*\.(sh|bb|mjs|js|ts|py|rb|clj)$/i.test(f) && !/node_modules\/|(^|\/)(test|tests|__tests__)\//.test(f) && !f.startsWith(".sova/") && !f.endsWith(".test.ts")) automation.push(f);
  for (const f of RELEASE_CONFIGS) if (has.has(f)) automation.push(`${f} (release tooling)`);
  for (const f of files.filter((x) => /^\.github\/workflows\/.+\.ya?ml$/.test(x))) {
    const text = at(f) ?? "";
    if (/^\s*tags\s*:/m.test(text) || /^\s*release\s*:/m.test(text) || /\bon:\s*\[?[^\n]*\brelease\b/.test(text)) automation.push(`${f} (runs on a tag or a release)`);
  }
  const gl = at(".gitlab-ci.yml");
  if (gl && /CI_COMMIT_TAG|only:\s*\n\s*-\s*tags/.test(gl)) automation.push(".gitlab-ci.yml (runs on a tag)");

  const remotes = (git(root, "remote") ?? "").split("\n").filter(Boolean);
  const ignored = BUILD_DIRS.filter((d) => {
    try {
      execFileSync("git", ["-C", root, "check-ignore", "-q", "--", `${d}/x`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });

  let def = null;
  const shown = git(root, "show", `HEAD:${CONTRACT_FILE}`);
  if (shown) {
    try {
      def = JSON.parse(shown);
    } catch {}
  }
  const mergeChecks = Array.isArray(def?.merge?.checks) ? def.merge.checks.filter(isObj).map((c) => ({ id: c.id, label: c.label ?? c.id, optional: c.optional === true })) : [];
  const deployTargets = isObj(def?.deploy?.targets) ? Object.keys(def.deploy.targets) : [];
  const pushes = def?.merge ? def.merge.push !== false && remotes.includes("origin") : remotes.includes("origin");
  const existing = { settings: isObj(def?.release) ? def.release : null, playbook: null };
  const dir = typeof def?.release?.playbook === "string" ? def.release.playbook : DEFAULT_DIR;
  if (existsSync(join(root, dir))) existing.playbook = { dir, files: readdirSync(join(root, dir)).sort() };

  return { root, head, tags: tagCandidates(root), versions, changelogs, automation: [...new Set(automation)], remotes, pushes, ignored, mergeChecks, deployTargets, definition: !!shown, existing };
}

// ---- check ---------------------------------------------------------------------------------------

const IPV4 = /(^|[^\d.])((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/;
const USER_AT_HOST = /\b[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]*[A-Za-z]\b/;
const SECRETISH = /(token|secret|password|passwd|apikey|api_key|bearer)\s*[=:]\s*["']?[A-Za-z0-9_\-./+]{12,}|\b(ghp|gho|github_pat|sk|xox[bpa])[-_][A-Za-z0-9_]{12,}/i;
/** What a release step's code must never do: each is Sova's (Publish, Withdraw, the freeze) or the operator's. */
const FORBIDDEN = [
  [/\bgit\s+push\b/, "pushes: Sova's Publish is the only push of a release"],
  [/\bgit\s+tag\s+(?!(-l|--list|-n\d*|--contains|--no-contains|--points-at|--merged|--no-merged|--sort|-v|--verify|--column|--format)\b)\S/, "creates or moves a tag: Sova's Publish makes the numbered tag and moves the channels"],
  [/\bgit\s+update-ref\s+(-d\s+)?refs\/(tags|heads)\//, "moves a ref by hand: Sova's queue and Publish own them"],
  [/\bgh\s+release\s+create\b(?![^\n]*--verify-tag)/, "creates a release page without --verify-tag, which would make the tag itself"],
  [/\bgh\s+release\s+(delete|upload\s+--clobber)\b/, "deletes or overwrites a published release's page or files"],
  [/\bgit\s+(reset\s+--hard|checkout\s+-B|branch\s+-f)\b/, "resets a branch: never in a release, abandon is Sova's"],
  [/\bsova-project\b|scripts\/sova-project\.mjs|\/api\/project-services\b|\bSOVA_TOKEN\b|auth-token/, "calls Sova as the operator: a step reports only through the release chat's own release.step"],
  [/\bmerge\.(pause|resume)\b/, "pauses or resumes the merge queue: the release freeze replaces it"],
];

/** The command text in a markdown file: fenced blocks, and inline code on lines that don't say never/don't. */
export function codeOf(md) {
  const out = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) out.push(line);
    else if (!/\b(never|don't|do not|not|refuse[sd]?|no)\b/i.test(line)) for (const m of line.matchAll(/`([^`]+)`/g)) out.push(m[1]);
  }
  return out.join("\n");
}

/** Problems in one text (code only), named by where. Pure. */
export function textProblems(where, code) {
  const problems = [];
  for (const [re, why] of FORBIDDEN) if (re.test(code)) problems.push(`${where}: ${why} (${(code.match(re) ?? [""])[0].trim()})`);
  const plain = code.replace(/\$\{[^}]*\}/g, "");
  if (IPV4.test(plain)) problems.push(`${where}: a literal IP address; name it, and keep the value off the repository`);
  if (SECRETISH.test(code)) problems.push(`${where}: a value that looks like a secret; name credentials, never write them`);
  return problems;
}

function walk(dir, base = dir) {
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p, base));
    else if (s.isFile()) out.push(relative(base, p));
  }
  return out;
}

const expandHome = (p) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
/** Artifact paths the playbook names (`release.mjs artifact <path>`), as written. */
export const artifactPaths = (text) => [...text.matchAll(/release\.mjs\s+artifact\s+["']?([^\s"'`]+)/g)].map((m) => m[1]);

export async function check(root) {
  const shared = await loadShared();
  if (!shared) return { ok: false, fatal: true, problems: ["Sova's parsers (shared/project-contract.ts, shared/release.ts) could not be loaded: run this from Sova's playbooks/ folder"], notes: [] };
  const problems = [];
  const notes = [];
  const defFile = join(root, CONTRACT_FILE);
  const defText = readText(defFile);
  if (defText === null) return { ok: false, fatal: false, problems: [`${CONTRACT_FILE} is missing: the release settings live there (init writes them)`], notes };
  let def;
  try {
    def = shared.contract.parseDefinition(defText);
  } catch (err) {
    return { ok: false, fatal: false, problems: [`${CONTRACT_FILE}: ${err instanceof Error ? err.message : String(err)}`], notes };
  }
  if (!def.release) return { ok: false, fatal: false, problems: [`${CONTRACT_FILE}: $.release: no release section (releases are not set up)`], notes };
  const r = def.release;
  try {
    if (formatText(defText) !== defText) problems.push(`${CONTRACT_FILE}: not in canonical form: run fmt`);
  } catch {}

  const dir = join(root, r.playbook);
  const entry = readText(join(dir, "PLAYBOOK.md"));
  if (entry === null) problems.push(`${r.playbook}/PLAYBOOK.md is missing: the release chat reads it after Sova's method`);
  const mText = readText(join(dir, MANIFEST));
  let manifest = null;
  if (mText === null) problems.push(`${r.playbook}/${MANIFEST} is missing: it is the release's step list`);
  else {
    try {
      manifest = shared.release.parseReleaseManifest(mText);
      if (formatManifest(mText) !== mText) problems.push(`${r.playbook}/${MANIFEST}: not in canonical form: run fmt`);
    } catch (err) {
      problems.push(`${r.playbook}/${MANIFEST}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (manifest) {
    const ids = manifest.steps.map((s) => s.id);
    const commitStep = manifest.steps.find((s) => s.id === "commit");
    if (r.commit && !commitStep) problems.push(`${MANIFEST}: release.commit is true, so a prepare step "commit" must make the release commit (Sova queues it from that step's commit= fact)`);
    if (r.commit && commitStep && commitStep.phase !== "prepare") problems.push(`${MANIFEST}: the "commit" step must be a prepare step`);
    if (!r.commit && commitStep) problems.push(`${MANIFEST}: release.commit is false (tag-only), yet a "commit" step is declared: drop it, or set commit to true`);
    if (!ids.includes("version")) notes.push(`${MANIFEST}: no "version" step; some step must still report the version= fact before Sova's checks`);
    if (entry !== null) for (const id of ids) if (!entry.includes(`\`${id}\``)) problems.push(`${r.playbook}/PLAYBOOK.md never names the step \`${id}\`: say what it does`);
    if (!manifest.steps.some((s) => s.phase === "after")) notes.push("no after-publish steps: Publish is the release's last step");
    for (const s of manifest.steps.filter((x) => x.artifact)) if (entry !== null && !/release\.mjs\s+artifact\b/.test(entry)) problems.push(`${s.id} is an artifact step, yet PLAYBOOK.md never says where the artifact goes (release.mjs artifact <path>)`);
    for (const s of manifest.steps.filter((x) => x.held)) notes.push(`${s.id} is held: the release waits there for the operator's Continue`);
  }
  if (!r.channels.length) notes.push("no channels: Publish makes the numbered tag and moves nothing");
  if (!r.checkIds.length) notes.push("no release-only checks: the release entry runs the merge queue's required checks only");
  const remotes = (git(root, "remote") ?? "").split("\n").filter(Boolean);
  const pushes = def.merge ? def.merge.push !== false && remotes.includes("origin") : remotes.includes("origin");
  notes.push(pushes ? "Publish pushes the target, the tag and the channels to origin in one atomic push" : "local-only: Publish tags and moves the channels on this machine and pushes nothing");

  // What the parsers can't see: every file of the playbook folder.
  if (existsSync(dir)) {
    for (const f of walk(dir)) {
      const text = readText(join(dir, f));
      if (text === null || text.includes("\u0000")) continue;
      const where = `${r.playbook}/${f}`;
      const code = f.endsWith(".md") ? codeOf(text) : f.endsWith(".json") ? "" : text;
      problems.push(...textProblems(where, code));
      if (f.endsWith(".md")) {
        for (const m of text.matchAll(/(?<![\w./-])((?:scripts|references)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]+)/g))
          if (!existsSync(join(dir, m[1]))) problems.push(`${where} names ${m[1]}, which this folder doesn't have`);
        if (SECRETISH.test(text)) problems.push(`${where}: a value that looks like a secret`);
      }
      for (const p of artifactPaths(text)) {
        const literal = expandHome(p.split("${")[0].replace(/X\.Y\.Z.*$/, ""));
        if (!literal) continue;
        const abs = resolve(root, literal);
        const rel = relative(root, abs);
        if (rel.startsWith("..") || isAbsolute(rel)) continue;
        const probe = rel === "" ? "x" : `${rel.replace(/\/$/, "")}${literal.endsWith("/") ? "/x" : ""}`;
        let ignoredPath = false;
        try {
          execFileSync("git", ["-C", root, "check-ignore", "-q", "--", probe], { stdio: "ignore" });
          ignoredPath = true;
        } catch {}
        if (!ignoredPath) problems.push(`${where}: the artifact path ${p} is inside the repository and not ignored: artifacts are never committed (add it to .gitignore, or build outside the repository)`);
      }
    }
  }
  return { ok: problems.length === 0, fatal: false, problems, notes, release: { playbook: r.playbook, tag: r.tag, scheme: r.scheme, channels: r.channels, commit: r.commit, checks: r.checkIds, quietMin: r.quietMin }, steps: manifest?.steps ?? [] };
}

// ---- CLI ------------------------------------------------------------------------------------------

function args(list) {
  const o = { _: [], bump: [], channel: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (["--json", "--check", "--tag-only", "--no-channel"].includes(a)) o[a.slice(2)] = true;
    else if (a === "--bump" || a === "--channel") o[a.slice(2)].push(list[++i]);
    else if (["--root", "--tag", "--scheme", "--dir"].includes(a)) o[a.slice(2)] = list[++i];
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
    console.error(`release-maker: ${err.message}`);
    return 2;
  }
  const root = o.root ? resolve(o.root) : git(process.cwd(), "rev-parse", "--show-toplevel")?.trim();
  if (!root) return (console.error("release-maker: not inside a git checkout (pass --root)"), 2);
  const print = (v, digest) => console.log(o.json ? JSON.stringify(v, null, 2) : digest(v));

  if (cmd === "candidates") {
    const r = candidates(root);
    if (!r) return (console.error("release-maker: can't read the repository's HEAD"), 2);
    print(r, (x) =>
      [
        `release-maker candidates: ${x.root} at ${x.head.slice(0, 12)} (offer them, quoted; never run them)`,
        "release tags:",
        ...(x.tags.patterns.length ? x.tags.patterns.map((p) => `  ${p.pattern}: ${p.count} tag(s), newest ${p.newest.join(", ")}${p.annotated ? "" : " (some lightweight)"}`) : ["  none: a first release"]),
        ...(x.tags.moving.length ? [`moving tags: ${x.tags.moving.map((m) => `${m.tag} → ${m.at}`).join(", ")}`] : ["moving tags: none"]),
        "files holding a version:",
        ...(x.versions.length ? x.versions.map((v) => `  ${v.file}: ${v.version}`) : ["  none found"]),
        "changelogs:",
        ...(x.changelogs.length ? x.changelogs.map((c) => `  ${c.file}${c.headings.length ? `: ${c.headings.join(" | ")}` : ""}`) : ["  none found"]),
        "release automation:",
        ...(x.automation.length ? x.automation.map((a) => `  ${a}`) : ["  none found: ask how they release today"]),
        `remotes: ${x.remotes.length ? x.remotes.join(", ") : "none (local-only)"}; Publish would ${x.pushes ? "push to origin" : "push nothing"}`,
        `ignored build folders: ${x.ignored.length ? x.ignored.join(", ") : "none"}`,
        `merge checks (may gate a release): ${x.mergeChecks.length ? x.mergeChecks.map((c) => `${c.id}${c.optional ? " (optional)" : ""}`).join(", ") : "none"}`,
        `deploy targets (offered after Publish): ${x.deployTargets.length ? x.deployTargets.join(", ") : "none"}`,
        `definition: ${x.definition ? CONTRACT_FILE : "none (init makes one holding only release)"}`,
        `release settings: ${x.existing.settings ? JSON.stringify(x.existing.settings) : "none (releases not set up)"}`,
        `release playbook: ${x.existing.playbook ? `${x.existing.playbook.dir} (${x.existing.playbook.files.join(", ")})` : "none"}`,
      ].join("\n"),
    );
    return 0;
  }
  if (cmd === "init") {
    const channels = o["no-channel"] ? [] : o.channel.length ? o.channel : ["stable"];
    const r = init(root, { tagOnly: !!o["tag-only"], bump: o.bump, channels, ...(o.tag ? { tag: o.tag } : {}), ...(o.scheme ? { scheme: o.scheme } : {}), ...(o.dir ? { dir: o.dir } : {}) });
    print(r, (x) => (x.ok ? [`release-maker init: wrote ${x.written.join(", ")}${x.madeDefinition ? ` (${CONTRACT_FILE} made, holding only release)` : ""}`, "every part of it is the project's: edit it to fit, then check"].join("\n") : x.problems.map((p) => `release-maker init: problem: ${p}`).join("\n")));
    return r.ok ? 0 : 1;
  }
  if (cmd === "fmt") {
    let code = 0;
    const defFile = join(root, CONTRACT_FILE);
    const files = [[defFile, formatText]];
    const defText = readText(defFile);
    let dir = DEFAULT_DIR;
    try {
      if (defText && typeof JSON.parse(defText)?.release?.playbook === "string") dir = JSON.parse(defText).release.playbook;
    } catch {}
    files.push([join(root, dir, MANIFEST), formatManifest]);
    for (const [file, fmt] of files) {
      const text = readText(file);
      if (text === null) continue;
      let out;
      try {
        out = fmt(text);
      } catch (err) {
        console.log(`release-maker fmt: ${relative(root, file)} is not JSON: ${err.message}`);
        code = 1;
        continue;
      }
      if (out === text) console.log(`release-maker fmt: ${relative(root, file)} is canonical`);
      else if (o.check) (console.log(`release-maker fmt: ${relative(root, file)} is not canonical (run fmt without --check)`), (code = 1));
      else (writeFileSync(file, out), console.log(`release-maker fmt: rewrote ${relative(root, file)}`));
    }
    return code;
  }
  if (cmd === "check") {
    const r = await check(root);
    print(r, (x) =>
      [
        `release-maker check: ${root}: ${x.ok ? "ok" : `${x.problems.length} problem(s)`}${x.release ? ` — ${x.release.playbook}, tag ${x.release.tag}, ${x.steps.length} step(s)` : ""}`,
        ...x.problems.map((p) => `  problem: ${p}`),
        ...x.notes.map((n) => `  note: ${n}`),
      ].join("\n"),
    );
    return r.fatal ? 2 : r.ok ? 0 : 1;
  }
  console.error("usage: release-maker <candidates|init|fmt|check> … (see the header of scripts/release-maker.mjs)");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().then((code) => process.exit(code));
}
