import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SovaConfirmItem } from "./protocol";
import {
  applyCardCall,
  CARD_TOOL,
  CardError,
  cardsNote,
  changeLine,
  clickCardId,
  clickItems,
  foldCards,
  itemsClick,
  matchCardClick,
  nextCardId,
  normalizeCard,
  normalizeCardDetails,
  optionClick,
  safeHttpsUrl,
  type CardDetails,
  type CardPrepared,
  type OverseerCard,
} from "./overseer-card";

const NOW = "2026-09-30T10:00:00.000Z";
const LATER = "2026-09-30T10:05:00.000Z";

const session = (id: string, extra: Partial<Extract<SovaConfirmItem, { kind: "session" }>> = {}): SovaConfirmItem & { default?: string } => ({ kind: "session", id, title: `Title ${id}`, ...extra });
const todo = (id: string): SovaConfirmItem => ({ kind: "todo", id, text: `Do ${id}` });
const idea = (id: string): SovaConfirmItem => ({ kind: "idea", id, title: `Idea ${id}` });

/** Applies calls in order over a growing card list, like the fold over tool results would. */
function run(calls: { input: unknown; prepared?: CardPrepared; now?: string }[], start: OverseerCard[] = []) {
  let cards = start;
  const outs: ReturnType<typeof applyCardCall>[] = [];
  for (const c of calls) {
    const out = applyCardCall(cards, c.input, { now: c.now ?? NOW, ...(c.prepared ? { prepared: c.prepared } : {}) });
    outs.push(out);
    cards = foldCards([...cards.map((card) => entry({ v: 1, card, changes: [], line: "" })), entry(out.details)]);
  }
  return { cards, outs };
}
const entry = (details: unknown, extra: { isError?: boolean; toolName?: string } = {}) => ({
  type: "message",
  message: { role: "toolResult", toolName: extra.toolName ?? CARD_TOOL, toolCallId: "t", isError: extra.isError ?? false, details },
});

const archiveCard = {
  input: {
    ops: [
      {
        op: "create",
        title: "Archive these?",
        detail: "Both are merged.",
        options: [{ label: "Archive All", reply: "Archive the 2 sessions listed" }, { label: "Keep", tone: "danger" }, { label: "Open s1", link: { session: "s1" } }],
        items: { sessions: ["s1", "s2"], todos: ["td_1"] },
        choices: ["Archive", "Keep"],
        recommendation: { option: "a", why: "Nothing is running." },
      },
    ],
  },
  prepared: { items: [session("s1", { default: "a" } as never), session("s2"), todo("td_1")], hrefs: [undefined, undefined, "#/s/%2Fp%2Fs1.jsonl"] },
};

describe("create", () => {
  test("ids, item numbers in display order, answer letters skip links, and no terminate", () => {
    const { cards, outs } = run([archiveCard]);
    const c = cards[0]!;
    assert.equal(c.id, "c_1");
    assert.equal(c.phase, "open");
    // Display order: todos before sessions; numbered 1..N once.
    assert.deepEqual(c.items.map((it) => `${it.n}:${it.id}`), ["1:td_1", "2:s1", "3:s2"]);
    assert.equal(c.items[1]!.default, "a");
    assert.equal(c.options[2]!.href, "#/s/%2Fp%2Fs1.jsonl");
    assert.equal(optionClick(c, "a"), "c_1 a: Archive the 2 sessions listed");
    assert.equal(optionClick(c, "b"), "c_1 b: Keep");
    assert.equal(optionClick(c, "c"), null, "a link option has no letter");
    assert.equal(outs[0]!.details.line, "created");
    assert.ok(!("terminate" in outs[0]!), "the tool's outcome never ends the turn");
    assert.match(outs[0]!.text, /^c_1 "Archive these\?" · open · v1 · created/);
    assert.match(outs[0]!.text, /options: a\. Archive All \("Archive the 2 sessions listed"\) · b\. Keep/);
    assert.match(outs[0]!.text, /2\. \[Title s1\]\(sova:\/\/s\/s1\) \(s1\) \[default a\]/);
    assert.match(outs[0]!.text, /It stays open until you record it/);
  });

  test("the next id is one past the highest on the branch, never reused", () => {
    const { cards } = run([archiveCard, archiveCard]);
    assert.deepEqual(cards.map((c) => c.id), ["c_1", "c_2"]);
    assert.equal(nextCardId([{ ...cards[0]!, id: "c_9" }]), "c_10");
  });

  test("refusals name the field, and nothing changes", () => {
    const bad = (input: unknown, re: RegExp, prepared?: CardPrepared) => assert.throws(() => applyCardCall([], input, { now: NOW, ...(prepared ? { prepared } : {}) }), (e: unknown) => e instanceof CardError && re.test(e.message));
    bad({ op: "create" }, /wrap ops in \{ops: \[\.\.\.\]\}/);
    bad({ ops: [{ op: "create", title: "x", options: [{ label: "A" }] }, { op: "get" }] }, /create stands alone/);
    bad({ ops: [{ op: "create", question: "x", options: [{ label: "A" }] }] }, /unknown field "question" \(did you mean "title"\?\)/);
    bad({ ops: [{ op: "close" }] }, /use \{op: "drop", reason\}/);
    bad({ ops: [{ op: "create", title: "x", options: [{ label: "Go", link: { url: "x" } }] }] }, /answer option/, { items: [], hrefs: ["https://example.com/"] });
    bad({ ops: [{ op: "create", title: "x", options: [{ label: "Go", link: {}, reply: "r" }] }] }, /takes no reply/, { items: [], hrefs: ["#/usage"] });
    bad({ ops: [{ op: "create", title: "x", options: [{ label: "A" }], choices: ["One", "Two"] }] }, /needs items/, { items: [], hrefs: [] });
    bad({ ops: [{ op: "create", title: "x", options: [{ label: "A" }], choices: ["One"] }] }, /2 to 4 labels/, { items: [todo("t")], hrefs: [] });
    bad({ ops: [{ op: "create", title: "x", options: [{ label: "A" }] }] }, /has a default, but neither it nor the card has choices/, { items: [{ ...todo("t"), default: "a" }], hrefs: [] });
    bad({ ops: [{ op: "create", title: "x", options: [{ label: "A" }], recommendation: { option: "c", why: "w" } }] }, /not an answer option's letter/, { items: [], hrefs: [] });
    bad({ ops: [{ op: "create", title: "x", options: [1, 2, 3, 4, 5].map((i) => ({ label: `O${i}` })) }] }, /at most 4 answer options/, { items: [], hrefs: [] });
  });

  test("replaces supersedes an open card in the same result, and only an open one", () => {
    const { cards, outs } = run([archiveCard, { input: { ops: [{ op: "create", title: "Smaller", options: [{ label: "Go" }], replaces: "c_1" }] }, prepared: { items: [], hrefs: [] } }]);
    const c1 = cards.find((c) => c.id === "c_1")!;
    assert.equal(c1.phase, "superseded");
    assert.equal(c1.supersededBy, "c_2");
    assert.equal(outs[1]!.details.closed?.id, "c_1");
    assert.equal(outs[1]!.details.card?.replaces, "c_1");
    assert.equal(outs[1]!.details.line, "created, replaces c_1");
    assert.throws(() => applyCardCall(cards, { ops: [{ op: "create", title: "Again", options: [{ label: "Go" }], replaces: "c_1" }] }, { now: NOW, prepared: { items: [], hrefs: [] } }), /c_1 is superseded, not open/);
  });
});

describe("answers: only the model's ops move a card", () => {
  test("an option answer closes it; a link letter is never an answer", () => {
    const { cards } = run([archiveCard]);
    assert.throws(() => applyCardCall(cards, { card: "c_1", ops: [{ op: "answer", text: "open it", option: "c" }] }, { now: NOW }), /a link option is never an answer/);
    const out = applyCardCall(cards, { card: "c_1", ops: [{ op: "answer", text: "c_1 a: Archive the 2 sessions listed", option: "a" }] }, { now: LATER });
    assert.equal(out.details.card?.phase, "answered");
    assert.deepEqual(out.details.card?.answer, { text: "c_1 a: Archive the 2 sessions listed", option: "a", by: "user", at: LATER });
    assert.equal(out.details.card?.rev, 2);
    assert.equal(out.details.line, "answered a");
  });

  test("per item: a partial answer keeps it open, the last item closes it", () => {
    const { cards } = run([archiveCard, { input: { ops: [{ op: "answer", text: "1 keep", items: { "1": "b" } }] } }]);
    const c = cards[0]!;
    assert.equal(c.phase, "open");
    assert.deepEqual(c.items[0]!.decided, { choice: "b", text: "Keep", by: "user", at: NOW });
    assert.match(cardsNote(cards)!, /open \(1 of 3 items decided\)/);
    const done = applyCardCall(cards, { ops: [{ op: "answer", text: "archive the others, and s2 only after lunch", items: { "2": "a", "3": "after lunch" } }] }, { now: NOW });
    assert.equal(done.details.card?.phase, "answered");
    assert.deepEqual(done.details.card?.items[2]!.decided, { text: "after lunch", by: "user", at: NOW });
    assert.equal(done.details.line, "2, 3 decided · answered");
    assert.throws(() => applyCardCall(cards, { ops: [{ op: "answer", text: "x", items: { "9": "a" } }] }, { now: NOW }), /has no item 9 \(it has 1\.\.3\)/);
    assert.throws(() => applyCardCall(cards, { ops: [{ op: "answer", text: "x", items: { "1": "z" } }] }, { now: NOW }), /"z" is not one of item 1's choice letters \(a\. Archive, b\. Keep\)/);
  });

  test("accept takes the recommended option, or each named item's default", () => {
    const { cards } = run([archiveCard]);
    const opt = applyCardCall(cards, { ops: [{ op: "accept" }] }, { now: NOW });
    assert.deepEqual(opt.details.card?.answer, { text: "Archive All", option: "a", by: "accepted-recommendation", at: NOW });
    const items = applyCardCall(cards, { ops: [{ op: "accept", items: [2] }] }, { now: NOW });
    assert.equal(items.details.card?.phase, "open");
    assert.equal(items.details.card?.items[1]!.decided?.by, "accepted-recommendation");
    assert.throws(() => applyCardCall(cards, { ops: [{ op: "accept", items: [1] }] }, { now: NOW }), /item 1 has no default/);
  });

  test("drop and reopen; a superseded card is never reopened; several open cards need a name", () => {
    const { cards } = run([archiveCard, { input: { ops: [{ op: "drop", reason: "The user merged them by hand." }] } }]);
    assert.equal(cards[0]!.phase, "dropped");
    assert.equal(cards[0]!.droppedWhy, "The user merged them by hand.");
    assert.equal(cardsNote(cards), undefined, "a closed card leaves the note");
    const back = run([{ input: { card: "c_1", ops: [{ op: "reopen" }] } }], cards).cards;
    assert.equal(back[0]!.phase, "open");
    assert.equal(back[0]!.droppedWhy, undefined);
    const two = run([archiveCard, archiveCard]).cards;
    assert.throws(() => applyCardCall(two, { ops: [{ op: "drop", reason: "x" }] }, { now: NOW }), /card is required while several are open \(c_1 "Archive these\?", c_2/);
    assert.throws(() => applyCardCall(two, { card: "c_7", ops: [{ op: "get" }] }, { now: NOW }), /No card c_7/);
  });

  test("a call is atomic: a bad op after a good one changes nothing", () => {
    const { cards } = run([archiveCard]);
    assert.throws(() => applyCardCall(cards, { ops: [{ op: "answer", text: "1 keep", items: { "1": "b" } }, { op: "drop" }] }, { now: NOW }), /reason is required/);
    assert.equal(cards[0]!.items[0]!.decided, undefined);
  });
});

describe("fold and normalize", () => {
  test("newest valid snapshot per id; errors, malformed details and legacy sova_confirm are never state", () => {
    const { outs } = run([archiveCard, { input: { ops: [{ op: "answer", text: "b", option: "b" }] } }]);
    const branch = [
      entry(outs[0]!.details),
      entry({ ...outs[1]!.details, card: { ...outs[1]!.details.card, phase: "bogus" } }),
      entry(outs[1]!.details, { isError: true }),
      entry({ title: "Old card", options: [{ label: "Yes" }] }, { toolName: "sova_confirm" }),
    ];
    assert.equal(foldCards(branch)[0]!.phase, "open");
    assert.equal(foldCards([...branch, entry(outs[1]!.details)])[0]!.phase, "answered");
    assert.deepEqual(foldCards("nope" as never), []);
  });

  test("normalizeCard enforces each state's reason, item numbering and real letters", () => {
    const c = run([archiveCard]).cards[0]!;
    assert.deepEqual(normalizeCard(structuredClone(c)), c);
    assert.equal(normalizeCard({ ...c, phase: "answered" }), undefined, "answered without an answer");
    assert.equal(normalizeCard({ ...c, phase: "dropped" }), undefined, "dropped without why");
    assert.equal(normalizeCard({ ...c, items: [{ ...c.items[0]!, n: 2 }] }), undefined, "items numbered from 1");
    assert.equal(normalizeCard({ ...c, items: [{ ...c.items[0]!, default: "d" }, ...c.items.slice(1)] }), undefined, "a default that is no choice");
    assert.equal(normalizeCard({ ...c, options: [{ label: "x", href: "javascript:alert(1)" }] }), undefined, "no other scheme");
    assert.equal(normalizeCard({ ...c, extra: 1 })?.["extra" as never], undefined, "unknown keys are dropped, not kept");
    assert.equal(normalizeCardDetails({ v: 2, changes: [], line: "" }), undefined);
    assert.equal(normalizeCardDetails({ v: 1, changes: [], line: "", closed: c }), undefined, "closed is always superseded");
  });

  test("https only, no credentials", () => {
    assert.equal(safeHttpsUrl("https://github.com/x/y/pull/1"), "https://github.com/x/y/pull/1");
    assert.equal(safeHttpsUrl("http://example.com"), null);
    assert.equal(safeHttpsUrl("https://u:p@example.com/"), null);
    assert.equal(safeHttpsUrl("javascript:alert(1)"), null);
  });
});

describe("the note and the change line", () => {
  test("the note lists every open card with handles; after compaction it says so", () => {
    const { cards } = run([archiveCard]);
    const note = cardsNote(cards)!;
    assert.match(note, /^\[cards\] Open cards in this conversation\./);
    assert.match(note, /record it with sova_card \(answer with their words, accept for "your recommendation"\)/);
    assert.match(note, /c_1 "Archive these\?" · open · v1/);
    assert.match(note, /per-item choices: a\. Archive · b\. Keep/);
    assert.match(note, /1\. td_1 · Do td_1/);
    assert.match(note, /rec: a — Archive All: Nothing is running\./);
    assert.match(note, /links \(they open a page, never an answer\): Open s1 → #\/s\//);
    assert.match(cardsNote(cards, true)!, /^\[cards\] The context was just compacted\./);
    assert.equal(cardsNote([]), undefined);
  });

  test("changeLine", () => {
    assert.equal(changeLine([{ kind: "created" }]), "created");
    assert.equal(changeLine([{ kind: "answered", items: [1, 3] }]), "1, 3 decided");
    assert.equal(changeLine([{ kind: "accepted", option: "b", complete: true }]), "accepted b");
    assert.equal(changeLine([]), "");
  });
});

describe("clicks compose a message, and only that exact message matches", () => {
  const c = run([archiveCard]).cards[0]!;
  test("option clicks and per-item Apply recompose byte for byte", () => {
    assert.deepEqual(matchCardClick(c, "c_1 a: Archive the 2 sessions listed"), { card: "c_1", option: "a" });
    const apply = itemsClick(c, { 3: "a", 1: "b" })!;
    assert.equal(apply, "c_1: 1b Keep, 3a Archive");
    assert.deepEqual(matchCardClick(c, apply), { card: "c_1", items: { 1: "b", 3: "a" } });
    assert.deepEqual(clickItems(c, { card: "c_1", items: { 1: "b", 3: "a" } }).map((it) => it.id), ["td_1", "s2"]);
    assert.equal(clickItems(c, { card: "c_1", option: "a" }).length, 3);
    assert.equal(clickCardId(apply), "c_1");
    assert.equal(clickCardId("c_1 a: x"), "c_1");
  });
  test("typed text that looks like a click, but isn't one, matches nothing", () => {
    for (const typed of ["c_1 a", "c_1 a: archive them", "c_1 c: Open s1", "yes", "c_1: 1b keep", "c_1: 1b Keep, 1a Archive", "c_1: 4a Archive", "c_2 a: Archive the 2 sessions listed"]) {
      assert.equal(matchCardClick(c, typed), null, typed);
    }
  });
});

describe("per-row choices", () => {
  // c_28's shape: one row with a worktree to clean up, one without, and no answer option at all.
  const cleanup = ["Clean Up & Archive", "Archive Only", "Keep"];
  const perRow = {
    input: { ops: [{ op: "create", title: "Archive these?", choices: ["Archive", "Keep"], items: { sessions: ["s1", "s2"] } }] },
    prepared: { items: [session("s1", { default: "a", choices: cleanup } as never), session("s2", { default: "b" } as never)], hrefs: [] },
  };
  const card = () => run([perRow]).cards[0]!;

  test("a row's own choices replace the card's for that row only; no answer option is needed", () => {
    const c = card();
    assert.deepEqual(c.options, []);
    assert.deepEqual(c.items[0]!.choices, cleanup.map((label) => ({ label })));
    assert.equal(c.items[1]!.choices, undefined, "the second row takes the card's list");
    assert.deepEqual(c.choices, [{ label: "Archive" }, { label: "Keep" }]);
  });

  test("Apply sends each row's own letter and label, and matches exactly; a letter past its row's list is no click", () => {
    const c = card();
    const apply = itemsClick(c, { 1: "c", 2: "a" })!;
    assert.equal(apply, "c_1: 1c Keep, 2a Archive");
    assert.deepEqual(matchCardClick(c, apply), { card: "c_1", items: { 1: "c", 2: "a" } });
    assert.equal(itemsClick(c, { 2: "c" }), null, "row 2 has only a and b");
    for (const typed of ["c_1: 2c Keep", "c_1: 1c Archive", "c_1: 1a Archive", "c_1: 1a Clean Up & Archive, 2b Archive"]) assert.equal(matchCardClick(c, typed), null, typed);
    assert.deepEqual(matchCardClick(c, "c_1: 1a Clean Up & Archive, 2b Keep"), { card: "c_1", items: { 1: "a", 2: "b" } });
  });

  test("answer and accept read each row's own list", () => {
    const { cards } = run([perRow, { input: { card: "c_1", ops: [{ op: "answer", text: "1c, 2a", items: { "1": "c", "2": "a" } }] } }]);
    assert.deepEqual(cards[0]!.items.map((it) => [it.decided?.choice, it.decided?.text]), [["c", "Keep"], ["a", "Archive"]]);
    assert.equal(cards[0]!.phase, "answered");
    assert.throws(() => run([perRow, { input: { card: "c_1", ops: [{ op: "answer", text: "2c", items: { "2": "c" } }] } }]), /"c" is not one of item 2's choice letters \(a\. Archive, b\. Keep\)/);
    const accepted = run([perRow, { input: { card: "c_1", ops: [{ op: "accept" }] } }]).cards[0]!;
    assert.deepEqual(accepted.items.map((it) => it.decided?.text), ["Clean Up & Archive", "Keep"]);
  });

  test("the echo and the note list each row's own choices", () => {
    const { cards, outs } = run([perRow]);
    const note = cardsNote(cards)!;
    assert.match(note, /per-item choices \(items without their own\): a\. Archive · b\. Keep/);
    assert.match(note, /1\. \[Title s1\]\(sova:\/\/s\/s1\) \(s1\) \[choices a\. Clean Up & Archive · b\. Archive Only · c\. Keep\] \[default a\]/);
    assert.match(note, /2\. \[Title s2\]\(sova:\/\/s\/s2\) \(s2\) \[default b\]$/m);
    assert.match(note, /each item's letter one of its own choices/);
    assert.match(outs[0]!.text, /\[choices a\. Clean Up & Archive/);
  });

  test("refusals: a default outside its row's list, a row with no choices on a card without options, a bad own list", () => {
    const bad = (prepared: CardPrepared, re: RegExp, input: unknown = perRow.input) =>
      assert.throws(() => applyCardCall([], input, { now: NOW, prepared }), (e: unknown) => e instanceof CardError && re.test(e.message));
    bad({ items: [session("s1", { default: "c" } as never)], hrefs: [] }, /s1's default "c" is not one of its choice letters \(a\. Archive, b\. Keep\)/);
    bad({ items: [session("s1", { choices: ["Only"] } as never)], hrefs: [] }, /s1's choices takes 2 to 4 labels \(this has 1\)/);
    bad({ items: [session("s1", { choices: ["Go", "go"] } as never)], hrefs: [] }, /s1's choices: each choice needs its own label/);
    bad({ items: [session("s1", { choices: ["A", "B"] } as never), todo("t")], hrefs: [] }, /choices for every item/, { ops: [{ op: "create", title: "x", items: {} }] });
    bad({ items: [], hrefs: [] }, /give at least one answer option/, { ops: [{ op: "create", title: "x" }] });
  });

  test("a stored v1 card from before per-row choices reads unchanged, and its legacy Apply option stays a live answer", () => {
    // As the old code wrote it: card-level choices only, and the forced "a. Apply" answer option.
    const old = {
      v: 1,
      changes: [{ kind: "created" }],
      line: "created",
      card: {
        id: "c_26",
        title: "Tidy these?",
        options: [{ label: "Apply" }],
        items: [
          { kind: "session", id: "s1", title: "One", n: 1, default: "a" },
          { kind: "todo", id: "td_1", text: "Do it", n: 2, default: "b" },
        ],
        choices: [{ label: "Archive" }, { label: "Keep" }],
        phase: "open",
        rev: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    };
    const d = normalizeCardDetails(JSON.parse(JSON.stringify(old)))!;
    assert.deepEqual(d.card, old.card);
    const [c] = foldCards([entry(old)]);
    assert.equal(optionClick(c!, "a"), "c_26 a: Apply");
    assert.deepEqual(matchCardClick(c!, "c_26 a: Apply"), { card: "c_26", option: "a" });
    assert.equal(itemsClick(c!, { 1: "b", 2: "a" }), "c_26: 1b Keep, 2a Archive");
    assert.deepEqual(matchCardClick(c!, "c_26: 1b Keep, 2a Archive"), { card: "c_26", items: { 1: "b", 2: "a" } });
  });

  test("normalize checks a row's default and decided choice against its own list", () => {
    const c = card();
    assert.deepEqual(normalizeCard(structuredClone(c)), c);
    assert.ok(normalizeCard({ ...c, items: [{ ...c.items[0]!, default: "c" }, c.items[1]] }), "c is row 1's third choice");
    assert.equal(normalizeCard({ ...c, items: [c.items[0], { ...c.items[1]!, default: "c" }] }), undefined, "row 2 takes the card's two");
    assert.equal(normalizeCard({ ...c, items: [{ ...c.items[0]!, choices: [{ label: "Only" }] }, c.items[1]] }), undefined, "an own list of one");
  });
});

describe("create with card", () => {
  const open = { input: { ops: [{ op: "create", title: "First", options: [{ label: "Go" }] }] }, prepared: { items: [], hrefs: [] } };
  test("card alone, or equal to replaces, is read as replaces", () => {
    for (const ops of [[{ op: "create", title: "Second", options: [{ label: "Go" }] }], [{ op: "create", title: "Second", options: [{ label: "Go" }], replaces: "c_1" }]]) {
      const { cards, outs } = run([open, { input: { card: "c_1", ops }, prepared: { items: [], hrefs: [] } }]);
      assert.equal(outs[1]!.details.card?.id, "c_2");
      assert.equal(outs[1]!.details.card?.replaces, "c_1");
      assert.equal(cards.find((c) => c.id === "c_1")!.phase, "superseded");
    }
  });
  test("card naming a different card than replaces refuses", () => {
    assert.throws(
      () => run([open, open, { input: { card: "c_1", ops: [{ op: "create", title: "x", options: [{ label: "Go" }], replaces: "c_2" }] }, prepared: { items: [], hrefs: [] } }]),
      /card is c_1 and replaces is c_2/,
    );
  });
});

describe("staleness in the note", () => {
  test("an open card whose listed session was active after it was raised is marked; the card itself is unchanged", () => {
    const { cards } = run([archiveCard]);
    const activity: Record<string, string> = { s1: LATER, s2: "2026-09-30T09:00:00.000Z" };
    const note = cardsNote(cards, false, (id) => activity[id])!;
    assert.match(note, /c_1 "Archive these\?"[\s\S]*\n {2}may be stale: s1 active since 2026-09-30T10:05:00\.000Z/);
    assert.doesNotMatch(note, /may be stale: s2/, "activity before the card was raised");
    assert.match(note, /check that session before acting on the card/);
    assert.doesNotMatch(cardsNote(cards, false, () => undefined)!, /may be stale/);
    assert.equal(cards[0]!.phase, "open");
  });
});

// A worked example is a second implementation of its rule: pin the details shape the server writes.
test("details are v1 with the card snapshot and a line", () => {
  const d: CardDetails = run([archiveCard]).outs[0]!.details;
  assert.equal(d.v, 1);
  assert.deepEqual(normalizeCardDetails(JSON.parse(JSON.stringify(d))), d);
  assert.equal(idea("x").kind, "idea");
});

describe("org, folder and standalone project rows (§app.overseer/org-project-add)", () => {
  const rows: SovaConfirmItem[] = [
    { kind: "project", id: "prj_solo0001", name: "Solo" },
    { kind: "folder", id: "/home/u/code/app", asked: "/home/u/code/app/web", orgId: "org_a", orgName: "Acme", name: "App" },
    { kind: "folder", id: "/home/u/code/tool" },
    { kind: "org", id: "org_a", name: "Acme" },
  ];
  test("they survive the fold, in display order: orgs, folders, then projects", () => {
    const created = applyCardCall([], { ops: [{ op: "create", title: "Add these?", options: [{ label: "Add" }] }] }, { now: "2026-10-04T10:00:00.000Z", prepared: { items: rows, hrefs: [], clickOnly: true } }).details;
    const folded = foldCards([{ type: "message", message: { role: "toolResult", toolCallId: "k1", toolName: CARD_TOOL, details: created } }]);
    assert.deepEqual(folded[0]!.items.map((i) => [i.kind, i.id]), [["org", "org_a"], ["folder", "/home/u/code/app"], ["folder", "/home/u/code/tool"], ["project", "prj_solo0001"]]);
    const note = cardsNote(folded, false, () => undefined);
    assert.match(note ?? "", /organization Acme \(org_a\)/);
    assert.match(note ?? "", /folder \/home\/u\/code\/app \(the checkout root of \/home\/u\/code\/app\/web\), named App, into Acme \(org_a\)/);
    assert.match(note ?? "", /folder \/home\/u\/code\/tool, standalone/);
    assert.match(note ?? "", /project Solo \(prj_solo0001\), in no organization/);
  });
  test("a project with an org id but no org name (or the reverse) is malformed", () => {
    const bad = applyCardCall([], { ops: [{ op: "create", title: "t", options: [{ label: "x" }] }] }, { now: "2026-10-04T10:00:00.000Z", prepared: { items: [{ kind: "project", id: "p", name: "P", orgId: "org_a" } as SovaConfirmItem], hrefs: [], clickOnly: true } }).details;
    assert.equal(foldCards([{ type: "message", message: { role: "toolResult", toolCallId: "k1", toolName: CARD_TOOL, details: bad } }]).length, 0);
  });
});
