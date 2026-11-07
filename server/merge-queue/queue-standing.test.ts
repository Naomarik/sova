// The standing approval (al_3): after the user's one Land, the branch's chat answers the queue's requests (Fixed,
// Needs you, Can't) and a fix the merge thread checked goes back in line by itself — drafts-only fixes included —
// with no second Land. Real git underneath (queue-kit.ts); the run is a stand-in whose verdict each test scripts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { MERGE_REQUEST_ID_RE } from "../../shared/topic-message";
import type { MergeEntry } from "../../shared/merge-queue";
import type { ThreadEvent } from "./contract";
import type { Caller } from "../project-services/engine";
import { merger } from "./routes";
import { makeKit, sh, until, untilAborted } from "./testing/queue-kit";

const landed = async (k: ReturnType<typeof makeKit>, id: string) => until(async () => (await k.entry(id)).state === "landed", `${id} landed`);
const withChat = async (k: ReturnType<typeof makeKit>, id: string) => until(async () => ((await k.entry(id)).state === "with-chat" ? k.entry(id) : null), `${id} back with its chat`);
const lastRequest = (e: MergeEntry) => e.requests![e.requests!.length - 1]!;

/** A kit whose merge thread answers only the events `up` lets through (none: it isn't running), with drafts and a docs
 *  check the test moves by hand. */
function standingKit(o: { thread?: (ev: ThreadEvent) => boolean } = {}) {
  const d = { hash: "h1", check: { problems: [] as string[] } as { problems: string[] } | "pending", adds: 0 };
  const events: ThreadEvent[] = [];
  const thread = { up: (_ev: ThreadEvent) => false };
  if (o.thread) thread.up = o.thread;
  const k = makeKit({
    deps: {
      draftsHash: () => ({ hash: d.hash, names: ["x"] }),
      draftsFingerprint: () => d.hash,
      docsCheck: () => d.check,
      thread: (ev) => (events.push(ev), thread.up(ev)),
    },
  });
  return { k, d, events, thread };
}

describe("one Land covers the checked fixes", () => {
  test("drafts-only fix: sent back for its drafts, the drafts edited with no commit, answered Fixed, checked by the thread: back in line at the same commit with its drafts re-pinned, and it lands with no second Land", async () => {
    const { k, d, events, thread } = standingKit({ thread: (ev) => ev.kind === "fix" });
    try {
      let runs = 0;
      k.run.set(() => (++runs === 1 ? { verdict: "failed", blame: "branch", cause: "drafts", why: "its spec drafts don't fit: a promise has no verification note" } : {}));
      const q = await k.q();
      const b = k.repo.branch("feat/docs-only", { "b.txt": "b\n" });
      const { entry } = await q.add({ branch: "feat/docs-only", by: "land-button", session: "s1" });
      assert.equal(entry.approval.standing, true, "the user's Land stands");
      assert.equal(entry.approval.drafts?.hash, "h1");
      const back = await withChat(k, entry.id);
      const rq = lastRequest(back);
      assert.match(rq.id, MERGE_REQUEST_ID_RE, "the chat queue's own id form");
      assert.equal(rq.kind, "fix");
      assert.equal(rq.session, "s1");
      assert.equal(back.standing?.phase, "with-chat");
      assert.ok(k.notices.some((n) => n.kind === "needs-fix" && n.branch === "feat/docs-only"), "the request went to the chat");

      // The chat edits only .sova/spec/drafts/<name>: no commit (drafts are gitignored), the drafts' hash moves.
      d.hash = "h2";
      await assert.rejects(q.respond(rq.id, "s2", { answer: "fixed", drafts: true }), /only the chat the request was sent to/);
      await assert.rejects(q.respond(rq.id, null, { answer: "fixed", drafts: true }), /only the chat the request was sent to/);
      const r = await q.respond(rq.id, "s1", { answer: "fixed", drafts: true, text: "recorded the verification note" });
      assert.deepEqual(r.request.answer && { kind: r.request.answer.kind, changed: r.request.answer.kind === "fixed" ? r.request.answer.changed : null }, { kind: "fixed", changed: "drafts" });
      await assert.rejects(q.respond(rq.id, "s1", { answer: "fixed", drafts: true }), /answered already/, "once only");
      let e = await k.entry(entry.id);
      assert.equal(e.state, "with-chat", "nothing moves until the thread checked it");
      assert.equal(e.standing?.phase, "waiting-thread");
      const fix = events.find((ev) => ev.kind === "fix");
      assert.equal(fix?.request, rq.id);
      assert.equal(fix?.drafts, true);
      assert.equal(fix?.fixCommit, undefined, "a drafts-only fix makes no commit");

      thread.up = () => true;
      await q.fixRuling(entry.id, rq.id, true, "");
      e = await k.entry(entry.id);
      assert.notEqual(e.state, "drafts-changed", "re-pinned: the drafts gate doesn't park it");
      assert.equal(e.commit, b.head, "the same commit");
      assert.equal(e.approval.drafts?.hash, "h2", "the approval's drafts re-pinned to the drafts as they are now");
      assert.deepEqual(e.approval.fixes?.map((f) => ({ request: f.request, commit: f.commit ?? null, drafts: f.drafts })), [{ request: rq.id, commit: null, drafts: "h2" }]);
      await landed(k, entry.id);
      assert.equal(runs, 2, "every check ran again");
      assert.equal(k.repo.head(), (await k.entry(entry.id)).landed?.sha);
      assert.ok(!k.notices.some((n) => n.kind === "drafts-changed"), "never drafts-changed");
      assert.equal(q.entries().filter((x) => x.branch === "feat/docs-only").length, 1, "one entry: no second Land");
    } finally {
      await k.done();
    }
  });

  test("a fix commit while the merge thread is down waits for it ('Waiting for the merge thread'); once it acts, it is handed the fix; checked, it lands at the fix's commit", async () => {
    const { k, events, thread } = standingKit();
    try {
      let runs = 0;
      k.run.set(() => (++runs === 1 ? { verdict: "failed", blame: "branch", why: "Unit tests failed" } : {}));
      const q = await k.q();
      const b = k.repo.branch("feat/fix-commit", { "c.txt": "c\n" });
      const { entry } = await q.add({ branch: "feat/fix-commit", by: "land-button", session: "s1" });
      const rq = lastRequest(await withChat(k, entry.id));
      assert.equal((await k.entry(entry.id)).standing?.phase === "with-chat" && (await k.entry(entry.id)).tries?.used, 1, "try 1 of 3");
      const fixSha = k.repo.commitOn(b.path, { "c.txt": "c fixed\n" }, "fix the unit test");
      await q.respond(rq.id, "s1", { answer: "fixed", commit: fixSha, text: "fixed the assertion" });
      let e = await k.entry(entry.id);
      assert.equal(e.standing?.phase, "waiting-thread");
      assert.equal(e.fix?.told, false, "the thread isn't running: not told yet");
      assert.equal(e.state, "with-chat", "never lands unchecked");

      thread.up = (ev) => ev.kind === "fix";
      q.threadActed();
      await until(() => events.some((ev) => ev.kind === "fix" && ev.request === rq.id && ev.fixCommit === fixSha), "the fix handed to the thread once it runs");
      e = await k.entry(entry.id);
      await until(async () => (await k.entry(entry.id)).fix?.told === true, "told");
      await q.fixRuling(entry.id, rq.id, true, "");
      e = await k.entry(entry.id);
      assert.equal(e.commit, fixSha, "the approval moved to the fix's commit");
      assert.equal(e.approval.userCommit, b.head, "the user's own Land's commit is kept");
      await landed(k, entry.id);
      assert.equal(sh(k.repo.root, "merge-base", "--is-ancestor", fixSha, "master"), "", "the fix landed");
    } finally {
      await k.done();
    }
  });

  test("three tries, then the user; the same failure twice stops early", async () => {
    const { k } = standingKit({ thread: (ev) => ev.kind === "fix" });
    try {
      const whys = ["unit tests failed in alpha", "unit tests failed in beta", "unit tests failed in gamma"];
      let runs = 0;
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: whys[runs++] ?? "again" }));
      const q = await k.q();
      const b = k.repo.branch("feat/tries", { "t.txt": "t\n" });
      const { entry } = await q.add({ branch: "feat/tries", by: "land-button", session: "s1" });
      for (let i = 1; i <= 2; i++) {
        const e = await until(async () => {
          const x = await k.entry(entry.id);
          return x.state === "with-chat" && x.tries?.used === i ? x : null;
        }, `try ${i}`);
        assert.deepEqual(e.standing?.phase === "with-chat" ? { try: e.standing.try, of: e.standing.of } : null, { try: i, of: 3 });
        const sha = k.repo.commitOn(b.path, { "t.txt": `t${i}\n` }, `fix ${i}`);
        await q.respond(lastRequest(e).id, "s1", { answer: "fixed", commit: sha });
        await q.fixRuling(entry.id, lastRequest(e).id, true, "");
      }
      const out = await until(async () => ((await k.entry(entry.id)).decision?.kind === "out-of-tries" ? k.entry(entry.id) : null), "out of tries");
      assert.match(out.decision!.question, /Tried 3 times/);
      assert.deepEqual(out.decision!.actions, ["land", "remove"]);
      assert.equal(runs, 3);
      // Land on it: a new standing approval at the branch's newest commit, with 3 new tries.
      const again = await q.answer(entry.id, "land");
      assert.notEqual(again.id, entry.id);
      assert.equal(again.commit, k.repo.head("feat/tries"));
      assert.equal(again.tries, undefined, "new tries");
      assert.equal((await k.entry(entry.id)).state, "cancelled");
    } finally {
      await k.done();
    }
  });

  test("the same failure twice: out at the second run, whatever tries are left", async () => {
    const { k } = standingKit({ thread: (ev) => ev.kind === "fix" });
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit tests failed in alpha" }));
      const q = await k.q();
      const b = k.repo.branch("feat/same", { "s.txt": "s\n" });
      const { entry } = await q.add({ branch: "feat/same", by: "land-button", session: "s1" });
      const e = await withChat(k, entry.id);
      const sha = k.repo.commitOn(b.path, { "s.txt": "s1\n" }, "try");
      await q.respond(lastRequest(e).id, "s1", { answer: "fixed", commit: sha });
      await q.fixRuling(entry.id, lastRequest(e).id, true, "");
      const out = await until(async () => ((await k.entry(entry.id)).decision?.kind === "out-of-tries" ? k.entry(entry.id) : null), "stopped early");
      assert.match(out.decision!.question, /Failed the same way twice/);
      assert.equal(out.tries?.used, 2);
    } finally {
      await k.done();
    }
  });
});

describe("the chat's answers", () => {
  test("Can't goes to the merge thread first; Needs you becomes the user's decision; a removed entry takes no answer", async () => {
    const { k, events } = standingKit({ thread: (ev) => ev.kind === "chat-answer" });
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit tests failed" }));
      const q = await k.q();
      k.repo.branch("feat/answers", { "a2.txt": "a\n" });
      const { entry } = await q.add({ branch: "feat/answers", by: "land-button", session: "s1" });
      const rq = lastRequest(await withChat(k, entry.id));
      await assert.rejects(q.respond(rq.id, "s1", { answer: "cant" }), /say why/);
      await assert.rejects(q.respond(rq.id, "s1", { answer: "maybe", text: "x" }), /answer is/);
      await q.respond(rq.id, "s1", { answer: "cant", text: "the fixture is generated upstream" });
      const ev = events.find((x) => x.kind === "chat-answer");
      assert.equal(ev?.answer, "cant");
      assert.equal(ev?.request, rq.id);
      assert.notEqual((await k.entry(entry.id)).state, "needs-user", "the thread rules first");

      // The thread's other approach is a new request; the chat raises Needs you on it.
      const other = await q.rule(entry.id, { ruling: "try-again", text: "regenerate the fixture locally" });
      const rq2 = lastRequest(other);
      assert.equal(rq2.kind, "other-approach");
      await q.respond(rq2.id, "s1", { answer: "needs-you", text: "Keep the old fixture or take upstream's?", options: ["Keep the old one", "Take upstream's"] });
      const e = await k.entry(entry.id);
      assert.equal(e.state, "needs-user");
      assert.equal(e.decision?.raisedBy, "chat");
      assert.deepEqual(e.decision?.choices, ["Keep the old one", "Take upstream's"]);

      // Remove from Queue ends the standing approval: no answer revives it.
      await q.cancel(entry.id);
      assert.equal((await k.entry(entry.id)).reason, "removed by you");
      const req3 = q.addRequest(q.entry(entry.id) as Parameters<typeof q.addRequest>[0], { kind: "fix", text: "late" });
      await assert.rejects(q.respond(req3.id, "s1", { answer: "fixed", text: "x" }), /removed from the queue/);
    } finally {
      await k.done();
    }
  });

  test("a merge thread question is the user's: the chat can't answer it itself", async () => {
    const { k } = standingKit();
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit tests failed" }));
      const q = await k.q();
      k.repo.branch("feat/ask", { "q.txt": "q\n" });
      const { entry } = await q.add({ branch: "feat/ask", by: "land-button", session: "s1" });
      const e = await withChat(k, entry.id);
      const ask = q.addRequest(q.entry(e.id) as Parameters<typeof q.addRequest>[0], { kind: "thread-ask", text: "Which names are private?" });
      await assert.rejects(q.respond(ask.id, "s1", { answer: "fixed", text: "x" }), /they answer it with their own next message/);
    } finally {
      await k.done();
    }
  });

  test("a fix that arrives while its run is checking waits: the run is never voided, and once it lands the fix is later work", async () => {
    const { k } = standingKit({ thread: () => true });
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      k.run.set(async () => (await gate, {}));
      const q = await k.q();
      const b = k.repo.branch("feat/mid-run", { "m.txt": "m\n" });
      const { entry } = await q.add({ branch: "feat/mid-run", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "checking", "checking");
      const e = q.entry(entry.id) as Parameters<typeof q.addRequest>[0];
      const rq = q.addRequest(e, { kind: "blocked", text: "an older request" });
      const sha = k.repo.commitOn(b.path, { "m.txt": "m2\n" }, "later work");
      await q.respond(rq.id, "s1", { answer: "fixed", commit: sha });
      assert.equal((await k.entry(entry.id)).state, "checking", "not voided");
      release();
      await landed(k, entry.id);
      const done = await k.entry(entry.id);
      assert.equal(done.commit, b.head, "landed the commit the run checked");
      assert.equal(done.approval.fixes, undefined, "the fix is later work: Land Again");
    } finally {
      await k.done();
    }
  });

  test("Stop in the chat pauses the branch until the user's next message", async () => {
    const { k } = standingKit();
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit tests failed" }));
      const q = await k.q();
      k.repo.branch("feat/stop", { "p.txt": "p\n" });
      const { entry } = await q.add({ branch: "feat/stop", by: "land-button", session: "s1" });
      const was = (await withChat(k, entry.id)).standing;
      await q.chatPaused("s1", true);
      assert.deepEqual((await k.entry(entry.id)).standing, { phase: "paused" });
      await q.chatPaused("s1", false);
      assert.deepEqual((await k.entry(entry.id)).standing, was, "the phase it had comes back");
      // A worker's branch: its requests reach the chat running the worker, where Stop is pressed.
      const rq = lastRequest(await k.entry(entry.id));
      q.requestDelivered(rq.id, "delivered", "parent-1");
      await q.chatPaused("other-chat", true);
      assert.deepEqual((await k.entry(entry.id)).standing, was, "another chat's Stop pauses nothing here");
      await q.chatPaused("parent-1", true);
      assert.deepEqual((await k.entry(entry.id)).standing, { phase: "paused" }, "Stop in the chat its requests reached");
      await q.chatPaused("parent-1", false);
      assert.deepEqual((await k.entry(entry.id)).standing, was);
    } finally {
      await k.done();
    }
  });
});

describe("Approved · waiting for a fix", () => {
  test("Land on a branch that conflicts: it joins the line and its conflict goes to the merge thread's judgement, never straight to the chat; chat-fixes sends the request with the thread's diagnosis. Drafts that don't fit wait with the chat and join the line by themselves once they fit", async () => {
    const { k, d, events } = standingKit({ thread: (ev) => ev.kind === "conflict" });
    try {
      const q = await k.q();
      // A conflict: master and the branch change the same line (a UX word, say).
      const b = k.repo.branch("feat/blocked", { "a.txt": "ONE\ntwo\nthree\n" });
      k.repo.commitOn(k.repo.root, { "a.txt": "uno\ntwo\nthree\n" }, "master moves");
      const { entry } = await q.add({ branch: "feat/blocked", by: "land-button", session: "s1" });
      assert.notEqual(entry.state, "with-chat", "a conflict doesn't block at Land");
      assert.equal(entry.requests, undefined, "nothing goes to the chat unjudged");
      await until(async () => (await k.entry(entry.id)).state === "conflict", "the run finds the conflict");
      const ev = await until(() => events.find((x) => x.kind === "conflict" && x.entry.id === entry.id), "the thread is told");
      assert.deepEqual(ev.files, ["a.txt"]);
      assert.equal((await k.entry(entry.id)).requests, undefined, "still nothing to the chat while the thread judges");
      // The thread rules it the chat's to fix (no decision of the user's): the request carries its diagnosis.
      await q.resolve(entry.id, { verdict: "chat-fixes", ours: "master says uno", theirs: "the branch says ONE", proposal: "keep master's word and the branch's casing" });
      const back = await withChat(k, entry.id);
      assert.equal(lastRequest(back).kind, "fix");
      assert.match(lastRequest(back).text, /keep master's word/);
      assert.equal(back.tries?.used, 0, "the conflict already there at the Land counts no try");
      assert.equal(back.standing?.phase === "with-chat" && back.standing.try, 0, "and shows none");
      assert.doesNotMatch(lastRequest(back).text, /\(try \d/, "the request names no try");
      assert.ok(b.head);

      // Drafts that don't fit at the same commit, on another branch: blocked; fixed in place with no commit: in line by itself.
      const c = k.repo.branch("feat/blocked-drafts", { "z.txt": "z\n" });
      d.check = { problems: ["§z/x: no verification note"] };
      const second = await q.add({ branch: "feat/blocked-drafts", by: "land-button", session: "s2" });
      assert.equal(second.entry.state, "with-chat");
      assert.match(second.entry.reason ?? "", /spec drafts don't fit/);
      d.check = { problems: [] };
      await q.recheckNow();
      await landed(k, second.entry.id);
      assert.equal((await k.entry(second.entry.id)).commit, c.head);
    } finally {
      await k.done();
    }
  });
});

describe("merge.respond: who may answer", () => {
  test("only the branch's chat the request went to (or the chat it reached), with its own tool; never the user's page, a chat's script, a card, the merge thread or a reviewer", async () => {
    const { k } = standingKit();
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit tests failed" }));
      const call = merger({
        queues: k.queues,
        served: { isListed: () => true, served: async () => true, bareView: async () => { throw new Error("every root here is served"); } },
        rootOf: async (p) => (p.startsWith(k.repo.scratch) ? k.repo.root : null),
        isThreadChat: (root, sid) => root === k.repo.root && sid === "thread-1",
        isReviewerChat: (sid) => sid === "reviewer-1",
      });
      const session = (id: string): Caller => ({ kind: "session", id, root: k.repo.root, own: [] });
      const q = await k.q();
      const b = k.repo.branch("feat/verb", { "v.txt": "v\n" });
      const { entry } = await q.add({ branch: "feat/verb", by: "land-button", session: "s1" });
      const rq = lastRequest(await withChat(k, entry.id));
      const fix = k.repo.commitOn(b.path, { "v.txt": "v2\n" }, "fix");
      const body = { request: rq.id, answer: "fixed", commit: fix, text: "fixed it" };
      for (const caller of [{ kind: "operator" } as Caller, { kind: "operator", fromChat: true } as Caller, { kind: "operator", fromCard: true } as Caller, session("thread-1"), session("reviewer-1"), session("s2")]) {
        const r = await call("merge.respond", body, caller);
        assert.equal(r.error?.code, "forbidden", `${JSON.stringify(caller)}: ${JSON.stringify(r.error)}`);
      }
      assert.equal(lastRequest(await k.entry(entry.id)).answer, undefined, "nothing was answered");
      // The chat a worker's request reached (its parent) may answer, as the worker's own chat may.
      q.requestDelivered(rq.id, "delivered", "parent-1");
      const ok = await call("merge.respond", body, session("parent-1"));
      assert.equal(ok.ok, true, JSON.stringify(ok.error));
      assert.equal(ok.merge?.request?.answer?.kind, "fixed");
      const again = await call("merge.respond", body, session("s1"));
      assert.equal(again.error?.code, "invalid-request");
      const missing = await call("merge.respond", { ...body, request: "rq_ffffffffffff" }, session("s1"));
      assert.equal(missing.error?.code, "not-found");
    } finally {
      await k.done();
    }
  });
});

describe("what a fix may carry", () => {
  test("a conflict fixed by merging the target in: the target's own commits are nobody's unasked work, so the checked fix goes straight back in line and lands", async () => {
    const { k } = standingKit({ thread: (ev) => ev.kind === "fix" || ev.kind === "conflict" });
    try {
      const q = await k.q();
      const b = k.repo.branch("feat/merge-in", { "a.txt": "ONE\ntwo\nthree\n" });
      // Master moves twice before the Land: both its commits are older than the request.
      k.repo.commitOn(k.repo.root, { "a.txt": "uno\ntwo\nthree\n" }, "master side");
      k.repo.commitOn(k.repo.root, { "list.txt": "alpha\nbeta\ngamma\n" }, "master again");
      const { entry } = await q.add({ branch: "feat/merge-in", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "conflict", "conflict");
      await q.resolve(entry.id, { verdict: "chat-fixes", ours: "uno", theirs: "ONE", proposal: "merge master in, keep uno" });
      const rq = lastRequest(await withChat(k, entry.id));
      // The chat merges master in and resolves it.
      tryMerge(b.path, "master");
      const fix = k.repo.commitOn(b.path, { "a.txt": "UNO\ntwo\nthree\n" }, "merge master in");
      await q.respond(rq.id, "s1", { answer: "fixed", commit: fix, text: "merged master in" });
      const e = await q.fixRuling(entry.id, rq.id, true, "");
      assert.equal(e.decision, undefined, "no 'on top of work the queue didn't ask for'");
      assert.equal(e.state, "queued");
      await landed(k, entry.id);
    } finally {
      await k.done();
    }
  });

  test("work the user asked for before the request, under the fix: the card asks the user once; Land takes it at the fix's commit, that work included", async () => {
    const { k } = standingKit({ thread: (ev) => ev.kind === "fix" });
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit tests failed" }));
      const q = await k.q();
      const b = k.repo.branch("feat/user-work", { "u.txt": "u\n" });
      // The request is made after the user's own commit: hold the line, commit, then let the run fail.
      await q.pause("hold");
      const { entry } = await q.add({ branch: "feat/user-work", by: "land-button", session: "s1" });
      // Made before the request (commit times are whole seconds: dated well before it).
      writeFileSync(join(b.path, "w.txt"), "the user's\n");
      sh(b.path, "add", "w.txt");
      execFileSync("git", ["commit", "-q", "-m", "work the user asked for"], { cwd: b.path, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } });
      const userWork = sh(b.path, "rev-parse", "HEAD");
      await q.resume();
      const rq = lastRequest(await withChat(k, entry.id));
      const fix = k.repo.commitOn(b.path, { "u.txt": "u2\n" }, "the fix");
      await q.respond(rq.id, "s1", { answer: "fixed", commit: fix });
      const e = await q.fixRuling(entry.id, rq.id, true, "");
      assert.equal(e.decision?.kind, "fix-ok");
      assert.match(e.decision?.question ?? "", /1 commit the merge queue didn't ask for/);
      assert.deepEqual(e.decision?.actions, ["land", "remove"]);
      k.run.set(null);
      const after = await q.answer(entry.id, "land");
      assert.equal(after.commit, fix, "Land takes it at the fix's commit");
      await landed(k, entry.id);
      assert.equal(sh(k.repo.root, "merge-base", "--is-ancestor", userWork, "master"), "", "that work included");
    } finally {
      await k.done();
    }
  });

  test("a drafts fix the merge thread finds changes a promise's meaning never goes back in line: it waits for the user", async () => {
    const { k, d } = standingKit({ thread: (ev) => ev.kind === "fix" });
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", cause: "drafts", why: "its spec drafts don't fit" }));
      const q = await k.q();
      k.repo.branch("feat/meaning", { "n.txt": "n\n" });
      const { entry } = await q.add({ branch: "feat/meaning", by: "land-button", session: "s1" });
      const rq = lastRequest(await withChat(k, entry.id));
      d.hash = "h-meaning";
      await q.respond(rq.id, "s1", { answer: "fixed", drafts: true });
      const e = await q.fixRuling(entry.id, rq.id, false, "§b/x now promises a different default");
      assert.equal(e.state, "needs-user");
      assert.equal(e.decision?.kind, "fix-ok");
      assert.match(e.decision?.question ?? "", /different default/);
      assert.equal(e.approval.drafts?.hash, "h1", "the approval's drafts aren't re-pinned");
      assert.equal(k.run.inputs.length, 1, "not run again");
    } finally {
      await k.done();
    }
  });

  test("Remove from Queue is one act at every stage: in line and while checking it ends 'removed by you' too, the run voided", async () => {
    const { k } = standingKit();
    try {
      k.run.set(untilAborted);
      const q = await k.q();
      k.repo.branch("feat/rm-a", { "ra.txt": "a\n" });
      k.repo.branch("feat/rm-b", { "rb.txt": "b\n" });
      const a = await q.add({ branch: "feat/rm-a", by: "land-button", session: "s1" });
      const b = await q.add({ branch: "feat/rm-b", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(a.entry.id)).state === "checking", "a checking");
      const rb = await q.cancel(b.entry.id);
      assert.deepEqual([rb.state, rb.reason], ["cancelled", "removed by you"]);
      const ra = await q.cancel(a.entry.id);
      assert.deepEqual([ra.state, ra.reason], ["cancelled", "removed by you"]);
      await until(() => q.currentRun() === null, "the run voided");
      assert.equal(k.repo.head(), sh(k.repo.root, "rev-parse", "HEAD"), "master unmoved");
      assert.ok(k.notices.filter((n) => n.kind === "removed").length >= 2, "each chat card gets its Removed revision");
    } finally {
      await k.done();
    }
  });
});

function tryMerge(cwd: string, ref: string): void {
  try {
    sh(cwd, "merge", "-q", "--no-edit", ref);
  } catch {
    /* a conflict: the test resolves it and commits */
  }
}

describe("drafts changed after the Land with no request (q8)", () => {
  test("they wait for the user: one Drafts changed decision, nothing run, the thread not asked to re-pin them; Land takes them as they are now and it lands", async () => {
    const { k, d, events } = standingKit({ thread: () => true });
    try {
      const q = await k.q();
      k.repo.branch("feat/edited", { "e.txt": "e\n" });
      await q.pause("hold");
      const { entry } = await q.add({ branch: "feat/edited", by: "land-button", session: "s1" });
      d.hash = "h-edited"; // the user's own edit, or the chat's unasked one: no request was answered
      await q.resume();
      const e = await until(async () => ((await k.entry(entry.id)).decision ? k.entry(entry.id) : null), "a decision");
      assert.equal(e.state, "needs-user");
      assert.equal(e.decision?.kind, "drafts-changed");
      assert.deepEqual(e.decision?.actions, ["land", "remove"]);
      assert.equal(e.approval.drafts?.hash, "h1", "not re-pinned");
      assert.equal(k.run.inputs.length, 0, "nothing ran");
      assert.ok(!events.some((ev) => ev.kind === "drafts-changed"), "the thread isn't asked to re-pin them");
      await assert.rejects(q.fixRuling(entry.id, undefined, true, ""), /no fix waits|name the request/, "no ruling re-pins drafts no request asked for");
      await q.answer(entry.id, "land");
      assert.equal((await k.entry(entry.id)).approval.drafts?.hash, "h-edited", "Land re-pins them as they are now");
      await landed(k, entry.id);
    } finally {
      await k.done();
    }
  });
});

describe("only what the merge thread checked is pinned", () => {
  test("drafts edited between the chat's Fixed and the thread's check never land on the standing Land: they wait for the user", async () => {
    const { k, d } = standingKit({ thread: (ev) => ev.kind === "fix" });
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", cause: "drafts", why: "its spec drafts don't fit" }));
      const q = await k.q();
      k.repo.branch("feat/race", { "r.txt": "r\n" });
      const { entry } = await q.add({ branch: "feat/race", by: "land-button", session: "s1" });
      const rq = lastRequest(await withChat(k, entry.id));
      d.hash = "h-answered";
      await q.respond(rq.id, "s1", { answer: "fixed", drafts: true });
      d.hash = "h-edited-after"; // an edit while the thread reads
      const e = await q.fixRuling(entry.id, rq.id, true, "");
      assert.equal(e.state, "needs-user", "not back in line");
      assert.equal(e.decision?.kind, "drafts-changed");
      assert.equal(e.approval.drafts?.hash, "h1", "nothing re-pinned");
      assert.equal(k.run.inputs.length, 1, "not run again");
    } finally {
      await k.done();
    }
  });

  test("a commit-only fix whose drafts moved meanwhile, undeclared, waits for the user too", async () => {
    const { k, d } = standingKit({ thread: (ev) => ev.kind === "fix" });
    try {
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit tests failed" }));
      const q = await k.q();
      const b = k.repo.branch("feat/race-commit", { "rc.txt": "r\n" });
      const { entry } = await q.add({ branch: "feat/race-commit", by: "land-button", session: "s1" });
      const rq = lastRequest(await withChat(k, entry.id));
      const fix = k.repo.commitOn(b.path, { "rc.txt": "r2\n" }, "fix");
      await q.respond(rq.id, "s1", { answer: "fixed", commit: fix });
      d.hash = "h-moved";
      const e = await q.fixRuling(entry.id, rq.id, true, "");
      assert.equal(e.decision?.kind, "drafts-changed");
      assert.equal(e.commit, b.head, "the approval didn't move");
    } finally {
      await k.done();
    }
  });
});

describe("a fix that decides something that is the user's (q3)", () => {
  test("the thread rules needs-user on the fix: a decision for the user, never landed as checked; checked is refused after", async () => {
    const { k, events } = standingKit({ thread: (ev) => ev.kind === "fix" });
    try {
      let runs = 0;
      k.run.set(() => (++runs === 1 ? { verdict: "failed", blame: "branch", why: "Unit tests failed: expects \"Save changes\"" } : {}));
      const q = await k.q();
      const b = k.repo.branch("feat/label", { "c.txt": "c\n" });
      const { entry } = await q.add({ branch: "feat/label", by: "land-button", session: "s1" });
      const rq = lastRequest(await withChat(k, entry.id));
      const fixSha = k.repo.commitOn(b.path, { "c.txt": "button: Store\n" }, "rename the button to Store");
      await q.respond(rq.id, "s1", { answer: "fixed", commit: fixSha, text: "renamed the button" });
      await until(() => events.some((ev) => ev.kind === "fix" && ev.request === rq.id), "the fix handed to the thread");
      const d = await q.rule(entry.id, { ruling: "needs-user", text: "The fix renamed the button to \"Store\"; the branch said \"Save changes\". Which should it say?", choices: ["Store", "Save changes"] });
      assert.equal(d.state, "needs-user");
      assert.equal(d.decision?.raisedBy, "merge-thread");
      assert.deepEqual(d.decision?.choices, ["Store", "Save changes"]);
      await assert.rejects(q.rule(entry.id, { ruling: "checked", request: rq.id }), /already waits for the user's decision/, "the thread can't take it back as checked");
      assert.equal((await k.entry(entry.id)).state, "needs-user");
      assert.equal(runs, 1, "nothing ran on the fix: it never went into line unchecked");
    } finally {
      await k.done();
    }
  });
});

describe("fixes under one Land build on each other", () => {
  test("two requests in a row, each fixed with a commit (the first held out of line by a failing check): the second fix's checked commit isn't 'work the queue didn't ask for'", async () => {
    let failing: string | null = null;
    const kit = makeKit({ deps: { draftsHash: () => undefined, chatCheckFailing: async () => failing, thread: (ev) => ev.kind === "fix" } });
    try {
      kit.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit tests failed" }));
      const q = await kit.q();
      const b = kit.repo.branch("feat/chain", { "ch.txt": "c\n" });
      const { entry } = await q.add({ branch: "feat/chain", by: "land-button", session: "s1" });
      const rq1 = lastRequest(await withChat(kit, entry.id));
      // Commit times are whole seconds: the first request is dated 2019, fix one 2020 (after it, before the second).
      lastRequest(q.entry(entry.id) as MergeEntry).at = "2019-01-01T00:00:00.000Z";
      writeFileSync(join(b.path, "ch.txt"), "c1\n");
      sh(b.path, "add", "ch.txt");
      execFileSync("git", ["commit", "-q", "-m", "fix one"], { cwd: b.path, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" } });
      const fix1 = sh(b.path, "rev-parse", "HEAD");
      await q.respond(rq1.id, "s1", { answer: "fixed", commit: fix1 });
      failing = "this chat's last test run failed"; // the requeue is held: the pin stays at the Land's commit
      let e = await q.fixRuling(entry.id, rq1.id, true, "");
      assert.equal(e.standing?.phase, "waiting-fix");
      assert.equal(e.commit, b.head, "not re-pinned yet");
      const rq2 = lastRequest(e);
      assert.equal(rq2.kind, "blocked");
      const fix2 = kit.repo.commitOn(b.path, { "ch.txt": "c2\n" }, "fix two");
      failing = null;
      kit.run.set(null);
      await q.respond(rq2.id, "s1", { answer: "fixed", commit: fix2 });
      e = await q.fixRuling(entry.id, rq2.id, true, "");
      assert.equal(e.decision, undefined, "fix one is the Land's, not unasked work");
      assert.equal(e.state, "queued");
      assert.equal(e.commit, fix2);
      await landed(kit, entry.id);
    } finally {
      await kit.done();
    }
  });
});

describe("fixes under one Land: what still counts as unasked work", () => {
  /** A commit on `path` dated `date` (commit times are whole seconds: tests date them apart). */
  const datedCommit = (path: string, file: string, text: string, message: string, date: string) => {
    writeFileSync(join(path, file), text);
    sh(path, "add", file);
    execFileSync("git", ["commit", "-q", "-m", message], { cwd: path, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_COMMITTER_DATE: date } });
    return sh(path, "rev-parse", "HEAD");
  };
  /** Land, sent back once (request 1 dated 2019), fix one (2020) answered on it. */
  async function firstFix(failing: { why: string | null }) {
    const kit = makeKit({ deps: { draftsHash: () => undefined, chatCheckFailing: async () => failing.why, thread: (ev) => ev.kind === "fix" } });
    kit.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit tests failed" }));
    const q = await kit.q();
    const b = kit.repo.branch("feat/chain2", { "ch.txt": "c\n" });
    const { entry } = await q.add({ branch: "feat/chain2", by: "land-button", session: "s1" });
    const rq1 = lastRequest(await withChat(kit, entry.id));
    lastRequest(q.entry(entry.id) as MergeEntry).at = "2019-01-01T00:00:00.000Z";
    const fix1 = datedCommit(b.path, "ch.txt", "c1\n", "fix one", "2020-01-01T00:00:00Z");
    await q.respond(rq1.id, "s1", { answer: "fixed", commit: fix1 });
    return { kit, q, b, entry, rq1, fix1 };
  }

  test("a user commit between a checked fix and the next fix still counts: one commit, the pin unmoved", async () => {
    const failing = { why: "this chat's last test run failed" as string | null };
    const { kit, q, b, entry, rq1 } = await firstFix(failing);
    try {
      const held = await q.fixRuling(entry.id, rq1.id, true, ""); // checked, its requeue held by the failing check
      const rq2 = lastRequest(held);
      datedCommit(b.path, "u.txt", "the user's\n", "work the user asked for", "2021-01-01T00:00:00Z");
      const fix2 = kit.repo.commitOn(b.path, { "ch.txt": "c2\n" }, "fix two");
      failing.why = null;
      await q.respond(rq2.id, "s1", { answer: "fixed", commit: fix2 });
      const e = await q.fixRuling(entry.id, rq2.id, true, "");
      assert.equal(e.decision?.kind, "fix-ok");
      assert.match(e.decision?.question ?? "", /1 commit the merge queue didn't ask for/, "only the user's commit: fix one is the Land's");
      assert.equal(e.commit, b.head, "the pin unmoved");
    } finally {
      await kit.done();
    }
  });

  test("an earlier fix answered but never checked isn't the Land's: it and the user's commit both count", async () => {
    const { kit, q, b, entry } = await firstFix({ why: null });
    try {
      // The thread never rules on fix one; another request follows (its diagnosis, say).
      const rq2 = q.addRequest(q.entry(entry.id) as Parameters<typeof q.addRequest>[0], { kind: "fix", text: "the thread's diagnosis" });
      datedCommit(b.path, "u.txt", "the user's\n", "work the user asked for", "2021-01-01T00:00:00Z");
      const fix2 = kit.repo.commitOn(b.path, { "ch.txt": "c2\n" }, "fix two");
      await q.respond(rq2.id, "s1", { answer: "fixed", commit: fix2 });
      const e = await q.fixRuling(entry.id, rq2.id, true, "");
      assert.equal(e.decision?.kind, "fix-ok");
      assert.match(e.decision?.question ?? "", /2 commits the merge queue didn't ask for/);
      assert.equal(e.commit, b.head, "the pin unmoved");
    } finally {
      await kit.done();
    }
  });
});

describe("the conflict there at the Land", () => {
  test("counts no try and shows none; the next send-back that counts reads try 1 of 3", async () => {
    const { k, events } = standingKit({ thread: (ev) => ev.kind === "conflict" || ev.kind === "fix" });
    try {
      const q = await k.q();
      const b = k.repo.branch("feat/free", { "a.txt": "ONE\ntwo\nthree\n" });
      k.repo.commitOn(k.repo.root, { "a.txt": "uno\ntwo\nthree\n" }, "master moves");
      const { entry } = await q.add({ branch: "feat/free", by: "land-button", session: "s1" });
      await until(async () => (await k.entry(entry.id)).state === "conflict", "conflict");
      await q.resolve(entry.id, { verdict: "chat-fixes", ours: "uno", theirs: "ONE", proposal: "merge master in" });
      const rq = lastRequest(await withChat(k, entry.id));
      sh(b.path, "merge", "-q", "--no-edit", "-X", "theirs", "master");
      const fix = sh(b.path, "rev-parse", "HEAD");
      k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit tests failed" }));
      await q.respond(rq.id, "s1", { answer: "fixed", commit: fix });
      await q.fixRuling(entry.id, rq.id, true, "");
      const e = await until(async () => {
        const x = await k.entry(entry.id);
        return x.state === "with-chat" && x.tries?.used === 1 ? x : null;
      }, "a counted send-back");
      assert.deepEqual(e.standing?.phase === "with-chat" ? [e.standing.try, e.standing.of] : null, [1, 3]);
      assert.match(lastRequest(e).text, /\(try 1 of 3\)/);
      assert.ok(events.length);
    } finally {
      await k.done();
    }
  });

  test("resolved by the thread after waiting for it: the wait ends with the ruling, no try is left owed, and it lands", async () => {
    let up = false;
    const { k, events } = standingKit({ thread: (ev) => ev.kind === "conflict" && up });
    try {
      const q = await k.q();
      k.repo.branch("feat/resolved", { "a.txt": "ONE\ntwo\nthree\n" });
      k.repo.commitOn(k.repo.root, { "a.txt": "uno\ntwo\nthree\n" }, "master moves");
      const { entry } = await q.add({ branch: "feat/resolved", by: "land-button", session: "s1" });
      assert.equal(q.entry(entry.id)?.approval.conflictAtLand, true);
      await until(async () => (await k.entry(entry.id)).fix?.told === false, "waits for the thread");
      up = true;
      q.threadActed();
      const ev = await until(() => events.find((x) => x.kind === "conflict" && x.scratch), "handed to the thread with a copy");
      // The thread resolves it in its scratch copy: no behaviour change.
      const copy = ev.scratch!;
      try {
        sh(copy, "merge", "--no-ff", "--no-commit", entry.commit);
      } catch {}
      writeFileSync(join(copy, "a.txt"), "UNO\ntwo\nthree\n");
      sh(copy, "add", "a.txt");
      sh(copy, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "commit", "-q", "--no-edit");
      const res = sh(copy, "rev-parse", "HEAD");
      const e = await q.resolve(entry.id, { verdict: "no-behaviour-change", ours: "uno", theirs: "ONE", proposal: "both", commit: res });
      assert.equal(e.fix, undefined, "no longer waiting for the thread");
      assert.equal(e.approval.conflictAtLand, undefined, "nothing went back to the chat: a later conflict counts");
      assert.equal(e.state, "queued");
      await landed(k, entry.id);
    } finally {
      await k.done();
    }
  });
});
