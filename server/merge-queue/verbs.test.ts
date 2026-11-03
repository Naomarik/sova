import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { recordGoAhead, typedGoAhead } from "../../pi-config/extensions/worktrees/landing.ts";
import { isVerbResult, MERGE_VERBS } from "../../shared/project-contract";
import { COMMANDS } from "../../shared/commands-catalog";
import type { Caller } from "../project-services/engine";
import { ingestOnce } from "./ingest";
import { noticeText } from "./notices";
import { merger } from "./routes";
import { makeKit, makeRepo, sh, until } from "./testing/queue-kit";

const op: Caller = { kind: "operator" };

describe("the typed word (landing.json)", () => {
  test("only new owner-chat go-aheads are queued, once each, at that commit; 'skip review' carries; the first read takes none", async () => {
    const k = makeKit();
    try {
      const q = await k.q();
      await q.pause("hold");
      const file = join(k.repo.state, "landing.json");
      const seenFile = join(k.repo.state, "merge-queue", "ingest.json");
      const refused: string[] = [];
      const deps = { file, seenFile, roots: () => [k.repo.root], served: async () => true, queue: () => k.q(), refused: (_s: string, t: string) => void refused.push(t) };
      const old = k.repo.branch("feat/old", { "o.txt": "o\n" });
      recordGoAhead({ branch: "feat/old", commit: old.head, session: "s0", at: "2026-11-01T00:00:00Z", by: "owner-chat" }, file);
      assert.deepEqual(await ingestOnce(deps), [], "the first read is a baseline");
      assert.equal(q.entries().length, 0);
      const b = k.repo.branch("feat/b", { "b.txt": "b\n" });
      const word = typedGoAhead("land it, skip review")!;
      recordGoAhead({ branch: "feat/b", commit: b.head, session: "s1", at: "2026-11-02T00:00:00Z", by: "owner-chat", ...(word.withoutReview ? { withoutReview: true as const } : {}) }, file);
      // Not the user's typed word in the branch's chat: never taken here.
      const c = k.repo.branch("feat/c", { "c.txt": "c\n" });
      recordGoAhead({ branch: "feat/c", commit: c.head, at: "2026-11-02T00:00:01Z", by: "land-it" }, file);
      const did = await ingestOnce(deps);
      assert.equal(did.length, 1);
      const e = q.entries().find((x) => x.branch === "feat/b")!;
      assert.equal(e.approval.by, "typed");
      assert.equal(e.commit, b.head);
      assert.equal(e.approval.withoutReview, true);
      assert.equal(e.session, "s1");
      assert.equal(q.entries().some((x) => x.branch === "feat/c"), false);
      assert.deepEqual(await ingestOnce(deps), [], "once each");
      // A refusal reaches the branch's chat.
      sh(k.repo.root, "branch", "feat/none");
      recordGoAhead({ branch: "feat/none", commit: k.repo.head(), session: "s2", at: "2026-11-02T00:00:02Z", by: "owner-chat" }, file);
      await ingestOnce(deps);
      assert.match(refused[0]!, /couldn't be queued to land: nothing to land/);
      // No project holds it.
      recordGoAhead({ branch: "feat/elsewhere", commit: "a".repeat(40), session: "s3", at: "2026-11-02T00:00:03Z", by: "owner-chat" }, file);
      await ingestOnce(deps);
      assert.match(refused[1]!, /not a project the merge queue serves: merge it into main from the chat/);
      assert.ok(JSON.parse(readFileSync(seenFile, "utf8")).keys.length >= 4);
    } finally {
      await k.done();
    }
  });
});

describe("the verbs and who may call them", () => {
  const setup = () => {
    const k = makeKit();
    const thread = "thread-1";
    const reviewer = "reviewer-1";
    const call = merger({
      queues: k.queues,
      served: { isListed: () => true, served: async () => true, bareView: async () => { throw new Error("every root here is served"); } },
      rootOf: async (p) => (p.startsWith(k.repo.scratch) ? k.repo.root : null),
      isThreadChat: (root, sid) => root === k.repo.root && sid === thread,
      reviewerOf: (run) => (run === "mr_0rev" ? reviewer : null),
      deliverReview: (run) => run === "mr_0rev",
    });
    const session = (id: string, root: string | null = k.repo.root): Caller => ({ kind: "session", id, root, own: [] });
    return { k, call, thread, reviewer, session };
  };

  test("the operator lands, cancels, pauses and answers; results are verb results with the merge key", async () => {
    const { k, call } = setup();
    try {
      const b = k.repo.branch("feat/a", { "b.txt": "b\n" });
      const r = await call("merge.add", { checkout: b.path, chat: "s1" }, op);
      assert.ok(isVerbResult(r), "a verb result");
      assert.equal(r.ok, true);
      assert.equal(r.merge!.entry!.branch, "feat/a");
      assert.equal(r.merge!.entry!.approval.by, "land-button");
      assert.equal(r.merge!.entry!.session, "s1");
      const s = await call("merge.status", { project: k.repo.root }, op);
      assert.equal(s.merge!.view!.target, "master");
      await until(async () => (await call("merge.status", { project: k.repo.root }, op)).merge!.view!.recent.length === 1, "landed");
      const logs = await call("merge.logs", { entry: r.merge!.entry!.id }, op);
      assert.equal(logs.ok, true);
      assert.equal(logs.merge!.run!.verdict, "passed");
      const bad = await call("merge.answer", { entry: r.merge!.entry!.id, answer: "nope" }, op);
      assert.equal(bad.error!.code, "invalid-request");
      const p = await call("merge.pause", { project: k.repo.root, why: "release" }, op);
      assert.equal(p.merge!.view!.state, "paused");
      const p2 = await call("merge.pause", { project: k.repo.root }, op);
      assert.equal(p2.changed, false);
      const unknown = await call("merge.cancel", { entry: "mq_nope" }, op);
      assert.equal(unknown.error!.code, "not-found");
    } finally {
      await k.done();
    }
  });

  test("a chat reads its own project's queue and nothing more; never another project's", async () => {
    const { k, call, session } = setup();
    try {
      const b = k.repo.branch("feat/a", { "b.txt": "b\n" });
      const me = session("s-any");
      assert.equal((await call("merge.status", {}, me)).ok, true);
      for (const [verb, body] of [
        ["merge.add", { checkout: b.path }],
        ["merge.pause", {}],
        ["merge.resume", {}],
        ["merge.note", { entry: "mq_x", note: "x" }],
      ] as const) {
        const r = await call(verb, { project: k.repo.root, ...body }, me);
        assert.equal(r.error?.code, "forbidden", verb);
      }
      const other = makeRepo({ prefix: "mq-other-" });
      try {
        const r = await call("merge.status", { project: k.repo.root }, session("s-x", other.root));
        assert.equal(r.error!.code, "forbidden");
      } finally {
        other.done();
      }
    } finally {
      await k.done();
    }
  });

  test("the merge thread notes, extends, resolves and retries, never adds, cancels or answers; the reviewer only reviews its run", async () => {
    const { k, call, thread, reviewer, session } = setup();
    try {
      const q = await k.q();
      await q.pause("hold");
      k.repo.branch("feat/a", { "b.txt": "b\n" });
      const added = await call("merge.add", { project: k.repo.root, branch: "feat/a" }, op);
      const id = added.merge!.entry!.id;
      const t = session(thread);
      assert.equal((await call("merge.note", { entry: id, note: "changes server code" }, t)).ok, true);
      assert.equal((await call("merge.extend", { entry: id, checks: ["statecharts"], why: "statecharts/ changed" }, t)).ok, true);
      assert.equal((await call("merge.add", { project: k.repo.root, branch: "feat/a" }, t)).error!.code, "forbidden");
      assert.equal((await call("merge.cancel", { entry: id }, t)).error!.code, "forbidden");
      assert.equal((await call("merge.answer", { entry: id, answer: "accept" }, t)).error!.code, "forbidden");
      assert.equal((await call("merge.note", { entry: id, note: "x" }, session("someone"))).error!.code, "forbidden");
      assert.equal((await call("merge.review", { project: k.repo.root, run: "mr_0rev", verdict: "ok" }, session(reviewer))).ok, true);
      assert.equal((await call("merge.review", { project: k.repo.root, run: "mr_0rev", verdict: "ok" }, t)).error!.code, "forbidden");
      assert.equal((await call("merge.review", { project: k.repo.root, run: "mr_0rev", verdict: "blocking" }, session(reviewer))).error!.code, "invalid-request");
      const e = q.entry(id)!;
      assert.equal(e.notes[0]!.text, "changes server code");
      assert.equal(e.picks[0]!.id, "statecharts");
    } finally {
      await k.done();
    }
  });

  test("every merge verb is on the catalogue, at its route, as the admin's", () => {
    for (const v of MERGE_VERBS) {
      const c = COMMANDS.find((x) => x.id === `project.verb.${v}`);
      assert.ok(c, v);
      assert.equal(c!.route.path, `/api/project-services/${v}`);
      assert.equal(c!.meshNeed, "admin");
      assert.equal(c!.effect, v === "merge.status" || v === "merge.logs" ? "looks" : "changes");
    }
  });
});

describe("what the branch's chat is told", () => {
  const base = { id: "mq_1", project: "p", target: "master", branch: "feat/a", commit: "a".repeat(40), approval: { by: "land-button" as const, at: "t", commit: "a".repeat(40) }, state: "landed" as const, runs: [], picks: [], notes: [], createdAt: "t", updatedAt: "t" };

  test("landed: the commit, the note, what isn't included; no word of restarting or live", () => {
    const text = noticeText("landed", { ...base, newerCommits: 1, landed: { sha: "b".repeat(40), from: "c".repeat(40), at: "t", pushed: "pushed" }, notes: [{ kind: "thread", text: "changes server code; restart Sova to pick it up", at: "t" }] });
    assert.match(text, /feat\/a landed on master at bbbbbbb \(the commit you approved, aaaaaaa\)/);
    assert.match(text, /1 newer commit not included/);
    assert.match(text, /Note: changes server code/);
    const plain = noticeText("landed", { ...base, landed: { sha: "b".repeat(40), from: "c".repeat(40), at: "t", pushed: "pushed" } });
    assert.doesNotMatch(plain, /\blive\b|restart/i);
  });

  test("handed back: why, the failing step and its log; sent back: both sides in plain words", () => {
    const run = { id: "mr_1", entry: "mq_1", project: "p", branch: "feat/a", base: "x", commit: "y", checks: [], verdict: "failed" as const, startedAt: "t", steps: [{ id: "check:unit", kind: "check" as const, label: "Unit tests", result: "failed" as const, ms: 1, log: "logs/03-unit.log", detail: "1 failed", failures: [{ file: "src/a.test.ts", name: "adds", message: "expected 2\nmore", blame: "branch" as const }] }] };
    const t = noticeText("needs-fix", { ...base, state: "needs-fix", reason: "Unit tests failed" }, { run, logDir: "/state/runs/mr_1" });
    assert.match(t, /didn't land: Unit tests failed/);
    assert.match(t, /Unit tests: 1 failed \(src\/a\.test\.ts › adds\) · log \/state\/runs\/mr_1\/logs\/03-unit\.log/);
    assert.match(t, /expected 2$/m);
    const s = noticeText("sent-back", { ...base, state: "needs-fix", reason: "the two sides want different behaviour", conflict: { files: ["a.ts"], verdict: "behaviour-differs", ours: "returns 2", theirs: "returns 3", proposal: "a flag", at: "t" } });
    assert.match(s, /master's side: returns 2\nThis branch's side: returns 3\nProposed: a flag/);
  });
});

void writeFileSync;

describe("the worktree row's numbers", () => {
  test("commits ahead and lines +/− of the branch's side, against the target's head", async () => {
    const { statsOf } = await import("./wire");
    const repo = makeRepo({ prefix: "mq-stats-" });
    try {
      const b = repo.branch("feat/s", { "n.txt": "1\n2\n3\n" });
      repo.commitOn(b.path, { "a.txt": "one\n" }, "second");
      repo.commitOn(repo.root, { "m.txt": "master only\n" }, "on master");
      assert.deepEqual(await statsOf(repo.root, repo.head(), "feat/s"), { head: sh(repo.root, "rev-parse", "feat/s"), ahead: 2, added: 3, removed: 2 });
      assert.equal(await statsOf(repo.root, repo.head(), "feat/none"), null);
    } finally {
      repo.done();
    }
  });
});
