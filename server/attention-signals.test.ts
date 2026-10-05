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
const { createFakeProvider } = await import("./decide-fake");
const { decisionDefaults } = await import("./decide-settings");
const { WorkerTranscriptAdapters } = await import("../pi-config/extensions/subagents/worker-transcript.ts");

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
const ANSWERS = { stuck: { probabilities: [0, 0.1, 0.9] }, asks_user: { p: 0.9 } };

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
    adapters: () => new WorkerTranscriptAdapters(),
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

  test("repeats are counted in code: the longest identical run, distinct files", () => {
    const t = (name: string, args: E) => ({ name, args: JSON.stringify(args), result: "" });
    const r = sig.repeats([t("read", { path: "a" }), t("read", { path: "a" }), t("read", { path: "a" }), t("bash", { command: "x" }), t("edit", { file_path: "b" })]);
    assert.deepEqual(r, { same_tool_and_args_in_a_row: 3, distinct_files_touched: 2 });
  });
});

describe("failure is a fact of the file, never a question", () => {
  test("the excerpt carries no tool-failure counts or per-call failed marks (an exit-1 grep misled the classifier)", () => {
    const facts = turnFactsOf(finishedTurn())!;
    assert.equal(facts.tools[0]!.ok, false, "the fixture does hold a failed call");
    const st = sig.turnState("t", facts) as any;
    assert.equal(st.tool_failures, undefined);
    assert.ok(st.tool_calls_recent.every((t: any) => Object.keys(t).sort().join() === "summary,tool"));
    const ws = sig.workerState({ name: "w", status: "done" }, { lastAssistantText: "x", partialTurn: false, items: [
      { kind: "tool", toolName: "bash", text: '{"command":"make"}' }, { kind: "tool-result", text: "Command exited with code 2" },
    ] }, NOW) as any;
    assert.equal(ws.tool_failures, undefined);
  });

  test("no question asks whether the work failed, for a turn or a worker", () => {
    const f = turnFactsOf(finishedTurn())!;
    const all = { ...sig.turnQuestions({ ...f, durationMs: sig.LONG_TURN_MS }) };
    assert.deepEqual(Object.keys(all), ["stuck", "asks_user"]);
    assert.doesNotMatch(JSON.stringify(all), /fail/i);
    assert.equal((sig as any).OUTCOME, undefined);
    assert.equal((sig as any).WORK_FAILED, undefined);
  });

  test("a settled turn that stopped with an error is not classified, and the turn before it stops marking the row", async () => {
    const h = harness();
    const turn = finishedTurn();
    const path = file(turn);
    assert.equal(await h.s.classifySession(summary(path), true), true);
    const id = summary(path).id;
    assert.deepEqual(store.toWire(h.stored().sessions[id]!).kinds, ["asks-you", "looping"]);
    writeFileSync(path, readFileSync(path, "utf8") + [user("u9", "a3", "widen it", NOW - 5000), assistant("a9", "u9", NOW - 1000, [], "error", { errorMessage: "529 overloaded" })].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const told = h.changed();
    assert.equal(await h.s.classifySession(summary(path), true), false);
    assert.equal(h.provider.calls.length, 1, "no call for the errored turn");
    assert.equal(h.stored().sessions[id], undefined, "the previous turn's looping is gone");
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
  test("every text field is capped; the reply keeps its END (where it asks)", () => {
    const f = { ...turnFactsOf(finishedTurn())!, lastUser: "u".repeat(10_000), assistantLast: `${"x".repeat(10_000)} DECIDE?` };
    f.tools = Array.from({ length: 30 }, (_, i) => ({ name: "bash", args: "{}", ok: true, result: "r".repeat(1000) + i }));
    const st = sig.turnState("t".repeat(1000), f) as any;
    assert.equal(st.last_user_message.length, sig.CAP.user);
    assert.equal(st.assistant_last.length, sig.CAP.assistant);
    assert.match(st.assistant_last, /DECIDE\?$/);
    assert.equal(st.tool_calls_recent.length, sig.CAP.tools);
    assert.ok(st.tool_calls_recent.every((t: any) => t.summary.length <= sig.CAP.tool));
    assert.ok(JSON.stringify(st).length < 8000);
  });

  test("the stuck question is asked only of a long turn; asks_user only of a reply that looks like it asks", () => {
    const f = { ...turnFactsOf(finishedTurn(NOW - 60_000, 60_000))!, assistantLast: "Done: the build passes." };
    assert.deepEqual(Object.keys(sig.turnQuestions(f)), [], "a short turn that asks nothing has no question at all");
    assert.deepEqual(Object.keys(sig.turnQuestions({ ...f, durationMs: sig.LONG_TURN_MS })), ["stuck"]);
    assert.deepEqual(Object.keys(sig.turnQuestions({ ...f, tools: Array.from({ length: sig.LONG_TURN_TOOLS }, () => f.tools[0]!) })), ["stuck"]);
    const asking = { ...f, assistantLast: "Built and tested. Should I merge it into master?" };
    assert.deepEqual(Object.keys(sig.turnQuestions(asking)), ["asks_user"]);
  });

  test("asks_user is skipped while the session has open alignment questions, and for a turn a link message opened", () => {
    const f = { ...turnFactsOf(finishedTurn(NOW - 60_000, 60_000))!, assistantLast: "Want me to take it on?" };
    assert.deepEqual(Object.keys(sig.turnQuestions(f, { openQuestions: 2 })), [], "open questions already put it in Needs you");
    assert.deepEqual(Object.keys(sig.turnQuestions(f, { openQuestions: 0 })), ["asks_user"], "an align plan with 0 open questions is still asked (01a0edc0)");
    const linked = { ...f, lastUser: '[link_msg lk_0123456789abcdef lm_0123456789abcdef] from "Alice" (host/abc)\nwhat\'s your ETA?\n\nReply with link_send (to: "abc").' };
    assert.deepEqual(Object.keys(sig.turnQuestions(linked)), [], "its question is to the partner (§mesh.links/transcript)");
  });

  test("a long turn that mostly waited on workers is not asked stuck", () => {
    const f = turnFactsOf(finishedTurn())!;
    const w = (name: string) => ({ name, args: "{}", result: "" });
    const waits = [w("agent_wait"), w("team_inbox"), w("wake_nudge"), w("mcp__team__team_msg"), w("bash")];
    assert.equal(sig.mostlyWaits(waits), true);
    assert.equal(sig.mostlyWaits([w("agent_wait"), w("bash")]), false, "half is not mostly");
    assert.equal(sig.turnQuestions({ ...f, assistantLast: "Done.", tools: waits }).stuck, undefined);
    assert.ok(sig.turnQuestions({ ...f, assistantLast: "Done." }).stuck);
  });

  test("STUCK says waiting is not looping, and judges only this turn", () => {
    assert.match(sig.STUCK.instructions as string, /Waiting is not looping/);
    assert.match(sig.STUCK.instructions as string, /Judge only this turn/);
  });
});

describe("looksLikeAsk: the mechanical pre-filter (labelled cases from the Jev audit)", () => {
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
    assert.deepEqual(Object.keys(req.questions), ["stuck", "asks_user"]);
    assert.ok("tool_calls_recent" in (req.state as any), "with stuck, the one request carries the stuck excerpt");
    const id = summary(path).id;
    const t = h.stored().sessions[id]!;
    assert.equal(t.turnId, "a3");
    assert.equal(t.replyAt, NOW - 60_000);
    assert.equal(t.answers.stuck?.type, "score");
    assert.deepEqual(store.toWire(t).kinds, ["asks-you", "looping"]);
    assert.equal(t.detail, "The type is wrong. Should I widen it to number | string, or change the caller?".slice("The type is wrong. ".length));
    assert.deepEqual(store.signalTextOf(id, NOW, h.stored()).sentence, t.detail);
    assert.equal(h.changed(), 1);
    assert.deepEqual(readFileSync(path), bytes);
    // Same turn again: no second call.
    assert.equal(await h.s.classifySession(summary(path), true), false);
    assert.equal(h.provider.calls.length, 1);
  });

  test("a short turn makes no model call, and drops the turn before it", async () => {
    const h = harness();
    const path = file(finishedTurn());
    assert.equal(await h.s.classifySession(summary(path), true), true);
    const id = summary(path).id;
    writeFileSync(path, readFileSync(path, "utf8") + [user("u9", "a3", "and the docs?", NOW - 5000), assistant("a9", "u9", NOW - 1000, [{ type: "text", text: "Updated the README too." }])].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const told = h.changed();
    assert.equal(await h.s.classifySession(summary(path), true), false);
    assert.equal(h.provider.calls.length, 1, "a short turn that asks nothing makes no call");
    assert.equal(h.stored().sessions[id], undefined, "the long turn's mark is replaced by the short turn");
    assert.equal(h.changed(), told + 1);
  });

  test("a short turn that asks: one asks_user call on the reply's tail, stored with its sentence; open questions skip it", async () => {
    const h = harness();
    const turn = [user("u1", null, "and the docs?", NOW - 5000), assistant("a1", "u1", NOW - 1000, [{ type: "text", text: "Found two. Which docs do you mean: the README or the spec?\n\nAlso changes: none" }])];
    const path = file(turn);
    assert.equal(await h.s.classifySession(summary(path), true), true);
    const req = h.provider.calls[0]!;
    assert.deepEqual(Object.keys(req.questions), ["asks_user"]);
    assert.deepEqual(Object.keys(req.state as any), ["title", "last_user_message", "assistant_last"]);
    assert.doesNotMatch(JSON.stringify(req.state), /Also changes/);
    const t = h.stored().sessions[summary(path).id]!;
    assert.deepEqual(store.toWire(t).kinds, ["asks-you"]);
    assert.equal(t.detail, "Which docs do you mean: the README or the spec?");
    // It stays after a look (the overlay keeps asks-you when seen) and clears on the user's next turn.
    const id = summary(path).id;
    assert.deepEqual(store.signalsOverlay(id, { enabled: true, viewing: false, running: false, seenAt: NOW + 1 }, h.stored())?.kinds, ["asks-you"]);
    writeFileSync(path, readFileSync(path, "utf8") + [user("u2", "a1", "the README", NOW + 1000), assistant("a2", "u2", NOW + 2000, [{ type: "text", text: "Updated the README." }])].map((e) => JSON.stringify(e)).join("\n") + "\n");
    assert.equal(await h.s.classifySession(summary(path), true), false);
    assert.equal(h.stored().sessions[id], undefined, "the answered ask is gone");
    assert.equal(store.signalsOverlay(id, { enabled: true, viewing: false, running: false }, h.stored()), undefined);
    const q = harness();
    const align = { openDocs: 1, openQuestions: 2, questionDocs: 1 } as SessionSummary["align"];
    assert.equal(await q.s.classifySession(summary(file(turn), { align }), true), false);
    assert.equal(q.provider.calls.length, 0, "open alignment questions already say it waits");
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
    writeFileSync(path, readFileSync(path, "utf8") + [user("u9", "a3", "widen it", NOW - 7 * 60_000), assistant("a9", "u9", NOW - 1000, [{ type: "text", text: "Done: widened." }])].map((e) => JSON.stringify(e)).join("\n") + "\n");
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

describe("AttentionSignals: workers", () => {
  const parentPath = join(dir, "parent.jsonl");
  const parent = summary(parentPath, { id: "parent" });
  const worker = (over: Partial<WorkerInfo>): WorkerInfo => ({ id: "w1", name: "builder", status: "running", working: true, backend: "pi", sessionFile: "/w/w1.jsonl", ...over });
  type Item = import("../pi-config/extensions/subagents/worker-transcript.ts").WorkerTranscriptItem;
  /** A current turn started `ago` ms before NOW, retrying the same build 6 times (the pre-gate passes). */
  const looping = (ago = 6 * 60_000, opener = "build it"): Item[] => [
    { kind: "task", text: opener, at: NOW - ago },
    ...Array.from({ length: 6 }, () => [{ kind: "tool" as const, toolName: "bash", text: '{"command":"pnpm build"}' }, { kind: "tool-result" as const, text: "error" }]).flat(),
  ];
  function workerHarness(workers: () => WorkerInfo[], reply: any = { stuck: { probabilities: [0, 0.1, 0.9] } }, items: () => Item[] = () => looping(), over: Partial<import("./attention-signals").SignalsDeps> = {}) {
    const reads: string[] = [];
    const adapters = new WorkerTranscriptAdapters([
      {
        protocol: 1,
        backend: "pi",
        capabilities: () => ({ read: true, usage: "none", perModel: false, cost: false, items: true, resume: "none" }),
        locate: (ref) => ({ file: ref.locator }),
        read: async (ref) => {
          reads.push(ref.locator);
          return {
            ref, found: true, state: "in-progress", partialTurn: false, compactions: 0, lastAssistantText: "Retrying the build again.",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, byModel: [], source: "none" },
            items: items(),
          };
        },
      },
    ]);
    const h = harness({
      list: async () => [parent],
      liveRecords: () => [{ sessionFile: parentPath, pid: 1, rec: { presence: {} } }],
      decodeWorkers: () => workers(),
      adapters: () => adapters,
      ...over,
    }, reply);
    return { ...h, reads };
  }
  const key = store.workerKey("parent", "w1");

  test("a current turn running > 5 min gets a stuck check, again only after 5 min; it counts after two looping answers", async () => {
    const h = workerHarness(() => [worker({ startedAt: NOW - 6 * 60_000 })]);
    assert.equal(await h.s.tick(), 1);
    const req = h.provider.calls[0]!;
    assert.equal(req.purpose, "worker");
    assert.deepEqual(Object.keys(req.questions), ["stuck"]);
    assert.equal((req.state as any).repeats.same_tool_and_args_in_a_row, 6);
    assert.equal((req.state as any).worker.turn_running_min, 6);
    assert.equal((req.state as any).worker.turn_started_by, "task");
    assert.equal((req.state as any).worker.running_min, undefined);
    const first = h.stored().workers[key]!;
    assert.equal(first.kind, "stuck");
    assert.equal(first.strikes, 1);
    assert.equal(store.workerSignalsOverlay("parent", { enabled: true, viewing: false }, NOW, h.stored()), undefined, "one looping answer is not enough");
    h.setNow(NOW + 60_000);
    assert.equal(await h.s.tick(), 0);
    h.setNow(NOW + sig.WORKER_STUCK_EVERY_MS);
    assert.equal(await h.s.tick(), 1);
    assert.equal(h.stored().workers[key]!.strikes, 2);
    assert.deepEqual(store.signalTextOf("parent", NOW + sig.WORKER_STUCK_EVERY_MS, h.stored()).stuckWorkers, ["builder"]);
    assert.deepEqual(store.workerSignalsOverlay("parent", { enabled: true, viewing: false }, NOW + sig.WORKER_STUCK_EVERY_MS, h.stored()), { stuck: 1 });
  });

  test("the gate is the CURRENT turn's age, not the first spawn: a monitor-like wake of a 3-hour-old worker is not checked", async () => {
    const h = workerHarness(() => [worker({ startedAt: NOW - 190 * 60_000 })], undefined, () => looping(8_000));
    assert.equal(await h.s.tick(), 0);
    assert.equal(h.provider.calls.length, 0);
    assert.equal(h.reads.length, 1);
    // Not read again until the turn could be 5 minutes old.
    h.setNow(NOW + 60_000);
    await h.s.tick();
    assert.equal(h.reads.length, 1);
  });

  test("the excerpt holds only the current turn's items (an earlier turn's burst is not evidence)", async () => {
    const earlier: Item[] = [
      { kind: "task", text: "first task", at: NOW - 40 * 60_000 },
      ...Array.from({ length: 5 }, () => [{ kind: "tool" as const, toolName: "team_inbox", text: '{"limit":2}' }, { kind: "tool-result" as const, text: "Nothing new" }]).flat(),
    ];
    const h = workerHarness(() => [worker({})], undefined, () => [...earlier, ...looping(7 * 60_000, "now fix the verifier")]);
    await h.s.tick();
    const st = h.provider.calls[0]!.state as any;
    assert.ok(st.tool_calls_recent.every((t: any) => t.tool === "bash"));
    assert.equal(st.task, "now fix the verifier");
  });

  test("the pre-gate: a turn that neither repeats nor keeps failing is stored as progress without a call", async () => {
    const varied: Item[] = [
      { kind: "task", text: "build it", at: NOW - 20 * 60_000 },
      ...["a", "b", "c", "d"].flatMap((f) => [{ kind: "tool" as const, toolName: "read", text: JSON.stringify({ path: f }) }, { kind: "tool-result" as const, text: "ok" }]),
    ];
    const h = workerHarness(() => [worker({})], undefined, () => varied);
    assert.equal(await h.s.tick(), 0);
    assert.equal(h.provider.calls.length, 0);
    const w = h.stored().workers[key]!;
    assert.equal(w.mechanical, true);
    assert.deepEqual(w.answers, {});
    assert.equal(sig.workerSuspect(sig.workerTools(varied), 20 * 60_000), false);
    // Erroring for 15 minutes passes the gate; 14 minutes does not.
    const erroring: Item[] = ["a", "b", "c"].flatMap((f) => [{ kind: "tool" as const, toolName: "bash", text: JSON.stringify({ command: f }) }, { kind: "tool-result" as const, text: "Error: nope" }]);
    assert.equal(sig.workerSuspect(sig.workerTools(erroring), sig.WORKER_ERRORING_MS), true);
    assert.equal(sig.workerSuspect(sig.workerTools(erroring), sig.WORKER_ERRORING_MS - 60_000), false);
  });

  test("a non-looping answer resets the strikes, and a new turn starts them over", async () => {
    let n = 0;
    const answers = [[0, 0.1, 0.9], [0.9, 0.1, 0], [0, 0.1, 0.9]];
    let turnAgo = 6 * 60_000;
    const h = workerHarness(() => [worker({})], () => ({ stuck: { probabilities: answers[n++] } }), () => looping(turnAgo));
    await h.s.tick();
    assert.equal(h.stored().workers[key]!.strikes, 1);
    h.setNow(NOW + sig.WORKER_STUCK_EVERY_MS);
    await h.s.tick();
    assert.equal(h.stored().workers[key]!.strikes, 0);
    h.setNow(NOW + 2 * sig.WORKER_STUCK_EVERY_MS);
    await h.s.tick();
    assert.equal(h.stored().workers[key]!.strikes, 1);
  });

  test("monitors and coordinators are never checked, nor a turn a wake nudge started", async () => {
    const h = workerHarness(() => [worker({ id: "w1" }), worker({ id: "w2", sessionFile: "/w/w2.jsonl" })], undefined, () => looping(), {
      duties: async () => new Map([["w1", "monitor" as const], ["w2", "coordinator" as const]]),
    });
    assert.equal(await h.s.tick(), 0);
    assert.deepEqual(h.reads, [], "not even read");
    const wake = workerHarness(() => [worker({})], undefined, () => looping(20 * 60_000, "[wake_nudge n6] Scheduled wakeup fired (set 10m ago).\nReason: (none)\nCheck the roster."));
    assert.equal(await wake.s.tick(), 0);
    assert.equal(wake.provider.calls.length, 0);
  });

  test("the same ag_NN in two sessions: two records, keyed by parent and worker id", async () => {
    const otherPath = join(dir, "other.jsonl");
    const other = summary(otherPath, { id: "other" });
    const h = workerHarness(() => [worker({})], undefined, () => looping(), {
      list: async () => [parent, other],
      liveRecords: () => [{ sessionFile: parentPath, pid: 1, rec: { presence: {} } }, { sessionFile: otherPath, pid: 2, rec: { presence: {} } }],
    });
    assert.equal(await h.s.tick(), 2);
    assert.deepEqual(Object.keys(h.stored().workers).sort(), [store.workerKey("other", "w1"), key].sort());
    assert.equal(h.stored().workers[store.workerKey("other", "w1")]!.sessionId, "other");
  });

  test("a worker that ended is never checked (its error is worker-error, in code)", async () => {
    let w = worker({});
    const h = workerHarness(() => [w]);
    for (const status of ["done", "error"] as const) {
      w = worker({ startedAt: NOW - 10 * 60_000, status, working: false, endedAt: NOW - 1000 });
      assert.equal(await h.s.tick(), 0);
    }
    assert.equal(h.provider.calls.length, 0);
    assert.deepEqual(h.reads, []);
  });

  test("workers of an excluded parent are never read or sent", async () => {
    const h = workerHarness(() => [worker({ startedAt: NOW - 6 * 60_000 })]);
    h.deps.settings = () => on({ exclusions: ["/work"] });
    assert.equal(await h.s.tick(), 0);
    assert.deepEqual(h.reads, []);
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
