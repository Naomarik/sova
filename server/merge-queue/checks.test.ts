import { describe, test } from "node:test";
import { expect } from "./testing/expect";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDefinition, type ProjectDef } from "../../shared/project-contract";
import { scratchRoot } from "../test-scratch";
import { checksOf, envOf, failingFilesIn, planChecks, readCheckOut, templateVarsOf } from "./checks";

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
    try {
      const scope = { project: "/p/demo", projectId: "demo1", copy: "/p/.worktrees/demo-merge", slot: 19, data: "/s/data", target: "master", base: "b".repeat(40), tip: "t".repeat(40), changedFile: "/s/changed.txt" };
      const e = envOf(declared, scope, { step: "unit", out: "/s/out.json", picked: true });
      expect(e.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(e.SOVA_CHAT_ID).toBeUndefined();
      expect(e.ANTHROPIC_API_KEY).toBeUndefined();
      expect(e).toMatchObject({ SOVA_VERB: "merge", SOVA_STEP: "unit", SOVA_OUT: "/s/out.json", SOVA_MERGE_BASE: scope.base, SOVA_MERGE_TIP: scope.tip, SOVA_MERGE_TARGET: "master", SOVA_MERGE_CHANGED: "/s/changed.txt", SOVA_MERGE_PICKED: "1", SOVA_CHECKOUT: scope.copy, SOVA_PORT_WEB_HTTP: String(5100 + 19) });
      expect(templateVarsOf(declared, scope)).toMatchObject({ "merge.base": scope.base, "merge.tip": scope.tip, "merge.target": "master", checkout: scope.copy, main: "/p/demo", "ports.web.http": String(5100 + 19) });
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
      delete process.env.SOVA_CHAT_ID;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("a check's report: counts, skipped why, failures, every failing file; garbage reads as null", () => {
    const dir = scratchRoot("mq-checks-");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, "out.json");
    writeFileSync(f, JSON.stringify({ passed: 3, failed: 1, skipped: 2, failures: [{ name: "x", file: "a.test.ts", message: "boom" }, { bogus: 1 }], failingFiles: ["a.test.ts", "b.test.ts"], notes: ["n"] }));
    expect(readCheckOut(f)).toEqual({ passed: 3, failed: 1, skipped: 2, failures: [{ name: "x", file: "a.test.ts", message: "boom" }], failingFiles: ["a.test.ts", "b.test.ts"], notes: ["n"] });
    writeFileSync(f, JSON.stringify({ passed: 0, failed: 0, skipped: "no change to its paths" }));
    expect(readCheckOut(f)).toMatchObject({ skippedWhy: "no change to its paths", skipped: null });
    writeFileSync(f, JSON.stringify({ failures: [{ file: "c.test.ts" }] }));
    expect(readCheckOut(f)!.failingFiles).toEqual(["c.test.ts"]);
    writeFileSync(f, "not json");
    expect(readCheckOut(f)).toBeNull();
    expect(readCheckOut(join(dir, "missing.json"))).toBeNull();
  });

  test("failing files from a runner's own output, relative only", () => {
    expect(failingFilesIn("FAIL server/a.test.ts (exit 1)\nnot ok 2 - src/b.test.ts\n✖ /abs/c.test.ts\n")).toEqual(["server/a.test.ts", "src/b.test.ts"]);
  });
});
