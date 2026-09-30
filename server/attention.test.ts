// Run: npx tsx --test server/attention.test.ts (or npm test). Pure: no files, no runtime.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
import { type AttentionRow, blockerKey, buildDigest, DIGEST_MAX, openQuestionsText, sessionItems, STALE_MS, whereOf, workerErrorTime } from "./attention";
import { workerErrorTimesOf } from "./live";

const NOW = Date.parse("2026-09-25T12:00:00.000Z");

function summary(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    path: `/s/${id}.jsonl`,
    cwd: "/home/u/proj",
    title: `Session ${id}`,
    createdAt: "2026-09-25T10:00:00.000Z",
    lastActiveAt: new Date(NOW - 60_000).toISOString(),
    model: "a/b",
    live: null,
    busy: false,
    origin: "web",
    archived: false,
    ...over,
  };
}
const row = (s: SessionSummary, over: Partial<AttentionRow> = {}): AttentionRow => ({ summary: s, dialogs: [], queued: 0, failedWorkers: 0, activitySince: 0, ...over });
const kinds = (r: AttentionRow) => sessionItems(r, NOW, "/home/u").map((i) => `${i.tier}:${i.kind}`);

describe("attention: which signal lands in which tier", () => {
  test("blockers are act: a hosted pending dialog (titles in detail), a live-record needs-input, an error, a failed worker", () => {
    const dialog = sessionItems(row(summary("d"), { dialogs: ["Overwrite file?", "Pick one"] }), NOW);
    assert.deepEqual(dialog.map((i) => `${i.tier}:${i.kind}`), ["act:needs-input"]);
    assert.match(dialog[0]!.detail!, /Overwrite file\?; Pick one/);
    assert.deepEqual(kinds(row(summary("n", { activity: { state: "needs-input" } }))), ["act:needs-input"]);
    const err = sessionItems(row(summary("e", { activity: { state: "error", error: "rate limited" } })), NOW);
    assert.deepEqual(err.map((i) => `${i.tier}:${i.kind}:${i.detail}`), ["act:error:rate limited"]);
    assert.deepEqual(kinds(row(summary("w"), { failedWorkers: 2 })), ["act:worker-error"]);
  });

  test("an errored last turn from the file (turnError) is act:error, its message the detail, dated by the reply", () => {
    const err = sessionItems(row(summary("f", { turnError: { message: "529 overloaded" } }), { lastReplyAt: NOW - 7000 }), NOW);
    assert.deepEqual(err.map((i) => `${i.tier}:${i.kind}:${i.detail}`), ["act:error:529 overloaded"]);
    assert.equal(err[0]!.since, NOW - 7000);
    assert.deepEqual(sessionItems(row(summary("f", { turnError: {} })), NOW).map((i) => i.detail), ["The last turn stopped with an error."]);
    // A closed session has no live record: the file is the only source, and it is enough.
    assert.deepEqual(kinds(row(summary("c", { turnError: {}, live: null }))), ["act:error"]);
    // An archived one comes back for it, like any blocker.
    assert.deepEqual(kinds(row(summary("a", { turnError: {}, archived: true }))), ["act:error"]);
  });

  test("the file's error and a live error state are ONE error item, the file's message first", () => {
    const both = sessionItems(row(summary("b", { turnError: { message: "from the file" }, activity: { state: "error", error: "from presence" } })), NOW);
    assert.deepEqual(both.map((i) => `${i.kind}:${i.detail}`), ["error:from the file"]);
    const noMsg = sessionItems(row(summary("b", { turnError: {}, activity: { state: "error", error: "from presence" } })), NOW);
    assert.deepEqual(noMsg.map((i) => `${i.kind}:${i.detail}`), ["error:from presence"]);
  });

  test("a pending dialog and a needs-input record are ONE needs-input item, not two", () => {
    assert.deepEqual(kinds(row(summary("x", { activity: { state: "needs-input" } }), { dialogs: ["Q"] })), ["act:needs-input"]);
  });

  test("decide: finished-unseen, an idle draft, idle queued input; a running session's draft is not a decision yet", () => {
    assert.deepEqual(kinds(row(summary("f", { unread: true, outlineNow: "done the thing" }))), ["decide:finished"]);
    assert.deepEqual(kinds(row(summary("dr", { hasDraft: true }))), ["decide:draft"]);
    assert.deepEqual(kinds(row(summary("q"), { queued: 2 })), ["decide:queued"]);
    assert.deepEqual(kinds(row(summary("busy", { busy: true, hasDraft: true }))), ["fyi:working"]);
  });

  test("fyi: running (busy, working activity, or working subagents), context ≥85%, stale web sessions", () => {
    assert.deepEqual(kinds(row(summary("b", { busy: true }))), ["fyi:working"]);
    assert.deepEqual(kinds(row(summary("a", { activity: { state: "working" } }))), ["fyi:working"]);
    assert.deepEqual(kinds(row(summary("sw", { workers: { working: 2, total: 3 } }))), ["fyi:working"]);
    assert.deepEqual(kinds(row(summary("c", { context: { tokens: 90, window: 100 } }))), ["fyi:context-full"]);
    assert.deepEqual(kinds(row(summary("c2", { context: { tokens: 84, window: 100 } }))), []);
    const old = new Date(NOW - STALE_MS - 1000).toISOString();
    assert.deepEqual(kinds(row(summary("st", { lastActiveAt: old }))), ["fyi:stale"]);
    // Stale is for Sova's own sessions only, and never for one with a draft or open in a terminal.
    assert.deepEqual(kinds(row(summary("ext", { lastActiveAt: old, origin: "external" }))), []);
    assert.deepEqual(kinds(row(summary("tui", { lastActiveAt: old, live: { pid: 1, status: "Idle" } }))), []);
  });

  test("never listed: the Overseer itself, subagents' own sessions; an archived session only for a blocker", () => {
    assert.deepEqual(kinds(row(summary("o", { overseer: true, activity: { state: "error" } }))), []);
    assert.deepEqual(kinds(row(summary("wk", { workerSession: true, activity: { state: "error" } }))), []);
    assert.deepEqual(kinds(row(summary("ar", { archived: true, unread: true, busy: true }))), []);
    assert.deepEqual(kinds(row(summary("ar2", { archived: true, activity: { state: "error" } }))), ["act:error"]);
  });

  test("a TUI-live session is flagged read-only on its items", () => {
    const [it] = sessionItems(row(summary("t", { live: { pid: 9, status: "Needs input" }, activity: { state: "needs-input" } })), NOW);
    assert.equal(it?.tuiLive, true);
    assert.match(it!.detail!, /terminal/);
  });
});

describe("attention: a worker error is acknowledged by seeing the session after it", () => {
  const ERR = NOW - 10 * 60_000;

  test("seen after the error: no item and no badge; the same failure seen BEFORE it still raises one", () => {
    const after = row(summary("w", { seenAt: ERR + 1 }), { failedWorkers: 1, workerErrorAt: ERR });
    assert.deepEqual(kinds(after), []);
    assert.deepEqual(buildDigest([after], NOW).badge, { act: 0, decide: 0 });
    assert.deepEqual(kinds(row(summary("w", { seenAt: ERR - 1 }), { failedWorkers: 1, workerErrorAt: ERR })), ["act:worker-error"]);
  });

  test("a NEW error after the stamp raises it again", () => {
    const seenAt = ERR + 1;
    assert.deepEqual(kinds(row(summary("w", { seenAt }), { failedWorkers: 1, workerErrorAt: ERR })), []);
    assert.deepEqual(kinds(row(summary("w", { seenAt }), { failedWorkers: 2, workerErrorAt: ERR + 5000 })), ["act:worker-error"]);
  });

  test("on screen now counts as seen; never stamped, or an error of unknown time, still shows", () => {
    assert.deepEqual(kinds(row(summary("v"), { failedWorkers: 1, workerErrorAt: NOW, viewing: true })), []);
    assert.deepEqual(kinds(row(summary("n"), { failedWorkers: 1, workerErrorAt: ERR })), ["act:worker-error"]);
    assert.deepEqual(kinds(row(summary("u", { seenAt: NOW }), { failedWorkers: 1 })), ["act:worker-error"]);
  });

  test("an archived session's seen worker error no longer brings it back; an unseen one does", () => {
    assert.deepEqual(kinds(row(summary("a", { archived: true, seenAt: ERR + 1 }), { failedWorkers: 1, workerErrorAt: ERR })), []);
    assert.deepEqual(kinds(row(summary("a", { archived: true, seenAt: ERR - 1 }), { failedWorkers: 1, workerErrorAt: ERR })), ["act:worker-error"]);
  });

  test("acknowledging a worker error leaves the session's other items alone", () => {
    const r = row(summary("m", { seenAt: ERR + 1, activity: { state: "error" } }), { failedWorkers: 1, workerErrorAt: ERR });
    assert.deepEqual(kinds(r), ["act:error"]);
  });

  test("workerErrorTime: rows covering every failure give their latest; missing rows fall back to the observed rise", () => {
    assert.equal(workerErrorTime(0, [5], 9), undefined);
    assert.equal(workerErrorTime(2, [5, 7], 99), 7); // complete rows: the rise is not consulted
    assert.equal(workerErrorTime(2, [5], 9), 9); // a row was dropped: the later rise stands in
    assert.equal(workerErrorTime(2, [50], 9), 50);
    assert.equal(workerErrorTime(1, [], undefined), undefined);
  });

  test("workerErrorTimesOf: error rows only, endedAt first, malformed rows skipped", () => {
    const rec = {
      presence: {
        workers: [
          { status: "error", endedAt: 30, lastActivity: 20 },
          { status: "error", lastActivity: 40 },
          { status: "done", endedAt: 99 },
          { status: "killed", endedAt: 98 },
          { status: "error" },
          null,
        ],
      },
    };
    assert.deepEqual(workerErrorTimesOf(rec), [30, 40]);
    assert.deepEqual(workerErrorTimesOf({}), []);
  });
});

describe("attention: the digest", () => {
  test("sorted by tier, then newest first; counts cover every item even past the 30-item cap", () => {
    const rows: AttentionRow[] = [];
    for (let i = 0; i < 40; i++) rows.push(row(summary(`f${i}`, { unread: true }), { lastReplyAt: NOW - i * 1000 }));
    rows.push(row(summary("late-blocker", { activity: { state: "error" } }), { activitySince: NOW - 10 * 86_400_000 }));
    const d = buildDigest(rows, NOW);
    assert.equal(d.items.length, DIGEST_MAX);
    assert.deepEqual(d.counts, { act: 1, decide: 40, fyi: 0 });
    assert.equal(d.items[0]!.id, "late-blocker"); // act outranks any age
    assert.equal(d.items[1]!.id, "f0"); // then the newest finished
    assert.equal(d.items[2]!.id, "f1");
  });

  test("past the cap, every kind present keeps its newest item, in place of the lowest tier's last", () => {
    const rows: AttentionRow[] = [];
    for (let i = 0; i < 31; i++) rows.push(row(summary(`e${i}`, { activity: { state: "error" } }), { activitySince: NOW - i * 1000 }));
    const proposals = [
      { personId: "p1", name: "Maria", role: "Payroll", by: "Tony", since: NOW - 90_000 },
      { personId: "p2", name: "Karim", role: "", by: "Tony", since: NOW - 10_000 },
    ];
    rows.push(row(summary("referral", { baton: { proposals } as never })));
    rows.push(row(summary("idle", { unread: true }), { lastReplyAt: NOW - 5000 }));
    const d = buildDigest(rows, NOW);
    assert.equal(d.items.length, DIGEST_MAX);
    assert.deepEqual(d.counts, { act: 31, decide: 3, fyi: 0 }, "counts still cover everything");
    const kept = d.items.map((i) => `${i.tier}:${i.kind}:${i.id}`);
    assert.deepEqual(kept.filter((k) => !k.startsWith("act:error:")), ["decide:finished:idle", "decide:roster-proposal:referral"], "each kind once, newest first, after the act tier");
    assert.match(d.items.find((i) => i.kind === "roster-proposal")!.detail!, /Approve Karim/, "the newest proposal");
    assert.equal(d.items.filter((i) => i.kind === "error").length, 28, "the two oldest errors made room");
    assert.ok(!kept.includes("act:error:e29") && !kept.includes("act:error:e30"));
  });

  test("under the cap the digest is unchanged: every item, tier then newest", () => {
    const rows = [row(summary("a", { activity: { state: "error" } }), { activitySince: NOW - 1000 }), row(summary("b", { unread: true }), { lastReplyAt: NOW - 500 })];
    assert.deepEqual(buildDigest(rows, NOW).items.map((i) => i.id), ["a", "b"]);
  });

  test("the badge counts sessions at their most urgent tier, once each", () => {
    const d = buildDigest(
      [
        row(summary("a", { activity: { state: "error" }, unread: true }), { dialogs: ["Q"] }),
        row(summary("b", { unread: true, hasDraft: true })),
        row(summary("c", { busy: true })),
      ],
      NOW,
    );
    assert.deepEqual(d.badge, { act: 1, decide: 1 });
    assert.deepEqual(d.counts, { act: 2, decide: 3, fyi: 1 }); // c is running: fyi only, not in the badge
  });

  test("items link to the session route and say where it runs", () => {
    const [it] = buildDigest([row(summary("x", { unread: true }))], NOW, "/home/u").items;
    assert.equal(it!.href, `#/s/${encodeURIComponent("/s/x.jsonl")}`);
    assert.equal(it!.where, "~/proj");
    assert.equal(whereOf({ cwd: "/p", target: "cell", remoteCwd: "/srv/app" }), "cell:/srv/app");
  });
});

describe("attention: open alignment questions (§chat.alignment/session-mark)", () => {
  const align = (openQuestions: number, questionDocs = 1) => ({ openDocs: questionDocs + 1, openQuestions, questionDocs, lead: { id: "al_3", title: "Autonomy settings" } });

  test("an idle session with open questions is act, dated by its last reply, worded by its lead alignment", () => {
    const items = sessionItems(row(summary("s", { align: align(3) }), { lastReplyAt: NOW - 7000 }), NOW);
    assert.deepEqual(items.map((i) => `${i.tier}:${i.kind}:${i.detail}`), ["act:open-questions:3 open questions in al_3 Autonomy settings"]);
    assert.equal(items[0]!.since, NOW - 7000);
    assert.equal(openQuestionsText(align(1)), "1 open question in al_3 Autonomy settings");
    assert.equal(openQuestionsText(align(5, 2)), "5 open questions in 2 alignments");
  });

  test("never while it runs, never archived, never without an open question; no signal or feature needed", () => {
    assert.deepEqual(kinds(row(summary("s", { align: align(2), busy: true }))), ["fyi:working"]);
    assert.deepEqual(kinds(row(summary("s", { align: align(2), activity: { state: "working" } }))), ["fyi:working"]);
    assert.deepEqual(kinds(row(summary("s", { align: align(2), archived: true }))), []);
    assert.deepEqual(kinds(row(summary("s", { align: { openDocs: 1, openQuestions: 0, questionDocs: 0 } }))), []);
    const d = buildDigest([row(summary("a", { align: align(2) }))], NOW);
    assert.deepEqual(d.badge, { act: 1, decide: 0 });
    assert.equal(blockerKey(d.items[0]!), "a:open-questions");
  });
});

describe("attention: decision signals (the list carries them only while unseen and idle)", () => {
  const signals = (kinds: ("looping" | "asks-you")[]) => ({ at: NOW - 5000, turnId: "t", provider: "jev" as const, kinds });

  test("a main session's looping is decide, dated by the classification", () => {
    const items = sessionItems(row(summary("s", { signals: signals(["looping"]) })), NOW);
    assert.deepEqual(items.map((i) => `${i.tier}:${i.kind}`), ["decide:looping"]);
    assert.ok(items.every((i) => i.since === NOW - 5000));
  });

  test("worker checks: stuck subagents are the parent's decide item, one with the session's own looping", () => {
    const items = sessionItems(row(summary("s", { signals: signals(["looping"]), workerSignals: { stuck: 2 } })), NOW);
    assert.deepEqual(items.map((i) => `${i.tier}:${i.kind}`), ["decide:looping"]);
    assert.equal(items[0]!.detail, "2 subagents look stuck. The last turn looks like it went in circles too.");
  });

  test("details name stuck workers; fixed fallbacks without them", () => {
    const text = { stuckWorkers: ["builder"] };
    const detail = (s: SessionSummary, t?: AttentionRow["signalText"]) =>
      sessionItems(row(s, t ? { signalText: t } : {}), NOW).map((i) => `${i.tier}:${i.kind}:${i.detail}`);
    assert.deepEqual(detail(summary("l", { signals: signals(["looping"]) })), ["decide:looping:The last turn looks like it went in circles."]);
    assert.deepEqual(detail(summary("w", { workerSignals: { stuck: 1 } }), text), ["decide:looping:A subagent looks stuck: builder."]);
    assert.deepEqual(detail(summary("w", { workerSignals: { stuck: 2 } }), { stuckWorkers: ["a", "b"] }), ["decide:looping:Subagents look stuck: a, b."]);
  });

  test("no kinds, no items; an empty kinds list is not a mark; a stuck subagent is never needs-you", () => {
    assert.deepEqual(kinds(row(summary("s", { signals: signals([]) }))), []);
    const d = buildDigest([row(summary("a", { workerSignals: { stuck: 1 }, unread: true }))], NOW);
    assert.deepEqual(d.badge, { act: 0, decide: 1 });
  });

  test("a stalled team is the session's decide item (never Needs you), unless it already waits on the user", () => {
    const stall = { since: NOW - 22 * 60_000, names: ["verifier", "builder"] };
    const items = sessionItems(row(summary("a"), { teamStall: stall }), NOW);
    assert.deepEqual(items.map((i) => `${i.tier}:${i.kind}:${i.detail}`), ["decide:team-stalled:Waiting on verifier, builder, quiet for 22 min."]);
    assert.equal(items[0]!.later, undefined, "a decide item has no Later key");
    assert.equal(items[0]!.since, stall.since);
    const many = sessionItems(row(summary("a"), { teamStall: { ...stall, names: ["a", "b", "c", "d", "e"] } }), NOW);
    assert.match(many[0]!.detail!, /^Waiting on a, b, c and 2 more,/);
    assert.deepEqual(kinds(row(summary("a", { signals: signals(["asks-you"]) }), { teamStall: stall })), ["decide:asks-you"]);
    assert.deepEqual(kinds(row(summary("a", { align: { openDocs: 1, openQuestions: 1, questionDocs: 1 } }), { teamStall: stall })), ["act:open-questions"]);
    assert.deepEqual(kinds(row(summary("a", { busy: true }), { teamStall: stall })).filter((k) => k.endsWith("team-stalled")), []);
    assert.deepEqual(buildDigest([row(summary("a"), { teamStall: stall })], NOW).badge, { act: 0, decide: 1 });
  });

  test("a reply that asks is decide asks-you (a row mark, never Needs you), quoting its sentence; open questions take its place", () => {
    const detail = (s: SessionSummary, t?: AttentionRow["signalText"]) =>
      sessionItems(row(s, t ? { signalText: t } : {}), NOW).map((i) => `${i.tier}:${i.kind}:${i.detail}`);
    assert.deepEqual(detail(summary("a", { signals: signals(["asks-you"]) }), { sentence: "Shall I merge it into master?", stuckWorkers: [] }), ["decide:asks-you:Asks you: Shall I merge it into master?"]);
    assert.deepEqual(detail(summary("a", { signals: signals(["asks-you"]) })), ["decide:asks-you:The last reply asks you something."]);
    const both = sessionItems(row(summary("a", { signals: signals(["asks-you"]), align: { openDocs: 1, openQuestions: 1, questionDocs: 1 } })), NOW);
    assert.deepEqual(both.map((i) => i.kind), ["open-questions"]);
    assert.deepEqual(kinds(row(summary("a", { signals: signals(["asks-you"]), archived: true }))), [], "archived: out of the way");
    const d = buildDigest([row(summary("a", { signals: signals(["asks-you"]) }))], NOW);
    assert.deepEqual(d.badge, { act: 0, decide: 1 });
    assert.deepEqual(d.counts, { act: 0, decide: 1, fyi: 0 });
  });

  test("Overseer and worker sessions never carry items, signals or not", () => {
    assert.deepEqual(kinds(row(summary("o", { overseer: true, signals: signals(["looping"]) }))), []);
    assert.deepEqual(kinds(row(summary("w", { workerSession: true, workerSignals: { stuck: 1 } }))), []);
  });
});
