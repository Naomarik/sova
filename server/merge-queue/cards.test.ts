import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { type MergeCard, type MergeQueueView } from "../../shared/merge-queue";
import { isMergeQueueText, MERGE_QUEUE_SENT_PREFIX, MERGE_QUEUE_SESSION } from "../../shared/senders";
import { MERGE_QUEUE_SENDER } from "./wake";
import { blockedNoteText, docsNudgeText } from "../ready-to-land";
import { withMergeCardNote, setMergeCardNoteSource } from "./card-note";
import { MergeCards } from "./cards";
import type { QueueDeps } from "./queue";
import { makeKit, until, untilAborted } from "./testing/queue-kit";

const landed = (k: ReturnType<typeof makeKit>, id: string) =>
  until(async () => {
    const e = await k.entry(id);
    return e.state === "landed" && e.landed?.pushed !== "pending";
  }, `${id} landed`);

/** A kit whose queue raises real cards: notify → cards, publish → sync; `last` is the chat's last transcript entry. */
function cardKit(o: { deps?: Partial<QueueDeps>; threadAnswers?: boolean; wakeFails?: boolean; wakeHangs?: boolean } = {}) {
  const chat = { last: "e1" as string | null };
  const wakes: { session: string; text: string }[] = [];
  const published: { session: string; cards: MergeCard[] }[] = [];
  let cards!: MergeCards;
  const pending: Promise<void>[] = [];
  const track = (p: Promise<void>) => void pending.push(p.catch((err) => assert.fail(String(err))));
  const k = makeKit({
    ...(o.threadAnswers !== undefined ? { threadAnswers: o.threadAnswers } : {}),
    deps: {
      notify: (kind, e, extra) => {
        k.notices.push({ kind, branch: e.branch, ...(e.session ? { session: e.session } : {}) });
        track(kind === "approved" ? cards.approved(e, extra.root) : cards.outcome(kind, e, { ...(extra.run ? { run: extra.run } : {}), root: extra.root }));
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
      wake: async (session, text) => {
        if (o.wakeFails) throw new Error("archived");
        if (o.wakeHangs) {
          wakes.push({ session, text });
          return new Promise<void>(() => {});
        }
        wakes.push({ session, text });
      },
      publish: (session, list) => published.push({ session, cards: list }),
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
      const note = t.cards.noteFor("s1", null)!;
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
      assert.equal(fresh.noteFor("s1", null)!.split("\n").length, 1);
    } finally {
      await t.k.done();
    }
  });

  test("Needs a fix starts one turn marked as the merge queue's; a wake not taken becomes the hidden line", async () => {
    for (const wakeFails of [false, true]) {
      const t = cardKit({ wakeFails });
      try {
        const q = await t.k.q();
        t.k.run.set(() => ({ verdict: "failed", blame: "branch", why: "unit failed: src/a.test.ts", failedSteps: [] }) as never);
        t.k.repo.branch("feat/bad", { "x.txt": "x\n" });
        const { entry } = await q.add({ branch: "feat/bad", by: "land-button", session: "s1" });
        await until(async () => (await t.k.entry(entry.id)).state === "needs-fix", "needs-fix");
        await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.revisions.length === 2), "needs-fix revision");
        await t.cards.sync(await q.view());
        const card = t.cards.cardsOf("s1")[0]!;
        assert.deepEqual(card.revisions.map((r) => r.kind), ["approved", "needs-fix"]);
        if (!wakeFails) {
          assert.equal(t.wakes.length, 1);
          assert.ok(isMergeQueueText(t.wakes[0]!.text));
          assert.match(t.wakes[0]!.text, /^\[merge-queue\] feat\/bad didn't land: unit failed/);
          assert.equal(t.cards.noteFor("s1", null), null);
        } else {
          assert.match(t.cards.noteFor("s1", null)!, /^feat\/bad didn't land/);
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
      await until(async () => (await t.k.entry(entry.id)).state === "needs-fix", "needs-fix");
      await until(() => t.wakes.length === 1, "the wake sent (never answered)");
      assert.equal(t.cards.noteFor("s1", null), null, "while this process still sends it, it is no line");
      // Sova stops here: a fresh store on the same records.
      const fresh = t.restart();
      const note = fresh.noteFor("s1", null);
      assert.ok(note, "the hand-back survives the stop as the hidden line");
      assert.match(note!, /^feat\/stop didn't land: unit failed: src\/a\.test\.ts/);
      assert.equal(fresh.noteFor("s1", null), note, "once");
      // A later view or outcome for the same entry sends no second wake and adds no second line.
      await fresh.sync(await q.view());
      await fresh.outcome("needs-fix", await t.k.entry(entry.id), { root: t.k.repo.root });
      assert.equal(t.wakes.length, 1, "never resent");
      assert.equal(fresh.noteFor("s1", null)!.split("\n").filter((l) => l.startsWith("feat/stop didn't land")).length, 1);
    } finally {
      await t.k.done();
    }
  });

  test("behaviour differs is a revision; Send Back is one more (not also a needs-fix) and starts one marked turn", async () => {
    const t = cardKit({ threadAnswers: true, deps: { sanity: async () => ({ ok: true, files: ["a.txt"] }) } });
    try {
      const q = await t.k.q();
      t.k.repo.branch("feat/c", { "a.txt": "one\nTWO-c\nthree\n" });
      t.k.repo.commitOn(t.k.repo.root, { "a.txt": "one\nTWO-master\nthree\n" }, "master side");
      const c = await q.add({ branch: "feat/c", by: "land-button", session: "s1" });
      await until(async () => (await t.k.entry(c.entry.id)).state === "conflict", "conflict");
      await q.resolve(c.entry.id, { verdict: "behaviour-differs", ours: "master returns 2", theirs: "the branch returns 3", proposal: "a flag" });
      await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.revisions.some((r) => r.kind === "behaviour-differs")), "behaviour-differs revision");
      assert.equal(t.cards.cardsOf("s1")[0]!.conflict!.ours, "master returns 2");
      await q.answer(c.entry.id, "send-back");
      await t.settle();
      await t.cards.sync(await q.view());
      await t.settle();
      const kinds = t.cards.cardsOf("s1")[0]!.revisions.map((r) => r.kind);
      assert.deepEqual(kinds, ["approved", "behaviour-differs", "sent-back"]);
      assert.equal(t.wakes.length, 1);
      assert.match(t.wakes[0]!.text, /^\[merge-queue\] The user sent feat\/c back/);
    } finally {
      await t.k.done();
    }
  });

  test("can't tell whose failure: a waiting revision with Land Anyway / Send Back, no turn and no line; Send Back starts one marked turn", async () => {
    const t = cardKit();
    try {
      const q = await t.k.q();
      t.k.run.set(() => ({ verdict: "unattributed", why: "Unit tests failed on the merge and on master alone" }));
      t.k.repo.branch("feat/u", { "u.txt": "u\n" });
      const u = await q.add({ branch: "feat/u", by: "land-button", session: "s1" });
      await until(async () => (await t.k.entry(u.entry.id)).state === "unattributed", "unattributed");
      await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.revisions.some((r) => r.kind === "unattributed")), "unattributed revision");
      const card = t.cards.cardsOf("s1")[0]!;
      assert.equal(card.state, "unattributed");
      assert.equal(card.reason, "Unit tests failed on the merge and on master alone");
      assert.equal(t.wakes.length, 0, "waiting for the user: no turn");
      assert.equal(t.cards.noteFor("s1", null), null, "and no hidden line");
      await q.answer(u.entry.id, "send-back");
      await t.settle();
      await t.cards.sync(await q.view());
      await t.settle();
      assert.deepEqual(t.cards.cardsOf("s1")[0]!.revisions.map((r) => r.kind), ["approved", "unattributed", "sent-back"]);
      assert.equal(t.wakes.length, 1);
      assert.match(t.wakes[0]!.text, /^\[merge-queue\] The user sent feat\/u back: a check failed on the merge and on master alone, and couldn't say whose failure it is/);
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

  test("Land with no chat named: the branch's owner (owners.ts, stood in here), else its earlier chat", async () => {
    const t = cardKit({ deps: { ownerOf: async (_r, branch, wt) => (branch === "feat/w" && wt ? "s-wt" : null) } });
    try {
      const q = await t.k.q();
      await q.pause("hold");
      t.k.repo.branch("feat/w", { "w.txt": "w\n" });
      const a = await q.add({ branch: "feat/w", by: "land-button" });
      assert.equal(a.entry.session, "s-wt");
      await q.cancel(a.entry.id);
      t.k.repo.branch("feat/v", { "v.txt": "v\n" });
      const v1 = await q.add({ branch: "feat/v", by: "land-button", session: "s-v" });
      await q.cancel(v1.entry.id);
      const v2 = await q.add({ branch: "feat/v", by: "land-button" });
      assert.equal(v2.entry.session, "s-v");
      await t.settle();
      // A new approval of the same branch moves the same card on (a new "approved" revision), never a second card.
      const vs = t.cards.cardsOf("s-v");
      assert.equal(vs.length, 1);
      assert.equal(vs[0]!.entry, v2.entry.id);
      assert.deepEqual(vs[0]!.revisions.map((r) => r.kind), ["approved", "approved"]);
    } finally {
      await t.k.done();
    }
  });

  test("drafts changed: a revision and a hidden line, never a turn", async () => {
    let hash = "h1";
    const t = cardKit({ deps: { draftsHash: () => ({ hash, names: ["x"] }) } });
    try {
      const q = await t.k.q();
      await q.pause("hold");
      t.k.repo.branch("feat/d", { "d.txt": "d\n" });
      const { entry } = await q.add({ branch: "feat/d", by: "land-button", session: "s1" });
      hash = "h2";
      await q.resume();
      await until(async () => (await t.k.entry(entry.id)).state === "drafts-changed", "drafts-changed");
      await until(async () => (await t.settle(), t.cards.cardsOf("s1")[0]!.revisions.length === 2), "revision");
      assert.equal(t.cards.cardsOf("s1")[0]!.revisions[1]!.kind, "drafts-changed");
      assert.deepEqual(t.wakes, []);
      assert.match(t.cards.noteFor("s1", null)!, /spec drafts changed since the user approved it/);
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

describe("the hidden line reaches the chat with its card note", () => {
  test("after the transcript cards' own note; nothing from either: null; a failing source: the cards' note alone", () => {
    setMergeCardNoteSource((s) => (s === "s1" ? "feat/a landed on master at abc1234." : null));
    try {
      assert.equal(withMergeCardNote(null, "s1", null), "From Sova's merge queue (not the user's words; nothing to answer):\nfeat/a landed on master at abc1234.");
      assert.equal(withMergeCardNote("Card c1: chose A.", "s1", null), "Card c1: chose A.\nFrom Sova's merge queue (not the user's words; nothing to answer):\nfeat/a landed on master at abc1234.");
      assert.equal(withMergeCardNote(null, "s2", null), null);
      setMergeCardNoteSource(() => {
        throw new Error("x");
      });
      assert.equal(withMergeCardNote("Card c1: chose A.", "s1", null), "Card c1: chose A.");
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
    assert.match(readFileSync(new URL("merge-readiness.ts", server), "utf8"), /nudge: async \(path, text\) => \(await import\("\.\/merge-queue\/wake"\)\)\.sendQueueWake\(path, text\)/);
    // The wake carries the "another session" marker the worktree tool's land refuses, in old chats too.
    // One name each, shared with the page (shared/senders.ts), and the worktree tool's own spelling agrees.
    assert.equal(MERGE_QUEUE_SENDER.sessionId, MERGE_QUEUE_SESSION);
    // landing.ts's NOT_TYPED regex literal spells the prefix with its brackets escaped: \[merge-queue\]
    const escaped = MERGE_QUEUE_SENT_PREFIX.replace(/[[\]]/g, (c) => `\\${c}`);
    assert.equal(escaped, "\\[merge-queue\\]");
    assert.ok(readFileSync(new URL("../../pi-config/extensions/worktrees/landing.ts", dir), "utf8").includes(escaped), "the worktree tool refuses the same prefix");
    const wake = read("wake.ts");
    assert.match(wake, /sentBySession: \{ \.\.\.MERGE_QUEUE_SENDER \}/);
  });
});
