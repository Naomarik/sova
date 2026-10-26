// Run: pnpm test -- server/test-groups.test.ts. The integration tier's slow groups (scripts/test-groups.mjs,
// §app.server-runtime/test-tiers): what a landing runs, and what a session's `--changed` adds, by trigger.
import assert from "node:assert/strict";
import { existsSync, globSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { GROUPS, globRe, groupOf, selectFiles, setKey, triggersHit } from "../scripts/test-groups.mjs";

const REPO = join(import.meta.dirname, "..");
const trial = "server/chat-runtime/trial-s4-teams.integration.test.ts";
const tour = "server/tours/runner-socket.integration.test.ts";
const tourNoChrome = "server/tours/bindings-app.integration.test.ts";
const everyday = "server/sidebar-guide-lines.integration.test.ts";
const nearTours = "server/tours/sova-copy.integration.test.ts";
const files = [trial, tour, tourNoChrome, everyday, nearTours];
const landing = (changed: string[]) => selectFiles(files, changed, { mode: "landing" });
const changedRun = (changed: string[], closure: (f: string[]) => string[] = () => []) => selectFiles(files, changed, { mode: "changed", closure });

describe("which group a file is in", () => {
  test("the trial's files, the Chrome tours (the Sova-screens one too), and the everyday rest", () => {
    assert.equal(groupOf(trial)?.name, "trial");
    assert.equal(groupOf(tour)?.name, "tours");
    assert.equal(groupOf(nearTours)?.name, "tours");
    assert.equal(groupOf(tourNoChrome), null, "a tour test that starts no browser stays everyday");
    assert.equal(groupOf(everyday), null, "an everyday Chrome UI test outside server/tours stays everyday");
    assert.equal(groupOf("server/chat-runtime/host.integration.test.ts"), null);
  });

  test("the declaration names real files: every exception exists, and each group matches files on disk", () => {
    for (const g of GROUPS) {
      for (const f of g.except) assert.ok(existsSync(join(REPO, f)), `${g.name} excepts ${f}, which doesn't exist`);
      const onDisk = g.files.flatMap((p) => globSync(p, { cwd: REPO }));
      assert.ok(onDisk.filter((f) => !g.except.includes(f)).length > 5, `${g.name} matches no file on disk`);
    }
    for (const t of GROUPS.flatMap((g) => g.triggers).filter((t) => !t.includes("*"))) assert.ok(existsSync(join(REPO, t)), `trigger ${t} names no file`);
  });

  test("globs: ** any depth, * within one segment", () => {
    assert.ok(globRe("server/chat-runtime/**").test("server/chat-runtime/a/b.ts"));
    assert.ok(globRe("server/baton*").test("server/baton-files.ts"));
    assert.ok(!globRe("server/baton*").test("server/batons/x.ts"));
  });
});

describe("what a landing runs", () => {
  test("a pi pin change alone (package.json, the lockfile) runs Chat processes", () => {
    for (const changed of [["package.json"], ["pnpm-lock.yaml"], ["mise.toml"], ["pnpm-workspace.yaml"]]) {
      const r = landing(changed);
      assert.deepEqual(r.ran, ["trial"], changed[0]);
      assert.ok(r.files.includes(trial));
    }
  });

  test("an extension under pi-config/extensions/subagents runs Chat processes; so does the harness or a steer-keys change", () => {
    for (const f of ["pi-config/extensions/subagents/team.ts", "server/harness/pi/quirks.ts", "server/send-keys.ts", "scripts/run-tests.mjs", "scripts/test-groups.mjs"]) {
      assert.deepEqual(landing([f]).ran, ["trial"], f);
    }
  });

  test("a tours-only change runs no group at landing (Tours never run there), and the everyday set still runs", () => {
    const r = landing(["server/tours/runner.ts"]);
    assert.deepEqual(r.ran, []);
    assert.deepEqual(r.files, [tourNoChrome, everyday]);
    const tours = r.skipped.find((s) => s.name === "tours");
    assert.equal(tours?.why, "never");
    assert.deepEqual(tours?.hits, ["server/tours/runner.ts"]);
    assert.equal(r.skipped.find((s) => s.name === "trial")?.why, "untriggered");
  });

  test("Tours never run at landing, even when every trigger changed", () => {
    const r = landing(["server/tours/runner.ts", "package.json", "scripts/run-tests.mjs"]);
    assert.ok(!r.files.includes(tour) && !r.files.includes(nearTours));
    assert.deepEqual(r.ran, ["trial"]);
  });

  test("an unrelated change runs only the everyday set, naming both groups as skipped", () => {
    const r = landing(["src/components/Sidebar.tsx"]);
    assert.deepEqual(r.files, [tourNoChrome, everyday]);
    assert.deepEqual(r.skipped.map((s) => [s.name, s.why]), [["trial", "untriggered"], ["tours", "never"]]);
    assert.equal(setKey(r.ran), "core");
    assert.equal(setKey(landing(["package.json"]).ran), "core+trial");
  });

  test("a changed test file triggers only its own group, never the area it sits in", () => {
    assert.deepEqual(triggersHit(["server/team-inbox.test.ts"]).trial, []);
    assert.deepEqual(triggersHit([trial]).trial, [trial]);
    assert.deepEqual(landing([trial]).ran, ["trial"]);
    assert.deepEqual(triggersHit([tour]).trial, [], "a tour test's change is no trial trigger");
  });
});

describe("what a session's --changed adds", () => {
  test("a tours-only change selects the Tours under --changed", () => {
    const r = changedRun(["server/tours/runner.ts"]);
    assert.deepEqual(r.ran, ["tours"]);
    assert.ok(r.files.includes(tour) && r.files.includes(nearTours));
    assert.ok(!r.files.includes(trial));
  });

  test("a group's file is never chosen by its imports alone: the closure decides only the everyday files", () => {
    // A closure that would pick every file it is given.
    const r = changedRun(["server/some-helper.ts"], (fs) => fs);
    assert.deepEqual(r.ran, []);
    assert.deepEqual(r.files, [tourNoChrome, everyday]);
  });

  test("a subagents extension change adds Chat processes, as at landing", () => {
    assert.deepEqual(changedRun(["pi-config/extensions/subagents/team.ts"]).ran, ["trial"]);
  });
});

describe("--groups", () => {
  test("only the named groups' files; all is every group", () => {
    assert.deepEqual(selectFiles(files, [], { mode: "groups", only: ["tours"] }).files, [tour, nearTours]);
    assert.deepEqual(selectFiles(files, [], { mode: "groups", only: ["all"] }).ran, ["trial", "tours"]);
  });
});
