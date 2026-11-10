import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { recordGoAhead, typedGoAhead } from "../../pi-config/extensions/worktrees/landing.ts";
import { isVerbResult, MERGE_READ_VERBS, MERGE_VERBS } from "../../shared/project-contract";
import { COMMANDS } from "../../shared/commands-catalog";
import type { Caller } from "../project-services/engine";
import { ingestOnce } from "./ingest";
import { noticeText } from "./notices";
import { merger } from "./routes";
import type { ReviewAnswer } from "./review-step";
import { FINDING_MAX, MAX_FINDINGS, PATH_MAX, REVIEW_TEXT_LIMIT, SUMMARY_MAX } from "./review-verdict";
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
      const deps = { file, seenFile, roots: () => [k.repo.root], served: async () => true, repoOf: async () => null, queue: () => k.q(), refused: (_s: string, t: string) => void refused.push(t) };
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
      assert.match(refused[0]!, /couldn't be queued to land: Nothing to land: everything on this branch is already on master/);
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
    const delivered: ReviewAnswer[] = [];
    const call = merger({
      queues: k.queues,
      served: { isListed: () => true, served: async () => true, bareView: async () => { throw new Error("every root here is served"); } },
      rootOf: async (p) => (p.startsWith(k.repo.scratch) ? k.repo.root : null),
      isThreadChat: (root, sid) => root === k.repo.root && sid === thread,
      reviewerOf: (run) => (run === "mr_0rev" ? reviewer : null),
      deliverReview: (run, v) => (delivered.push(v), run === "mr_0rev"),
    });
    const session = (id: string, root: string | null = k.repo.root): Caller => ({ kind: "session", id, root, own: [] });
    return { k, call, thread, reviewer, session, delivered };
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
    const { k, call, thread, reviewer, session, delivered } = setup();
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
      // The verdict's shape is Sova's check now (the reviewer has no shell): a malformed one is refused, saying what is wrong.
      const bare = await call("merge.review", { project: k.repo.root, run: "mr_0rev", verdict: "notes", text: "Looks a bit off." }, session(reviewer));
      assert.equal(bare.error!.code, "invalid-request");
      assert.match(bare.error!.message, /needs at least one finding/);
      const kind = await call("merge.review", { project: k.repo.root, run: "mr_0rev", verdict: "blocking", text: "Bad.\n- [style] a.ts:3: tabs" }, session(reviewer));
      assert.match(kind.error!.message, /kind must be one of/);
      // The longest review the format allows passes the verb whole (ten findings of the longest text, with long paths).
      const longest = ["S".repeat(SUMMARY_MAX), ...Array.from({ length: MAX_FINDINGS }, (_, i) => `- [missing-test] ${`d${i}/`.padEnd(PATH_MAX - 6, "p")}.ts:9999: ${"t".repeat(FINDING_MAX)}`)].join("\n");
      const big = await call("merge.review", { project: k.repo.root, run: "mr_0rev", verdict: "blocking", text: longest }, session(reviewer));
      assert.equal(big.ok, true, JSON.stringify(big.error));
      assert.equal(delivered.at(-1)!.text, longest);
      assert.equal(delivered.at(-1)!.findings!.length, MAX_FINDINGS);
      assert.match((await call("merge.review", { project: k.repo.root, run: "mr_0rev", verdict: "blocking", text: "x".repeat(REVIEW_TEXT_LIMIT + 1) }, session(reviewer))).error!.message, /at most \d+ characters/);
      // Only merge.review's text is that long: every other verb's stays at 4000.
      assert.match((await call("merge.rule", { entry: id, ruling: "chat-fixes", text: "x".repeat(4001) }, t)).error!.message, /"text" must be at most 4000 characters/);
      // merge.rule is the thread's alone; a ruling on an entry in line is refused for what it is, not for who asks.
      assert.equal((await call("merge.rule", { entry: id, ruling: "needs-user", text: "Which wording?" }, session("someone"))).error!.code, "forbidden");
      assert.equal((await call("merge.rule", { entry: id, ruling: "chat-fixes", text: "d" }, t)).error!.code, "invalid-request");
      assert.equal((await call("merge.rule", { entry: id, ruling: "overrule" }, t)).error!.code, "invalid-request");
      const raised = await call("merge.rule", { entry: id, ruling: "needs-user", text: "Which wording should the button use?", choices: ["Land", "Merge"] }, t);
      assert.equal(raised.ok, true, JSON.stringify(raised.error));
      assert.equal(raised.merge!.entry!.decision?.question, "Which wording should the button use?");
      assert.deepEqual(raised.merge!.entry!.decision?.choices, ["Land", "Merge"]);
      // Raised, the thread can't take it back: only the user's answer moves it on.
      assert.equal((await call("merge.retry", { entry: id }, t)).error!.code, "invalid-request");
      const e = q.entry(id)!;
      assert.equal(e.notes[0]!.text, "changes server code");
      assert.equal(e.picks[0]!.id, "statecharts");
    } finally {
      await k.done();
    }
  });

  test("a chat's script on the operator's route never lands, answers, removes or cancels: only the user's click does, and the merge thread's own verbs still work", async () => {
    const { k, call, thread, session } = setup();
    try {
      const q = await k.q();
      await q.pause("hold");
      const b = k.repo.branch("feat/a", { "b.txt": "b\n" });
      k.repo.branch("feat/b", { "c.txt": "c\n" });
      const script: Caller = { kind: "operator", fromChat: true };
      // Land from a chat's script: refused, nothing queued.
      for (const body of [{ checkout: b.path, chat: "s1" }, { project: k.repo.root, branch: "feat/b" }]) {
        const r = await call("merge.add", body, script);
        assert.equal(r.error?.code, "forbidden", JSON.stringify(r.error));
        assert.match(r.error!.message, /never act as the user/);
      }
      assert.equal(q.entries().length, 0, "nothing was queued");
      // The same Land from the user's page: queued (the refusal is the caller's, not the body's).
      const added = await call("merge.add", { checkout: b.path, chat: "s1" }, op);
      assert.equal(added.ok, true, JSON.stringify(added.error));
      const id = added.merge!.entry!.id;
      // Every other act from a chat's script is refused too, and changes nothing.
      for (const [verb, body] of [
        ["merge.cancel", { entry: id }],
        ["merge.answer", { entry: id, answer: "accept" }],
        ["merge.answer", { entry: id, answer: "land-anyway" }],
        ["merge.retry", { entry: id }],
        ["merge.resume", { project: k.repo.root }],
        ["merge.pause", { project: k.repo.root }],
        ["merge.fresh", { project: k.repo.root }],
        ["merge.clear", { project: k.repo.root }],
        ["merge.reply", { project: k.repo.root, ask: "ak_x", text: "yes" }],
        ["merge.respond", { project: k.repo.root, request: "rq_0123456789ab", answer: "fixed", text: "x" }],
        ["merge.answer", { entry: id, answer: "try-again" }],
        ["merge.answer", { entry: id, answer: "land" }],
        ["merge.note", { entry: id, note: "x" }],
        ["merge.resolve", { entry: id }],
        ["merge.hold", { project: k.repo.root, action: "set" }],
      ] as const) {
        const r = await call(verb, body, script);
        assert.equal(r.error?.code, "forbidden", `${verb}: ${JSON.stringify(r.error)}`);
      }
      assert.equal(q.entry(id)!.notes.length, 0);
      assert.equal(q.entries().some((e) => e.id === id), true, "still queued: no cancel went through");
      // It still reads.
      assert.equal((await call("merge.status", { project: k.repo.root }, script)).ok, true);
      // The merge thread's own verbs, through its own tool, still work.
      assert.equal((await call("merge.note", { entry: id, note: "changes server code" }, session(thread))).ok, true);
      // A card's command (its view's code or its button's) is never the user's act either, reads aside.
      const card: Caller = { kind: "operator", fromCard: true };
      for (const [verb, body] of [
        ["merge.add", { project: k.repo.root, branch: "feat/b" }],
        ["merge.cancel", { entry: id }],
        ["merge.answer", { entry: id, answer: "accept" }],
        ["merge.retry", { entry: id }],
        ["merge.resume", { project: k.repo.root }],
        ["merge.try", { project: k.repo.root, branch: "feat/b" }],
      ] as const) {
        const r = await call(verb, body, card);
        assert.equal(r.error?.code, "forbidden", `card ${verb}: ${JSON.stringify(r.error)}`);
        assert.match(r.error!.message, /a card's commands never act as the user/);
      }
      assert.equal(q.entries().length, 1, "the card queued nothing and removed nothing");
      assert.equal((await call("merge.status", { project: k.repo.root }, card)).ok, true, "a card still reads");
      // The user's Remove from Queue, from their page, still works.
      const removed = await call("merge.cancel", { entry: id }, op);
      assert.equal(removed.ok, true, JSON.stringify(removed.error));
    } finally {
      await k.done();
    }
  });

  test("the user's route acts only for their own page: a request that isn't the page (a chat's shell that left its key out, any script) is refused every act, still reads", async () => {
    const { k, call } = setup();
    try {
      const q = await k.q();
      await q.pause("hold");
      const b = k.repo.branch("feat/a", { "b.txt": "b\n" });
      // What the route makes of a token in a header with no chat key: the operator, but not the page.
      const script: Caller = { kind: "operator", notPage: true };
      const land = await call("merge.add", { checkout: b.path, chat: "s1" }, script);
      assert.equal(land.error?.code, "forbidden", JSON.stringify(land.error));
      assert.match(land.error!.message, /only the user's own click in Sova's page/);
      assert.equal(q.entries().length, 0, "nothing was queued");
      // The same Land from the page: queued (the refusal is the caller's, not the body's).
      const added = await call("merge.add", { checkout: b.path, chat: "s1" }, op);
      assert.equal(added.ok, true, JSON.stringify(added.error));
      const id = added.merge!.entry!.id;
      for (const [verb, body] of [
        ["merge.cancel", { entry: id }],
        ["merge.answer", { entry: id, answer: "accept" }],
        ["merge.retry", { entry: id }],
        ["merge.resume", { project: k.repo.root }],
        ["merge.pause", { project: k.repo.root }],
        ["merge.reply", { project: k.repo.root, ask: "ak_x", text: "yes" }],
        ["merge.setup", { project: k.repo.root, command: "true", dryRun: true }],
      ] as const) {
        const r = await call(verb, body, script);
        assert.equal(r.error?.code, "forbidden", `${verb}: ${JSON.stringify(r.error)}`);
      }
      assert.equal(q.entries().some((e) => e.id === id), true, "still queued: no cancel went through");
      assert.equal((await call("merge.status", { project: k.repo.root }, script)).ok, true, "it still reads");
      assert.equal((await call("merge.cancel", { entry: id }, op)).ok, true, "the page removes it");
    } finally {
      await k.done();
    }
  });

  test("merge.hold is the merge thread's (and the operator's): no other chat holds the queue, and the thread still never pauses it", async () => {
    const { k, call, thread, reviewer, session } = setup();
    try {
      const q = await k.q();
      const t = session(thread);
      const set = await call("merge.hold", { action: "set" }, t);
      assert.equal(set.ok, true, set.error?.message);
      assert.equal(set.changed, true);
      assert.ok(set.merge!.hold && Date.parse(set.merge!.hold.until) > Date.now());
      assert.ok(q.holdNow());
      assert.equal((await call("merge.pause", { why: "restart" }, t)).error!.code, "forbidden", "merge.pause stays the user's");
      assert.equal(q.isPaused(), false);
      for (const who of [session("someone"), session(reviewer), { kind: "project-overseer", root: k.repo.root } as unknown as Caller]) {
        const r = await call("merge.hold", { project: k.repo.root, action: "clear" }, who);
        assert.equal(r.error?.code, "forbidden", JSON.stringify(who));
      }
      assert.ok(q.holdNow(), "still held");
      assert.equal((await call("merge.hold", { action: "later" }, t)).error!.code, "invalid-request");
      assert.equal((await call("merge.hold", {}, t)).error!.code, "invalid-request");
      const clear = await call("merge.hold", { action: "clear" }, t);
      assert.equal(clear.ok, true);
      assert.equal(clear.merge!.hold, null);
      assert.equal((await call("merge.hold", { project: k.repo.root, action: "set" }, op)).ok, true, "the operator may too");
    } finally {
      await k.done();
    }
  });

  test("merge.restart, merge.test and merge.names are the merge thread's (and the user's page's): never another chat, a reviewer or a chat's script on the operator route; merge.live is a read", async () => {
    const { k, call, thread, reviewer, session } = setup();
    try {
      await k.q();
      const fromChat = { kind: "operator", fromChat: true } as unknown as Caller;
      for (const verb of ["merge.restart", "merge.test", "merge.names"]) {
        for (const who of [session("someone"), session(reviewer), { kind: "project-overseer", root: k.repo.root } as unknown as Caller, fromChat]) {
          const r = await call(verb, { project: k.repo.root, entry: "mq_x", action: "show" }, who);
          assert.equal(r.error?.code, "forbidden", `${verb} by ${JSON.stringify(who)}`);
        }
        const t = await call(verb, { project: k.repo.root, entry: "mq_x", action: "show" }, session(thread));
        assert.notEqual(t.error?.code, "forbidden", `${verb} is the thread's: ${t.error?.message}`);
      }
      // No restart deps wired here: the thread is told so, and nothing restarts.
      assert.equal((await call("merge.restart", { project: k.repo.root }, session(thread))).error?.code, "unsupported");
      assert.equal((await call("merge.live", { project: k.repo.root }, session("someone"))).error?.code, "unsupported", "a read anyone on the project may make (unwired here)");
    } finally {
      await k.done();
    }
  });

  test("merge.status {entry} answers that entry's rows only", async () => {
    const { k, call } = setup();
    try {
      const q = await k.q();
      await q.pause("hold");
      const a = await call("merge.add", { checkout: k.repo.branch("feat/a", { "a.txt": "a\n" }).path }, op);
      await call("merge.add", { checkout: k.repo.branch("feat/b", { "b.txt": "b\n" }).path }, op);
      const all = (await call("merge.status", { project: k.repo.root }, op)).merge!.view!;
      const one = (await call("merge.status", { project: k.repo.root, entry: a.merge!.entry!.id }, op)).merge!.view!;
      const ids = (v: typeof all) => [...v.checking, ...v.waiting, ...v.needsYou, ...v.needsFix].map((e) => e.id);
      assert.equal(ids(all).length, 2);
      assert.deepEqual(ids(one), [a.merge!.entry!.id]);
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
      assert.equal(c!.effect, (MERGE_READ_VERBS as readonly string[]).includes(v) ? "looks" : "changes");
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
    // Under a standing Land (al_3) no text that reaches the chat asks for another Land; only one with none does.
    const askAgain = /land it|Land This Commit Again|land its newest commit|Land comes back|Land again|Land on feat\/a again/i;
    const standing = { ...base, approval: { ...base.approval, standing: true as const } };
    for (const sentBackFor of ["drafts", "checks", "conflict"] as const) {
      const r = sentBackFor === "conflict" ? { ...run, verdict: "conflict" as const } : run;
      const st = noticeText("needs-fix", { ...standing, state: "with-chat", reason: "x", sentBackFor }, { run: r });
      assert.doesNotMatch(st, askAgain, `${sentBackFor}: ${st}`);
      assert.match(st, /the user's Land stands/i);
      const old = noticeText("needs-fix", { ...base, state: "needs-fix", reason: "x", sentBackFor }, { run: r });
      assert.match(old, /needs the user's Land again/, "no standing Land (a release's hand-back): the user lands it again");
      assert.doesNotMatch(old, /Land This Commit Again|land it again|type "land it"/);
    }
    const d = noticeText("decision", { ...base, state: "needs-user", decision: { id: "dc_1", kind: "needs-you", question: "Which wording?", choices: [], raisedBy: "chat", actions: [], at: "t" } });
    assert.match(d, /waits for the user's decision: Which wording\?/);
  });
});

void writeFileSync;

describe("the worktree row's numbers", () => {
  test("commits ahead and lines +/− of the branch's side, against the target's head, and when the branch last changed", async () => {
    const { statsOf } = await import("./wire");
    const repo = makeRepo({ prefix: "mq-stats-" });
    try {
      const b = repo.branch("feat/s", { "n.txt": "1\n2\n3\n" });
      repo.commitOn(b.path, { "a.txt": "one\n" }, "second");
      repo.commitOn(repo.root, { "m.txt": "master only\n" }, "on master");
      // The date is the head's committer date (the Ready rows' own), not the author date.
      sh(b.path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--amend", "--no-edit", "--date=2020-01-02T03:04:05Z");
      assert.deepEqual(await statsOf(repo.root, repo.head(), "feat/s"), { head: sh(repo.root, "rev-parse", "feat/s"), ahead: 2, added: 3, removed: 2, headAt: sh(repo.root, "log", "-1", "--format=%cI", "feat/s") });
      assert.notEqual(sh(repo.root, "log", "-1", "--format=%cI", "feat/s").slice(0, 4), "2020", "the committer date, not the author's");
      assert.equal(await statsOf(repo.root, repo.head(), "feat/none"), null);
    } finally {
      repo.done();
    }
  });
});
