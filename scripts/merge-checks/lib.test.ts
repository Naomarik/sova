import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchRoot } from "../../server/test-scratch.ts";
import { changedExtensions, context, expandArgs, opt, suiteOf, touchesSpecReplay, touchesStatecharts } from "./lib.mjs";

const README = `# pi-config

## Tests

\`\`\`sh
node --test install.test.mjs
cd extensions/worktrees && node --test state.test.ts git.test.ts && node tests/run.mjs
cd extensions/spec && node --test --test-concurrency=4 tests/*.test.mjs
\`\`\`
`;

describe("merge-checks lib", () => {
  test("suiteOf reads an extension's commands from the README's Tests block, and null for none", () => {
    expect(suiteOf(README, "worktrees")).toEqual({ dir: "extensions/worktrees", commands: [["node", "--test", "state.test.ts", "git.test.ts"], ["node", "tests/run.mjs"]] });
    expect(suiteOf(README, "nope")).toBeNull();
    expect(suiteOf("# no tests block", "worktrees")).toBeNull();
  });

  test("expandArgs expands one star in the last segment, sorted, and keeps a pattern with no hit", () => {
    const root = scratchRoot("mc-lib-");
    mkdirSync(join(root, "tests"));
    for (const f of ["b.test.mjs", "a.test.mjs", "c.txt"]) writeFileSync(join(root, "tests", f), "");
    expect(expandArgs(["--test", "tests/*.test.mjs"], root)).toEqual(["--test", "tests/a.test.mjs", "tests/b.test.mjs"]);
    expect(expandArgs(["none/*.x"], root)).toEqual(["none/*.x"]);
  });

  test("which changes trigger which checks", () => {
    expect(changedExtensions(["pi-config/extensions/spec/a.ts", "pi-config/extensions/mode/b.ts", "pi-config/README.md", "server/x.ts", "pi-config/extensions/spec/c.ts"])).toEqual(["mode", "spec"]);
    expect(touchesSpecReplay("pi-config/extensions/spec/core/x.mjs")).toBe(true);
    expect(touchesSpecReplay("pi-config/extensions/mode/spec-guard.ts")).toBe(true);
    expect(touchesSpecReplay("pi-config/extensions/spec/tools.ts")).toBe(false);
    expect(touchesStatecharts("statecharts/src/a.cljs")).toBe(true);
    expect(touchesStatecharts("scripts/statecharts-test.mjs")).toBe(true);
    expect(touchesStatecharts("server/statecharts-replay.ts")).toBe(true);
    expect(touchesStatecharts("src/statecharts/x.ts")).toBe(false);
  });

  test("opt reads a flag's value and never takes the next flag as one", () => {
    expect(opt(["--base", "abc", "--x"], "--base")).toBe("abc");
    expect(opt(["--base", "--x"], "--base", "d")).toBe("d");
  });

  test("context: SOVA_MERGE_BASE and SOVA_MERGE_CHANGED win; else the merge base with the target and git's diff", () => {
    const root = scratchRoot("mc-ctx-");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "master");
    writeFileSync(join(root, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "feat");
    writeFileSync(join(root, "b.txt"), "b\n");
    git("add", "b.txt");
    git("commit", "-qm", "feat");
    const own = context([], {}, root);
    expect(own.base).toBe(base);
    expect(own.changed).toEqual(["b.txt"]);
    expect(own.out).toBeNull();
    const list = join(root, "changed.txt");
    writeFileSync(list, "x/y.ts\n\nz.md\n");
    const given = context([], { SOVA_MERGE_BASE: "deadbeef", SOVA_MERGE_CHANGED: list, SOVA_OUT: "/o.json" }, root);
    expect(given).toMatchObject({ base: "deadbeef", changed: ["x/y.ts", "z.md"], out: "/o.json" });
  });
});
