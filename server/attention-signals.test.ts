// Run: npx tsx --test server/attention-signals.test.ts
// A throwaway PI_CODING_AGENT_DIR in the OS temp dir; a FakeProvider (no network, no model).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { DecisionSettings, SessionSummary, WorkerInfo } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-signals-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
after(() => rmSync(agentDir, { recursive: true, force: true }));

const sig = await import("./attention-signals");
const store = await import("./signals-store");
const { latestOutcome, turnOutcomesOf } = await import("./turn-outcomes");
const { createFakeProvider } = await import("./decide-fake");
const { decisionDefaults } = await import("./decide-settings");

const { historyOf } = await import("./harness/pi/reader");
/** The facts of a branch written as pi's raw entries. */
const turnFactsOf = (branch: E[]) => sig.turnFacts(historyOf(branch));

const NOW = Date.parse("2026-09-25T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;
const dir = join(agentDir, "sessions", "--tmp-signals--");
mkdirSync(dir, { recursive: true });

type E = Record<string, any>;
const user = (id: string, parentId: string | null, text: string, t: number): E => ({
  type: "message", id, parentId, timestamp: iso(t), message: { role: "user", content: [{ type: "text", text }], timestamp: t },
});
const assistant = (id: string, parentId: string, t: number, content: any[], stopReason = "stop", extra: E = {}): E => ({
  type: "message", id, parentId, timestamp: iso(t), message: { role: "assistant", content, stopReason, timestamp: t, ...extra },
});
const toolResult = (id: string, parentId: string, callId: string, text: string, isError = false): E => ({
  type: "message", id, parentId, message: { role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }], isError },
});
const call = (id: string, name: string, args: E) => ({ type: "toolCall", id, name, arguments: args });

/** A session file; returns its path. */
function file(entries: E[]): string {
  const path = join(dir, `2026-09-25T00-00-00-000Z_s${++seq}.jsonl`);
  writeFileSync(path, [{ type: "session", version: 3, id: `s${seq}`, timestamp: iso(NOW - 3_600_000), cwd: "/work/app" }, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
}

function summary(path: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: path.split("_").pop()!.replace(".jsonl", ""), path, cwd: "/work/app", title: "Fix the build",
    createdAt: iso(NOW - 3_600_000), lastActiveAt: iso(NOW - 60_000), model: "a/b", live: null, busy: false, origin: "web", archived: false,
    ...over,
  };
}

const on = (over: Partial<DecisionSettings> = {}): DecisionSettings => ({ ...decisionDefaults(), features: { attention: true, tags: false }, ...over });

// Extra answers are ignored for questions not asked: one reply serves every request.
const ANSWERS = {
  asks_user: { p: 0.9 },
  outcome: { probabilities: { "waiting-on-user": 0.9, "did-what-was-asked": 0.1 } },
  ask_kind: { probabilities: { "choose-between-options": 0.9, none: 0.1 } },
  claims_unverified: { p: 0.1 },
  left_open: { p: 0.2 },
};
const CARD = ["asks_user", "outcome", "ask_kind", "claims_unverified", "left_open"];

function harness(over: Partial<import("./attention-signals").SignalsDeps> = {}, reply: any = ANSWERS) {
  const provider = createFakeProvider({ reply });
  const storeFile = join(agentDir, "sova", `signals-${++seq}.json`);
  let now = NOW;
  let changed = 0;
  const replyAt = new Map<string, number>();
  const replyStop = new Map<string, string>();
  const deps: import("./attention-signals").SignalsDeps = {
    settings: () => on(),
    provider: () => provider,
    list: async () => [],
    summary: async () => null,
    lastReply: (p) => {
      const at = replyAt.get(p);
      return at === undefined ? undefined : { at, stopReason: replyStop.get(p) ?? "stop" };
    },
    held: () => false,
    liveRecords: () => [],
    decodeWorkers: () => [],
    redact: <T>(v: T): T => JSON.parse(JSON.stringify(v).replaceAll("hunter2-secret", "[redacted]")),
    changed: () => void changed++,
    file: storeFile,
    now: () => now,
    home: "/home/u",
    ...over,
  };
  const s = new sig.AttentionSignals(deps);
  return {
    s, provider, deps, storeFile, replyAt, replyStop,
    setNow: (t: number) => void (now = t),
    changed: () => changed,
    stored: () => store.readSignals(storeFile),
  };
}

/** A finished LONG turn (6 minutes: the stuck question applies): a question at the end, two tool calls, one failed. */
function finishedTurn(t = NOW - 60_000, took = 6 * 60_000): E[] {
  return [
    user("u1", null, "make the build pass", t - took),
    assistant("a1", "u1", t - 100_000, [{ type: "text", text: "Looking." }, call("c1", "bash", { command: "pnpm build" })], "toolUse"),
    toolResult("r1", "a1", "c1", "error TS2322 in src/x.ts", true),
    assistant("a2", "r1", t - 80_000, [call("c2", "read", { path: "src/x.ts" })], "toolUse"),
    toolResult("r2", "a2", "c2", "export const x = 1"),
    assistant("a3", "r2", t, [{ type: "text", text: "The type is wrong. Should I widen it to number | string, or change the caller?" }]),
  ];
}

describe("turnFacts: the last finished turn of a branch", () => {
  test("pairs calls with results, knows errors, measures the turn, keys it by the last assistant entry", () => {
    const f = turnFactsOf(finishedTurn())!;
    assert.equal(f.turnId, "a3");
    assert.equal(f.replyAt, NOW - 60_000);
    assert.equal(f.durationMs, 6 * 60_000);
    assert.equal(f.lastUser, "make the build pass");
    assert.match(f.assistantLast, /Should I widen it/);
    assert.deepEqual(f.tools.map((t) => [t.name, t.ok]), [["bash", false], ["read", true]]);
    assert.equal(f.stopReason, "stop");
    assert.equal(f.error, undefined);
  });

  test("a branch ending on a tool request is mid-turn: nothing to classify", () => {
    assert.equal(turnFactsOf(finishedTurn().slice(0, 2)), null);
    assert.equal(turnFactsOf([user("u", null, "hi", NOW)]), null);
  });

  test("an errored reply with no text: the error is a fact, the last text of the turn is the reply", () => {
    const b = [...finishedTurn().slice(0, 5), assistant("a3", "r2", NOW, [], "error", { errorMessage: "overloaded" })];
    b.splice(3, 1, assistant("a2", "r1", NOW - 80_000, [{ type: "text", text: "Reading the file." }, call("c2", "read", { path: "src/x.ts" })], "toolUse"));
    const f = turnFactsOf(b)!;
    assert.equal(f.error, "overloaded");
    assert.equal(f.assistantLast, "Reading the file.");
  });

});

describe("failure is a fact of the file, never a question", () => {
  test("no question asks whether the turn stopped with an error: only whether the reply reports a failure it didn't fix", () => {
    const f = turnFactsOf(finishedTurn())!;
    const all = { ...sig.turnQuestions(f) };
    assert.deepEqual(Object.keys(all), CARD);
    assert.equal((sig as any).WORK_FAILED, undefined);
    const text = JSON.stringify(all);
    assert.doesNotMatch(text, /stop(?:ped)? with an error|work_failed|turn failed/i);
    assert.deepEqual(text.match(/fail\w*/gi), ["failure", "failure"], "only the outcome option for a failure the agent ran into and left");
  });

  test("a settled turn that stopped with an error is not classified, and the turn before it stops marking the row", async () => {
    const h = harness();
    const turn = finishedTurn();
    const path = file(turn);
    assert.equal(await h.s.classifySession(summary(path), true), true);
    const id = summary(path).id;
    assert.deepEqual(store.toWire(h.stored().sessions[id]!).kinds, ["asks-you"]);
    writeFileSync(path, readFileSync(path, "utf8") + [user("u9", "a3", "widen it", NOW - 5000), assistant("a9", "u9", NOW - 1000, [], "error", { errorMessage: "529 overloaded" })].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const told = h.changed();
    assert.equal(await h.s.classifySession(summary(path), true), false);
    assert.equal(h.provider.calls.length, 1, "no call for the errored turn");
    assert.equal(h.stored().sessions[id], undefined, "the previous turn's ask is gone");
    assert.equal(h.changed(), told + 1, "and the feed was told");
  });

  test("the ticker skips an errored reply on the list's cached stopReason alone: no read, no call", async () => {
    const h = harness();
    const path = file([...finishedTurn().slice(0, 5), assistant("a3", "r2", NOW - 1000, [], "error", { errorMessage: "overloaded" })]);
    h.replyAt.set(path, NOW - 1000);
    h.replyStop.set(path, "error");
    assert.equal(await h.s.classifySession(summary(path), false), false);
    assert.equal(h.provider.calls.length, 0);
    assert.deepEqual(h.stored().sessions, {});
  });
});

describe("state and questions", () => {
  test("the whole card is asked of every finished turn, whatever its words or length; never stuck", () => {
    const f = { ...turnFactsOf(finishedTurn(NOW - 60_000, 60_000))!, assistantLast: "Done: the build passes." };
    assert.deepEqual(Object.keys(sig.turnQuestions(f)), CARD, "no pre-filter on the reply's words");
    assert.deepEqual(Object.keys(sig.turnQuestions({ ...f, durationMs: 60 * 60_000, tools: Array.from({ length: 50 }, () => f.tools[0]!) })), CARD, "a long turn is not asked stuck");
    for (const q of Object.values(sig.CARD_QUESTIONS)) assert.doesNotMatch(JSON.stringify(q), /loop|stuck|circles/i);
  });

  test("no card for a turn a link message or a topic batch opened", () => {
    const f = { ...turnFactsOf(finishedTurn(NOW - 60_000, 60_000))!, assistantLast: "Want me to take it on?" };
    const linked = { ...f, lastUser: '[link_msg lk_0123456789abcdef lm_0123456789abcdef] from "Alice" (host/abc)\nwhat\'s your ETA?\n\nReply with link_send (to: "abc").' };
    assert.deepEqual(Object.keys(sig.turnQuestions(linked)), [], "its question is to the partner (§mesh.links/transcript)");
  });

  test("the card's state: the asks excerpt plus facts counted in code, never tool calls", () => {
    const f = turnFactsOf(finishedTurn())!;
    const st = sig.cardState("t", f, { openQuestions: 2, workersRunning: 1, restartPending: true }) as any;
    assert.deepEqual(Object.keys(st), ["title", "last_user_message", "assistant_last", "facts"]);
    assert.deepEqual(st.facts, { open_alignment_questions: 2, subagents_working: 1, server_restart_owed: true, stop_reason: "stop" });
    assert.equal(JSON.stringify(st).includes("pnpm build"), false);
  });
});

describe("looksLikeAsk: the mechanical pre-filter (labelled cases from the Jev audit)", () => {
  test("asks the gate used to lose (measured on real replies): quoted reply commands, awaiting your, needs your approval", () => {
    for (const a of [
      'Answer each by id, or say "your recs" and I\'ll start.',
      "Say 'prune drafts' and I'll delete all five.",
      "Reply “your recs” to take all three.",
      "Say OK and I'll schedule the restart.",
      "Master is 39 ahead of origin, awaiting your push/scrub call.",
      "The preview still needs the operator approval above.",
      "Promoting needs your go-ahead.",
    ])
      assert.equal(sig.looksLikeAsk(a), true, a);
    for (const p of ["I said the tests pass.", "The reply said it was done.", "No restart pending; nothing ready-declared."]) assert.equal(sig.looksLikeAsk(p), false, p);
  });

  // Hard asks and soft offers Jev put at p >= 0.5 (asks.txt), and the reviewer's A1-A3.
  const asks = [
    "Should I build pass 1? I'd do it in a feature worktree and test on the hermetic server. Also tell me whether you want pass 2.",
    "When those workers finish, or if you're fine losing them, run `systemctl --user restart sova-runtime.service` or tell me to.",
    "Once you know which tab it is, tell me.",
    "Say \"go\" to take all my recommendations, or tell me which to change.",
    "The `feat/usage-poll` branch and its worktree are still there; say if you want them removed.",
    "Both worktrees are still on disk and I haven't pushed; say if you want either done.\n\nAlso changes: none",
    "I've written up my reading of the task as al_1 (01a0edc0, A1). Confirm and I'll start.",
    "The branch is ready. Once you say yes I'll merge it.",
    "Notes: nothing has been implemented yet. The spec draft comes after you confirm.\n\nAlso changes: none", // 01a0def5
    "Shall I merge it into master? Once you say yes I'll run the merge.",
    "**Still waiting on you:** 1. the port 2. the key",
    "Want me to take it on?\n\nAlso changes: §app/x — y; §app/z — w",
  ];
  const plain = [
    "OK, nothing changes. Ejecting stays permanent, and a replacement joins under a new role name.",
    "`~/webapps/sova` is unchanged. The only item in `git status` there is `.cache-stamp-report.md`, which isn't from this work, so I left it.",
    "Short answer: writing precise requirements first is very likely one of your main sources of leverage.\n\nAlso changes: none",
    "Committed as 60639921; the build passes.",
  ];
  test("every ask passes, plain reports do not", () => {
    for (const a of asks) assert.equal(sig.looksLikeAsk(a), true, a);
    for (const p of plain) assert.equal(sig.looksLikeAsk(p), false, p);
  });
  test("only the reply's end counts, after the closing spec lines", () => {
    assert.equal(sig.looksLikeAsk(`Should I start? ${"Then I did it all. ".repeat(100)}`), false);
    assert.equal(sig.withoutFooter("Merge it?\n\nDeferred: §a — b\nAlso changes: none"), "Merge it?");
  });
  test("the closing Also updates lines are cut too", () => {
    assert.equal(sig.withoutFooter("Merge it?\n\nAlso updates §app.x/y: a\nAlso updates §app.z/w: b"), "Merge it?");
  });
  test("the quoted sentence is the asking one, read on from its start", () => {
    assert.equal(sig.lastSentence("I fixed it. Should I push first? The tests pass.\n\nAlso changes: none"), "Should I push first? The tests pass.");
    assert.equal(sig.lastSentence("Done with the audit. **Still waiting on you:** 1. the port 2. the key"), "Still waiting on you: 1. the port 2. the key");
    assert.ok(sig.lastSentence(`${"word ".repeat(100)}?`).length <= sig.SENTENCE_MAX);
  });
  test("the asks-only excerpt: title, the head of the ask, the tail of the reply, footer cut", () => {
    const st = sig.asksState("t", { lastUser: "u".repeat(5000), assistantLast: `${"x".repeat(5000)} Merge it?\n\nAlso changes: none` }) as any;
    assert.deepEqual(Object.keys(st), ["title", "last_user_message", "assistant_last"]);
    assert.equal(st.last_user_message.length, sig.ASK_USER_CHARS);
    assert.equal(st.assistant_last.length, sig.ASK_TAIL_CHARS);
    assert.match(st.assistant_last, /Merge it\?$/);
  });
});

describe("exclusionReason: what is never sent", () => {
  const s = (over: Partial<SessionSummary> = {}) => summary("/x/s.jsonl", over);
  test("each rule, with the one that lets a session through", () => {
    assert.equal(sig.exclusionReason(s(), on(), false, "/home/u"), null);
    assert.equal(sig.exclusionReason(s(), decisionDefaults(), false, "/home/u"), "feature-off");
    assert.equal(sig.exclusionReason(s({ overseer: true }), on(), false), "overseer");
    assert.equal(sig.exclusionReason(s({ workerSession: true }), on(), false), "worker session");
    assert.equal(sig.exclusionReason(s({ archived: true }), on(), false), "archived");
    assert.equal(sig.exclusionReason(s({ cwd: "/home/u/secret/x" }), on({ exclusions: ["~/secret"] }), false, "/home/u"), "excluded");
    assert.equal(sig.exclusionReason(s({ cwd: "/home/u/secretive" }), on({ exclusions: ["~/secret"] }), false, "/home/u"), null);
  });
  test("never-send-TUI: a live TUI session, or one Sova didn't start and doesn't hold", () => {
    const tui = on({ neverSendTui: true });
    assert.equal(sig.exclusionReason(s({ live: { pid: 1, status: "idle" } }), tui, false), "tui");
    assert.equal(sig.exclusionReason(s({ origin: "external" }), tui, false), "tui");
    assert.equal(sig.exclusionReason(s({ origin: "external" }), tui, true), null);
    assert.equal(sig.exclusionReason(s({ origin: "external" }), on(), false), null);
  });
});

describe("readTailBranch: read-only, tail-only, branch-aware", () => {
  test("the leaf is the last entry; an abandoned branch is not the turn; a cut first line is skipped", async () => {
    const pad = user("u0", null, "p".repeat(5000), NOW - 900_000);
    const rewound = [...finishedTurn(), assistant("a4", "u1", NOW - 10_000, [{ type: "text", text: "Other branch, done." }])];
    const path = file([pad, ...rewound.map((e) => (e.id === "u1" ? { ...e, parentId: "u0" } : e))]);
    const before = statSync(path);
    const branch = await sig.readTailBranch(path, 3000); // cuts into the padding line
    assert.equal(sig.turnFacts(branch)?.turnId, "a4");
    assert.ok(!branch.some((e) => e.id === "a3"));
    const after2 = statSync(path);
    assert.equal(after2.size, before.size);
    assert.equal(after2.mtimeMs, before.mtimeMs);
  });
});

describe("AttentionSignals: classify each finished turn once", () => {
  test("a settled hosted turn: one decision, raw answers stored, the session file untouched, the push told", async () => {
    const h = harness();
    const path = file(finishedTurn());
    const bytes = readFileSync(path);
    assert.equal(await h.s.classifySession(summary(path), true), true);
    assert.equal(h.provider.calls.length, 1);
    const req = h.provider.calls[0]!;
    assert.equal(req.purpose, "attention");
    assert.deepEqual(Object.keys(req.questions), CARD);
    assert.equal("tool_calls_recent" in (req.state as any), false, "no stuck excerpt: tool calls never leave");
    const id = summary(path).id;
    const t = h.stored().sessions[id]!;
    assert.equal(t.turnId, "a3");
    assert.equal(t.replyAt, NOW - 60_000);
    assert.equal(t.answers.stuck, undefined, "never asked stuck");
    assert.deepEqual(store.toWire(t).kinds, ["asks-you"]);
    assert.equal(t.detail, "The type is wrong. Should I widen it to number | string, or change the caller?".slice("The type is wrong. ".length));
    assert.deepEqual(store.signalTextOf(id, NOW, h.stored()).sentence, t.detail);
    assert.equal(h.changed(), 1);
    assert.deepEqual(readFileSync(path), bytes);
    // Same turn again: no second call.
    assert.equal(await h.s.classifySession(summary(path), true), false);
    assert.equal(h.provider.calls.length, 1);
  });

  test("a turn that asks nothing still gets its card; it replaces the turn before it, and its outcome is kept per turn", async () => {
    const h = harness({}, { ...ANSWERS, asks_user: { p: 0.05 }, outcome: { probabilities: { "did-what-was-asked": 0.95, "partial-stopped": 0.05 } }, ask_kind: { probabilities: { none: 1 } }, claims_unverified: { p: 0.9 } });
    const outcomes = join(agentDir, "sova", `outcomes-${seq}.json`);
    h.deps.outcomesFile = outcomes;
    const path = file(finishedTurn());
    assert.equal(await h.s.classifySession(summary(path), true), true);
    const id = summary(path).id;
    writeFileSync(path, readFileSync(path, "utf8") + [user("u9", "a3", "and the docs?", NOW - 5000), assistant("a9", "u9", NOW - 1000, [{ type: "text", text: "Updated the README too. I didn't run the docs build." }])].map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.equal(await h.s.classifySession(summary(path), true), true);
    assert.equal(h.provider.calls.length, 2, "one card per finished turn");
    const t = h.stored().sessions[id]!;
    assert.equal(t.turnId, "a9");
    assert.deepEqual(store.toWire(t).kinds, ["unverified"]);
    assert.deepEqual(store.toWire(t).card, { outcome: "did-what-was-asked", askKind: "none", claimsUnverified: 0.9, leftOpen: 0.2 });
    const kept = turnOutcomesOf(id, outcomes);
    assert.deepEqual(kept.map((r) => r.turnId), ["a3", "a9"], "both turns kept, oldest first");
    assert.equal(latestOutcome(id, undefined, outcomes)?.outcome, "did-what-was-asked");
    assert.equal(latestOutcome(id, NOW - 30_000, outcomes)?.turnId, "a3", "the newest at or before a time");
  });

  test("a short turn that asks: one card on the reply's tail, stored with its sentence; open questions ride as a fact", async () => {
    const h = harness();
    const turn = [user("u1", null, "and the docs?", NOW - 5000), assistant("a1", "u1", NOW - 1000, [{ type: "text", text: "Found two. Which docs do you mean: the README or the spec?\n\nAlso changes: none" }])];
    const path = file(turn);
    assert.equal(await h.s.classifySession(summary(path), true), true);
    const req = h.provider.calls[0]!;
    assert.deepEqual(Object.keys(req.questions), CARD);
    assert.deepEqual(Object.keys(req.state as any), ["title", "last_user_message", "assistant_last", "facts"]);
    assert.doesNotMatch(JSON.stringify(req.state), /Also changes/);
    const t = h.stored().sessions[summary(path).id]!;
    assert.deepEqual(store.toWire(t).kinds, ["asks-you"]);
    assert.equal(t.detail, "Which docs do you mean: the README or the spec?");
    // It stays after a look (the overlay keeps asks-you when seen) and clears on the user's next turn.
    const id = summary(path).id;
    assert.deepEqual(store.signalsOverlay(id, { enabled: true, viewing: false, running: false, seenAt: NOW + 1 }, h.stored())?.kinds, ["asks-you"]);
    writeFileSync(path, readFileSync(path, "utf8") + [user("u2", "a1", "the README", NOW + 1000), assistant("a2", "u2", NOW + 2000, [{ type: "text", text: "Updated the README." }])].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const done = harness({}, { ...ANSWERS, asks_user: { p: 0.05 }, ask_kind: { probabilities: { none: 1 } }, outcome: { probabilities: { "did-what-was-asked": 1 } } });
    done.deps.file = h.storeFile;
    const s2 = new sig.AttentionSignals(done.deps);
    assert.equal(await s2.classifySession(summary(path), true), true);
    assert.equal(store.signalsOverlay(id, { enabled: true, viewing: false, running: false }, store.readSignals(h.storeFile)), undefined, "the answered ask is gone");
    const q = harness();
    const align = { openDocs: 1, openQuestions: 2, questionDocs: 1 } as SessionSummary["align"];
    assert.equal(await q.s.classifySession(summary(file(turn), { align }), true), true);
    assert.equal((q.provider.calls[0]!.state as any).facts.open_alignment_questions, 2, "open questions ride as a fact; the row shows them first");
  });

  test("a new turn replaces the stored one; the list's reply time gates the ticker path cheaply", async () => {
    const h = harness();
    const turn = finishedTurn();
    const path = file(turn);
    await h.s.classifySession(summary(path), true);
    // Ticker, same reply time: no read, no call.
    h.replyAt.set(path, NOW - 60_000);
    assert.equal(await h.s.classifySession(summary(path), false), false);
    // A new reply.
    writeFileSync(path, readFileSync(path, "utf8") + [user("u9", "a3", "widen it", NOW - 7 * 60_000), assistant("a9", "u9", NOW - 1000, [{ type: "text", text: "Done: widened. Should I push it?" }])].map((e) => JSON.stringify(e)).join("\n") + "\n");
    h.replyAt.set(path, NOW - 1000);
    assert.equal(await h.s.classifySession(summary(path), false), true);
    assert.equal(h.stored().sessions[summary(path).id]!.turnId, "a9");
    assert.equal(h.provider.calls.length, 2);
  });

  test("the ticker never classifies an old turn it sees for the first time (switching the feature on is not a backfill)", async () => {
    const h = harness();
    const path = file(finishedTurn(NOW - sig.FRESH_MS - 1000));
    h.replyAt.set(path, NOW - sig.FRESH_MS - 1000);
    assert.equal(await h.s.classifySession(summary(path), false), false);
    assert.equal(await h.s.classifySession(summary(path), true), false);
    assert.equal(h.provider.calls.length, 0);
  });

  test("nothing is sent while off, excluded, TUI (with the switch), running, or for an Overseer/worker session", async () => {
    const path = file(finishedTurn());
    for (const [settings, over] of [
      [decisionDefaults(), {}],
      [on({ exclusions: ["/work"] }), {}],
      [on({ neverSendTui: true }), { live: { pid: 1, status: "idle" } }],
      [on(), { busy: true }],
      [on(), { activity: { state: "working" as const } }],
      [on(), { overseer: true as const }],
      [on(), { workerSession: true as const }],
    ] as [DecisionSettings, Partial<SessionSummary>][]) {
      const h = harness({ settings: () => settings });
      assert.equal(await h.s.classifySession(summary(path, over), true), false, JSON.stringify(over));
      assert.equal(h.provider.calls.length, 0);
    }
  });

  test("the state is redacted before it leaves", async () => {
    const h = harness();
    const t = finishedTurn();
    t[5] = assistant("a3", "r2", NOW - 60_000, [{ type: "text", text: "The token is hunter2-secret. Keep it?" }]);
    await h.s.classifySession(summary(file(t)), true);
    const sent = JSON.stringify(h.provider.calls[0]!.state);
    assert.ok(!sent.includes("hunter2-secret"));
    assert.match(sent, /\[redacted\]/);
    const stored = JSON.stringify(h.stored());
    assert.ok(!stored.includes("hunter2-secret"));
  });

  test("a failure stores nothing and retries only after RETRY_MS, at most MAX_ATTEMPTS; bad-request never", async () => {
    const h = harness({}, { fail: "rate-limit" });
    const path = file(finishedTurn());
    assert.equal(await h.s.classifySession(summary(path), true), false);
    assert.equal(await h.s.classifySession(summary(path), true), false);
    assert.equal(h.provider.calls.length, 1);
    assert.deepEqual(h.stored().sessions, {});
    for (let i = 1; i <= 5; i++) {
      h.setNow(NOW + i * sig.RETRY_MS);
      await h.s.classifySession(summary(path), true);
    }
    assert.equal(h.provider.calls.length, sig.MAX_ATTEMPTS);
    const bad = harness({}, { fail: "bad-request" });
    await bad.s.classifySession(summary(path), true);
    bad.setNow(NOW + 10 * sig.RETRY_MS);
    await bad.s.classifySession(summary(path), true);
    assert.equal(bad.provider.calls.length, 1);
  });

  test("tick: nothing at all while the feature is off; no decision while the chain has no provider", async () => {
    let listed = 0;
    const list = async () => (listed++, [summary(file(finishedTurn()))]);
    assert.equal(await harness({ settings: () => decisionDefaults(), list }).s.tick(), 0);
    assert.equal(listed, 0);
    const none = harness({ provider: () => null, list });
    assert.equal(await none.s.tick(), 0);
    assert.equal(listed, 1, "the list is read for team stalls, which are counted in code");
    assert.deepEqual(none.stored().sessions, {});
  });

  test("tick prunes sessions whose file left the list", async () => {
    const h = harness();
    const path = file(finishedTurn());
    await h.s.classifySession(summary(path), true);
    const other = summary(file(finishedTurn(NOW - sig.FRESH_MS * 2)));
    h.deps.list = async () => [other];
    await h.s.tick();
    assert.deepEqual(Object.keys(h.stored().sessions), []);
  });
});

describe("team stalls: a session waiting on subagents that all went quiet (counted in code)", () => {
  // Reply tails from the stalls the user asked about (CONFUSION X1), and replies that do not wait.
  const waiting = [
    "Nothing needs you right now. The verifier's round 6 is still running on the 17:10 build, and it's the final round. Once the verifier signs off, the coordinator runs its checks and reports to me.\n\nAlso changes: none", // 01a0eb99
    "After those, the lead will do three things: rerun the full suite; commit M0; write the report.  I'll verify it when it arrives.  Also changes: none", // 01a0e977
    "Nothing will merge to master without your go. The coordinator will send me the baseline results and each cycle's results as they come.  Also changes: none", // 01a0e82a
  ];
  const done = [
    "Merged feat/x into master at abc1234; the build passes and the worktree is removed.\n\nAlso changes: none",
    "The audit is written to ~/.cache/audit/REPORT.md. Nothing else changed.",
  ];
  test("the reply's words: waiting on the team, or not", () => {
    for (const w of waiting) assert.equal(sig.waitsOnTeam(w), true, w);
    for (const d of done) assert.equal(sig.waitsOnTeam(d), false, d);
  });

  const idle = summary("/x/p.jsonl");
  const reply = { at: NOW - 20 * 60_000, stopReason: "stop" };
  const member = (over: Partial<WorkerInfo> = {}): WorkerInfo => ({ id: "ag_1", name: "verifier", status: "waiting", working: false, lastActivity: NOW - 18 * 60_000, ...over });
  const none = new Map();

  test("quiet for 15 minutes: every member idle and nothing since the reply", () => {
    assert.deepEqual(sig.quietTeam(idle, [member()], none, reply, NOW), { since: NOW - 18 * 60_000, names: ["verifier"] });
    assert.equal(sig.quietTeam(idle, [member({ lastActivity: NOW - 10 * 60_000 })], none, reply, NOW), null, "a member active 10 min ago");
    assert.equal(sig.quietTeam(idle, [member()], none, { ...reply, at: NOW - 5 * 60_000 }, NOW), null, "a reply 5 min ago");
  });

  test("busy workers are not a stall (01a0e82a / 01a0ebbf waiting on a working team)", () => {
    assert.equal(sig.quietTeam(idle, [member(), member({ id: "ag_2", name: "builder", working: true, status: "running" })], none, reply, NOW), null);
    assert.equal(sig.quietTeam({ ...idle, busy: true }, [member()], none, reply, NOW), null, "the parent itself is running");
    assert.equal(sig.quietTeam({ ...idle, activity: { state: "working" } }, [member()], none, reply, NOW), null);
    assert.equal(sig.quietTeam(idle, [member()], none, { ...reply, stopReason: "error" }, NOW), null, "an errored turn is its own item");
  });

  test("monitors and coordinators neither count as members nor as activity; killed workers are gone", () => {
    const monitor = member({ id: "ag_9", name: "monitor", working: true, status: "running", lastActivity: NOW - 1000 });
    const duties = new Map([["ag_9", "monitor" as const]]);
    assert.deepEqual(sig.quietTeam(idle, [member(), monitor], duties, reply, NOW)?.names, ["verifier"], "its wake-up is not activity");
    assert.equal(sig.quietTeam(idle, [monitor], duties, reply, NOW), null, "a monitor alone is no team to wait on");
    assert.equal(sig.quietTeam(idle, [member({ status: "killed" })], none, reply, NOW), null);
    for (const over of [{ overseer: true }, { workerSession: true }, { archived: true }] as Partial<SessionSummary>[])
      assert.equal(sig.quietTeam({ ...idle, ...over }, [member()], none, reply, NOW), null);
  });

  test("the scan stores a stall once, keeps it while it holds, drops it when a member works again; no model is asked", async () => {
    const path = file([user("u1", null, "run the team", NOW - 30 * 60_000), assistant("a1", "u1", NOW - 20 * 60_000, [{ type: "text", text: waiting[1]! }])]);
    const parent = summary(path);
    let workers = [member()];
    const h = harness({
      list: async () => [parent],
      liveRecords: () => [{ sessionFile: path, pid: 1, rec: { presence: {} } }],
      decodeWorkers: () => workers,
      provider: () => null,
    });
    h.replyAt.set(path, NOW - 20 * 60_000);
    await h.s.tick();
    assert.deepEqual(store.teamStallOf(parent.id, h.stored()), { since: NOW - 18 * 60_000, names: ["verifier"] });
    const told = h.changed();
    await h.s.tick();
    assert.equal(h.changed(), told, "unchanged: no write, no push");
    workers = [member({ working: true, status: "running" })];
    await h.s.tick();
    assert.equal(store.teamStallOf(parent.id, h.stored()), undefined);
    assert.equal(h.provider.calls.length, 0);
  });

  // 01a0eced (velocity report): ag_01 delivered its report at 11:52:46Z on 29 Sep, the session
  // answered the user after it (last reply 12:47:37Z, ending in advice to the user), and 21 h later
  // opening the session restored the idle ag_01 into presence. It raised "quiet for 1320 min".
  const ECED_REPLY =
    "Tags are added in the Velocity tab.\n\nWhen you report a bug, add a tag so it counts in the velocity report. If you want, I can add a default tag for new sessions.";
  const ECED_REPLY_AT = Date.parse("2026-09-29T12:47:37.000Z");
  const ECED_NOW = Date.parse("2026-09-30T09:58:00.000Z");
  const agO1 = (over: Partial<WorkerInfo> = {}): WorkerInfo => ({ id: "ag_01", name: "velocity-metrics", status: "restored", working: false, outcome: "success", startedAt: Date.parse("2026-09-29T11:30:00.000Z"), lastActivity: Date.parse("2026-09-29T11:52:46.000Z"), ...over });

  test("01a0eced: a waiting phrase whose subject is 'you' never counts", () => {
    assert.equal(sig.waitsOnTeam(ECED_REPLY), false, "When you report a bug… is advice to the user");
    assert.equal(sig.waitsOnTeam("Once you signs off… no. Once the reviewer reports back, I'll merge."), true, "a worker subject still counts");
  });

  test("01a0eced: a worker counts only if active after the last reply and not done with a finished report", () => {
    const eced = { at: ECED_REPLY_AT, stopReason: "stop" };
    assert.equal(sig.quietTeam(idle, [agO1()], none, eced, ECED_NOW), null, "its report came before the last reply, and it succeeded");
    assert.equal(sig.quietTeam(idle, [agO1({ outcome: undefined })], none, eced, ECED_NOW), null, "last activity before the last reply alone suffices");
    assert.equal(sig.quietTeam(idle, [agO1({ lastActivity: ECED_REPLY_AT + 60_000 })], none, eced, ECED_NOW), null, "a delivered finished report alone suffices");
    const late = agO1({ outcome: undefined, lastActivity: ECED_REPLY_AT + 60_000 });
    assert.deepEqual(sig.quietTeam(idle, [late], none, eced, ECED_NOW), { since: ECED_REPLY_AT + 60_000, names: ["velocity-metrics"] }, "active after the reply, no report yet: a real wait");
  });

  test("01a0eced loaded again (21-h-old reply, idle worker restored on open): the scan stores no stall", async () => {
    const path = file([user("u1", null, "why is the count off?", ECED_REPLY_AT - 60_000), assistant("a1", "u1", ECED_REPLY_AT, [{ type: "text", text: ECED_REPLY }])]);
    let records: { sessionFile: string; pid: number; rec: { presence: object } }[] = [];
    const h = harness({ list: async () => [summary(path)], liveRecords: () => records, decodeWorkers: () => [agO1()], provider: () => null, now: () => ECED_NOW });
    h.replyAt.set(path, ECED_REPLY_AT);
    await h.s.tick();
    assert.deepEqual(h.stored().stalls, {}, "not loaded: nothing");
    records = [{ sessionFile: path, pid: 1, rec: { presence: {} } }]; // the user opens it: ag_01 is restored
    await h.s.tick();
    await h.s.tick();
    assert.deepEqual(h.stored().stalls, {}, "loaded again: still nothing");
  });

  test("a reply that does not wait on the team is no stall, whatever the quiet", async () => {
    const path = file([user("u1", null, "merge it", NOW - 30 * 60_000), assistant("a1", "u1", NOW - 20 * 60_000, [{ type: "text", text: done[0]! }])]);
    const h = harness({ list: async () => [summary(path)], liveRecords: () => [{ sessionFile: path, pid: 1, rec: { presence: {} } }], decodeWorkers: () => [member()] });
    h.replyAt.set(path, NOW - 20 * 60_000);
    await h.s.tick();
    assert.deepEqual(h.stored().stalls, {});
  });
});

describe("b3: an errored turn makes no decision call and shows the code-derived Needs-you state", () => {
  test("stopReason error: no card, nothing stored; the turn error is an act item and a Needs you row", async () => {
    const { buildDigest, sessionItems } = await import("./attention");
    const { needsYouRows } = await import("../src/lib/needs-you");
    const h = harness();
    const path = file([...finishedTurn().slice(0, 5), assistant("a3", "r2", NOW - 1000, [], "error", { errorMessage: "529 overloaded" })]);
    // Both paths: the settled hook (reads the file) and the ticker (the list's cached stopReason).
    assert.equal(await h.s.classifySession(summary(path), true), false);
    h.replyAt.set(path, NOW - 1000);
    h.replyStop.set(path, "error");
    assert.equal(await h.s.classifySession(summary(path), false), false);
    assert.equal(h.provider.calls.length, 0, "no decision call of any purpose");
    assert.deepEqual(h.stored().sessions, {});
    // What the list gives the row (§app.overseer/seen turnError) is all the digest needs.
    const row = { ...summary(path), turnError: { message: "529 overloaded" } } as SessionSummary;
    const att = { summary: row, dialogs: [], queued: 0, failedWorkers: 0, activitySince: 0, lastReplyAt: NOW - 1000 };
    assert.deepEqual(sessionItems(att, NOW, "/home/u").filter((i) => i.tier === "act").map((i) => [i.kind, i.detail]), [["error", "529 overloaded"]]);
    const listed = needsYouRows(buildDigest([att], NOW, "/home/u"), [row]);
    assert.deepEqual(listed.map((r) => [r.session.path, r.detail]), [[path, "529 overloaded"]]);
  });
});
