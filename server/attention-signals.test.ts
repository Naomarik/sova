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

const ANSWERS = { asks_user: { p: 0.92 }, work_failed: { p: 0.1 }, outcome: { probabilities: { done: 0.1, partial: 0.1, failed: 0.1, blocked_on_user: 0.7 } }, stuck: { probabilities: [0.9, 0.1, 0] } };

function harness(over: Partial<import("./attention-signals").SignalsDeps> = {}, reply: any = ANSWERS) {
  const provider = createFakeProvider({ reply });
  const storeFile = join(agentDir, "sova", `signals-${++seq}.json`);
  let now = NOW;
  let changed = 0;
  const replyAt = new Map<string, number>();
  const deps: import("./attention-signals").SignalsDeps = {
    settings: () => on(),
    provider: () => provider,
    list: async () => [],
    summary: async () => null,
    lastReplyAt: (p) => replyAt.get(p),
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
    s, provider, deps, storeFile, replyAt,
    setNow: (t: number) => void (now = t),
    changed: () => changed,
    stored: () => store.readSignals(storeFile),
  };
}

/** A finished turn: a question at the end, two tool calls, one failed. */
function finishedTurn(t = NOW - 60_000): E[] {
  return [
    user("u1", null, "make the build pass", t - 120_000),
    assistant("a1", "u1", t - 100_000, [{ type: "text", text: "Looking." }, call("c1", "bash", { command: "pnpm build" })], "toolUse"),
    toolResult("r1", "a1", "c1", "error TS2322 in src/x.ts", true),
    assistant("a2", "r1", t - 80_000, [call("c2", "read", { path: "src/x.ts" })], "toolUse"),
    toolResult("r2", "a2", "c2", "export const x = 1"),
    assistant("a3", "r2", t, [{ type: "text", text: "The type is wrong. Should I widen it to number | string, or change the caller?" }]),
  ];
}

describe("turnFacts: the last finished turn of a branch", () => {
  test("pairs calls with results, knows errors, measures the turn, keys it by the last assistant entry", () => {
    const f = sig.turnFacts(finishedTurn())!;
    assert.equal(f.turnId, "a3");
    assert.equal(f.replyAt, NOW - 60_000);
    assert.equal(f.durationMs, 120_000);
    assert.equal(f.lastUser, "make the build pass");
    assert.match(f.assistantLast, /Should I widen it/);
    assert.deepEqual(f.tools.map((t) => [t.name, t.ok]), [["bash", false], ["read", true]]);
    assert.equal(f.stopReason, "stop");
    assert.equal(f.error, undefined);
  });

  test("a branch ending on a tool request is mid-turn: nothing to classify", () => {
    assert.equal(sig.turnFacts(finishedTurn().slice(0, 2)), null);
    assert.equal(sig.turnFacts([user("u", null, "hi", NOW)]), null);
  });

  test("an errored reply with no text: the error is a fact, the last text of the turn is the reply", () => {
    const b = [...finishedTurn().slice(0, 5), assistant("a3", "r2", NOW, [], "error", { errorMessage: "overloaded" })];
    b.splice(3, 1, assistant("a2", "r1", NOW - 80_000, [{ type: "text", text: "Reading the file." }, call("c2", "read", { path: "src/x.ts" })], "toolUse"));
    const f = sig.turnFacts(b)!;
    assert.equal(f.error, "overloaded");
    assert.equal(f.assistantLast, "Reading the file.");
  });

  test("repeats are counted in code: the longest identical run, distinct files", () => {
    const t = (name: string, args: E) => ({ name, args: JSON.stringify(args), result: "" });
    const r = sig.repeats([t("read", { path: "a" }), t("read", { path: "a" }), t("read", { path: "a" }), t("bash", { command: "x" }), t("edit", { file_path: "b" })]);
    assert.deepEqual(r, { same_tool_and_args_in_a_row: 3, distinct_files_touched: 2 });
  });
});

describe("D1: a failed tool call is a named fact, and failure has its own question", () => {
  const t = (name: string, args: E, ok: boolean | undefined, result: string) => ({ name, args: JSON.stringify(args), ok, result });

  test("the e2e shape (npm test in a missing dir, calmly reported) carries the failure, its input and the END of its error", () => {
    const facts = {
      ...sig.turnFacts(finishedTurn())!,
      tools: [t("bash", { command: "npm test --prefix /nonexistent/proj" }, false, `${"npm error ".repeat(80)}enoent Could not read package.json\nCommand exited with code 254`)],
      assistantLast: "The test run failed with exit code 254 because npm could not find a package.json.",
    };
    const st = sig.turnState("t", facts) as any;
    assert.equal(st.tool_calls_recent[0].status, "failed");
    assert.deepEqual({ ...st.tool_failures, failed_calls: undefined }, { failed_tool_calls: 1, unresolved_failed_calls: 1, last_tool_call_failed: true, failed_calls: undefined });
    const fc = st.tool_failures.failed_calls[0];
    assert.equal(fc.tool, "bash");
    assert.match(fc.input, /npm test --prefix \/nonexistent\/proj/);
    assert.ok(fc.error.length <= sig.CAP.error);
    assert.match(fc.error, /Command exited with code 254$/);
  });

  test("a failure fixed and re-run later in the turn is not unresolved; a different call does not resolve it", () => {
    const run = { command: "pnpm test" };
    const fixed = sig.toolFailures([t("bash", run, false, "fail 1"), t("edit", { path: "a" }, true, "ok"), t("bash", run, true, "pass")]) as any;
    assert.equal(fixed.failed_tool_calls, 1);
    assert.equal(fixed.unresolved_failed_calls, 0);
    assert.equal(fixed.last_tool_call_failed, false);
    const other = sig.toolFailures([t("read", { path: "/missing" }, false, "ENOENT"), t("read", { path: "/other" }, true, "x")]) as any;
    assert.equal(other.unresolved_failed_calls, 1);
  });

  test("a worker's results carry no error flag: a non-zero exit in the text counts, exit 0 and plain text do not", () => {
    assert.equal(sig.toolFailed(t("bash", {}, undefined, "boom\nCommand exited with code 2")), true);
    assert.equal(sig.toolFailed(t("bash", {}, undefined, "Command terminated without an exit code")), true);
    assert.equal(sig.toolFailed(t("bash", {}, undefined, "done; exited with code 0")), false);
    assert.equal(sig.toolFailed(t("bash", {}, true, "Command exited with code 1")), false); // the source's own flag wins
    const st = sig.workerState({ name: "w", status: "done" }, { lastAssistantText: "x", partialTurn: false, items: [
      { kind: "tool", toolName: "bash", text: '{"command":"make"}' }, { kind: "tool-result", text: "Command exited with code 2" },
    ] }, NOW) as any;
    assert.equal(st.tool_failures.unresolved_failed_calls, 1);
  });

  test("the failure question names the fact and says tone and expectation don't matter; the outcome no longer judges 'against what was asked'", () => {
    const text = JSON.stringify(sig.WORK_FAILED);
    assert.match(text, /unresolved_failed_calls/);
    assert.match(text, /not how calmly it is told or whether the user expected it/);
    assert.doesNotMatch(JSON.stringify(sig.OUTCOME), /against what was asked/);
  });

  test("task-failed fires from work_failed even when the outcome says done (the e2e answers)", async () => {
    const h = harness({}, { asks_user: { p: 0.02 }, work_failed: { p: 0.98 }, outcome: { probabilities: { done: 0.83, partial: 0.01, failed: 0.16, blocked_on_user: 0 } } });
    const path = file(finishedTurn());
    await h.s.classifySession(summary(path), true);
    const wire = store.toWire(h.stored().sessions[summary(path).id]!);
    assert.deepEqual(wire.kinds, ["task-failed"]);
    assert.equal(wire.workFailed, 0.98);
    assert.equal(wire.outcome?.choice, "done");
  });
});

describe("lastSentence: what the digest quotes", () => {
  test("D2: a dot inside a file name, version or path is not a sentence end", () => {
    assert.equal(sig.lastSentence("I can write it. Should I name the file notes.md or todo.md?"), "Should I name the file notes.md or todo.md?");
    assert.equal(sig.lastSentence("The file `/nonexistent/definitely-missing.txt` does not exist."), "The file `/nonexistent/definitely-missing.txt` does not exist.");
    assert.equal(sig.lastSentence("Bumped to v1.2.3. Ship it?"), "Ship it?");
    assert.equal(sig.lastSentence('It said "done." Then it stopped.'), "Then it stopped.");
  });

  test("the last asking sentence among the last three, else the last; code blocks skipped; capped", () => {
    assert.equal(sig.lastSentence("I found two loaders. Which one should I rename? I can also merge them."), "Which one should I rename?");
    assert.equal(sig.lastSentence("Done. Tests pass."), "Tests pass.");
    assert.equal(sig.lastSentence("Is this a question? One. Two. Three."), "Three.");
    assert.equal(sig.lastSentence("Run this.\n```\nwhy? no.\n```\nThen report back"), "Then report back");
    assert.equal(sig.lastSentence(""), "");
    assert.equal(sig.lastSentence(`${"w ".repeat(200)}?`).length, sig.SENTENCE_MAX);
  });
});

describe("state and questions", () => {
  test("every text field is capped; the reply keeps its END (where it asks)", () => {
    const f = { ...sig.turnFacts(finishedTurn())!, lastUser: "u".repeat(10_000), assistantLast: `${"x".repeat(10_000)} DECIDE?` };
    f.tools = Array.from({ length: 30 }, (_, i) => ({ name: "bash", args: "{}", ok: true, result: "r".repeat(1000) + i }));
    const st = sig.turnState("t".repeat(1000), f) as any;
    assert.equal(st.last_user_message.length, sig.CAP.user);
    assert.equal(st.assistant_last.length, sig.CAP.assistant);
    assert.match(st.assistant_last, /DECIDE\?$/);
    assert.equal(st.tool_calls_recent.length, sig.CAP.tools);
    assert.ok(st.tool_calls_recent.every((t: any) => t.summary.length <= sig.CAP.tool));
    assert.ok(JSON.stringify(st).length < 8000);
  });

  test("the stuck question is asked only of a long turn", () => {
    const f = sig.turnFacts(finishedTurn())!;
    assert.deepEqual(Object.keys(sig.turnQuestions(f)), ["asks_user", "outcome", "work_failed"]);
    assert.deepEqual(Object.keys(sig.turnQuestions({ ...f, durationMs: sig.LONG_TURN_MS })), ["asks_user", "outcome", "work_failed", "stuck"]);
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
    assert.deepEqual(Object.keys(req.questions), ["asks_user", "outcome", "work_failed"]);
    const id = summary(path).id;
    const t = h.stored().sessions[id]!;
    assert.equal(t.turnId, "a3");
    assert.equal(t.replyAt, NOW - 60_000);
    assert.equal(t.answers.asks_user?.type, "boolean");
    assert.deepEqual(store.toWire(t).kinds, ["asks-you"]);
    assert.equal(t.detail, "Should I widen it to number | string, or change the caller?");
    assert.equal((store.toWire(t) as any).detail, undefined); // local only: never on the wire
    assert.equal(h.changed(), 1);
    assert.deepEqual(readFileSync(path), bytes);
    // Same turn again: no second call.
    assert.equal(await h.s.classifySession(summary(path), true), false);
    assert.equal(h.provider.calls.length, 1);
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
    writeFileSync(path, readFileSync(path, "utf8") + [user("u9", "a3", "widen it", NOW - 5000), assistant("a9", "u9", NOW - 1000, [{ type: "text", text: "Done: widened." }])].map((e) => JSON.stringify(e)).join("\n") + "\n");
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

  test("tick: nothing at all while the chain has no provider or the feature is off", async () => {
    let listed = 0;
    const list = async () => (listed++, [summary(file(finishedTurn()))]);
    assert.equal(await harness({ provider: () => null, list }).s.tick(), 0);
    assert.equal(await harness({ settings: () => decisionDefaults(), list }).s.tick(), 0);
    assert.equal(listed, 0);
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
  function workerHarness(workers: () => WorkerInfo[], reply: any = { stuck: { probabilities: [0, 0.1, 0.9] }, work_failed: { p: 0.2 }, outcome: { probabilities: { done: 0, partial: 0, failed: 1, blocked_on_user: 0 } } }) {
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
            items: [
              { kind: "task", text: "build it" },
              ...Array.from({ length: 6 }, () => [{ kind: "tool" as const, toolName: "bash", text: '{"command":"pnpm build"}' }, { kind: "tool-result" as const, text: "error" }]).flat(),
            ],
          };
        },
      },
    ]);
    const h = harness({
      list: async () => [parent],
      liveRecords: () => [{ sessionFile: parentPath, pid: 1, rec: { presence: {} } }],
      decodeWorkers: () => workers(),
      adapters: () => adapters,
    }, reply);
    return { ...h, reads };
  }

  test("a worker running > 5 min gets a stuck check, again only after 5 min; looping counts show", async () => {
    const h = workerHarness(() => [worker({ startedAt: NOW - 6 * 60_000 })]);
    assert.equal(await h.s.tick(), 1);
    const req = h.provider.calls[0]!;
    assert.equal(req.purpose, "worker");
    assert.deepEqual(Object.keys(req.questions), ["stuck"]);
    assert.equal((req.state as any).repeats.same_tool_and_args_in_a_row, 6);
    assert.equal(h.stored().workers.w1?.kind, "stuck");
    assert.deepEqual(store.signalTextOf("parent", NOW, h.stored()).stuckWorkers, ["builder"]);
    assert.deepEqual(store.workerSignalsOverlay("parent", { enabled: true, viewing: false }, NOW, h.stored()), { stuck: 1, failed: 0 });
    h.setNow(NOW + 60_000);
    assert.equal(await h.s.tick(), 0);
    h.setNow(NOW + sig.WORKER_STUCK_EVERY_MS);
    assert.equal(await h.s.tick(), 1);
  });

  test("a worker younger than 5 min is not checked; one that just ended gets one outcome check", async () => {
    let w = worker({ startedAt: NOW - 60_000 });
    const h = workerHarness(() => [w]);
    assert.equal(await h.s.tick(), 0);
    w = worker({ startedAt: NOW - 60_000, status: "done", working: false, endedAt: NOW - 1000 });
    assert.equal(await h.s.tick(), 1);
    assert.deepEqual(Object.keys(h.provider.calls[0]!.questions), ["outcome", "work_failed"]);
    assert.equal(await h.s.tick(), 0);
    assert.deepEqual(store.workerSignalsOverlay("parent", { enabled: true, viewing: false }, NOW, h.stored()), { stuck: 0, failed: 1 });
  });

  test("workers of an excluded parent are never read or sent", async () => {
    const h = workerHarness(() => [worker({ startedAt: NOW - 6 * 60_000 })]);
    h.deps.settings = () => on({ exclusions: ["/work"] });
    assert.equal(await h.s.tick(), 0);
    assert.deepEqual(h.reads, []);
  });
});
