import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { parseDefinition } from "../../shared/project-contract";
import { parseReleaseManifest } from "../../shared/release";
import { git, ReleaseFixture } from "../../scripts/e2e-release/fixtures";
import { scratchRoot } from "../test-scratch";

/**
 * The Release playbook maker's driver (E2E-PLAN.md S2, S4, S5; al_1 a10, t21) on scratch projects: `init` writes the
 * starter on a not-initialized project, which Sova's own parsers read; `check` refuses a playbook that pushes,
 * tags, makes the tag through a release page, calls Sova as the operator, holds a secret, or keeps an artifact in
 * the repository unignored; `init` never overwrites. Real processes (node), so an integration file.
 */

const MAKER = new URL("../../playbooks/release-maker/scripts/release-maker.mjs", import.meta.url).pathname;
const under = scratchRoot("sova-rel-maker-");
const fixtures: ReleaseFixture[] = [];
after(() => {
  for (const fx of fixtures) fx.dispose();
});
const maker = (root: string, ...args: string[]) => {
  const r = spawnSync("node", [MAKER, ...args, "--root", root], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
const fixture = (o: ConstructorParameters<typeof ReleaseFixture>[0] = {}) => {
  const fx = new ReleaseFixture({ under, ...o });
  fixtures.push(fx);
  return fx;
};
const PB = ".sova/playbooks/release";

test("S2: init on a project with no releases writes the starter, which Sova's parsers read and check passes", () => {
  const fx = fixture({ kind: "bare" });
  const before = readFileSync(join(fx.project, ".sova/project.json"), "utf8");
  const r = maker(fx.project, "init");
  assert.equal(r.code, 0, r.out);
  const def = parseDefinition(readFileSync(join(fx.project, ".sova/project.json"), "utf8"));
  assert.equal(def.release?.playbook, PB);
  assert.equal(def.release?.tag, "v${version}");
  assert.deepEqual(def.release?.channels, ["stable"]);
  assert.equal(def.release?.commit, true);
  assert.deepEqual(JSON.parse(before).merge, JSON.parse(readFileSync(join(fx.project, ".sova/project.json"), "utf8")).merge, "the merge section untouched");
  const m = parseReleaseManifest(readFileSync(join(fx.project, PB, "release.json"), "utf8"));
  assert.ok(m.steps.some((s) => s.id === "commit" && s.phase === "prepare"));
  assert.ok(existsSync(join(fx.project, PB, "PLAYBOOK.md")));
  const c = maker(fx.project, "check");
  assert.equal(c.code, 0, c.out);
  assert.equal(git(fx.project, ["status", "--porcelain", "--untracked-files=no"]).includes("project.json"), true, "written in the checkout, not committed: the branch is the maker's to hand back");
  assert.equal(git(fx.project, ["log", "-1", "--format=%s"]), "fixture: base", "init commits nothing");
});

test("S5: init refuses when the playbook or the settings already exist (changes are edits)", () => {
  const fx = fixture();
  const r = maker(fx.project, "init");
  assert.equal(r.code, 1, r.out);
  assert.ok(fx.clean(), "nothing written");
});

test("S4: check passes the fixture's playbook and refuses each planted problem, naming it", () => {
  const cases: Array<{ name: string; kind?: "local"; file: string; text: string; want: RegExp | null }> = [
    { name: "clean", file: "PLAYBOOK.md", text: "", want: null },
    { name: "a tag read is fine", file: "scripts/release.mjs", text: '\nexecFileSync("git", ["tag", "--list", "v*"]);\n', want: null },
    { name: "gh release create --verify-tag is fine", file: "PLAYBOOK.md", text: "\n- `gh release create v1.2.3 --verify-tag`\n", want: null },
    { name: "git push in a script (string)", file: "scripts/release.mjs", text: '\nexecSync("git push origin HEAD");\n', want: /pushes/ },
    { name: "git push in a script (argv)", file: "scripts/release.mjs", text: '\nexecFileSync("git", ["push", "origin", "HEAD"]);\n', want: /pushes/ },
    { name: "git tag in a script (argv)", file: "scripts/release.mjs", text: '\nexecFileSync("git", ["tag", "-a", "v1.0.0", "-m", "x"]);\n', want: /tag/ },
    { name: "git push in a shell script", file: "scripts/publish.sh", text: "#!/bin/sh\ngit push --tags origin\n", want: /pushes/ },
    { name: "git tag in the playbook", file: "PLAYBOOK.md", text: "\n- Tag it: `git tag -a v1.2.3 -m x`\n", want: /tag/ },
    { name: "a release page that makes the tag", file: "PLAYBOOK.md", text: "\n- `gh release create v1.2.3`\n", want: /verify-tag|tag itself/ },
    { name: "a script calling Sova as the operator", file: "scripts/release.mjs", text: '\nexecFileSync("node", ["scripts/sova-project.mjs", "release.publish", "--confirm"]);\n', want: /operator|release\.step/ },
    { name: "a secret", file: "PLAYBOOK.md", text: `\nUse token ghp_${"a".repeat(36)}\n`, want: /secret/ },
    { name: "an artifact kept in the repository", kind: "local", file: "PLAYBOOK.md", text: "\nAlso: `release.mjs artifact build/app.jar`.\n", want: /inside the repository and not ignored/ },
  ];
  const failures: string[] = [];
  for (const c of cases) {
    const fx = fixture({ kind: c.kind ?? "remote" });
    const f = join(fx.project, PB, c.file);
    if (c.file.endsWith(".sh")) {
      writeFileSync(f, c.text);
      appendFileSync(join(fx.project, PB, "PLAYBOOK.md"), "\nRun `scripts/publish.sh`.\n");
    } else if (c.text) appendFileSync(f, c.text);
    assert.equal(maker(fx.project, "fmt").code, 0);
    const r = maker(fx.project, "check");
    const problems = (r.out.match(/problem: .*/g) ?? []).join("\n");
    if (c.want === null ? r.code !== 0 : r.code !== 1 || !c.want.test(problems)) failures.push(`${c.name}: exit ${r.code}\n${problems || r.out.slice(0, 400)}`);
  }
  assert.deepEqual(failures, [], failures.join("\n\n"));
});
