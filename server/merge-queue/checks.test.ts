import { describe, test } from "node:test";
import { expect } from "./testing/expect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDefinition, type ProjectDef } from "../../shared/project-contract";
import { scratchRoot } from "../test-scratch";
import { checksOf, envOf, failingFilesIn, freshOf, planChecks, readCheckOut, rerunArgvOf, reusedWords, templateVarsOf, testKey } from "./checks";
import { isReleaseRun, passedEnd } from "./run";

const svc = { web: { cmd: ["node", "web.js"], ports: { http: { base: 5100 } } } };
const def = (extra: Record<string, unknown>): ProjectDef => parseDefinition(JSON.stringify({ version: 1, services: svc, ...extra }));
const declared = def({
  merge: {
    checks: [
      { id: "typecheck", run: ["tsc"] },
      { id: "unit", label: "Unit tests", run: ["node", "t.mjs"], rerun: true },
      { id: "replay", run: ["node", "replay.mjs"] },
      { id: "tour", label: "Tours", run: ["node", "tours.mjs"], optional: true, rerun: true },
    ],
  },
});

describe("what a run checks", () => {
  test("checksOf: a declared list, one test command, none declared, or not set up", () => {
    expect(checksOf(declared)).toBe("declared");
    expect(checksOf(def({ merge: { checks: "none" } }))).toBe("none");
    expect(checksOf(def({ test: { run: ["npm", "test"], smoke: ["a"] } }))).toBe("test-command");
    // A merge section without checks falls back to the test command.
    expect(checksOf(def({ merge: { target: "main" }, test: { run: ["npm", "test"], smoke: ["a"] } }))).toBe("test-command");
    expect(checksOf(def({}))).toBe("unset");
    expect(checksOf(null)).toBe("unset");
  });

  test("the required set in order; optional checks only when picked", () => {
    expect(planChecks(declared).map((c) => [c.id, c.source])).toEqual([["typecheck", "required"], ["unit", "required"], ["replay", "required"]]);
  });

  test("picks add, never drop: an optional check, a narrowed rerun of a required one, a required one forced; unknown ids dropped", () => {
    const list = planChecks(declared, [
      { id: "tour", label: "x", source: "picked", why: "composer changed", select: ["server/tours/composer.integration.test.ts"] },
      { id: "unit", label: "x", source: "picked", why: "store changed", select: ["src/lib/store.test.ts", "--evil"] },
      { id: "replay", label: "x", source: "picked", why: "spec engine touched" },
      { id: "rm-rf", label: "x", source: "picked", why: "nope" },
      { id: "typecheck", label: "x", source: "picked", why: "again" },
    ]);
    expect(list.map((c) => c.id)).toEqual(["typecheck", "unit", "replay", "tour", "unit+1"]);
    expect(list.every((c) => c.id !== "rm-rf")).toBe(true);
    const replay = list.find((c) => c.id === "replay")!;
    expect(replay).toMatchObject({ source: "picked", why: "spec engine touched", picked: true });
    expect(list.find((c) => c.id === "typecheck")).toMatchObject({ source: "picked", why: "again" });
    const tour = list.find((c) => c.id === "tour")!;
    expect(tour).toMatchObject({ source: "picked", why: "composer changed", select: ["server/tours/composer.integration.test.ts"], label: "Tours (server/tours/composer.integration.test.ts)" });
    // A selector that reads as a flag is dropped.
    expect(list.find((c) => c.id === "unit+1")!.select).toEqual(["src/lib/store.test.ts"]);
  });

  test("one test command is the list (with its services); none and unset give nothing", () => {
    const t = planChecks(def({ services: { ...svc, db: { cmd: ["db"], ports: { p: { base: 6000 } } } }, test: { run: ["npm", "test"], requires: ["db"], smoke: ["a"], timeout: 1200 } }));
    expect(t).toEqual([{ id: "test", label: "Tests", run: ["npm", "test"], timeoutSec: 1200, rerun: true, requires: ["db"], source: "required" }]);
    expect(planChecks(def({ merge: { checks: "none" } }))).toEqual([]);
    expect(planChecks(def({}))).toEqual([]);
  });

  test("the environment: no chat or secret variable reaches a check; the merge's facts do", () => {
    process.env.CLAUDE_CONFIG_DIR = "/leak";
    process.env.SOVA_CHAT_ID = "leak";
    process.env.ANTHROPIC_API_KEY = "leak";
    process.env.MISE_STATE_DIR = "/ws/mise-state";
    process.env.MISE_GITHUB_TOKEN = "leak";
    process.env.XDG_DATA_HOME = "/ws/data";
    try {
      const scope = { project: "/p/demo", projectId: "demo1", copy: "/p/.worktrees/demo-merge", slot: 19, data: "/s/data", target: "master", base: "b".repeat(40), tip: "t".repeat(40), changedFile: "/s/changed.txt" };
      const e = envOf(declared, scope, { step: "unit", out: "/s/out.json", picked: true });
      expect(e.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(e.SOVA_CHAT_ID).toBeUndefined();
      expect(e.ANTHROPIC_API_KEY).toBeUndefined();
      // mise's own settings and the XDG homes reach a check (its mise is the server's), never a mise token.
      expect(e.MISE_STATE_DIR).toBe("/ws/mise-state");
      expect(e.XDG_DATA_HOME).toBe("/ws/data");
      expect(e.MISE_GITHUB_TOKEN).toBeUndefined();
      // No names set up for this project: a file that doesn't exist (scan secrets only, push held), never the server's.
      expect(e.SOVA_LEAK_NAMES).toBe("/s/data/no-private-names.json");
      expect(envOf(declared, { ...scope, leakNames: "/s/names.json" }).SOVA_LEAK_NAMES).toBe("/s/names.json");
      expect(e).toMatchObject({ SOVA_VERB: "merge", SOVA_STEP: "unit", SOVA_OUT: "/s/out.json", SOVA_MERGE_BASE: scope.base, SOVA_MERGE_TIP: scope.tip, SOVA_MERGE_TARGET: "master", SOVA_MERGE_CHANGED: "/s/changed.txt", SOVA_MERGE_PICKED: "1", SOVA_CHECKOUT: scope.copy, SOVA_PORT_WEB_HTTP: String(5100 + 19) });
      expect(templateVarsOf(declared, scope)).toMatchObject({ "merge.base": scope.base, "merge.tip": scope.tip, "merge.target": "master", checkout: scope.copy, main: "/p/demo", "ports.web.http": String(5100 + 19) });
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.SOVA_CHAT_ID;
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.MISE_STATE_DIR;
      delete process.env.MISE_GITHUB_TOKEN;
      delete process.env.XDG_DATA_HOME;
    }
  });

  test("a check's report: counts, skipped why, failures, every failing file; garbage reads as null", () => {
    const dir = scratchRoot("mq-checks-");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "out.json");
    writeFileSync(f, JSON.stringify({ passed: 3, failed: 1, skipped: 2, failures: [{ name: "x", file: "a.test.ts", message: "boom" }, { bogus: 1 }], failingFiles: ["a.test.ts", "b.test.ts"], notes: ["n"] }));
    expect(readCheckOut(f)).toEqual({ passed: 3, failed: 1, skipped: 2, failures: [{ name: "x", file: "a.test.ts", message: "boom" }], failingFiles: ["a.test.ts", "b.test.ts"], failingNames: ["x"], notes: ["n"] });
    writeFileSync(f, JSON.stringify({ passed: 0, failed: 0, skipped: "no change to its paths" }));
    expect(readCheckOut(f)).toMatchObject({ skippedWhy: "no change to its paths", skipped: null });
    writeFileSync(f, JSON.stringify({ failures: [{ file: "c.test.ts" }] }));
    expect(readCheckOut(f)!.failingFiles).toEqual(["c.test.ts"]);
    // Names beyond the 50 failures kept for display are still every one (attribution follows them by name).
    writeFileSync(f, JSON.stringify({ failed: 60, failures: Array.from({ length: 60 }, (_, i) => ({ name: `t${i % 55}` })) }));
    expect(readCheckOut(f)!.failingNames.length).toBe(55);
    // Kaocha's lines: one test, whatever line or verdict word, is one name.
    writeFileSync(f, JSON.stringify({ failed: 3, failures: [{ name: "FAIL in (app.access-test/account-sign-in) (access_test.clj:74)" }, { name: "FAIL in (app.access-test/account-sign-in) (access_test.clj:75)" }, { name: "ERROR in (app.onboarding-test/practice-widget) (onboarding_test.clj:168)" }] }));
    expect(readCheckOut(f)!.failingNames).toEqual(["app.access-test/account-sign-in", "app.onboarding-test/practice-widget"]);
    writeFileSync(f, "not json");
    expect(readCheckOut(f)).toBeNull();
    expect(readCheckOut(join(dir, "missing.json"))).toBeNull();
  });

  test("testKey: the test, without its verdict word or location", () => {
    expect(testKey("FAIL in (a.b-test/c) (b_test.clj:12)")).toBe("a.b-test/c");
    expect(testKey("ERROR in (a.b-test/c) (b_test.clj:3:4)")).toBe("a.b-test/c");
    expect(testKey("src/x.test.ts:41")).toBe("src/x.test.ts");
    expect(testKey("not ok 3 - adds numbers")).toBe("adds numbers");
    expect(testKey("plain name")).toBe("plain name");
  });

  test("failing files from a runner's own output, relative only", () => {
    expect(failingFilesIn("FAIL server/a.test.ts (exit 1)\nnot ok 2 - src/b.test.ts\n✖ /abs/c.test.ts\n")).toEqual(["server/a.test.ts", "src/b.test.ts"]);
  });
});

describe("a rerun of named files", () => {
  const def = (testRun?: string[]) => ({ test: testRun ? { run: testRun } : undefined }) as unknown as Parameters<typeof rerunArgvOf>[0];
  test("a check that is the test command with selection flags reruns the test command alone (any wrapper kept)", () => {
    const run = ["node", "scripts/nice.mjs", "node", "scripts/run-tests.mjs", "--integration", "--landing", "--base", "${merge.base}"];
    const rendered = run.map((a) => (a === "${merge.base}" ? "abc123" : a));
    expect(rerunArgvOf(def(["node", "scripts/run-tests.mjs"]), { run }, rendered)).toEqual(["node", "scripts/nice.mjs", "node", "scripts/run-tests.mjs"]);
  });
  test("anything else keeps its own command and selectors", () => {
    expect(rerunArgvOf(def(["node", "scripts/run-tests.mjs"]), { run: ["node", "checks/unit.mjs"], select: ["x"] }, ["node", "checks/unit.mjs"])).toEqual(["node", "checks/unit.mjs", "x"]);
    expect(rerunArgvOf(def(), { run: ["pytest", "-m", "slow"] }, ["pytest", "-m", "slow"])).toEqual(["pytest", "-m", "slow"]);
    // The check IS the test command (no flags after it): unchanged.
    expect(rerunArgvOf(def(["npm", "test"]), { run: ["npm", "test"] }, ["npm", "test"])).toEqual(["npm", "test"]);
  });
  test("SOVA_OUT's ranFiles is read when a runner writes it, and absent when it doesn't", () => {
    const dir = scratchRoot("mq-ran-");
    const f = join(dir, "o.json");
    writeFileSync(f, JSON.stringify({ passed: 1, failed: 0, ranFiles: ["a.test.ts", "a.test.ts", 3] }));
    expect(readCheckOut(f)?.ranFiles).toEqual(["a.test.ts"]);
    writeFileSync(f, JSON.stringify({ passed: 1, failed: 0 }));
    expect(readCheckOut(f)?.ranFiles).toBeUndefined();
  });
});

describe("reuse of passes from identical code", () => {
  test("reuse: fresh on a rerun, a release, or merge.reuse false; else the 5% re-check; only a check is told", () => {
    expect(freshOf(declared, {})).toBe(false);
    expect(freshOf(declared, { rerun: true })).toBe(true);
    expect(freshOf(declared, { release: true })).toBe(true);
    const off = def({ merge: { checks: [{ id: "unit", run: ["node", "t.mjs"] }], reuse: false } });
    expect(off.merge?.reuse).toBe(false);
    expect(freshOf(off, {})).toBe(true);
    expect(freshOf(def({ merge: { checks: [{ id: "unit", run: ["node", "t.mjs"] }], reuse: true } }), {})).toBe(false);
    expect(() => def({ merge: { reuse: "no" } })).toThrow(/reuse/);
    const scope = { project: "/p", projectId: "p", copy: "/c", slot: 1, data: "/d", target: "master", base: "b" };
    expect(envOf(declared, scope, { fresh: true })).toMatchObject({ SOVA_FRESH: "1" });
    expect(envOf(declared, scope, { fresh: true }).SOVA_REUSE_SAMPLE).toBeUndefined();
    expect(envOf(declared, scope, { fresh: false })).toMatchObject({ SOVA_REUSE_SAMPLE: "0.05" });
    expect(envOf(declared, scope, { fresh: false }).SOVA_FRESH).toBeUndefined();
    // A setup or install step (no `fresh`) is told nothing; the server's own value never leaks through.
    process.env.SOVA_FRESH = "1";
    process.env.SOVA_REUSE_SAMPLE = "0.9";
    try {
      const e = envOf(declared, scope, { step: "install" });
      expect(e.SOVA_FRESH).toBeUndefined();
      expect(e.SOVA_REUSE_SAMPLE).toBeUndefined();
      expect(envOf(declared, scope, { fresh: false }).SOVA_REUSE_SAMPLE).toBe("0.05");
    } finally {
      delete process.env.SOVA_FRESH;
      delete process.env.SOVA_REUSE_SAMPLE;
    }
    // A release entry: by its release id, gates or none.
    expect(isReleaseRun({ entry: { release: "rl_1" } as never })).toBe(true);
    expect(isReleaseRun({ entry: {} as never, releaseChecks: [] })).toBe(true);
    expect(isReleaseRun({ entry: {} as never })).toBe(false);
  });

  test("reuse: SOVA_OUT's `reused` is read; a string `skipped` keeps the skipped-test count", () => {
    const dir = scratchRoot("mq-checks-reused-");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "out.json");
    writeFileSync(f, JSON.stringify({ passed: 900, failed: 0, skipped: 3, ranFiles: ["a.test.ts"], reused: { files: 540, of: 980, rechecked: 28, at: "2026-11-05T14:02:00Z", from: "feat/x's chat", list: [{ file: "b.test.ts", at: "2026-11-05T14:02:00Z", from: "feat/x's chat", run: "r1" }, { nope: 1 }] } }));
    expect(readCheckOut(f)!.reused).toEqual({ files: 540, of: 980, rechecked: 28, at: "2026-11-05T14:02:00Z", from: "feat/x's chat", list: [{ file: "b.test.ts", at: "2026-11-05T14:02:00Z", from: "feat/x's chat", run: "r1" }] });
    writeFileSync(f, JSON.stringify({ passed: 9, failed: 0, skipped: "already passed on identical code at 14:02", skippedTests: 2, reused: { files: 4, of: 4 } }));
    expect(readCheckOut(f)).toMatchObject({ passed: 9, failed: 0, skipped: 2, skippedWhy: "already passed on identical code at 14:02", reused: { files: 4, of: 4, rechecked: 0, list: [] } });
    // Unreadable `reused` (more reused than selected, not numbers): absent.
    writeFileSync(f, JSON.stringify({ passed: 1, reused: { files: 5, of: 4 } }));
    expect(readCheckOut(f)!.reused).toBeUndefined();
    writeFileSync(f, JSON.stringify({ passed: 1, reused: { files: "5", of: 9 } }));
    expect(readCheckOut(f)!.reused).toBeUndefined();
  });

  test("reuse: a passed check's detail, never Skipped while the re-check ran a file", () => {
    expect(reusedWords({ files: 540, of: 980, rechecked: 28 })).toBe("412 ran, 568 already passed on identical code (28 re-checked)");
    expect(reusedWords({ files: 3, of: 10, rechecked: 0 })).toBe("7 ran, 3 already passed on identical code");
    expect(reusedWords({ files: 0, of: 10, rechecked: 0 })).toBeNull();
    const rep = (o: object) => ({ report: { passed: 1, failed: 0, skipped: null, failures: [], failingFiles: [], failingNames: [], notes: [], ...o } });
    const counts = { passed: 1, failed: 0, skipped: null };
    expect(passedEnd(rep({ reused: { files: 540, of: 980, rechecked: 28, list: [] } }), counts)).toEqual(["passed", { counts, detail: "412 ran, 568 already passed on identical code (28 re-checked)", reused: 568 }]);
    // Everything reused but one re-checked file: passed, never Skipped, whatever the runner's why.
    expect(passedEnd(rep({ skippedWhy: "already passed on identical code at 14:02", reused: { files: 9, of: 10, rechecked: 1, list: [] } }), counts)[0]).toBe("passed");
    // Everything reused, nothing re-checked (a fresh-less run outside the queue's sample): Skipped with its why.
    expect(passedEnd(rep({ skippedWhy: "already passed on identical code at 14:02", reused: { files: 10, of: 10, rechecked: 0, list: [] } }), counts)).toEqual(["skipped", { counts, detail: "skipped: already passed on identical code at 14:02", reused: 10 }]);
    expect(passedEnd(rep({}), counts)).toEqual(["passed", { counts }]);
    expect(passedEnd(rep({ skippedWhy: "no change to its paths" }), counts)).toEqual(["skipped", { counts, detail: "skipped: no change to its paths" }]);
  });
});
