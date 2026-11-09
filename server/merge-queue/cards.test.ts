import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { scratchRoot } from "../test-scratch";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import { sendQueueWake, type WakeDeps } from "./wake";
import { type MergeCard, type MergeEntry, type MergeQueueView } from "../../shared/merge-queue";
import { isMergeQueueText, MERGE_QUEUE_SENT_PREFIX, MERGE_QUEUE_SESSION } from "../../shared/senders";
import { MERGE_QUEUE_SENDER } from "./wake";
import { blockedNoteText, docsNudgeText } from "../ready-to-land";
import { withMergeCardNote, setMergeCardNoteSource } from "./card-note";
import { MergeCards } from "./cards";
import { noticeText } from "./notices";
import { sh } from "./testing/queue-kit";
import type { QueueDeps } from "./queue";
import { makeKit, until, untilAborted } from "./testing/queue-kit";
import { typedGoAhead } from "../../pi-config/extensions/worktrees/landing.ts";

/** The hidden lines past the approval's own, which every approved branch has (asserted below). */
const outcomeNote = (cards: Pick<MergeCards, "noteFor">, session: string, since: string | null = null): string | null => {
  const lines = cards.noteFor(session, since)?.split("\n").filter((l) => !/ is in line to land on .*Leave it alone until it lands/.test(l)) ?? [];
  return lines.length ? lines.join("\n") : null;
};

const landed = (k: ReturnType<typeof makeKit>, id: string) =>
  until(async () => {
    const e = await k.entry(id);
    return e.state === "landed" && e.landed?.pushed !== "pending";
  }, `${id} landed`);

/** A kit whose queue raises real cards: notify → cards, publish → sync; `last` is the chat's last transcript entry. */
function cardKit(o: { deps?: Partial<QueueDeps>; threadAnswers?: boolean; wakeFails?: boolean; wakeHangs?: boolean; wake?: (session: string, text: string) => Promise<unknown>; homeOf?: (session: string) => Promise<{ id: string; path: string } | null> } = {}) {
  const chat = { last: "e1" as string | null };
  const wakes: { session: string; text: string; info?: { id?: string; kind?: string; branch?: string; entry?: string } }[] = [];
  const published: { session: string; cards: MergeCard[] }[] = [];
  let cards!: MergeCards;
  const pending: Promise<void>[] = [];
  const track = (p: Promise<void>) => void pending.push(p.catch((err) => assert.fail(String(err))));
  const k = makeKit({
    ...(o.threadAnswers !== undefined ? { threadAnswers: o.threadAnswers } : {}),
    deps: {
      notify: (kind, e, extra) => {
        k.notices.push({ kind, branch: e.branch, ...(e.session ? { session: e.session } : {}) });
        // As wire.ts: a request that is no outcome of its own goes to the chat as itself.
        if (extra.request && kind !== "needs-fix" && kind !== "sent-back") return track(cards.request(e, extra.request, extra.run));
        track(kind === "approved" ? cards.approved(e, extra.root) : cards.outcome(kind as never, e, { ...(extra.run ? { run: extra.run } : {}), root: extra.root, ...(extra.request ? { request: extra.request } : {}) }));
      },
      publish: (v: MergeQueueView) => {
        k.views.push(v);
        track(cards.sync(v));
      },
      ...o.deps,
    },
  });
  const make = () =>
    new MergeCards({
      dir: join(k.repo.state, "merge-queue", "cards"),
      lastEntry: async () => chat.last,
      wake: async (session, text, info) => {
        if (o.wake) return o.wake(session, text);
        if (o.wakeFails) throw new Error("archived");
        if (o.wakeHangs) {
          wakes.push({ session, text, ...(info ? { info } : {}) });
          return new Promise<void>(() => {});
        }
        wakes.push({ session, text, ...(info ? { info } : {}) });
      },
      publish: (session, list) => published.push({ session, cards: list }),
      ...(o.homeOf ? { homeOf: o.homeOf } : {}),
    });
  cards = make();
  return {
    k,
    chat,
    wakes,
    published,
    get cards() {
      return cards;
    },
    restart() {
      cards = make();
      return cards;
    },
    settle: async () => {
      while (pending.length) await pending.shift();
    },
  };
}

describe("a branch's card in its own chat", () => {
  test("Land raises one card at the chat's end; queued and checking revise it in place; Landed is a new revision lower down, with one hidden line and no turn", async () => {
    const t = cardKit();
    try {
      const q = await t.k.q();
      await q.pause("hold");
      t.k.repo.branch("feat/a", { "a1.txt": "a\n", "a2.txt": "b\nc\n" });
      t.k.repo.branch("feat/b", { "b.txt": "b\n" });
      await q.add({ branch: "feat/b", by: "land-button", session: "s1" });
      const { entry } = await q.add({ branch: "feat/a", by: "typed", session: "s1" });
      await t.settle();
      let card = t.cards.cardsOf("s1").find((c) => c.entry === entry.id)!;
      assert.equal(card.revisions.length, 1);
      assert.deepEqual([card.revisions[0]!.kind, card.revisions[0]!.after, card.revisions[0]!.state, card.revisions[0]!.position], ["approved", "e1", "queued", 2]);
      assert.equal(card.approvedBy, "typed");
      assert.equal(card.head, entry.commit);
      // The chat goes on; the line moves (feat/b cancelled): the card is revised in place, not moved.
      t.chat.last = "e5";
      const b = (await q.view()).waiting.find((e) => e.branch === "feat/b")!;
      await q.cancel(b.id);
      await until(async () => (await t.settle(), t.cards.cardsOf("s1").find((c) => c.entry === entry.id)!.position === 1), "position 1 in place");
      card = t.cards.cardsOf("s1").find((c) => c.entry === entry.id)!;
      assert.equal(card.revisions.length, 1, "no new revision while queued");
      // Checking: in place too.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      t.k.run.set(async () => {
        await gate;
        return {};
      });
      await q.resume();
      await until(async () => (await t.settle(), t.cards.cardsOf("s1").find((c) => c.entry === entry.id)!.state === "checking"), "checking in place");
      assert.equal(t.cards.cardsOf("s1").find((c) => c.entry === entry.id)!.revisions.length, 1);
      t.chat.last = "e9";
      release();
      await landed(t.k, entry.id);
      await until(async () => (await t.settle(), t.cards.cardsOf("s1").find((c) => c.entry === entry.id)!.revisions.length === 2), "landed revision");
      card = t.cards.cardsOf("s1").find((c) => c.entry === entry.id)!;
      const rev = card.revisions[1]!;
      assert.deepEqual([rev.kind, rev.after, rev.state], ["landed", "e9", "landed"]);
      assert.equal(card.landed!.from.length, 40);
      assert.deepEqual(card.stats, { commits: 1, added: 3, removed: 0 }, "frozen at landing");
      assert.deepEqual(t.wakes, [], "a landing starts no turn");
      assert.match(t.cards.noteFor("s1", null)!, /is in line to land on master\. Leave it alone until it lands: don't merge master into it\. The queue handles any conflict and asks for any fix it needs\. Real new commits are fine: they stay on the branch as new work for a later Land\./);
      const note = outcomeNote(t.cards, "s1")!;
      assert.match(note, /^feat\/a landed on master at [0-9a-f]{7}, 1 commit \(the commit approved, [0-9a-f]{7}\)\.$/);
      assert.equal(t.cards.noteFor("s1", new Date(Date.now() + 1000).toISOString()), null, "given once: nothing after the note");
      assert.ok(t.published.some((p) => p.session === "s1"));
    } finally {
      await t.k.done();
    }
  });

  test("a restart repeats nothing: one Landed revision, one hidden line", async () => {
    const t = cardKit();
    try {
      const q = await t.k.q();
      t.k.repo.branch("feat/r", { "r.txt": "r\n" });
      const { entry } = await q.add({ branch: "feat/r", by: "land-button", session: "s1" });
      await landed(t.k, entry.id);
      await t.settle();
      const fresh = t.restart();
      const e = await t.k.entry(entry.id);
      await fresh.outcome("landed", e, { root: t.k.repo.root });
      await fresh.sync(await q.view());
      await fresh.approved(e, t.k.repo.root);
      const card = fresh.cardsOf("s1")[0]!;
      assert.deepEqual(card.revisions.map((r) => r.kind), ["approved", "landed"]);
      assert.equal(outcomeNote(fresh, "s1")!.split("\n").length, 1);
    } finally {
      await t.k.done();
    }
  });

  test("a failure that is the branch's goes back to its chat by itself (al_3): one request (try 1 of 3) by its recorded id, the card back with the chat; a chat that can't take notes gets the hidden line", async () => {
    for (const wakeFails of [false, true]) {
      const t = cardKit({ wakeFails });
      try {
        const q = await t.k.q();
        t.k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts", failedSteps: [] }) as never);
        t.k.repo.branch("feat/bad", { "x.txt": "x\n" });
        const { entry } = await q.add({ branch: "feat/bad", by: "land-button", session: "s1" });
        await until(async () => (await t.k.entry(entry.id)).state === "with-chat", "with-chat");
        await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.revisions.length === 2), "needs-fix revision");
        await t.cards.sync(await q.view());
        const card = t.cards.cardsOf("s1")[0]!;
        assert.deepEqual(card.revisions.map((r) => r.kind), ["approved", "needs-fix"]);
        assert.deepEqual(card.standing, { phase: "with-chat", try: 1, of: 3, why: "unit failed: src/a.test.ts" }, "Back with the chat · try 1 of 3");
        const e = await t.k.entry(entry.id);
        assert.equal(e.requests?.length, 1);
        if (!wakeFails) {
          assert.equal(t.wakes.length, 1);
          assert.ok(isMergeQueueText(t.wakes[0]!.text));
          assert.match(t.wakes[0]!.text, /^\[merge-queue\] feat\/bad didn't land \(try 1 of 3\): unit failed/);
          assert.match(t.wakes[0]!.text, /merge\.respond/, "asks for an answer by id");
          assert.doesNotMatch(t.wakes[0]!.text, /land it again|Land This Commit Again/);
          assert.deepEqual(t.wakes[0]!.info, { id: e.requests![0]!.id, kind: "fix", branch: "feat/bad", entry: entry.id }, "the queue's own request id rides on the note");
          assert.equal(outcomeNote(t.cards, "s1"), null);
        } else {
          assert.match(outcomeNote(t.cards, "s1")!, /^feat\/bad didn't land \(try 1 of 3\)/);
        }
      } finally {
        await t.k.done();
      }
    }
  });

  test("sent back for its drafts: the request says no commit is needed and never asks for a new Land; Remove from Queue is a final Removed revision, no turn", async () => {
    let print = "p1";
    const t = cardKit({ deps: { draftsHash: () => ({ hash: "h1", names: ["x"] }), draftsFingerprint: () => print, docsCheck: () => ({ problems: [] }) } });
    try {
      const q = await t.k.q();
      t.k.run.set(() => ({ verdict: "failed", blame: "branch", cause: "drafts", why: "your spec drafts don't fit, so nothing was made official: x" }));
      t.k.repo.branch("feat/doc", { "x.txt": "x\n" });
      const { entry } = await q.add({ branch: "feat/doc", by: "land-button", session: "s1" });
      await until(async () => (await t.k.entry(entry.id)).state === "with-chat", "with-chat");
      await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.revisions.length === 2), "needs-fix revision");
      assert.equal(t.wakes.length, 1);
      assert.match(t.wakes[0]!.text, /Make them fit in your drafts \(that needs no commit\)/);
      assert.doesNotMatch(t.wakes[0]!.text, /Land This Commit Again|land it again/);
      assert.doesNotMatch(t.wakes[0]!.text, /Fix it, commit/);
      assert.equal(t.cards.cardsOf("s1")[0]!.sentBackFor, "drafts");
      print = "p2";
      await t.cards.sync(await q.view({ fresh: true }));
      await q.cancel(entry.id);
      await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.revisions.length === 3), "removed revision");
      const card = t.cards.cardsOf("s1")[0]!;
      assert.deepEqual(card.revisions.map((r) => r.kind), ["approved", "needs-fix", "removed"]);
      assert.equal(card.state, "cancelled");
      assert.equal(card.removed, true);
      assert.equal(card.redrafted, undefined);
      assert.equal(t.wakes.length, 1, "no turn for a removal");
      // A later Land of the branch moves the same card on (held: nothing runs past the test).
      await q.pause("hold");
      const again = await q.add({ branch: "feat/doc", by: "land-button", session: "s1" });
      await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.entry === again.entry.id), "moved on");
      assert.equal(t.cards.cardsOf("s1")[0]!.removed, undefined);
      await q.idle();
      await t.settle();
    } finally {
      await t.k.done();
    }
  });

  test("an entry sent back before Send Back was retired (no standing Land): its words say it needs the user's Land again, never a button that is gone", () => {
    const e = { branch: "feat/x", target: "master", commit: "a".repeat(40), notes: [], reason: "the review flagged it" } as never as MergeEntry;
    const plain = noticeText("sent-back", e);
    const review = noticeText("sent-back", { ...e, review: { verdict: "blocking", text: "a TODO" } } as never);
    const conflict = noticeText("sent-back", { ...e, conflict: { ours: "o", theirs: "t", proposal: "p" } } as never);
    for (const t of [plain, review, conflict]) {
      assert.match(t, /it needs the user's Land again once your fix is committed and finished\.$/);
      assert.doesNotMatch(t, /Land This Commit Again|Land Newest Commit|Send Back|type "land it"/, "no retired control, no typed go-ahead");
      assert.doesNotMatch(t, /ask (the user|them) to land it again/);
    }
  });

  test("a card back with its chat whose entry settled (its branch and folder gone) says so on the card: nothing left to offer", async () => {
    const t = cardKit();
    try {
      const q = await t.k.q();
      t.k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed" }));
      const b = t.k.repo.branch("feat/gone", { "g.txt": "g\n" });
      const { entry } = await q.add({ branch: "feat/gone", by: "land-button", session: "s1" });
      await until(async () => (await t.k.entry(entry.id)).state === "with-chat", "with-chat");
      await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.revisions.length === 2), "needs-fix revision");
      assert.equal(t.cards.cardsOf("s1")[0]!.settled, undefined);
      sh(t.k.repo.root, "worktree", "remove", "--force", b.path);
      sh(t.k.repo.root, "branch", "-D", "feat/gone");
      await t.cards.sync(await q.view({ fresh: true }));
      assert.equal(t.cards.cardsOf("s1")[0]!.settled, "gone");
      await t.settle();
    } finally {
      await t.k.done();
    }
  });

  test("a worker owns the branch: its Needs a fix wakes the chat that runs it, once; one that can't take it leaves the hidden line", async () => {
    for (const parentArchived of [false, true]) {
      const sent: { path: string; text: string }[] = [];
      const rows = [
        { id: "p1", path: "/s/p1.jsonl", title: "Plan the rows", archived: parentArchived, live: null },
        { id: "w1", path: "/s/w1.jsonl", title: "Build the rows", archived: false, live: null, workerSession: true },
      ] as SessionSummary[];
      const deps: WakeDeps = {
        summary: async (p) => rows.find((r) => r.path === p) ?? null,
        parentOf: async (p) => (p === "/s/w1.jsonl" ? "/s/p1.jsonl" : null),
        send: async (path, text) => void sent.push({ path, text }),
      };
      const t = cardKit({ wake: (session, text) => sendQueueWake(`/s/${session}.jsonl`, text, deps) });
      try {
        const q = await t.k.q();
        t.k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts" }));
        t.k.repo.branch("feat/worker", { "w.txt": "w\n" });
        const { entry } = await q.add({ branch: "feat/worker", by: "land-button", session: "w1" });
        await until(async () => (await t.k.entry(entry.id)).state === "with-chat", "with-chat");
        await until(async () => (await t.settle(), t.cards.cardsOf("w1")[0]?.revisions.length === 2), "needs-fix revision");
        if (!parentArchived) {
          assert.equal(sent.length, 1, "exactly one wake");
          assert.equal(sent[0]!.path, "/s/p1.jsonl", "the chat that runs the worker");
          // A request on the chat queue (§chat.merge-queue/requests): the batch says whose it is, so no prefix.
          assert.match(sent[0]!.text, /^For your worker "Build the rows".*feat\/worker didn't land \(try 1 of 3\)/);
          assert.equal(outcomeNote(t.cards, "w1"), null, "nothing left over");
        } else {
          assert.deepEqual(sent, []);
          assert.match(outcomeNote(t.cards, "w1")!, /^feat\/worker didn't land/, "kept as the hidden line");
        }
      } finally {
        await t.k.done();
      }
    }
  });

  test("a stop between the hand-back's write and its send: the wake becomes the hidden line once, never a second turn", async () => {
    const t = cardKit({ wakeHangs: true });
    try {
      const q = await t.k.q();
      t.k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts" }));
      t.k.repo.branch("feat/stop", { "s.txt": "s\n" });
      const { entry } = await q.add({ branch: "feat/stop", by: "land-button", session: "s1" });
      await until(async () => (await t.k.entry(entry.id)).state === "with-chat", "with-chat");
      await until(() => t.wakes.length === 1, "the wake sent (never answered)");
      assert.equal(outcomeNote(t.cards, "s1"), null, "while this process still sends it, it is no line");
      // Sova stops here: a fresh store on the same records.
      const fresh = t.restart();
      const note = outcomeNote(fresh, "s1");
      assert.ok(note, "the hand-back survives the stop as the hidden line");
      assert.match(note!, /^feat\/stop didn't land \(try 1 of 3\): unit failed: src\/a\.test\.ts/);
      assert.equal(outcomeNote(fresh, "s1"), note, "once");
      // A later view or outcome for the same entry sends no second wake and adds no second line.
      await fresh.sync(await q.view());
      await fresh.outcome("needs-fix", await t.k.entry(entry.id), { root: t.k.repo.root });
      assert.equal(t.wakes.length, 1, "never resent");
      assert.equal(outcomeNote(fresh, "s1")!.split("\n").filter((l) => l.startsWith("feat/stop didn't land")).length, 1);
    } finally {
      await t.k.done();
    }
  });

  test("behaviour differs is one decision revision: the thread's question and choices on the card, no turn, no Send Back", async () => {
    const t = cardKit({ threadAnswers: true, deps: { sanity: async () => ({ ok: true, files: ["a.txt"] }) } });
    try {
      const q = await t.k.q();
      t.k.repo.branch("feat/c", { "a.txt": "one\nTWO-c\nthree\n" });
      // The target moves after the Land (a branch conflicting at Land waits for a fix instead, al_3 q7).
      await q.pause("setting up a conflict");
      const c = await q.add({ branch: "feat/c", by: "land-button", session: "s1" });
      t.k.repo.commitOn(t.k.repo.root, { "a.txt": "one\nTWO-master\nthree\n" }, "master side");
      await q.resume();
      await until(async () => (await t.k.entry(c.entry.id)).state === "conflict", "conflict");
      await q.resolve(c.entry.id, { verdict: "needs-user", ours: "master returns 2", theirs: "the branch returns 3", proposal: "a flag", text: "Should it return 2 or 3?", choices: ["Return 2", "Return 3"] });
      await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.revisions.some((r) => r.kind === "behaviour-differs")), "behaviour-differs revision");
      const card = t.cards.cardsOf("s1")[0]!;
      assert.equal(card.conflict!.ours, "master returns 2");
      assert.equal(card.decision?.question, "Should it return 2 or 3?");
      assert.deepEqual(card.decision?.choices, ["Return 2", "Return 3"]);
      assert.deepEqual(card.decision?.actions, [], "no resolution commit: nothing to Accept");
      assert.ok(card.decision?.heldNote?.text, "the queue's note is held, not sent");
      await t.cards.sync(await q.view());
      await t.settle();
      assert.deepEqual(t.cards.cardsOf("s1")[0]!.revisions.map((r) => r.kind), ["approved", "behaviour-differs"], "one revision for the decision");
      assert.equal(t.wakes.length, 0, "nothing goes to the chat until the user answers");
      await assert.rejects(q.answer(c.entry.id, "accept"), /no proposed resolution/);
    } finally {
      await t.k.done();
    }
  });

  test("can't tell whose failure: one decision revision with Land Anyway / Try Again, no turn and no line; Try Again requeues without a try", async () => {
    const t = cardKit();
    try {
      const q = await t.k.q();
      let calls = 0;
      t.k.run.set(() => (++calls === 1 ? { verdict: "unattributed", why: "Unit tests failed on the merge and on master alone" } : { verdict: "passed" }));
      t.k.repo.branch("feat/u", { "u.txt": "u\n" });
      const u = await q.add({ branch: "feat/u", by: "land-button", session: "s1" });
      await until(async () => (await t.k.entry(u.entry.id)).state === "unattributed", "unattributed");
      await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.revisions.some((r) => r.kind === "unattributed")), "unattributed revision");
      const card = t.cards.cardsOf("s1")[0]!;
      assert.equal(card.state, "unattributed");
      assert.equal(card.reason, "Unit tests failed on the merge and on master alone");
      assert.deepEqual(card.decision?.actions, ["land-anyway", "try-again"]);
      assert.equal(card.decision?.kind, "unattributed");
      assert.equal(t.wakes.length, 0, "waiting for the user: no turn");
      assert.equal(outcomeNote(t.cards, "s1"), null, "and no hidden line");
      await q.answer(u.entry.id, "try-again");
      await until(async () => (await t.k.entry(u.entry.id)).state === "landed", "landed on the second run");
      assert.equal((await t.k.entry(u.entry.id)).tries?.used ?? 0, 0, "Try Again uses no try");
      assert.equal(t.wakes.length, 0);
    } finally {
      await t.k.done();
    }
  });

  test("six branches in one chat: six cards; a branch with no known chat: none; no card back-filled for an entry raised before", async () => {
    const t = cardKit();
    try {
      const q = await t.k.q();
      await q.pause("hold");
      for (let i = 0; i < 6; i++) {
        t.k.repo.branch(`feat/n${i}`, { [`n${i}.txt`]: `${i}\n` });
        await q.add({ branch: `feat/n${i}`, by: "land-button", session: "s1" });
      }
      t.k.repo.branch("feat/orphan", { "o.txt": "o\n" });
      const orphan = await q.add({ branch: "feat/orphan", by: "land-button" });
      assert.equal(orphan.entry.session, undefined);
      await t.settle();
      assert.equal(t.cards.cardsOf("s1").length, 6);
      assert.deepEqual(new Set(t.cards.cardsOf("s1").map((c) => c.branch)).size, 6);
      // An entry the cards never saw approved (raised before this shipped): no card, whatever happens to it.
      const e = { ...(await t.k.entry(orphan.entry.id)), session: "s2" };
      await t.cards.outcome("landed", { ...e, state: "landed" }, { root: t.k.repo.root });
      assert.deepEqual(t.cards.cardsOf("s2"), []);
    } finally {
      await t.k.done();
    }
  });

  test("Land with no chat named: the branch's owner by the one rule (owners.ts, stood in here), nothing else", async () => {
    const t = cardKit({ deps: { ownerOf: async (_r, branch, wt) => (branch === "feat/w" && wt ? "s-wt" : branch === "feat/a" ? { session: "s-old", archived: true } : null) } });
    try {
      const q = await t.k.q();
      await q.pause("hold");
      t.k.repo.branch("feat/w", { "w.txt": "w\n" });
      const a = await q.add({ branch: "feat/w", by: "land-button" });
      assert.equal(a.entry.session, "s-wt");
      await q.cancel(a.entry.id);
      // An archived owner is still the owner: the approval records it.
      t.k.repo.branch("feat/a", { "a2.txt": "a\n" });
      assert.equal((await q.add({ branch: "feat/a", by: "land-button" })).entry.session, "s-old");
      // No owner: no chat, even when an earlier approval named one.
      t.k.repo.branch("feat/v", { "v.txt": "v\n" });
      const v1 = await q.add({ branch: "feat/v", by: "land-button", session: "s-v" });
      await q.cancel(v1.entry.id);
      const v2 = await q.add({ branch: "feat/v", by: "land-button" });
      assert.equal(v2.entry.session, undefined);
      await t.settle();
      assert.deepEqual(t.cards.cardsOf("s-v").map((c) => c.entry), [v1.entry.id]);
    } finally {
      await t.k.done();
    }
  });


  test("drafts changed after the Land with no request: one Drafts changed decision on the card (the user's), one notice, never a turn", async () => {
    let hash = "h1";
    const t = cardKit({ deps: { draftsHash: () => ({ hash, names: ["x"] }) } });
    try {
      const q = await t.k.q();
      await q.pause("hold");
      t.k.repo.branch("feat/d", { "d.txt": "d\n" });
      const { entry } = await q.add({ branch: "feat/d", by: "land-button", session: "s1" });
      hash = "h2";
      await q.resume();
      // q8: no request of the queue's was answered for them, so they are the user's to decide.
      await until(async () => (await t.k.entry(entry.id)).state === "needs-user", "waits for the user");
      assert.equal((await t.k.entry(entry.id)).decision?.kind, "drafts-changed");
      await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.revisions.length === 2), "revision");
      const card = t.cards.cardsOf("s1")[0]!;
      assert.equal(card.revisions[1]!.kind, "decision", "the card moves down as the decision");
      assert.equal(card.decision?.kind, "drafts-changed");
      assert.deepEqual(card.decision?.actions, ["land", "remove"]);
      assert.equal(t.k.notices.filter((n) => n.kind === "decision").length, 1, "one notice");
      assert.ok(!t.k.notices.some((n) => n.kind === "drafts-changed"), "no separate drafts-changed line");
      assert.deepEqual(t.wakes, [], "never a turn for the chat");
    } finally {
      await t.k.done();
    }
  });

  test("checking shows the run's steps done of all, in place", async () => {
    const t = cardKit();
    try {
      const q = await t.k.q();
      t.k.repo.branch("feat/p", { "p.txt": "p\n" });
      t.k.run.set((inp) => untilAborted(inp));
      const { entry } = await q.add({ branch: "feat/p", by: "land-button", session: "s1" });
      await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]?.progress), "progress");
      assert.deepEqual(t.cards.cardsOf("s1")[0]!.progress, { done: 1, total: 1 });
      assert.equal(t.cards.cardsOf("s1")[0]!.revisions.length, 1);
      await q.cancel(entry.id);
    } finally {
      await t.k.done();
    }
  });
});

describe("a blocking review's own card", () => {
  test("a worker's review card stands in the chat that runs it, at that chat's end, once; the queue card points to it; a notes-only landing tells the model its notes whole", async () => {
    const t = cardKit({ homeOf: async (s) => (s === "s1" ? { id: "p1", path: "/sessions/p1.jsonl" } : null) });
    try {
      const tip = sh(t.k.repo.root, "rev-parse", "master");
      const findings = [{ kind: "hack" as const, file: "a.ts", line: 3, text: "a flag only tests read" }, { kind: "naming" as const, text: "x says nothing" }];
      let runs = 0;
      t.k.run.set(() =>
        ++runs === 1
          ? { verdict: "review-flagged", review: { verdict: "blocking", summary: "Not yet.", findings, text: "Not yet.", commit: tip, at: "t" } }
          : { review: { verdict: "notes", summary: "Fine.", findings: [findings[1]!], text: "Fine.", commit: tip, at: "t" } },
      );
      const q = await t.k.q();
      const b = t.k.repo.branch("feat/w", { "w.txt": "w\n" });
      const { entry } = await q.add({ branch: "feat/w", by: "land-button", session: "s1" });
      await until(async () => (await t.k.entry(entry.id)).requests?.length === 1, "sent (no thread)");
      await t.settle();
      t.chat.last = "e9";
      await q.republish();
      await t.settle();
      const [rc, ...more] = t.cards.reviewsOf("p1");
      assert.equal(more.length, 0, "once");
      assert.equal(t.cards.reviewsOf("s1").length, 0, "not in the worker's own session");
      assert.deepEqual({ state: rc!.state, after: rc!.after, findings: rc!.findings, kept: rc!.reviewed.kept, try: rc!.try }, { state: "fixing", after: "e1", findings, kept: true, try: 1 });
      const card = t.cards.cardsOf("s1").find((c) => c.entry === entry.id)!;
      assert.deepEqual(card.reviewFound, { card: rc!.id, session: "p1", path: "/sessions/p1.jsonl", count: 2 });
      assert.ok(!(card.failures ?? []).some((f) => f.step === "review"));

      const e = await t.k.entry(entry.id);
      const fix = t.k.repo.commitOn(b.path, { "w.txt": "fixed\n" }, "fix");
      await q.respond(e.requests![0]!.id, "s1", { answer: "fixed", commit: fix, text: "x" });
      await until(async () => (await t.k.entry(entry.id)).fix !== undefined, "fix recorded");
      await q.fixRuling(entry.id, e.requests![0]!.id, true, "");
      await landed(t.k, entry.id);
      await t.settle();
      await q.republish();
      await t.settle();
      assert.equal(t.cards.reviewsOf("p1")[0]!.state, "passed");
      assert.equal(t.cards.cardsOf("s1").find((c) => c.entry === entry.id)!.reviewFound, undefined);
      assert.ok(outcomeNote(t.cards, "s1")!.includes("Review notes: Fine.\n- [naming] x says nothing"));
    } finally {
      await t.k.done();
    }
  });
});

describe("a review card's reviewed commit", () => {
  test("is read as kept or gone at each read, not only when the queue revises the card", async () => {
    const dir = scratchRoot("rc-kept-");
    const present = new Set(["t".repeat(40), "b".repeat(40)]);
    let now = 0;
    const cards = new MergeCards({
      dir,
      now: () => now,
      git: async (args) => ({ code: args[0] === "cat-file" && present.has(String(args[2]).replace("^{commit}", "")) ? 0 : 1, stdout: "", stderr: "" }),
    });
    const rec = { id: "mq_1:mr_1", run: "mr_1", commit: "c".repeat(40), tip: "t".repeat(40), base: "b".repeat(40), summary: "S.", findings: [{ kind: "hack" as const, text: "x" }], try: 1, of: 3, state: "passed" as const, at: "t", updatedAt: "t" };
    await cards.reviews({ id: "mq_1", session: "s1", project: "p", branch: "feat/x", target: "master", reviews: [rec] } as unknown as MergeEntry, "/repo");
    assert.equal((await cards.reviewsRead("s1"))[0]!.reviewed.kept, true);
    present.delete("t".repeat(40)); // gone at a gc: no queue event, and a passed card is never revised again
    now += 60_000;
    assert.equal((await cards.reviewsRead("s1"))[0]!.reviewed.kept, false);
  });
});

describe("the hidden line reaches the chat with its card note", () => {
  test("after the transcript cards' own note; nothing from either: null; a failing source: the cards' note alone", async () => {
    setMergeCardNoteSource((s) => (s === "s1" ? "feat/a landed on master at abc1234." : null));
    try {
      assert.equal(await withMergeCardNote(null, "s1", null), "From Sova's merge queue (not the user's words; nothing to answer):\nfeat/a landed on master at abc1234.");
      assert.equal(await withMergeCardNote("Card c1: chose A.", "s1", null), "Card c1: chose A.\nFrom Sova's merge queue (not the user's words; nothing to answer):\nfeat/a landed on master at abc1234.");
      assert.equal(await withMergeCardNote(null, "s2", null), null);
      setMergeCardNoteSource(() => {
        throw new Error("x");
      });
      assert.equal(await withMergeCardNote("Card c1: chose A.", "s1", null), "Card c1: chose A.");
    } finally {
      setMergeCardNoteSource(null);
    }
  });
});

describe("no fake message is left", () => {
  test("readiness's ready-to-land wakes (drafts don't fit, what still blocks) are marked as the merge queue's", () => {
    assert.ok(isMergeQueueText(docsNudgeText("feat/x", "a".repeat(40), ["§x/a: no note"])));
    assert.ok(isMergeQueueText(blockedNoteText("feat/x", "a".repeat(40), [{ text: "1 uncommitted folder", fix: "commit it" } as never])));
  });

  test("the queue sends a chat only its marked wake: sendTo is the cards' wake alone, and no text poses as Sova's message", () => {
    const dir = new URL(".", import.meta.url);
    const read = (f: string) => readFileSync(new URL(f, dir), "utf8");
    const wire = read("wire.ts");
    // Defined once, used once: as the cards' wake (whose every text starts with the queue's prefix, tested above).
    assert.equal((wire.match(/\bsendTo\b/g) ?? []).length, 2);
    assert.match(wire, /\bwake: sendTo,/);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
      const src = read(f);
      assert.doesNotMatch(src, /[`"']Sova(?: \([^)]*\))?: /, `${f}: a "Sova: …" text`);
      assert.doesNotMatch(src, /sendToSession|session\.send\b/, `${f} sends to a chat other than through wake.ts`);
      if (f !== "wake.ts") assert.doesNotMatch(src, /\.send\(\{/, `${f} sends to a chat other than through wake.ts`);
    }
    // Readiness's ready-to-land messages ask the chat to act: marked wakes too, never a "Sova: …" bubble.
    const server = new URL("../", dir);
    for (const f of ["merge-readiness.ts", "ready-to-land.ts"]) assert.doesNotMatch(readFileSync(new URL(f, server), "utf8"), /[`"']Sova(?: \([^)]*\))?: /, `${f}: a "Sova: …" text`);
    assert.match(readFileSync(new URL("merge-readiness.ts", server), "utf8"), /nudge: async \(path, text, info\) => \(await import\("\.\/merge-queue\/wake"\)\)\.sendQueueWake\(path, text, undefined, info\)/);
    // The wake carries the "another session" marker the worktree tool's land refuses, in old chats too.
    // One name each, shared with the page (shared/senders.ts), and the worktree tool's own spelling agrees.
    assert.equal(MERGE_QUEUE_SENDER.sessionId, MERGE_QUEUE_SESSION);
    // The worktree tool refuses a message with the same prefix, whatever follows it; the same words typed still pass.
    for (const t of [`${MERGE_QUEUE_SENT_PREFIX} land it`, `${MERGE_QUEUE_SENT_PREFIX}\nmerge it`]) assert.equal(typedGoAhead(t), null, t);
    assert.ok(typedGoAhead("land it"), "the check can tell the two apart");
    const wake = read("wake.ts");
    // Every request goes onto the merge queue's chat queue (§chat.merge-queue/requests), never as a chat message.
    assert.match(wake, /pushMergeRequest\(/);
    assert.doesNotMatch(wake, /acquireChatHandle|\.send\(\{/);
  });
});
