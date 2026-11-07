// The standing approval (al_3): after the user's one Land, the branch's chat answers the queue's requests (Fixed,
// Needs you, Can't) and a fix the merge thread checked goes back in line by itself — drafts-only fixes included —
// with no second Land. Real git underneath (queue-kit.ts); the run is a stand-in whose verdict each test scripts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MERGE_REQUEST_ID_RE } from "../../shared/topic-message";
import type { MergeEntry } from "../../shared/merge-queue";
import type { ThreadEvent } from "./contract";
import type { Caller } from "../project-services/engine";
import { merger } from "./routes";
import { makeKit, sh, until } from "./testing/queue-kit";

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
      await assert.rejects(q.respond(ask.id, "s1", { answer: "fixed", text: "x" }), /relay their own words with merge.reply/);
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
    } finally {
      await k.done();
    }
  });
});

describe("Approved · waiting for a fix", () => {
  test("Land on a finished branch that conflicts: it waits with its chat, told what blocks it; once its drafts fit at the same commit it joins the line by itself", async () => {
    const { k, d } = standingKit();
    try {
      const q = await k.q();
      // A conflict: master and the branch change the same line.
      const b = k.repo.branch("feat/blocked", { "a.txt": "ONE\ntwo\nthree\n" });
      k.repo.commitOn(k.repo.root, { "a.txt": "uno\ntwo\nthree\n" }, "master moves");
      const { entry } = await q.add({ branch: "feat/blocked", by: "land-button", session: "s1" });
      assert.equal(entry.state, "with-chat");
      assert.equal(entry.approval.blocked, true);
      assert.equal(entry.standing?.phase, "waiting-fix");
      assert.match(entry.standing?.phase === "waiting-fix" ? entry.standing.why : "", /conflicts with master in 1 file: a\.txt/);
      const rq = lastRequest(entry);
      assert.equal(rq.kind, "blocked");
      assert.ok(k.notices.some((n) => n.kind === "request"), "the chat is told what blocks it");
      assert.equal(k.run.inputs.length, 0, "not in line");

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
      assert.equal((await k.entry(entry.id)).state, "with-chat", "the conflict still blocks the first");
      assert.ok(b.head);
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
