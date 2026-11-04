import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseDefinition } from "../shared/project-contract";
import { parseReleaseManifest } from "../shared/release";
import { defHashOf } from "./project-services/def-hash";
// @ts-expect-error: a plain .mjs driver, no types
import * as maker from "../playbooks/release-maker/scripts/release-maker.mjs";
// @ts-expect-error: a plain .mjs driver, no types
import { formatText } from "../playbooks/project-verbs/scripts/project-verbs.mjs";
// @ts-expect-error: a plain .mjs driver, no types
import * as sr from "../.sova/playbooks/release/scripts/sova-release.mjs";

/**
 * Sova's own release setup: its `release` section and `site` deploy target (in .sova/project.json), its project release
 * playbook (.sova/playbooks/release) and that playbook's driver, scripts/sova-release.mjs. Scratch repositories in a temp
 * dir; nothing here tags, pushes, deploys or runs a release check. The cases that run the driver as a program:
 * sova-release-playbook.integration.test.ts.
 */

const ROOT = join(import.meta.dirname, "..");
const DEFINITION = ".sova/project.json";
const dir = mkdtempSync(join(tmpdir(), "sova-release-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=master", "-c", "tag.gpgSign=false", ...a], { cwd, stdio: "pipe", encoding: "utf8" });

/** Sova's definition as committed, its `release` and `deploy` sections included. */
const definitionText = () => readFileSync(join(ROOT, DEFINITION), "utf8");

/** The definition without `release` and `deploy`: what Sova's copies hashed before the sections moved in. */
const withoutReleaseSections = () => {
  const { release: _r, deploy: _d, ...rest } = JSON.parse(definitionText());
  return parseDefinition(JSON.stringify(rest));
};

test("Sova's release settings and site target are in .sova/project.json, parse, and leave the definition's hash as it was", () => {
  assert.equal(existsSync(join(ROOT, ".sova/playbooks/release/project-sections.json")), false, "the waiting fragment is gone");
  const def = parseDefinition(definitionText());
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
  assert.equal(defHashOf(def), defHashOf(withoutReleaseSections()), "the release and deploy sections stay outside the definition's hash");
  let base: string | null = null;
  try {
    base = git(ROOT, "show", "5ea4b141f:.sova/project.json");
  } catch {}
  if (base !== null) assert.equal(defHashOf(def), defHashOf(parseDefinition(base)));
});

test("every sova-release.mjs subcommand Sova's definition names exists, and the release check passes on Sova's setup", async () => {
  const def = JSON.parse(definitionText());
  const runs: string[][] = [
    ...def.release.checks.map((c: { run: string[] }) => c.run),
    ...Object.values(def.deploy.targets as Record<string, { build?: { run: string[] }[]; steps: { run: string[] }[]; credentials?: { check: string[] }[] }>).flatMap((t) => [...(t.build ?? []).map((s) => s.run), ...t.steps.map((s) => s.run), ...(t.credentials ?? []).map((c) => c.check)]),
  ];
  const known: string[] = sr.SUBCOMMANDS;
  const named = runs.filter((r) => r.includes(".sova/playbooks/release/scripts/sova-release.mjs")).map((r) => r[r.indexOf(".sova/playbooks/release/scripts/sova-release.mjs") + 1]!);
  assert.ok(named.length >= 7);
  for (const c of named) assert.ok(known.includes(c), `${c} is not a sova-release.mjs subcommand`);
  const manifest = parseReleaseManifest(readFileSync(join(ROOT, ".sova/playbooks/release/release.json"), "utf8"));
  const prepare = manifest.steps.filter((s) => s.phase === "prepare").map((s) => s.id);
  assert.equal(prepare.at(-1), "commit", "the commit step is the last prepare step");
  // The committed definition is in canonical form; a scratch repository holds it and Sova's playbook folder.
  assert.equal(formatText(definitionText()), definitionText(), "run release-maker fmt on .sova/project.json");
  const r = mkdtempSync(join(dir, "check-"));
  git(r, "init", "-q");
  cpSync(join(ROOT, ".sova/playbooks/release"), join(r, ".sova/playbooks/release"), { recursive: true });
  writeFileSync(join(r, ".sova/project.json"), definitionText());
  const out = await maker.check(r);
  assert.deepEqual(out.problems, []);
  assert.equal(out.ok, true);
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

test("the Docs step runs every release and finishes on its own; the Release Note is the operator's word, an ask only context", () => {
  const manifest = parseReleaseManifest(readFileSync(join(ROOT, ".sova/playbooks/release/release.json"), "utf8"));
  const docs = manifest.steps.find((s) => s.id === "docs");
  assert.ok(docs);
  assert.notEqual(docs.held, true, "the docs step is not held");
  const playbook = readFileSync(join(ROOT, ".sova/playbooks/release/PLAYBOOK.md"), "utf8");
  const ref = readFileSync(join(ROOT, ".sova/playbooks/release/references/docs.md"), "utf8");
  const general = readFileSync(join(ROOT, "playbooks/release/PLAYBOOK.md"), "utf8");
  const docsBullet = playbook.slice(playbook.indexOf("- `docs`:"), playbook.indexOf("- `commit`:"));
  assert.match(docsBullet, /every release unless the operator's Release Note/);
  for (const text of [docsBullet, ref]) {
    assert.doesNotMatch(text, /skipped\*\* unless|only when the start reason|step `held`|End your turn/);
  }
  assert.match(ref, /Report the step `done`, never `held`/);
  assert.match(ref, /new feature, by default/i);
  // A new page's record is made official on the release branch: promote, then commit the claims by explicit path.
  assert.match(ref, /sova-spec-draft\.mjs" promote <draft> --all --write/);
  assert.match(ref, /commit the claims files .* by explicit path\) in a commit of their own, before the page's commit and the release commit/);
  assert.match(playbook, /Release Note[^\n]*names[^\n]*wins over this rule/);
  assert.match(playbook, /An ask[^\n]*context only[^\n]*Never take a version from it/);
  assert.match(general, /operator's Release Note/);
  assert.match(general, /ask from a Project Assistant or an overseer is separate from the note/);
});
