import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFINITION_KEYS, DefinitionError, exitOf, isReleaseVerb, isVerb, parseDefinition, releaseTagOf, versionOfTag, versionProblem } from "./project-contract";
import { ManifestError, parseFacts, parseReleaseManifest, planOf } from "./release";

// The release section: a pointer to the project's release playbook plus the facts Sova acts on (the tag, the
// channels, the gating checks), parsed as strictly as the rest of the definition. Absent: releases not set up.

const BASE = {
  version: 1,
  merge: {
    checks: [
      { id: "unit", run: ["pnpm", "test"] },
      { id: "full-int", run: ["pnpm", "test:int"], optional: true },
    ],
  },
};
const parse = (release: unknown, extra: Record<string, unknown> = {}) => parseDefinition(JSON.stringify({ ...BASE, ...extra, release }));
const refusal = (release: unknown, extra: Record<string, unknown> = {}): string => {
  try {
    parse(release, extra);
  } catch (err) {
    assert.ok(err instanceof DefinitionError);
    return err.path;
  }
  assert.fail("expected a refusal");
};

test("absent: releases are not set up", () => {
  assert.equal(parseDefinition(JSON.stringify(BASE)).release, undefined);
});

test("the smallest release section fills its defaults", () => {
  assert.deepEqual(parse({ playbook: ".sova/playbooks/release" }).release, {
    playbook: ".sova/playbooks/release",
    tag: "v${version}",
    scheme: "semver",
    channels: [],
    commit: true,
    checks: [],
    checkIds: [],
    quietMin: 30,
  });
});

test("checks: a merge check by id (an optional one too, dropping optional) or one declared here, in order", () => {
  const r = parse({ playbook: ".sova/playbooks/release", channels: ["stable"], commit: false, scheme: "calver", tag: "release-${version}", quietMin: 60, checks: ["full-int", { id: "site-build", label: "Site build", run: ["pnpm", "site:build"], timeout: 900 }] }).release!;
  assert.deepEqual(r.checkIds, ["full-int", "site-build"]);
  assert.equal(r.checks[0]!.optional, undefined);
  assert.deepEqual(r.checks[1], { id: "site-build", label: "Site build", run: ["pnpm", "site:build"], timeout: 900, rerun: false, requires: [] });
  assert.equal(r.commit, false);
  assert.equal(r.scheme, "calver");
  assert.equal(r.quietMin, 60);
});

test("refusals name the JSON path of the first problem", () => {
  assert.equal(refusal({}), "$.release.playbook");
  assert.equal(refusal({ playbook: "/abs" }), "$.release.playbook");
  assert.equal(refusal({ playbook: "../x" }), "$.release.playbook");
  assert.equal(refusal({ playbook: "." }), "$.release.playbook");
  assert.equal(refusal({ playbook: "p", remote: "origin" }), "$.release.remote");
  assert.equal(refusal({ playbook: "p", tag: "v" }), "$.release.tag");
  assert.equal(refusal({ playbook: "p", tag: "v${version}-${version}" }), "$.release.tag");
  assert.equal(refusal({ playbook: "p", tag: "v${commit}" }), "$.release.tag");
  assert.equal(refusal({ playbook: "p", tag: "v ${version}" }), "$.release.tag");
  assert.equal(refusal({ playbook: "p", scheme: "date" }), "$.release.scheme");
  assert.equal(refusal({ playbook: "p", channels: ["stable", "stable"] }), "$.release.channels");
  assert.equal(refusal({ playbook: "p", channels: ["a", "b", "c", "d"] }), "$.release.channels");
  assert.equal(refusal({ playbook: "p", channels: ["v1.2.3"] }), "$.release.channels[0]");
  assert.equal(refusal({ playbook: "p", channels: ["bad..name"] }), "$.release.channels[0]");
  assert.equal(refusal({ playbook: "p", commit: "yes" }), "$.release.commit");
  assert.equal(refusal({ playbook: "p", checks: ["nope"] }), "$.release.checks[0]");
  assert.equal(refusal({ playbook: "p", checks: [{ id: "unit", run: ["x"] }] }), "$.release.checks[0].id");
  assert.equal(refusal({ playbook: "p", checks: [{ id: "x", run: ["x"], optional: true }] }), "$.release.checks[0].optional");
  assert.equal(refusal({ playbook: "p", checks: [{ id: "x", run: "x" }] }), "$.release.checks[0].run");
  assert.equal(refusal({ playbook: "p", checks: ["unit", "unit"] }), "$.release.checks");
  assert.equal(refusal({ playbook: "p", quietMin: 1 }), "$.release.quietMin");
  // A project with no merge checks names none by id.
  assert.equal(refusal({ playbook: "p", checks: ["unit"] }, { merge: { checks: "none" } }), "$.release.checks[0]");
});

test("the key lists name every key the parse accepts", () => {
  assert.ok(DEFINITION_KEYS.top.includes("release"));
  assert.deepEqual([...DEFINITION_KEYS.release], ["playbook", "tag", "scheme", "channels", "commit", "checks", "quietMin"]);
  assert.ok(DEFINITION_KEYS.target.includes("releases"));
});

test("a deploy target may take only released commits", () => {
  const def = parseDefinition(JSON.stringify({ version: 1, deploy: { targets: { site: { about: "The site.", steps: [{ id: "up", run: ["true"] }], rollback: { none: "static" }, requires: { tests: "none" }, releases: "only" } } } }));
  assert.equal(def.deploy!.targets[0]!.releases, "only");
  assert.throws(() => parseDefinition(JSON.stringify({ version: 1, deploy: { targets: { site: { about: "The site.", steps: [{ id: "up", run: ["true"] }], rollback: { none: "static" }, requires: { tests: "none" }, releases: true } } } })), /releases/);
});

test("tags, versions and schemes", () => {
  assert.equal(releaseTagOf("v${version}", "0.10.0"), "v0.10.0");
  assert.equal(versionOfTag("v${version}", "v0.10.0"), "0.10.0");
  assert.equal(versionOfTag("v${version}", "stable"), null);
  assert.equal(versionOfTag("app-${version}-final", "app-1.2.3-final"), "1.2.3");
  assert.equal(versionProblem("semver", "0.10.0"), null);
  assert.equal(versionProblem("semver", "1.0.0-rc.1"), null);
  assert.match(versionProblem("semver", "0.10")!, /semantic/);
  assert.equal(versionProblem("calver", "2026.11"), null);
  assert.equal(versionProblem("calver", "2026.11.03.2"), null);
  assert.match(versionProblem("calver", "26.11")!, /calendar/);
  assert.equal(versionProblem("none", "build-42"), null);
  assert.match(versionProblem("none", "a b")!, /not a version/);
});

test("the release verbs are verbs, and a gate not met is class 2", () => {
  for (const v of ["release.status", "release.step", "release.publish", "release.withdraw"]) assert.ok(isVerb(v) && isReleaseVerb(v), v);
  assert.equal(isReleaseVerb("release.push"), false);
  assert.equal(exitOf({ error: { code: "release-refused" } }), 2);
});

// ---- the manifest ------------------------------------------------------------------------------------

const manifestRefusal = (m: unknown): string => {
  try {
    parseReleaseManifest(typeof m === "string" ? m : JSON.stringify(m));
  } catch (err) {
    assert.ok(err instanceof ManifestError);
    return err.path;
  }
  assert.fail("expected a refusal");
};

test("a manifest's steps become the plan with Sova's checks and Publish between prepare and after", () => {
  const m = parseReleaseManifest(JSON.stringify({ v: 1, steps: [{ id: "version", label: "Pick the version", phase: "prepare" }, { id: "try-live", label: "Try it live", phase: "check", held: true }, { id: "page", label: "Release page", phase: "after" }, { id: "app", label: "Build the app", phase: "after", artifact: true }, { id: "unlist", label: "Mark the page withdrawn", phase: "withdraw" }] }));
  assert.deepEqual(
    planOf(m).map((s) => [s.id, s.phase, s.state, s.held ?? false]),
    [
      ["version", "prepare", "waiting", false],
      ["checks", "sova", "waiting", false],
      ["try-live", "check", "waiting", true],
      ["publish", "sova", "waiting", false],
      ["page", "after", "waiting", false],
      ["app", "after", "waiting", false],
      ["unlist", "withdraw", "waiting", false],
    ],
  );
  assert.deepEqual(parseReleaseManifest('{"v":1,"steps":[]}').steps, []);
});

test("a manifest is parsed strictly", () => {
  assert.equal(manifestRefusal("nope"), "$");
  assert.equal(manifestRefusal({ v: 2, steps: [] }), "$.v");
  assert.equal(manifestRefusal({ v: 1, steps: [], run: [] }), "$.run");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "x", label: "X", phase: "prepare", run: ["git", "push"] }] }), "$.steps[0].run");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "publish", label: "X", phase: "prepare" }] }), "$.steps[0].id");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "checks", label: "X", phase: "after" }] }), "$.steps[0].id");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "Bad", label: "X", phase: "prepare" }] }), "$.steps[0].id");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "x", label: "", phase: "prepare" }] }), "$.steps[0].label");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "x", label: "X", phase: "during" }] }), "$.steps[0].phase");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "x", label: "X", phase: "prepare", held: false }] }), "$.steps[0].held");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "x", label: "X", phase: "prepare" }, { id: "x", label: "Y", phase: "after" }] }), "$.steps");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "a", label: "A", phase: "after" }, { id: "b", label: "B", phase: "prepare" }] }), "$.steps[1].phase");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "withdraw", label: "A", phase: "withdraw" }] }), "$.steps[0].id");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "commit", label: "A", phase: "prepare" }, { id: "notes", label: "B", phase: "prepare" }] }), "$.steps[0]");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "commit", label: "A", phase: "after" }] }), "$.steps[0].phase");
  assert.equal(manifestRefusal({ v: 1, steps: [{ id: "a", label: "A", phase: "after", artifact: false }] }), "$.steps[0].artifact");
});

test("facts parse from key=value items, and an artifact's sha and size need its path", () => {
  const sha = "a".repeat(64);
  assert.deepEqual(parseFacts(["version=0.10.0", "commit=abc1234", "artifact=/home/u/builds/app.jar", `sha256=${sha}`, "size=1024"]), { version: "0.10.0", commit: "abc1234", artifact: { path: "/home/u/builds/app.jar", sha256: sha, size: 1024 } });
  assert.throws(() => parseFacts(["version"]), /key=value/);
  assert.throws(() => parseFacts(["colour=red"]), /unknown fact/);
  assert.throws(() => parseFacts([`sha256=${sha}`]), /artifact=/);
  assert.throws(() => parseFacts(["commit=xyz"]), /commit sha/);
  assert.throws(() => parseFacts(["url=ftp://x"]), /http/);
});
