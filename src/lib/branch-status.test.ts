// A session row's branch status says what its chat's composer status row says (WorktreesControl), for the same
// branch states: one table drives both sides, the chat's rows built as the Session tab's server builds them
// (worktrees-state.ts describeWorktrees + insights.ts: the session's readiness joined by path) and the list's as the
// session list carries them (SessionSummary.branches, its queue entry cut by branchQueueOf).
import assert from "node:assert/strict";
import { test } from "node:test";
import { branchQueueOf, type WorktreeMergeProject, type WorktreeQueueInfo } from "../../shared/merge-queue";
import type { SessionBranchRow, SessionReadiness, SessionWorktreeInfo, WorktreeReadiness } from "../../shared/protocol";
import { branchLine, rowBranchStatus, STATUS_MARK } from "./branch-status";
import { controlWords, queueRow, type RowKey } from "./merge-queue";

const SHA = "a".repeat(40);
const FIX = "b".repeat(40);
const ME = "s_me";

/** One branch's state, as the table states it. */
interface Branch {
  branch: string;
  /** Inherited from the chat this one was forked from: the session's readiness holds none for it. */
  inherited?: true;
  status?: "active" | "merged" | "dropped";
  exists?: boolean;
  mergedInto?: true;
  readiness?: Omit<WorktreeReadiness, "path" | "branch">;
  queue?: Partial<WorktreeQueueInfo>;
  served?: boolean;
}

const project: WorktreeMergeProject = { id: "prj_1", root: "/r", target: "main", checks: "declared", review: false };
const pathOf = (b: Branch) => `/w/${b.branch}`;
const queueOf = (b: Branch): WorktreeQueueInfo | undefined => (b.queue ? ({ id: "me_1", project: "prj_1", state: "queued", commit: SHA, notes: [], ...b.queue } as WorktreeQueueInfo) : undefined);

/** The session's readiness: its own branches only (merge-readiness.ts computeReadiness), never an inherited one. */
const readinessOf = (bs: Branch[]): SessionReadiness | undefined => {
  const trees = bs.filter((b) => !b.inherited && b.readiness && b.status !== "dropped").map((b) => ({ path: pathOf(b), branch: b.branch, ...b.readiness! }));
  return trees.length ? { trees, since: 1 } : undefined;
};

/** The chat's rows, as insights.ts serves them: describeWorktrees' row, its readiness by path (treeReadinessOf). */
const chatRows = (bs: Branch[]): SessionWorktreeInfo[] => {
  const r = readinessOf(bs);
  return bs.map((b) => {
    const q = queueOf(b);
    const readiness = r?.trees.find((t) => t.path === pathOf(b));
    return {
      path: pathOf(b),
      branch: b.branch,
      status: b.status ?? "active",
      how: "created",
      ...(b.inherited ? { sharedWith: "s_parent" } : {}),
      exists: b.exists ?? true,
      hasAgentDir: false,
      runningWorkers: 0,
      ...(b.mergedInto ? { mergedInto: { target: "main", sha: SHA } } : {}),
      ...(readiness ? { readiness } : {}),
      ...(q ? { queue: q } : {}),
      mergeProject: project,
      ...(b.served !== false ? { mergeServed: true as const } : {}),
    };
  });
};

/** The chat's words: WorktreesControl's own derivation (dropped left out, queueRow, controlWords). */
const chatSays = (bs: Branch[]) => controlWords(chatRows(bs).filter((w) => w.status !== "dropped").map((w) => queueRow(w)));

/** The list's row, as the session list carries it (merge-readiness.ts computeBranches, dropped left out). */
const listRow = (bs: Branch[]) => {
  const branches: SessionBranchRow[] = bs
    .filter((b) => b.status !== "dropped")
    .map((b) => {
      const q = queueOf(b);
      return {
        path: pathOf(b),
        branch: b.branch,
        status: b.status === "merged" ? "merged" : "active",
        exists: b.exists ?? true,
        ...(b.inherited ? { sharedWith: "s_parent" } : {}),
        ...(b.mergedInto ? { mergedInto: { target: "main", sha: SHA } } : {}),
        ...(q ? { queue: branchQueueOf(q) } : {}),
        ...(b.served !== false ? { mergeServed: true as const } : {}),
        mergeProject: { target: project.target, checks: project.checks },
      };
    });
  return { branches, readiness: readinessOf(bs) };
};

const ready: Omit<WorktreeReadiness, "path" | "branch"> = { state: "ready", landing: { state: "ready", commit: SHA } };
const merged: Omit<WorktreeReadiness, "path" | "branch"> = { state: "merged", merged: true };
const host = (state: "open" | "merged") => ({ how: "github-pr" as const, host: "github" as const, branch: "feat/x", base: "main", facts: { state } as never });

/** Every state a branch reads, alone and together, inherited ones among them. `keys`: what its rows' keys are. */
const TABLE: { name: string; branches: Branch[]; says: string; keys: RowKey[] }[] = [
  { name: "a ready branch", branches: [{ branch: "a", readiness: ready }], says: "1 ready", keys: ["ready"] },
  { name: "a ready branch of a repo the queue doesn't serve", branches: [{ branch: "a", readiness: ready, served: false }], says: "1 ready", keys: ["ready"] },
  { name: "queued", branches: [{ branch: "a", readiness: ready, queue: { state: "queued", position: 2 } }], says: "1 queued", keys: ["queued"] },
  { name: "two queued", branches: [{ branch: "a", queue: { state: "queued", position: 1 } }, { branch: "b", queue: { state: "queued", position: 2 } }], says: "2 queued", keys: ["queued", "queued"] },
  { name: "checking", branches: [{ branch: "a", queue: { state: "checking" } }], says: "1 checking", keys: ["checking"] },
  { name: "checking beats queued", branches: [{ branch: "a", queue: { state: "checking" } }, { branch: "b", queue: { state: "queued" } }], says: "1 checking", keys: ["checking", "queued"] },
  { name: "ready beats checking", branches: [{ branch: "a", queue: { state: "checking" } }, { branch: "b", readiness: ready }], says: "1 ready", keys: ["checking", "ready"] },
  { name: "sent back", branches: [{ branch: "a", readiness: ready, queue: { state: "needs-fix", reason: "Unit tests failed" } }], says: "1 needs a fix", keys: ["needs-fix"] },
  { name: "sent back, fixed and finished at a newer commit", branches: [{ branch: "a", readiness: { state: "ready", landing: { state: "ready", commit: FIX } }, queue: { state: "needs-fix" } }], says: "1 ready", keys: ["ready"] },
  { name: "needs a fix beats ready", branches: [{ branch: "a", queue: { state: "needs-fix" } }, { branch: "b", readiness: ready }], says: "1 needs a fix", keys: ["needs-fix", "ready"] },
  { name: "behaviour differs", branches: [{ branch: "a", queue: { state: "behaviour-differs" } }], says: "1 needs you", keys: ["behaviour-differs"] },
  { name: "review flagged", branches: [{ branch: "a", queue: { state: "review-flagged" } }], says: "1 needs you", keys: ["review-flagged"] },
  { name: "can't tell whose failure", branches: [{ branch: "a", queue: { state: "unattributed" } }], says: "1 needs you", keys: ["unattributed"] },
  { name: "drafts changed", branches: [{ branch: "a", queue: { state: "drafts-changed" } }], says: "1 needs you", keys: ["drafts-changed"] },
  { name: "a request to review", branches: [{ branch: "a", queue: { state: "request-review", request: host("open") } }], says: "1 needs you", keys: ["request-review"] },
  {
    name: "needs you beats needs a fix, counted together",
    branches: [{ branch: "a", queue: { state: "needs-fix" } }, { branch: "b", queue: { state: "review-flagged" } }, { branch: "c", queue: { state: "request-review", request: host("open") } }],
    says: "2 need you",
    keys: ["needs-fix", "review-flagged", "request-review"],
  },
  { name: "a conflict being judged", branches: [{ branch: "a", queue: { state: "conflict" } }], says: "1 worktree", keys: ["conflict"] },
  { name: "landed", branches: [{ branch: "a", queue: { state: "landed" } }], says: "1 worktree", keys: ["landed"] },
  { name: "waiting on the host", branches: [{ branch: "a", queue: { state: "requested", request: host("open") } }], says: "1 worktree", keys: ["requested"] },
  { name: "merged on the host, entry not moved yet", branches: [{ branch: "a", queue: { state: "requested", request: host("merged") } }], says: "1 worktree", keys: ["landed"] },
  { name: "pushed and closed", branches: [{ branch: "a", queue: { state: "pushed" } }, { branch: "b", queue: { state: "closed" } }], says: "2 worktrees", keys: ["pushed", "closed"] },
  { name: "cancelled: the tree itself", branches: [{ branch: "a", readiness: ready, queue: { state: "cancelled" } }], says: "1 ready", keys: ["ready"] },
  { name: "uncommitted", branches: [{ branch: "a", readiness: { state: "in-progress", dirtyCount: 2 } }], says: "1 worktree", keys: ["uncommitted"] },
  { name: "no commits yet", branches: [{ branch: "a", readiness: { state: "in-progress", noCommits: true } }], says: "1 worktree", keys: ["no-commits"] },
  { name: "merged: recorded, by git, by readiness", branches: [{ branch: "a", status: "merged" }, { branch: "b", mergedInto: true }, { branch: "c", readiness: merged }], says: "3 worktrees", keys: ["merged", "merged", "merged"] },
  { name: "removed", branches: [{ branch: "a", exists: false }], says: "1 worktree", keys: ["removed"] },
  { name: "dropped ones are left out", branches: [{ branch: "a", status: "dropped" }, { branch: "b", readiness: ready }], says: "1 ready", keys: ["ready"] },
  // Inherited (a fork): the chat has no readiness for one, so with nothing else said it reads ready there.
  { name: "an inherited tree", branches: [{ branch: "a", inherited: true }], says: "1 ready", keys: ["ready"] },
  { name: "an inherited tree, uncommitted in its own chat: still ready here", branches: [{ branch: "a", inherited: true, readiness: { state: "in-progress", dirtyCount: 3 } }], says: "1 ready", keys: ["ready"] },
  { name: "an inherited tree being checked", branches: [{ branch: "a", inherited: true, queue: { state: "checking" } }, { branch: "b", readiness: { state: "in-progress", dirtyCount: 1 } }], says: "1 checking", keys: ["checking", "uncommitted"] },
  { name: "an inherited tree git finds merged", branches: [{ branch: "a", inherited: true, mergedInto: true }, { branch: "b", readiness: merged }], says: "2 worktrees", keys: ["merged", "merged"] },
  { name: "an inherited tree sent back, beside an own ready one", branches: [{ branch: "a", inherited: true, queue: { state: "needs-fix" } }, { branch: "b", readiness: ready }], says: "1 needs a fix", keys: ["needs-fix", "ready"] },
];

test("the row says what the chat says, for every branch state in the table", () => {
  for (const c of TABLE) {
    const chat = chatSays(c.branches);
    const list = rowBranchStatus(listRow(c.branches));
    assert.equal(chat?.text, c.says, `${c.name}: the chat`);
    assert.equal(list?.text, chat?.text, `${c.name}: the row says the chat's words`);
    assert.equal(list?.n, chat?.n, `${c.name}: the same number`);
    // Each branch's key, chat and list alike.
    const chatKeys = chatRows(c.branches).filter((w) => w.status !== "dropped").map((w) => queueRow(w).key);
    assert.deepEqual(chatKeys, c.keys, `${c.name}: the chat's keys`);
    assert.equal(list!.lines.length >= 1 + c.keys.length, true, `${c.name}: a line per branch`);
  }
});

test("the table reaches every key a row can have", () => {
  // A Record over RowKey: a key added to the ladder fails to compile here until the table covers it.
  const every: Record<Exclude<RowKey, "dropped">, true> = {
    uncommitted: true,
    "no-commits": true,
    ready: true,
    queued: true,
    checking: true,
    conflict: true,
    "behaviour-differs": true,
    "review-flagged": true,
    unattributed: true,
    "needs-fix": true,
    "drafts-changed": true,
    landed: true,
    "request-review": true,
    requested: true,
    pushed: true,
    closed: true,
    merged: true,
    removed: true,
  };
  const seen = new Set(TABLE.flatMap((c) => c.keys));
  assert.deepEqual(Object.keys(every).filter((k) => !seen.has(k as RowKey)), []);
});

test("each fact has its own mark and tone; the words are the title's first line, then each branch in the Worktrees window's words", () => {
  const icons = Object.values(STATUS_MARK).map((m) => m.icon);
  assert.equal(new Set(icons).size, icons.length, "a symbol of its own per fact: colour is never the only signal");
  assert.deepEqual(STATUS_MARK.fix, { icon: "alert-triangle", tone: "error" });
  assert.deepEqual(STATUS_MARK.you, { icon: "alert-circle", tone: "warn" });
  assert.deepEqual(STATUS_MARK.ready, { icon: "check-circle", tone: "success" });
  assert.equal(STATUS_MARK.worktrees.icon, "branch");

  const s = listRow([
    { branch: "feat/login", queue: { state: "needs-fix", reason: "Unit tests failed on the merge" } },
    { branch: "feat/b", readiness: ready },
  ]);
  const st = rowBranchStatus({ ...s, readiness: { ...s.readiness!, restartPending: true, pushPending: true, status: { branch: "feat/old", commit: "1234567", pushed: false, live: false } } })!;
  assert.equal(st.kind, "fix");
  assert.equal(st.icon, "alert-triangle");
  assert.deepEqual(st.lines, [
    "1 needs a fix",
    "feat/login: Needs a fix · Unit tests failed on the merge",
    "feat/b: Ready",
    "feat/old: merged 1234567 · not pushed · restart owed",
    "A merge changed the server since it started: restart it to run the new code.",
    "The merge isn't pushed yet.",
  ]);
  // The same line the Worktrees window draws from the same row.
  const row = queueRow(chatRows([{ branch: "feat/login", queue: { state: "needs-fix", reason: "Unit tests failed on the merge" } }])[0]!);
  assert.equal(st.lines[1], branchLine("feat/login", row));
  // A reason over several lines (behaviour differs) stays one line per branch.
  assert.equal(branchLine("x", { label: "Behaviour differs", reason: "Target: a\nBranch: b" }), "x: Behaviour differs · Target: a · Branch: b");
});

test("a row with no branches shows nothing", () => {
  assert.equal(rowBranchStatus({}), null);
  assert.equal(rowBranchStatus({ branches: [] }), null);
  // Readiness alone (an older server, no branches) draws nothing rather than guess.
  assert.equal(rowBranchStatus({ readiness: { trees: [{ path: "/w/a", branch: "a", state: "ready" }], since: 1 } }), null);
});
