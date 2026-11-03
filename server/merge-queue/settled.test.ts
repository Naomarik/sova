import assert from "node:assert/strict";
import { test } from "node:test";
import type { Git } from "./guard";
import { SETTLED_CHECKED, settledFacts } from "./settled";
import type { QueueFile } from "./store";

// §app.merge-queue/view

type Stored = QueueFile["entries"][number];
const fix = (n: number, o: Partial<Stored> = {}): Stored =>
  ({ id: `mq_${n}`, seq: n, project: "p", target: "master", branch: `feat/b${n}`, commit: `c${n}`, approval: { by: "land-button", at: "t", commit: `c${n}` }, state: "needs-fix", runs: [], picks: [], notes: [], createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), updatedAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), ...o }) as Stored;

/** A git stand-in: branches that exist (name -> tip), commits already in the target, and an optional broken ref read. */
function stubGit(o: { branches: Record<string, string>; inTarget: string[]; broken?: string[] }): { git: Git; calls: string[][] } {
  const calls: string[][] = [];
  const git: Git = async (args) => {
    calls.push(args);
    const ref = args.find((a) => a.startsWith("refs/heads/"))?.replace(/^refs\/heads\//, "").replace(/\^\{commit\}$/, "");
    if (ref && o.broken?.includes(ref)) return { code: 128, stdout: "", stderr: "fatal: unable to read: Input/output error" };
    if (args[0] === "show-ref") return { code: ref && ref in o.branches ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "rev-parse") return ref && ref in o.branches ? { code: 0, stdout: `${o.branches[ref]}\n`, stderr: "" } : { code: 128, stdout: "", stderr: "fatal: Needed a single revision" };
    if (args[0] === "merge-base") return { code: o.inTarget.includes(args[2]!) ? 0 : 1, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  return { git, calls };
}

test("merged, gone and current from git; a git error that doesn't say missing settles nothing", async () => {
  const merged = fix(1);
  const tipMerged = fix(2);
  const deleted = fix(3);
  const folderGone = fix(4, { worktree: "/gone" });
  const broken = fix(5, { worktree: "/here" });
  const current = fix(6, { worktree: "/here" });
  const { git } = stubGit({ branches: { "feat/b1": "t1", "feat/b2": "t2", "feat/b4": "t4", "feat/b6": "t6" }, inTarget: ["c1", "t2"], broken: ["feat/b5"] });
  const facts = await settledFacts(git, "/r", "head", [merged, tipMerged, deleted, folderGone, broken, current], (p) => p === "/here");
  assert.deepEqual(Object.fromEntries(facts), { mq_1: "merged", mq_2: "merged", mq_3: "gone", mq_4: "gone" });
  assert.equal(facts.get("mq_5"), undefined, "a broken ref read is unknown: the entry stays current");
});

test("superseded entries skip git, and only the newest few are checked", async () => {
  const old = fix(1, { branch: "feat/same" });
  const later = fix(2, { branch: "feat/same", state: "landed" });
  const many = Array.from({ length: SETTLED_CHECKED + 10 }, (_, i) => fix(10 + i));
  const { git, calls } = stubGit({ branches: {}, inTarget: [] });
  const facts = await settledFacts(git, "/r", "head", [old, later, ...many], () => true);
  assert.ok(!calls.some((c) => c.includes("refs/heads/feat/same")), "the superseded entry asks git nothing");
  assert.equal(facts.size, SETTLED_CHECKED, "only the newest are checked (each reads gone: no branch)");
  assert.ok(facts.has(`mq_${10 + SETTLED_CHECKED + 9}`) && !facts.has("mq_10"));
});
