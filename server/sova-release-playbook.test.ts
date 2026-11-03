import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseDefinition } from "../shared/project-contract";
import { parseReleaseManifest } from "../shared/release";
import { defHashOf } from "./project-services/def-hash";
// @ts-expect-error: a plain .mjs driver, no types
import * as maker from "../playbooks/release-maker/scripts/release-maker.mjs";
// @ts-expect-error: a plain .mjs driver, no types
import * as sr from "../.sova/playbooks/release/scripts/sova-release.mjs";

/**
 * Sova's own release setup: its `release` section and `site` deploy target in .sova/project.json, its project release
 * playbook (.sova/playbooks/release) and that playbook's driver, scripts/sova-release.mjs. Scratch repositories in a temp
 * dir; nothing here tags, pushes, deploys or runs a release check.
 */

const ROOT = join(import.meta.dirname, "..");
const DRIVER = join(ROOT, ".sova/playbooks/release/scripts/sova-release.mjs");
const dir = mkdtempSync(join(tmpdir(), "sova-release-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=master", "-c", "tag.gpgSign=false", ...a], { cwd, stdio: "pipe", encoding: "utf8" });

test("Sova's definition declares its release and the site target, and its definition hash is what it was before them", () => {
  const text = readFileSync(join(ROOT, ".sova/project.json"), "utf8");
  const def = parseDefinition(text);
  assert.equal(def.release?.playbook, ".sova/playbooks/release");
  assert.deepEqual(def.release?.channels, ["stable"]);
  assert.equal(def.release?.commit, true);
  assert.deepEqual(def.release?.checkIds, ["release-notes", "release-integration", "release-extensions", "release-spec-replay", "release-site", "release-spec", "release-leaks"]);
  const site = def.deploy?.targets.find((t) => t.name === "site");
  assert.ok(site);
  assert.equal(site.releases, "only");
  assert.deepEqual(site.requires, { tests: "none" });
  // No host names: an unset one would fail every copy's doctor and conform, and `host` is inside the hash.
  assert.deepEqual(def.host, []);
  let base: string | null = null;
  try {
    base = git(ROOT, "show", "5ea4b141f:.sova/project.json");
  } catch {}
  if (base !== null) assert.equal(defHashOf(def), defHashOf(parseDefinition(base)), "the release and deploy sections stay outside the definition's hash");
  const bare = JSON.parse(text);
  delete bare.release;
  delete bare.deploy;
  assert.equal(defHashOf(def), defHashOf(parseDefinition(JSON.stringify(bare))));
});

test("every sova-release.mjs subcommand the definition names exists, and the release check passes on Sova's own setup", async () => {
  const def = JSON.parse(readFileSync(join(ROOT, ".sova/project.json"), "utf8"));
  const runs: string[][] = [
    ...def.release.checks.map((c: { run: string[] }) => c.run),
    ...Object.values(def.deploy.targets as Record<string, { build?: { run: string[] }[]; steps: { run: string[] }[]; credentials?: { check: string[] }[] }>).flatMap((t) => [...(t.build ?? []).map((s) => s.run), ...t.steps.map((s) => s.run), ...(t.credentials ?? []).map((c) => c.check)]),
  ];
  const usage = spawnSync(process.execPath, [DRIVER, "nope"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  const known = /<([a-z|-]+)>/.exec(usage.stderr)![1]!.split("|");
  const named = runs.filter((r) => r.includes(".sova/playbooks/release/scripts/sova-release.mjs")).map((r) => r[r.indexOf(".sova/playbooks/release/scripts/sova-release.mjs") + 1]!);
  assert.ok(named.length >= 7);
  for (const c of named) assert.ok(known.includes(c), `${c} is not a sova-release.mjs subcommand`);
  const manifest = parseReleaseManifest(readFileSync(join(ROOT, ".sova/playbooks/release/release.json"), "utf8"));
  const prepare = manifest.steps.filter((s) => s.phase === "prepare").map((s) => s.id);
  assert.equal(prepare.at(-1), "commit", "the commit step is the last prepare step");
  const out = await maker.check(ROOT);
  assert.deepEqual(out.problems, []);
  assert.equal(out.ok, true);
});

test("env-set answers by exit code and never prints the value", () => {
  const set = spawnSync(process.execPath, [DRIVER, "env-set", "SOVA_TEST_SITE_PROJECT"], { encoding: "utf8", env: { ...process.env, SOVA_TEST_SITE_PROJECT: "pages-project-secretish" } });
  assert.equal(set.status, 0);
  assert.ok(!(set.stdout + set.stderr).includes("pages-project-secretish"));
  const unset = spawnSync(process.execPath, [DRIVER, "env-set", "SOVA_TEST_SITE_PROJECT"], { encoding: "utf8", env: { ...process.env, SOVA_TEST_SITE_PROJECT: "" } });
  assert.equal(unset.status, 1);
});

/** A scratch tree shaped like Sova's: package.json, site.ts, a pinned example, a vNEXT page, a changelog, v0.1.0 tagged. */
function tree(): string {
  const r = mkdtempSync(join(dir, "t-"));
  git(r, "init", "-q");
  mkdirSync(join(r, "site/src/data"), { recursive: true });
  mkdirSync(join(r, "site/src/content/docs"), { recursive: true });
  mkdirSync(join(r, "docs"), { recursive: true });
  writeFileSync(join(r, "package.json"), `${JSON.stringify({ name: "sova", version: "0.1.0", devDependencies: { x: "1.0.0" } }, null, 2)}\n`);
  writeFileSync(join(r, "site/src/data/site.ts"), 'export const release = "v0.1.0";\nexport const installRef = "stable";\nexport const verified = { ref: "master", rev: "0ba0e92c", date: "2026-10-13" };\nexport const docsVerified = { rev: "094c968e", date: "2026-10-16" };\n');
  writeFileSync(join(r, "site/src/content/docs/install.md"), "Pin one: `SOVA_REF=v0.1.0 bash`.\n");
  writeFileSync(join(r, "docs/feature.md"), "Available from vNEXT or later.\n");
  writeFileSync(join(r, "README.md"), "Install.\n");
  writeFileSync(join(r, "CHANGELOG.md"), "# Changelog\n\n## v0.1.0 — 2026-10-01\n\nFirst.\n");
  git(r, "add", "-A");
  git(r, "commit", "-qm", "base");
  git(r, "tag", "-a", "v0.1.0", "-m", "v0.1.0");
  git(r, "commit", "-q", "--allow-empty", "-m", "feat: more");
  return r;
}

test("prev finds the previous release from HEAD; bump sets the version in each of its places and nothing else", () => {
  const r = tree();
  assert.equal(sr.prevRelease(r), "v0.1.0");
  const dry = sr.bump(r, "0.2.0", { check: true });
  assert.equal(dry.ok, true);
  assert.equal(readFileSync(join(r, "package.json"), "utf8").includes('"version": "0.1.0"'), true, "--check writes nothing");
  assert.deepEqual(dry.results.filter((x: { changed?: boolean }) => x.changed).map((x: { file: string }) => x.file).sort(), ["docs/feature.md", "package.json", "site/src/content/docs/install.md", "site/src/data/site.ts"]);
  assert.equal(sr.bump(r, "0.2.0").ok, true);
  const pkg = JSON.parse(readFileSync(join(r, "package.json"), "utf8"));
  assert.equal(pkg.version, "0.2.0");
  assert.equal(pkg.devDependencies.x, "1.0.0");
  assert.match(readFileSync(join(r, "site/src/data/site.ts"), "utf8"), /^export const release = "v0\.2\.0";$/m);
  assert.match(readFileSync(join(r, "site/src/data/site.ts"), "utf8"), /installRef = "stable"/);
  assert.equal(readFileSync(join(r, "site/src/content/docs/install.md"), "utf8"), "Pin one: `SOVA_REF=v0.2.0 bash`.\n");
  assert.equal(readFileSync(join(r, "docs/feature.md"), "utf8"), "Available from v0.2.0 or later.\n");
  assert.equal(sr.bump(r, "not-a-version").ok, false);
  // Tagged at HEAD (a release check after Publish): the previous release is still the one before it.
  git(r, "tag", "-a", "v0.2.0", "-m", "v0.2.0");
  assert.equal(sr.prevRelease(r), "v0.1.0");
});

test("stamps set only the stamp asked for, from a checked commit", () => {
  const text = 'export const verified = { ref: "master", rev: "0ba0e92c", date: "2026-10-13" };\nexport const docsVerified = { rev: "094c968e", date: "2026-10-16" };\n';
  const l = sr.stampText(text, "landing", { rev: "abc1234", version: "0.2.0", date: "2026-11-03" });
  assert.equal(l.text, 'export const verified = { ref: "v0.2.0", rev: "abc1234", date: "2026-11-03" };\nexport const docsVerified = { rev: "094c968e", date: "2026-10-16" };\n');
  const d = sr.stampText(text, "docs", { rev: "abc1234", date: "2026-11-03" });
  assert.match(d.text, /^export const docsVerified = \{ rev: "abc1234", date: "2026-11-03" \};$/m);
  assert.match(d.text, /ref: "master"/);
  assert.ok(sr.stampText(text, "landing", { rev: "abc1234", date: "x" }).error, "the landing stamp names its release");
  assert.ok(sr.stampText(text, "docs", { rev: "HEAD", date: "x" }).error, "a rev is a commit");
});

test("the release checks' pure parts: the dated changelog entry, the built landing, new spec findings, the live head", () => {
  const cl = "# Changelog\n\n## v0.2.0 — 2026-11-03\n\nNew things.\n\n## v0.1.0 — 2026-10-01\n\nFirst.\n";
  assert.deepEqual(sr.changelogProblem(cl, "0.2.0"), { ok: true, body: "New things.", date: "2026-11-03" });
  assert.equal(sr.changelogProblem(cl.replace("2026-11-03", "RELEASE-DATE"), "0.2.0").ok, false);
  assert.equal(sr.changelogProblem(cl.replace("## v0.2.0 — 2026-11-03", "## v0.2.0"), "0.2.0").ok, false);
  assert.equal(sr.changelogProblem(cl + "\n## v0.2.0 — 2026-11-04\n\nAgain.\n", "0.2.0").ok, false);
  assert.equal(sr.changelogProblem(cl, "0.3.0").ok, false);
  const html = '<a href="https://raw.githubusercontent.com/Naomarik/sova/stable/scripts/install.sh">x</a><a href="https://github.com/Naomarik/sova/releases/tag/v0.2.0">v0.2.0</a>';
  assert.deepEqual(sr.landingProblems(html, "v0.2.0"), []);
  assert.equal(sr.landingProblems(html, "v0.3.0").length, 1);
  assert.equal(sr.landingProblems("", "v0.2.0").length, 2);
  const f = (code: string, id: string) => ({ code, id, message: `${code} ${id} (n=3)` });
  assert.deepEqual(sr.newFindings([f("code-missing", "§a"), f("requires-uninvestigated", "§b")], [f("requires-uninvestigated", "§b"), f("code-missing", "§a")]), []);
  assert.deepEqual(sr.newFindings([f("x", "§a")], [f("x", "§a"), f("x", "§a"), f("y", "§c")]).map(sr.findingKey), ["x §a", "y §c"]);
  assert.equal(sr.sameCommit("abc1234", "abc1234def"), true);
  assert.equal(sr.sameCommit("abc1234def", "abc1234"), true);
  assert.equal(sr.sameCommit("abc", "abc"), false);
  assert.equal(sr.sameCommit("abc1234", "abc1235"), false);
});

test("site-video never fails a deploy: without SOVA_SITE_VIDEO_DIR it ships without the video and says so", () => {
  const r = mkdtempSync(join(dir, "v-"));
  const out = spawnSync(process.execPath, [DRIVER, "site-video", r], { encoding: "utf8", env: { ...process.env, SOVA_SITE_VIDEO_DIR: "" } });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /without its hero video/);
  const pages = spawnSync(process.execPath, [DRIVER, "site-pages", "abc1234"], { encoding: "utf8", env: { ...process.env, SOVA_SITE_PAGES_PROJECT: "" }, cwd: r });
  assert.equal(pages.status, 2, "no Pages project: nothing uploaded");
});
