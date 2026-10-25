import assert from "node:assert/strict";
import { test } from "node:test";
import type { OwnerConversationStatus, OwnerPerson } from "../../shared/owner";
import { builtLine, byTopic, conversationChip, conversationTabs, count, historyLine, outstandingRank, ownerTabTitle, differenceLine, factsLine, ownerHash, ownerTab, parseOwnerHash, readsHome, personLine, plainAgo, plainDate, projectChip, waitingLine } from "./owner-words";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("times read in whole words, singulars included, then a date", () => {
  assert.equal(plainAgo(ago(10_000), NOW), "just now");
  assert.equal(plainAgo(ago(MIN), NOW), "1 minute ago");
  assert.equal(plainAgo(ago(5 * MIN), NOW), "5 minutes ago");
  assert.equal(plainAgo(ago(HOUR), NOW), "1 hour ago");
  assert.equal(plainAgo(ago(3 * HOUR), NOW), "3 hours ago");
  assert.equal(plainAgo(ago(DAY), NOW), "yesterday");
  assert.equal(plainAgo(ago(3 * DAY), NOW), "3 days ago");
  assert.equal(plainAgo(ago(20 * DAY), NOW), plainDate(ago(20 * DAY), NOW));
  assert.match(plainAgo(ago(20 * DAY), NOW), /^[A-Z][a-z]{2} \d{1,2}$/);
  assert.match(plainDate("2025-03-04T12:00:00Z", NOW), /^Mar \d, 2025$/);
  // A future stamp (clock skew) and junk.
  assert.equal(plainAgo(new Date(NOW + HOUR).toISOString(), NOW), "just now");
  assert.equal(plainAgo("", NOW), "");
  assert.equal(plainAgo("nope", NOW), "");
  // None of the short forms the operator app uses.
  for (const ms of [5 * MIN, 3 * HOUR, 3 * DAY]) assert.doesNotMatch(plainAgo(ago(ms), NOW), /\d[mhd]\b/);
});

test("every count has its singular", () => {
  assert.equal(count(1, "person", "people"), "1 person");
  assert.equal(count(0, "person", "people"), "0 people");
  assert.equal(factsLine({ people: 1, decisions: 1, finished: 1, inProgress: 0 }), "Talked to 1 person · 1 decision · 1 piece of work finished");
  assert.equal(factsLine({ people: 3, decisions: 5, finished: 2, inProgress: 1 }), "Talked to 3 people · 5 decisions · 2 pieces of work finished");
  assert.equal(builtLine({ finished: 2, inProgress: 1 }), "2 pieces of work finished · 1 in progress");
  assert.equal(builtLine({ finished: 1, inProgress: 0 }), "1 piece of work finished · 0 in progress");
  assert.equal(waitingLine(1), "1 question is waiting for your answer.");
  assert.equal(waitingLine(2), "2 questions are waiting for your answer.");
});

test("chips: every status has a word, and warn is only for what waits on the owner", () => {
  assert.deepEqual(projectChip("waiting-on-you"), { word: "Waiting on you", tone: "warn" });
  assert.equal(projectChip("asking").word, "Asking questions");
  assert.equal(projectChip("building").word, "Building");
  assert.deepEqual(projectChip("quiet"), { word: "Quiet", tone: undefined });
  const all: OwnerConversationStatus[] = [
    { kind: "waiting-on", name: "Kim Lee", first: "Kim" },
    { kind: "waiting-on-you" },
    { kind: "with-operator", name: "Omar Hughes", first: "Omar" },
    { kind: "offered", count: 3 },
    { kind: "offered", count: 1 },
    { kind: "done" },
    { kind: "closed" },
  ];
  assert.deepEqual(
    all.map((s) => conversationChip(s).word),
    ["Waiting on Kim", "Waiting on you", "With Omar", "Asked 3 people", "Asked 1 person", "Finished", "Ended"],
  );
  assert.deepEqual(all.filter((s) => conversationChip(s).tone === "warn").map((s) => s.kind), ["waiting-on-you"]);
});

test("the words never on the owner page appear in no chip or line", () => {
  const banned = /\b(baton|hand-?off|holder|offer|lease|overseer|agent|model|AI|promoted?|draft(ed)?|reconcile|conflict|stakeholder|worktree|branch|merge|commit|repo|session|token|spec|workspace|roster)\b/i;
  const person = (x: Partial<OwnerPerson>): OwnerPerson => ({ name: "Kim Lee", first: "Kim", conversations: 2, waitingOnThem: false, isYou: false, ...x });
  const lines = [
    ...(["waiting-on-you", "asking", "building", "quiet"] as const).map((s) => projectChip(s).word),
    ...([{ kind: "offered", count: 2 }, { kind: "done" }, { kind: "closed" }, { kind: "waiting-on-you" }] as OwnerConversationStatus[]).map((s) => conversationChip(s).word),
    factsLine({ people: 2, decisions: 2, finished: 2, inProgress: 2 }),
    builtLine({ finished: 2, inProgress: 2 }),
    waitingLine(2),
    personLine(person({}), NOW),
    personLine(person({ lastWroteAt: ago(HOUR) }), NOW),
    differenceLine({ topic: "Pricing", between: ["Ana", "Ben"], chooser: { kind: "you" } }),
  ];
  for (const l of lines) assert.doesNotMatch(l, banned, l);
});

test("who we've talked to: conversations, then when they last wrote or that they haven't", () => {
  const p: OwnerPerson = { name: "Kim Lee", first: "Kim", conversations: 1, waitingOnThem: true, isYou: false };
  assert.equal(personLine(p, NOW), "1 conversation · hasn't replied yet");
  assert.equal(personLine({ ...p, conversations: 3, lastWroteAt: ago(2 * HOUR) }, NOW), "3 conversations · last wrote 2 hours ago");
});

test("different answers name who chooses: a person, the owner, or the operator", () => {
  const base = { topic: "the schedule", between: ["Ana", "Ben"] };
  assert.equal(differenceLine({ ...base, chooser: { kind: "person", name: "Cem Kaya", first: "Cem" } }), "Ana and Ben gave different answers about the schedule. We've asked Cem to choose.");
  assert.equal(differenceLine({ ...base, chooser: { kind: "you" } }), "Ana and Ben gave different answers about the schedule. We've asked you to choose.");
  assert.equal(differenceLine({ ...base, chooser: { kind: "operator", name: "Omar Hughes", first: "Omar" } }), "Ana and Ben gave different answers about the schedule. Omar will choose.");
  assert.equal(differenceLine({ topic: "fees", between: ["Ana"], chooser: { kind: "you" } }), "Ana gave different answers about fees. We've asked you to choose.");
});

test("decisions group by topic in first-seen order, keeping each group's order", () => {
  const g = byTopic([
    { topic: "B", n: 1 },
    { topic: "A", n: 2 },
    { topic: "B", n: 3 },
  ]);
  assert.deepEqual(
    g.map((x) => [x.topic, x.rows.map((r) => r.n)]),
    [
      ["B", [1, 3]],
      ["A", [2]],
    ],
  );
});

test("the hash route round-trips and anything malformed is Home", () => {
  for (const r of [{ kind: "home" }, { kind: "project", id: "q_abcd2345" }, { kind: "conversation", id: "k_zz99aa22" }, { kind: "assistant" }, { kind: "requests" }] as const) {
    assert.deepEqual(parseOwnerHash(ownerHash(r)), r);
  }
  for (const bad of ["", "#", "#p/", "#p/k_abcd2345", "#c/q_abcd2345", "#p/q_ABCD2345", "#p/q_abcd234", "#p/q_abcd23456", "#p/q_abcd1345", "#x/q_abcd2345", "#p/q_abcd2345/x", "#r/", "#rr", "#R", "#a/r"]) {
    assert.deepEqual(parseOwnerHash(bad), { kind: "home" }, bad);
  }
});

test("the requests tab is #r, and a project or a conversation keeps Home highlighted", () => {
  assert.deepEqual(parseOwnerHash("#r"), { kind: "requests" });
  assert.equal(ownerHash({ kind: "requests" }), "#r");
  assert.equal(ownerTab({ kind: "project", id: "q_abcd2345" }), "home");
  assert.equal(ownerTab({ kind: "conversation", id: "k_abcd2345" }), "home");
  assert.equal(ownerTab({ kind: "home" }), "home");
  assert.equal(ownerTab({ kind: "assistant" }), "assistant");
  assert.equal(ownerTab({ kind: "requests" }), "requests");
});

test("Home, the Assistant and Requests are one family: they read the Home answer; a project or a conversation does not", () => {
  assert.deepEqual(
    (["home", "assistant", "requests"] as const).map((kind) => readsHome({ kind })),
    [true, true, true],
  );
  assert.equal(readsHome({ kind: "project", id: "q_abcd2345" }), false);
  assert.equal(readsHome({ kind: "conversation", id: "k_abcd2345" }), false);
});

test("Home's Conversations: Outstanding is on you, then someone else, then the team, newest first within each; History the most recently ended first", () => {
  const row = (id: string, status: OwnerConversationStatus, since: string, project = "q_a", endedAt?: string) => ({ id, status, since, project, ...(endedAt ? { endedAt } : {}) });
  const rows = [
    row("team", { kind: "with-operator", name: "Omar", first: "Omar" }, "2026-10-05"),
    row("bob-old", { kind: "waiting-on", name: "Bob B", first: "Bob" }, "2026-10-01"),
    row("you-old", { kind: "waiting-on-you" }, "2026-10-02"),
    row("offer", { kind: "offered", count: 3 }, "2026-10-04"),
    row("you-new", { kind: "planning" }, "2026-10-06", "q_b"),
    row("done", { kind: "done" }, "2026-10-01", "q_a", "2026-10-03"),
    row("ended", { kind: "closed" }, "2026-10-01", "q_b", "2026-10-07"),
    row("agreed", { kind: "plan-agreed" }, "2026-10-01", "q_a", "2026-10-02"),
  ];
  const all = conversationTabs(rows);
  assert.deepEqual(all.outstanding.map((r) => r.id), ["you-new", "you-old", "offer", "bob-old", "team"]);
  assert.deepEqual(all.history.map((r) => r.id), ["ended", "done", "agreed"]);
  const b = conversationTabs(rows, "q_b");
  assert.deepEqual([b.outstanding.map((r) => r.id), b.history.map((r) => r.id)], [["you-new"], ["ended"]]);
  assert.equal(outstandingRank({ kind: "done" }), null);
  assert.equal(historyLine({ kind: "closed" }), "ended");
  assert.equal(historyLine({ kind: "done" }), "finished");
});

test("the browser tab's title leads with how many conversations wait on the owner", () => {
  assert.equal(ownerTabTitle("Acme Archery", 0), "Acme Archery");
  assert.equal(ownerTabTitle("Acme Archery", 2), "(2) Acme Archery");
});
