import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { listPlaybooks } from "./playbooks";
import { parseDefinition } from "../shared/project-contract";
import { parseFacts, parseReleaseManifest } from "../shared/release";
import { releaseSetupAt } from "./projects/release-proposal";
// @ts-expect-error: a plain .mjs script, no types
import * as maker from "../playbooks/release-maker/scripts/release-maker.mjs";
// @ts-expect-error: a plain .mjs script, no types
import * as rel from "../playbooks/release/scripts/release.mjs";

/**
 * Sova's release playbooks: the general method's driver (playbooks/release/scripts/release.mjs) and the Release
 * playbook maker (playbooks/release-maker, proposes release) with its driver, its starter, and the release setup's
 * hash a maker run's review is pinned to, called in-process (the drivers' exit codes: playbooks-release.integration.test.ts).
 * Every repository is a scratch one in a temp dir; nothing here tags, pushes or runs a candidate (each would leave a marker file).
 */

const dir = mkdtempSync(join(tmpdir(), "release-playbooks-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main", "-c", "tag.gpgSign=false", ...a], { cwd, stdio: "pipe", encoding: "utf8" });

let n = 0;
/** A scratch project: package.json at 1.2.3, a changelog, an ignored dist/, tags v1.2.3 and stable, a release script that would leave a marker. */
function project(extra: Record<string, string> = {}): string {
  const r = join(dir, `p${++n}`);
  mkdirSync(r, { recursive: true });
  git(r, "init", "-q");
  writeFileSync(join(r, "package.json"), JSON.stringify({ name: "demo", version: "1.2.3", scripts: { release: "touch RAN-RELEASE && npm publish" } }, null, 2) + "\n");
  writeFileSync(join(r, ".gitignore"), "dist/\n");
  writeFileSync(join(r, "CHANGELOG.md"), "# Changelog\n\n## v1.2.3 — 2026-01-01\n\n- First.\n");
  writeFileSync(join(r, "release.sh"), "#!/bin/sh\ntouch RAN-RELEASE-SH\n", { mode: 0o755 });
  for (const [f, t] of Object.entries(extra)) {
    mkdirSync(join(r, f, ".."), { recursive: true });
    writeFileSync(join(r, f), t);
  }
  git(r, "add", "-A");
  git(r, "commit", "-qm", "base");
  git(r, "tag", "-a", "v1.2.3", "-m", "v1.2.3");
  git(r, "tag", "-a", "stable", "-m", "stable: v1.2.3");
  return r;
}

test("the maker is a verb playbook that proposes release; the general method is not a verb playbook", async () => {
  const cat = await listPlaybooks(dir);
  const mk = cat.playbooks.find((p) => p.id === "release-maker");
  assert.ok(mk, "shipped");
  assert.equal(mk!.title, "Release playbook maker");
  assert.equal(mk!.proposes, "release");
  const gen = cat.playbooks.find((p) => p.id === "release");
  assert.ok(gen, "shipped");
  assert.equal(gen!.proposes, undefined);
});

test("candidates read tags, version files, the changelog and release automation, and run none of it", () => {
  const r = project({ ".github/workflows/rel.yml": "on:\n  push:\n    tags:\n      - 'v*'\n", "Cargo.toml": '[package]\nname = "x"\nversion = "1.2.3"\n' });
  const c = maker.candidates(r);
  assert.deepEqual(c.tags.patterns.map((p: { pattern: string }) => p.pattern), ["v${version}"]);
  assert.deepEqual(c.tags.moving, [{ tag: "stable", at: "v1.2.3" }]);
  assert.deepEqual(c.versions.map((v: { file: string; version: string }) => `${v.file}=${v.version}`).sort(), ["Cargo.toml=1.2.3", "package.json=1.2.3"]);
  assert.equal(c.changelogs[0].file, "CHANGELOG.md");
  assert.ok(c.automation.some((a: string) => a.startsWith("package.json script release")));
  assert.ok(c.automation.includes("release.sh"));
  assert.ok(c.automation.some((a: string) => a.startsWith(".github/workflows/rel.yml")));
  assert.deepEqual(c.ignored, ["dist"]);
  assert.equal(c.pushes, false, "no origin: local-only");
  assert.equal(c.existing.settings, null);
  assert.ok(!existsSync(join(r, "RAN-RELEASE")) && !existsSync(join(r, "RAN-RELEASE-SH")), "no candidate ran");
});

test("init writes Sova's starter, which both parsers take and check passes; it never overwrites", async () => {
  const r = project();
  const first = maker.init(r, { bump: ["package.json"] });
  assert.equal(first.ok, true, first.problems.join("\n"));
  const def = parseDefinition(readFileSync(join(r, ".sova/project.json"), "utf8"));
  assert.deepEqual({ ...def.release, checks: undefined }, { playbook: ".sova/playbooks/release", tag: "v${version}", scheme: "semver", channels: ["stable"], commit: true, checks: undefined, checkIds: [], quietMin: 30 });
  const m = parseReleaseManifest(readFileSync(join(r, ".sova/playbooks/release/release.json"), "utf8"));
  assert.deepEqual(m.steps.map((s) => s.id), ["version", "notes", "bump", "commit"]);
  const ok = await maker.check(r);
  assert.equal(ok.ok, true, ok.problems.join("\n"));
  assert.ok(ok.notes.some((x: string) => /local-only: Publish tags and moves the channels on this machine/.test(x)));
  const again = maker.init(r, {});
  assert.equal(again.ok, false);
  assert.match(again.problems.join("\n"), /already exists: change it by editing/);
  const m2 = readFileSync(join(r, ".sova/playbooks/release/release.json"), "utf8");
  assert.equal(maker.formatManifest(m2), m2, "written in canonical form");
});

test("a tag-only starter has no commit step, keeps an existing definition, and checks clean", async () => {
  const r = project({ ".sova/project.json": JSON.stringify({ version: 1, services: { web: { cmd: ["node", "s.js"] } } }) });
  assert.equal(maker.init(r, { tagOnly: true, channels: [] }).ok, true);
  const def = parseDefinition(readFileSync(join(r, ".sova/project.json"), "utf8"));
  assert.equal(def.release!.commit, false);
  assert.deepEqual(def.release!.channels, []);
  assert.deepEqual(def.services.map((s) => s.name), ["web"], "the rest of the definition kept");
  const m = parseReleaseManifest(readFileSync(join(r, ".sova/playbooks/release/release.json"), "utf8"));
  assert.deepEqual(m.steps.map((s) => s.id), ["version", "notes"]);
  const out = await maker.check(r);
  assert.equal(out.ok, true, out.problems.join("\n"));
  assert.ok(out.notes.some((x: string) => /no channels: Publish makes the numbered tag and moves nothing/.test(x)));
});

test("check refuses what the parsers can't see: tagging, pushing, calling Sova, a page before Publish, a stray artifact", async () => {
  const r = project();
  assert.equal(maker.init(r, {}).ok, true);
  const pb = join(r, ".sova/playbooks/release");
  writeFileSync(
    join(pb, "release.json"),
    maker.formatManifest(
      JSON.stringify({
        v: 1,
        steps: [
          { id: "version", label: "Pick the version", phase: "prepare" },
          { id: "notes", label: "Notes", phase: "prepare" },
          { id: "page", label: "Release page", phase: "after" },
          { id: "build", label: "Build the app", phase: "after", artifact: true },
        ],
      }),
    ),
  );
  mkdirSync(join(pb, "scripts"), { recursive: true });
  writeFileSync(join(pb, "scripts", "ship.sh"), "#!/bin/sh\ngit tag -a v$1 -m x\ngit push origin main --tags\nnode scripts/sova-project.mjs release.step --state done\n");
  writeFileSync(
    join(pb, "PLAYBOOK.md"),
    [
      "# Release (demo)",
      "- `version`: by the rule.",
      "- `notes`: the changelog.",
      "- `page`: run `gh release create v1.0.0 --notes-file n.md`.",
      "- `build`: build into `build/out`, then `node release.mjs artifact build/out/app.jar`; see scripts/missing.mjs.",
      "",
      "Never `git push` by hand.",
    ].join("\n"),
  );
  const out = await maker.check(r);
  assert.equal(out.ok, false);
  const p: string[] = out.problems;
  const has = (re: RegExp) => assert.ok(p.some((x) => re.test(x)), `expected ${re} in:\n${p.join("\n")}`);
  has(/release.commit is true, so a prepare step "commit"/);
  has(/scripts\/ship\.sh: creates or moves a tag/);
  has(/scripts\/ship\.sh: pushes/);
  has(/scripts\/ship\.sh: calls Sova as the operator/);
  has(/PLAYBOOK\.md: creates a release page without --verify-tag/);
  has(/names scripts\/missing\.mjs, which this folder doesn't have/);
  has(/artifact path build\/out\/app\.jar is inside the repository and not ignored/);
  assert.ok(!p.some((x) => /PLAYBOOK\.md: pushes/.test(x)), "a 'never' line is prose, not a command");
});

test("check fails on an invalid manifest and on a project without release settings", async () => {
  const r = project();
  const none = await maker.check(r);
  assert.equal(none.ok, false);
  assert.match(none.problems.join("\n"), /\.sova\/project\.json is missing/);
  assert.equal(maker.init(r, {}).ok, true);
  writeFileSync(join(r, ".sova/playbooks/release/release.json"), JSON.stringify({ v: 1, steps: [{ id: "publish", label: "Mine", phase: "after" }] }));
  const bad = await maker.check(r);
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join("\n"), /Sova's own step/);
});

test("release.mjs status suggests the next number from what landed; a first release says so", () => {
  const r = project();
  git(r, "commit", "-q", "--allow-empty", "-m", "fix: a crash");
  assert.equal(rel.status(r).suggest.version, "1.2.4");
  git(r, "commit", "-q", "--allow-empty", "-m", "feat: a new screen");
  const s = rel.status(r);
  assert.equal(s.previous.tag, "v1.2.3");
  assert.equal(s.since, 2);
  assert.deepEqual([s.suggest.version, s.suggest.kind], ["1.3.0", "minor"]);
  assert.equal(s.taken, false);
  const fresh = join(dir, "fresh");
  mkdirSync(fresh);
  git(fresh, "init", "-q");
  git(fresh, "commit", "-q", "--allow-empty", "-m", "init");
  const first = rel.status(fresh);
  assert.equal(first.previous, null);
  assert.deepEqual([first.suggest.version, first.suggest.kind], ["0.1.0", "first"]);
});

test("release.mjs changelog wants the entry exactly once and dated; bump changes only the version", () => {
  const ok = rel.changelogEntry("# C\n\n## v1.3.0 — 2026-02-02\n\n- New.\n\n## v1.2.3 — 2026-01-01\n- Old.\n", "1.3.0");
  assert.deepEqual([ok.ok, ok.body], [true, "- New."]);
  assert.match(rel.changelogEntry("## v1.3.0 — RELEASE-DATE\n- x\n", "1.3.0").problem, /placeholder/);
  assert.match(rel.changelogEntry("## v1.3.0 — 2026-02-02\n- x\n## v1.3.0 — 2026-02-03\n- y\n", "1.3.0").problem, /appears 2 times/);
  assert.match(rel.changelogEntry("## v1.2.0\n- x\n", "1.3.0").problem, /no heading/);

  const r = project({ "Cargo.toml": '[package]\nname = "x"\nversion = "1.2.3"\n\n[dependencies]\nserde = { version = "1.0.0" }\n' });
  const check = rel.bump(r, ["package.json", "Cargo.toml"], "1.3.0", { check: true });
  assert.deepEqual(check.map((x: { changed: boolean; written: boolean }) => [x.changed, x.written]), [[true, false], [true, false]]);
  assert.match(readFileSync(join(r, "package.json"), "utf8"), /"1\.2\.3"/, "--check writes nothing");
  rel.bump(r, ["package.json", "Cargo.toml", "CHANGELOG.md"], "1.3.0");
  assert.equal(JSON.parse(readFileSync(join(r, "package.json"), "utf8")).version, "1.3.0");
  assert.match(readFileSync(join(r, "Cargo.toml"), "utf8"), /^version = "1\.3\.0"$/m);
  assert.match(readFileSync(join(r, "Cargo.toml"), "utf8"), /serde = \{ version = "1\.0\.0" \}/, "a dependency's version untouched");
  const bad = rel.bump(r, ["CHANGELOG.md", "nope.toml"], "1.3.0");
  assert.match(bad[0].error, /doesn't know how to bump/);
  assert.equal(bad[1].error, "can't be read");
});

test("release.mjs artifact refuses a tracked or unignored path and reports facts Sova parses", () => {
  const r = project({ "out/app.jar": "tracked" });
  mkdirSync(join(r, "dist"), { recursive: true });
  writeFileSync(join(r, "dist", "app.jar"), "built");
  writeFileSync(join(r, "loose.jar"), "built");
  assert.match(rel.artifact(r, "out/app.jar").problem, /tracked by git/);
  assert.match(rel.artifact(r, "loose.jar").problem, /not ignored/);
  const ok = rel.artifact(r, "dist/app.jar");
  assert.equal(ok.ok, true);
  const facts = parseFacts(ok.facts);
  assert.equal(facts.artifact!.path, join(r, "dist", "app.jar"));
  assert.equal(facts.artifact!.size, 5);
  assert.match(facts.artifact!.sha256!, /^[0-9a-f]{64}$/);
  const outside = join(dir, "outside-artifact");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "a.bin"), "x");
  assert.equal(rel.artifact(r, outside).ok, true, "a folder outside the repository");
  assert.equal(rel.artifact(r, "nope.jar").fatal, true);
});

test("a release setup's hash pins the section and every file of the playbook folder", async () => {
  const r = project();
  assert.equal(await releaseSetupAt(r, "HEAD"), null, "no definition: nothing proposed");
  assert.equal(maker.init(r, {}).ok, true);
  git(r, "add", ".sova");
  git(r, "commit", "-qm", "Release setup");
  const a = await releaseSetupAt(r, "HEAD");
  assert.ok(a?.hash.startsWith("sha256:"), JSON.stringify(a));
  assert.deepEqual(a!.steps.map((s) => s.id), ["version", "notes", "commit"]);
  assert.deepEqual(a!.files.sort(), ["PLAYBOOK.md", "release.json"]);
  assert.deepEqual(a!.settings!.channels, ["stable"]);
  writeFileSync(join(r, ".sova/playbooks/release/PLAYBOOK.md"), readFileSync(join(r, ".sova/playbooks/release/PLAYBOOK.md"), "utf8") + "\nOne more line.\n");
  git(r, "commit", "-qam", "playbook line");
  const b = await releaseSetupAt(r, "HEAD");
  assert.notEqual(b!.hash, a!.hash, "a playbook line is a new hash");
  const def = JSON.parse(readFileSync(join(r, ".sova/project.json"), "utf8"));
  def.release.channels = ["stable", "latest"];
  writeFileSync(join(r, ".sova/project.json"), JSON.stringify(def));
  git(r, "commit", "-qam", "channel");
  const c = await releaseSetupAt(r, "HEAD");
  assert.notEqual(c!.hash, b!.hash, "a setting is a new hash");
  writeFileSync(join(r, ".sova/playbooks/release/release.json"), "{}");
  git(r, "commit", "-qam", "break the manifest");
  const d = await releaseSetupAt(r, "HEAD");
  assert.equal(d!.hash, "");
  assert.match(d!.problem!, /release\.json/);
});
