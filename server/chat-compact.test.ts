// Run: npx tsx --test server/chat-compact.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR and cwd in the OS temp dir; ~/.pi is never read or written. No model is
// called: the real runtime's compact() is replaced by one that writes through the SAME
// SessionManager.appendCompaction pi's own compact() writes through.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";

const agentDir = mkdtempSync(join(tmpdir(), "sova-compact-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-compact--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, BusyError, compactSession, disposeAllChats } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");

after(async () => {
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

const user = (id: string, parentId: string | null, text: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-09-25T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});
const assistant = (id: string, parentId: string, text: string, input: number) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-09-25T00:00:01.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "anthropic",
    model: "claude-opus-5",
    api: "anthropic-messages",
    stopReason: "stop",
    timestamp: 0,
    usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  },
});
const twoTurns = () => [user("u1", null, "first ask"), assistant("a1", "u1", "first answer", 100), user("u2", "a1", "second ask"), assistant("a2", "u2", "second answer", 200)];

/** A fake for compactSession: `compact()` writes through the wrapped appendCompaction as pi's does. */
function fake(opts: { streaming?: boolean; compacting?: boolean; lastIsCompaction?: boolean; throws?: string; noWrite?: boolean } = {}) {
  const calls: string[] = [];
  const branch = [{ type: "message", id: "u1" }, { type: opts.lastIsCompaction ? "compaction" : "message", id: "a1" }];
  const sessionManager = {
    getBranch: () => branch,
    appendCompaction(summary: string) {
      calls.push(`append:${summary}`);
      return "c1";
    },
  };
  const original = sessionManager.appendCompaction;
  const session = {
    isStreaming: !!opts.streaming,
    isCompacting: !!opts.compacting,
    sessionManager: sessionManager as any,
    async compact(instructions?: string) {
      calls.push(`compact:${instructions ?? ""}`);
      if (opts.throws) throw new Error(opts.throws);
      if (!opts.noWrite) sessionManager.appendCompaction("sum");
      return { tokensBefore: 4242 };
    },
  };
  const hooks = {
    guard: () => void calls.push("guard"),
    allowed: () => void calls.push("allowed"),
    queued: () => false,
    beforeWrite: () => void calls.push("flush"),
  };
  return { session, hooks, calls, restored: () => sessionManager.appendCompaction === original };
}

describe("compactSession", () => {
  test("runs pi's compact with the instructions; the write re-guards and flushes the open-time appends first", async () => {
    const f = fake();
    const out = await compactSession(f.session, "keep the API notes", f.hooks);
    assert.deepEqual(out, { ok: true, entryId: "c1", tokensBefore: 4242 });
    assert.deepEqual(f.calls, ["guard", "allowed", "compact:keep the API notes", "guard", "flush", "append:sum"]);
    assert.ok(f.restored(), "appendCompaction is pi's own again afterwards");
  });

  test("refuses while streaming, compacting, or with a message on its way out — without calling compact", async () => {
    for (const [opts, reason] of [
      [{ streaming: true }, "streaming"],
      [{ compacting: true }, "compacting"],
    ] as const) {
      const f = fake(opts);
      const out = await compactSession(f.session, undefined, f.hooks);
      assert.equal(out.ok, false);
      assert.equal(!out.ok && out.reason, reason);
      assert.ok(!f.calls.some((c) => c.startsWith("compact")), `${reason}: ${f.calls}`);
    }
    const f = fake();
    const out = await compactSession(f.session, undefined, { ...f.hooks, queued: () => true });
    assert.equal(!out.ok && out.reason, "queued");
    assert.ok(!f.calls.some((c) => c.startsWith("compact")));
    // The streaming refusal says why compact() is not simply called: it would abort the turn.
    const s = await compactSession(fake({ streaming: true }).session, undefined, fake().hooks);
    assert.equal(!s.ok && s.message, "Stop the turn first, then compact.");
  });

  test("a TUI-owned file is busy, an unknown writer recent, a switched-off model internal with its reason", async () => {
    for (const [code, reason] of [["busy", "busy"], ["recent", "recent"]] as const) {
      const f = fake();
      const out = await compactSession(f.session, undefined, { ...f.hooks, guard: () => { throw new BusyError(`nope ${code}`, code); } });
      assert.deepEqual(out, { ok: false, reason, message: `nope ${code}` });
    }
    const f = fake();
    const out = await compactSession(f.session, undefined, { ...f.hooks, allowed: () => { throw new Error("x/y is turned off"); } });
    assert.deepEqual(out, { ok: false, reason: "internal", message: "Compaction failed: x/y is turned off" });
    assert.ok(!f.calls.some((c) => c.startsWith("compact")));
  });

  test("a branch that already ends in a compaction is refused before pi announces one", async () => {
    const f = fake({ lastIsCompaction: true });
    const out = await compactSession(f.session, undefined, f.hooks);
    assert.equal(!out.ok && out.reason, "already");
    assert.ok(!f.calls.some((c) => c.startsWith("compact")));
  });

  test("pi's own refusals, a cancel and a failure map to typed reasons, and write nothing — not even the deferred appends", async () => {
    for (const [thrown, reason] of [
      ["Already compacted", "already"],
      ["Nothing to compact (session too small)", "nothing"],
      ["Compaction cancelled", "cancelled"],
      ["summarizer exploded", "internal"],
    ] as const) {
      const f = fake({ throws: thrown });
      const out = await compactSession(f.session, undefined, f.hooks);
      assert.equal(!out.ok && out.reason, reason, thrown);
      assert.ok(!f.calls.includes("flush"), `${thrown}: ${f.calls}`);
      assert.ok(f.restored());
    }
    const f = fake({ throws: "summarizer exploded" });
    const out = await compactSession(f.session, undefined, f.hooks);
    assert.equal(!out.ok && out.message, "Compaction failed: summarizer exploded");
  });

  test("a TUI that grabs the file DURING the summary gets no write: busy, nothing appended or flushed", async () => {
    const f = fake();
    let checks = 0;
    const out = await compactSession(f.session, undefined, {
      ...f.hooks,
      guard: () => {
        if (++checks > 1) throw new BusyError("opened in a TUI", "busy");
      },
    });
    assert.deepEqual(out, { ok: false, reason: "busy", message: "opened in a TUI" });
    assert.ok(!f.calls.includes("flush") && !f.calls.some((c) => c.startsWith("append")), f.calls.join(","));
    assert.ok(f.restored());
  });

  test("success with no compaction entry written is not reported as a compaction", async () => {
    const f = fake({ noWrite: true });
    const out = await compactSession(f.session, undefined, f.hooks);
    assert.equal(!out.ok && out.reason, "internal");
  });
});

describe("/compact through a real chat runtime", () => {
  let n = 0;
  async function open() {
    const id = `cp${++n}`;
    const path = canonicalPath(join(sessionsDir, `2026-09-25T00-00-00-000Z_${id}.jsonl`));
    const header = { type: "session", version: 3, id, timestamp: "2026-09-25T00:00:00.000Z", cwd };
    writeFileSync(path, [header, ...twoTurns()].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const chat = await acquireChat(path, true);
    const mine: ChatServerMessage[] = [];
    const theirs: ChatServerMessage[] = [];
    const me = { send: (m: ChatServerMessage) => void mine.push(m) };
    chat.attach(me);
    chat.attach({ send: (m) => void theirs.push(m) });
    const commands = mine.find((m): m is Extract<ChatServerMessage, { type: "commands" }> => m.type === "commands");
    mine.length = 0;
    theirs.length = 0;
    // pi's compact() minus the model call: the write goes through the same SessionManager method.
    const released: Array<() => void> = [];
    const compacts: Array<string | undefined> = [];
    const session = chat.session as any;
    session.compact = async (instructions?: string) => {
      compacts.push(instructions);
      await new Promise<void>((r) => released.push(r));
      session.sessionManager.appendCompaction("the summary", "u2", 300);
      return { tokensBefore: 300 };
    };
    const prompts: string[] = [];
    session.prompt = async (text: string) => void prompts.push(text);
    const lines = () => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 100 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(pred(), "timed out");
    };
    return { chat, me, mine, theirs, commands, released, compacts, prompts, lines, until, path };
  }

  test("the menu leads with the builtin compact", async () => {
    const t = await open();
    assert.deepEqual(t.commands?.commands[0], { name: "compact", description: t.commands?.commands[0]?.description, source: "builtin" });
    assert.equal(t.commands?.commands.filter((c) => c.name === "compact").length, 1);
  });

  test("a /compact prompt never reaches the model; the write lands after the open-time appends; every client gets the new branch", async () => {
    const t = await open();
    const before = t.lines().length;
    t.chat.handle(t.me, { type: "prompt", text: "/compact keep the decisions", clientId: "k1" });
    await t.until(() => t.compacts.length === 1);
    assert.deepEqual(t.compacts, ["keep the decisions"]);
    assert.equal(t.lines().length, before, "nothing is written while the summary runs");
    assert.ok(t.chat.isCompacting());
    t.released[0]!();
    await t.until(() => t.mine.some((m) => m.type === "compacted"));

    assert.deepEqual(t.prompts, [], "the literal /compact is never sent to the model");
    assert.deepEqual(t.mine[0], { type: "send_ack", clientId: "k1", queued: false });
    assert.deepEqual(t.mine.map((m) => m.type), ["send_ack", "hello", "mode", "queue", "compacted"]);
    assert.deepEqual(t.theirs.map((m) => m.type), ["hello", "mode", "queue"]);
    const done = t.mine.at(-1) as Extract<ChatServerMessage, { type: "compacted" }>;
    const written = t.lines();
    assert.equal(written.at(-1).type, "compaction");
    assert.equal(done.entryId, written.at(-1).id);
    assert.equal(done.tokensBefore, 300);
    assert.equal(done.id, "k1");
    // The open-time thinking entry (no thinking entry on this branch) was deferred; it lands
    // right before the compaction, as it would before a prompt.
    const added = written.slice(before).map((e) => e.type);
    assert.equal(added.at(-1), "compaction");
    assert.ok(added.slice(0, -1).every((t) => t === "thinking_level_change" || t === "model_change"), added.join(","));
    const hello = t.theirs[0] as Extract<ChatServerMessage, { type: "hello" }>;
    assert.equal(hello.items.at(-1)?.kind, "info");
    assert.equal(hello.context, null, "fill is unknown until the next reply");
    assert.equal(hello.isCompacting, false);
  });

  test("a send during the compaction is held, then goes as its own turn after the new branch is out", async () => {
    const t = await open();
    t.chat.handle(t.me, { type: "compact", id: "c1" });
    await t.until(() => t.compacts.length === 1);
    t.chat.handle(t.me, { type: "prompt", text: "after it", clientId: "p1" });
    t.chat.handle(t.me, { type: "steer", text: "and this", clientId: "p2" });
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(t.prompts, [], "pi would refuse a prompt mid-compaction; nothing is handed over");
    assert.ok(t.mine.some((m) => m.type === "send_ack" && m.clientId === "p1" && m.queued));
    assert.ok(t.mine.some((m) => m.type === "send_ack" && m.clientId === "p2" && m.queued));
    // A second /compact while one runs is refused, typed.
    t.chat.handle(t.me, { type: "compact", id: "c2" });
    await t.until(() => t.mine.some((m) => m.type === "compact_refused"));
    assert.equal((t.mine.find((m) => m.type === "compact_refused") as any).reason, "compacting");

    t.released[0]!();
    await t.until(() => t.prompts.length > 0);
    assert.equal(t.prompts[0], "after it");
    const types = t.mine.map((m) => m.type);
    // The queue snapshot follows the hello that reset the pane's rows, and still lists the held items.
    const helloAt = types.indexOf("hello");
    const snap = t.mine.slice(helloAt).find((m) => m.type === "queue") as Extract<ChatServerMessage, { type: "queue" }>;
    assert.deepEqual(snap.items.map((i) => i.id), ["p1", "p2"]);
    assert.ok(helloAt >= 0 && types.indexOf("compacted") > helloAt);
  });

  test("a /compact steer while a turn streams is refused and queues nothing", async () => {
    const t = await open();
    Object.defineProperty(t.chat.session, "isStreaming", { get: () => true, configurable: true });
    t.chat.handle(t.me, { type: "steer", text: "/compact", clientId: "s1" });
    await t.until(() => t.mine.some((m) => m.type === "compact_refused"));
    const refused = t.mine.find((m) => m.type === "compact_refused") as Extract<ChatServerMessage, { type: "compact_refused" }>;
    assert.deepEqual(refused, { type: "compact_refused", id: "s1", reason: "streaming", message: "Stop the turn first, then compact." });
    assert.equal(t.chat.queue.size, 0);
    assert.deepEqual(t.compacts, []);
    delete (t.chat.session as any).isStreaming;
  });

  test("a prompt pi refuses because a compaction just started is held and sent again, never reported as a failure", async () => {
    const t = await open();
    const session = t.chat.session as any;
    let calls = 0;
    session.prompt = async (text: string) => {
      calls++;
      // The gap before isCompacting turns true: pi's own refusal, by its own words.
      if (calls === 1) throw new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");
      t.prompts.push(text);
    };
    t.chat.handle(t.me, { type: "prompt", text: "/skill:x go", clientId: "r1" });
    await t.until(() => t.prompts.length === 1);
    assert.deepEqual(t.prompts, ["/skill:x go"]);
    assert.equal(calls, 2);
    assert.ok(!t.mine.some((m) => m.type === "error"), JSON.stringify(t.mine));
    assert.ok(t.mine.some((m) => m.type === "queue" && m.items.some((i) => i.id === "r1")), "held under the sender's own id");
  });

  test("/compact with an image is refused, not sent to the model and not compacted without it", async () => {
    const t = await open();
    t.chat.handle(t.me, { type: "prompt", text: "/compact", images: [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }] as any, clientId: "i1" });
    await t.until(() => t.mine.some((m) => m.type === "compact_refused"));
    assert.deepEqual(t.mine.find((m) => m.type === "compact_refused"), { type: "compact_refused", id: "i1", reason: "internal", message: "Send /compact without images." });
    assert.deepEqual(t.compacts, []);
    assert.deepEqual(t.prompts, []);
  });

  test("a compaction Sova did not start (ctx.compact from a hook), idle: every client gets the new branch BEFORE a held message's turn starts", async () => {
    const t = await open();
    const session = t.chat.session as any;
    // Held while "pi" compacts: an auto compaction flips pi's own isCompacting.
    Object.defineProperty(session, "isCompacting", { get: () => true, configurable: true });
    t.chat.handle(t.me, { type: "prompt", text: "held", clientId: "h1" });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(t.prompts, []);
    let promptedAt = -1;
    session.prompt = async (text: string) => {
      promptedAt = t.theirs.length;
      t.prompts.push(text);
    };
    delete session.isCompacting;
    session.sessionManager.appendCompaction("hook summary", "u2", 300);
    t.theirs.length = 0;
    session._emit({ type: "compaction_end", reason: "manual", result: { summary: "hook summary", tokensBefore: 300 }, aborted: false, willRetry: false });
    await t.until(() => t.prompts.length === 1);
    const types = t.theirs.map((m) => m.type);
    assert.deepEqual(types.slice(0, 4), ["event", "hello", "mode", "queue"]);
    assert.ok(promptedAt > types.indexOf("hello"), `turn started at ${promptedAt}, hello at ${types.indexOf("hello")}`);
    const hello = t.theirs[1] as Extract<ChatServerMessage, { type: "hello" }>;
    assert.equal(hello.items.at(-1)?.kind, "info", "the compaction row is on the pane, live");
    assert.deepEqual((t.theirs[3] as Extract<ChatServerMessage, { type: "queue" }>).items.map((i) => i.id), ["h1"]);
  });

  test("a compaction that lands mid-turn refreshes at that turn's agent_settled, never inside it", async () => {
    const t = await open();
    const session = t.chat.session as any;
    Object.defineProperty(session, "isStreaming", { get: () => true, configurable: true });
    session.sessionManager.appendCompaction("overflow summary", "u2", 300);
    session._emit({ type: "compaction_end", reason: "overflow", result: { summary: "overflow summary", tokensBefore: 300 }, aborted: false, willRetry: true });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!t.theirs.some((m) => m.type === "hello"), "no hello while the turn streams");
    delete session.isStreaming;
    session._emit({ type: "agent_settled" });
    await t.until(() => t.theirs.some((m) => m.type === "hello"));
    assert.equal(t.theirs.filter((m) => m.type === "hello").length, 1);
  });

  test("a failed or cancelled compaction (no result) refreshes nothing", async () => {
    const t = await open();
    (t.chat.session as any)._emit({ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false });
    (t.chat.session as any)._emit({ type: "agent_settled" });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(!t.theirs.some((m) => m.type === "hello"));
  });

  test("pi's automatic path: isCompacting is still true DURING compaction_end, yet the refresh's hello says false", async () => {
    const t = await open();
    const session = t.chat.session as any;
    session.sessionManager.appendCompaction("threshold summary", "u2", 300);
    Object.defineProperty(session, "isCompacting", { get: () => true, configurable: true });
    session._emit({ type: "compaction_end", reason: "threshold", result: { summary: "threshold summary", tokensBefore: 300 }, aborted: false, willRetry: false });
    delete session.isCompacting; // pi's finally, right after the emit returns
    await t.until(() => t.theirs.some((m) => m.type === "hello"));
    const hello = t.theirs.find((m) => m.type === "hello") as Extract<ChatServerMessage, { type: "hello" }>;
    assert.equal(hello.isCompacting, false);
  });
});
