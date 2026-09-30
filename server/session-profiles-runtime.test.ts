// Run: npx tsx --test server/session-profiles-runtime.test.ts (or pnpm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written.
//
// Session profiles in real runtimes (§chat.profiles/enforcement, /applying, /singleton,
// /session-tools, /limits, /delivery): runs are real SDK runs up to the model call, and only the
// model is a stub (the test dir has no credentials), as in overseer-runtime.test.ts.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import type { ChatServerMessage, SessionSummary } from "../shared/protocol";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-profiles-runtime-")));
process.on("exit", () => rmSync(agentDir, { recursive: true, force: true }));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Stand-ins for the subagents and link extensions' tools (the removals must take them), and this
// repo's mode extension by its real path, so strict mode really rewrites the active tools.
mkdirSync(join(agentDir, "extensions"), { recursive: true });
writeFileSync(
  join(agentDir, "extensions", "fake-tools.ts"),
  `export default function (pi) {
  const reg = (name) => pi.registerTool({ name, label: name, description: name, parameters: { type: "object", properties: {}, additionalProperties: true }, execute: async () => ({ content: [{ type: "text", text: name }], details: {} }) });
  for (const n of ["agent_spawn", "agent_list", "team_create", "link_send", "web_search", "wake_nudge", "worktree"]) reg(n);
  // An extension that later re-registers and re-activates bash, as the sandbox does.
  pi.on("session_start", () => {
    pi.registerTool({ name: "bash", label: "bash", description: "sandboxed bash", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "ran" }], details: {} }) });
    pi.setActiveTools([...pi.getActiveTools(), "bash", "edit", "write", "agent_spawn"]);
  });
}
`,
);
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({ retry: { baseDelayMs: 1 }, extensions: [resolve(dirname(fileURLToPath(import.meta.url)), "../pi-config/extensions/mode")] }),
);
const sessionsDir = join(agentDir, "sessions", "--tmp-profiles--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, disposeAllChats, heldChat } = await import("./chat-manager");
const { canonicalPath } = await import("./paths");
const { archiveSession, getSessionSummary } = await import("./sessions-index");
const { normalizeEntries, readActiveBranch } = await import("./transcript");
const { applyProfile } = await import("./session-profile-routes");
const { sessionActionsFile } = await import("./session-powers");
const { BUILTIN_PROFILES, PROFILE_ENTRY, SESSION_SENT_ENTRY } = await import("../shared/profiles");
const { overseerTools, TurnLimits } = await import("./overseer-tools");
const { DEFAULT_CAPS } = await import("./overseer-store");
const { addWebSession } = await import("./web-sessions");
const { markOwned } = await import("./write-guard");

after(async () => {
  await disposeAllChats();
});

const profile = (id: string) => ({ ...BUILTIN_PROFILES.find((p) => p.id === id)!, builtin: true });
let n = 0;
/** A web session file: its header, and a profile entry when given. */
function makeSession(p?: unknown, where = cwd, talked = false): string {
  const id = `0199aaaa-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const path = canonicalPath(join(sessionsDir, `2026-09-30T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`));
  const lines: unknown[] = [{ type: "session", version: 3, id, timestamp: "2026-09-30T00:00:00.000Z", cwd: where }];
  if (p !== undefined) lines.push({ type: "custom", id: `p${n}`, parentId: null, timestamp: "2026-09-30T00:00:00.100Z", customType: PROFILE_ENTRY, data: { v: 1, profile: p } });
  // A session the list shows (an empty one is never listed): one exchange.
  if (talked) {
    const parent = p !== undefined ? `p${n}` : null;
    lines.push({ type: "message", id: `u${n}`, parentId: parent, timestamp: "2026-09-30T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: `task ${n}` }], timestamp: 0 } });
    lines.push({
      type: "message", id: `a${n}`, parentId: `u${n}`, timestamp: "2026-09-30T00:00:02.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "done" }], provider: "stub", model: "stub", api: "stub", stopReason: "stop", timestamp: 0, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    });
  }
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  markOwned(path);
  addWebSession(id);
  return path;
}
const idOfPath = (path: string) => JSON.parse(readFileSync(path, "utf8").split("\n")[0]!).id as string;
const entries = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

type Chat = Awaited<ReturnType<typeof acquireChat>>;
const TEST_MODEL = {
  id: "stub", name: "stub", api: "stub", provider: "stub", baseUrl: "http://127.0.0.1:9", reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000,
};
type StubReply = { toolCall: { name: string; arguments: Record<string, unknown> } } | void;
/** Per session id: its model calls, in order (a hook may hold the reply back). */
const calls = new Map<string, Array<() => Promise<StubReply> | StubReply>>();
/** Let a runtime run without credentials: auth passes, and the model is a stub. */
function fakeRuns(chat: Chat): void {
  const session = chat.session as unknown as {
    _modelRuntime: { hasConfiguredAuth(p: string): boolean };
    agent: { state: { model: unknown }; getApiKey: unknown; streamFunction: unknown };
    sessionManager: { getSessionId(): string };
  };
  const sid = session.sessionManager.getSessionId();
  session._modelRuntime.hasConfiguredAuth = () => true;
  session.agent.state.model = TEST_MODEL;
  session.agent.getApiKey = async () => "stub";
  session.agent.streamFunction = async () => {
    const reply = (await calls.get(sid)?.shift()?.()) ?? undefined;
    const call = reply?.toolCall;
    const message = {
      role: "assistant", api: "stub", provider: "stub", model: "stub", timestamp: Date.now(),
      content: call ? [{ type: "toolCall", id: `tc-${Date.now()}-${Math.random()}`, name: call.name, arguments: call.arguments }] : [{ type: "text", text: "ok" }],
      stopReason: call ? "toolUse" : "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: call ? "toolUse" : "stop", message }; }, result: async () => message };
  };
}
async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const sink = () => {
  const got: ChatServerMessage[] = [];
  return { got, client: { send: (m: ChatServerMessage) => void got.push(m) } };
};
const send = (target: string, text: string, extra: Record<string, unknown> = {}) => ({ toolCall: { name: "session_send", arguments: { session: target, text, ...extra } } });
const auditLines = () => {
  try {
    return readFileSync(sessionActionsFile(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};

describe("removals hold in the runtime (excludeTools)", () => {
  test("a Read-only reviewer has no shell, edits or workers, even after strict mode and a re-registration", async () => {
    const path = makeSession(profile("reviewer"));
    const chat = await acquireChat(path, true);
    const active = () => chat.session.getActiveToolNames();
    for (const t of ["bash", "edit", "write", "agent_spawn", "agent_list", "team_create"]) assert.ok(!active().includes(t), `${t} must be gone`);
    for (const t of ["read", "session_list", "session_detail", "session_read"]) assert.ok(active().includes(t), `${t} must be there`);
    assert.ok(!active().includes("session_send"), "reading does not grant sending");
    // Strict delegate hides edit/write and restores its snapshot on the way out: nothing comes back.
    const cmd = chat.session.extensionRunner.getCommand("mode")!;
    const ctx = chat.session.extensionRunner.createCommandContext();
    await cmd.handler("delegate", ctx);
    await cmd.handler("strict on", ctx);
    await cmd.handler("strict off", ctx);
    await cmd.handler("normal", ctx);
    chat.session.setActiveToolsByName(["read", "bash", "edit", "agent_spawn"]);
    for (const t of ["bash", "edit", "write", "agent_spawn"]) assert.ok(!active().includes(t), `${t} came back`);
    assert.ok(!chat.session.getAllTools().some((t) => t.name === "bash"), "not even in the registry");
  });

  test("a Default session is exactly as before: every tool, and no session tools", async () => {
    const chat = await acquireChat(makeSession(), true);
    const active = chat.session.getActiveToolNames();
    for (const t of ["bash", "edit", "write", "agent_spawn", "web_search"]) assert.ok(active.includes(t), t);
    assert.ok(!active.some((t) => t.startsWith("session_")));
  });
});

describe("applying a pick (§chat.profiles/applying)", () => {
  test("a pick writes the entry and reopens the runtime with it; once a message is sent it is refused", async () => {
    const path = makeSession();
    const first = await acquireChat(path, true);
    const { got, client } = sink();
    first.attach(client);
    assert.equal((got.find((m) => m.type === "profile") as { profile: unknown } | undefined)?.profile, null, "a pristine Default session hears its profile");
    assert.deepEqual(await applyProfile(path, "reviewer"), { ok: true });
    assert.ok(got.some((m) => m.type === "error" && m.code === "reloaded"), "open tabs reconnect");
    assert.ok(first.disposed);
    assert.equal(entries(path).filter((e) => e.customType === PROFILE_ENTRY).length, 1);
    const again = await acquireChat(path, true);
    assert.ok(!again.session.getActiveToolNames().includes("bash"));
    assert.equal((await getSessionSummary(path))?.profile?.id, "reviewer");
    // Back to Default: a new entry, newest wins.
    assert.deepEqual(await applyProfile(path, null), { ok: true });
    assert.ok((await acquireChat(path, true)).session.getActiveToolNames().includes("bash"));
    assert.equal((await getSessionSummary(path))?.profile, undefined);
    // A message on the branch fixes it.
    const withMsg = makeSession(profile("reviewer"));
    const lines = entries(withMsg);
    lines.push({ type: "message", id: "u1", parentId: "p" + n, timestamp: "2026-09-30T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } });
    writeFileSync(withMsg, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    markOwned(withMsg);
    const r = await applyProfile(withMsg, "mini-overseer");
    assert.deepEqual(r.ok ? null : [r.status, r.error], [409, "The profile is fixed once a message is sent."]);
  });

  test("the entry draws no row before the first message, so the empty state stays", async () => {
    const path = makeSession(profile("reviewer"));
    const items = normalizeEntries(await readActiveBranch(path));
    assert.equal(items.length, 1);
    assert.deepEqual(items[0]?.profileMark?.profile?.id, "reviewer");
    // …and it is listed, so a session that holds a profile is never out of reach.
    assert.equal((await (await import("./sessions-index")).listSessions()).find((x) => x.path === path)?.profile?.id, "reviewer");
  });
});

describe("One at a time (§chat.profiles/singleton)", () => {
  test("a second pick is refused naming the holder; after the holder is archived it is allowed", async () => {
    const a = makeSession();
    const b = makeSession();
    assert.deepEqual(await applyProfile(a, "merge-captain"), { ok: true });
    const refused = await applyProfile(b, "merge-captain");
    assert.ok(!refused.ok);
    assert.equal(!refused.ok && refused.error, "Merge captain is already running. It's set to One at a time, so only 1 session can use it.");
    assert.equal(!refused.ok && refused.running?.path, a);
    assert.ok(!entries(b).some((e) => e.customType === PROFILE_ENTRY), "nothing was written");
    await disposeAllChats();
    assert.equal((await archiveSession(a, true)).ok, true);
    assert.deepEqual(await applyProfile(b, "merge-captain"), { ok: true });
  });

  test("race at Send: the first message is refused, nothing written, naming the session that has it", async () => {
    const a = makeSession(profile("merge-captain"));
    const b = makeSession(profile("merge-captain"));
    const chat = await acquireChat(b, true);
    const { got, client } = sink();
    const before = readFileSync(b, "utf8");
    chat.handle(client, { type: "prompt", text: "merge everything", clientId: "c1" });
    await until(() => got.some((m) => m.type === "error"));
    const err = got.find((m) => m.type === "error") as Extract<ChatServerMessage, { type: "error" }>;
    assert.equal(err.message, "Merge captain started in another session. Nothing was sent. Open it or pick another profile.");
    assert.equal(err.clientId, "c1", "the composer gets its draft back");
    assert.ok(err.profileRunning && [a, b].includes(err.profileRunning.path) && err.profileRunning.path !== b);
    assert.equal(readFileSync(b, "utf8"), before);
    await disposeAllChats();
    await archiveSession(a, true);
    await archiveSession(b, true);
  });
});

describe("session_send between sessions (§chat.profiles/session-tools, /delivery, /limits)", () => {
  test("a captain messages an idle session and a busy one; the marks, header, queue row, hop and audit are right", async () => {
    await disposeAllChats();
    const captain = makeSession({ ...profile("merge-captain"), singleton: false, id: "captain-a" });
    const mini = makeSession(profile("mini-overseer"), cwd, true);
    const other = makeSession(undefined, cwd, true);
    const busy = makeSession(undefined, cwd, true);
    const [cid, mid, oid, bid] = [captain, mini, other, busy].map(idOfPath) as [string, string, string, string];
    const chats = await Promise.all([captain, mini, other, busy].map((p) => acquireChat(p, true)));
    for (const c of chats) fakeRuns(c);
    const [cap, miniChat, otherChat, busyChat] = chats as [Chat, Chat, Chat, Chat];
    // Keep `busy` mid-turn until released.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    calls.set(bid, [() => held]);
    busyChat.acceptPrompt("long task");
    await until(() => busyChat.session.isStreaming);
    const { got: busyGot, client: busyClient } = sink();
    busyChat.attach(busyClient);
    // The captain sends to the mini overseer (which relays to `other` with hop 2), and to `busy`.
    calls.set(cid, [() => send(mid, "please relay"), () => send(bid, "you're next"), () => undefined]);
    calls.set(mid, [() => send(oid, "relayed"), () => undefined]);
    calls.set(oid, [() => undefined]);
    const { client } = sink();
    cap.handle(client, { type: "prompt", text: "merge everything that's ready" });
    await until(() => entries(other).some((e) => e.customType === SESSION_SENT_ENTRY), 6000);
    await until(() => busyGot.some((m) => m.type === "queue" && m.items.some((i) => i.fromSession)));
    const row = (busyGot.filter((m) => m.type === "queue").at(-1) as Extract<ChatServerMessage, { type: "queue" }>).items[0]!;
    assert.deepEqual(row.fromSession, { sessionId: cid, title: "merge everything that's ready" });
    release();
    await until(() => entries(busy).some((e) => e.customType === SESSION_SENT_ENTRY));
    for (const c of chats) await c.session.waitForIdle();

    const markOf = (path: string) => {
      const es = entries(path);
      const m = es.find((e) => e.customType === SESSION_SENT_ENTRY)!;
      const target = es.find((e) => e.id === m.data.targetId)!;
      return { data: m.data, text: target.message.content.map((c: { text?: string }) => c.text ?? "").join("") as string };
    };
    const toMini = markOf(mini);
    assert.deepEqual(toMini.data, { v: 1, targetId: toMini.data.targetId, from: { sessionId: cid, title: "merge everything that's ready" }, hop: 1 });
    assert.equal(toMini.text, `[from session "merge everything that's ready" (${cid}), hop 1]\nplease relay`);
    assert.equal(markOf(other).data.hop, 2, "a send in a run a session's message opened carries its hop plus 1");
    assert.equal(markOf(other).data.from.sessionId, mid);
    assert.equal(markOf(busy).data.hop, 1);
    // On reload: the transcript row carries the mark.
    await disposeAllChats();
    const items = normalizeEntries(await readActiveBranch(other));
    assert.equal(items.find((i) => i.sessionMark)?.sessionMark?.from.sessionId, mid);
    // The audit: every send, with its hop, never its text.
    const sends = auditLines().filter((l) => l.tool === "session_send");
    assert.deepEqual(
      sends.map((l) => [l.sessionId, l.target, l.hop, l.outcome]),
      [
        [cid, mid, 1, "ok"],
        [mid, oid, 2, "ok"],
        [cid, bid, 1, "ok"],
      ].sort((x, y) => sends.findIndex((l) => l.target === x[1]) - sends.findIndex((l) => l.target === y[1])),
    );
    assert.ok(!JSON.stringify(sends).includes("please relay"));
    void miniChat;
    void otherChat;
  });

  test("refusals: itself, a hidden or unseen session, and the hop limit; each takes nothing and is audited", async () => {
    await disposeAllChats();
    const hopOne = { ...profile("merge-captain"), singleton: false, id: "captain-copy", limits: { ...profile("merge-captain").limits, hops: 1 } };
    const a = makeSession(hopOne);
    const elsewhere = makeSession(undefined, agentDir, true);
    const narrow = makeSession(profile("mini-overseer"));
    const [aid, eid] = [a, elsewhere].map(idOfPath) as [string, string];
    const chat = await acquireChat(a, true);
    const tool = (name: string) => chat.session.agent.state.tools.find((t) => t.name === name)!;
    const run = (params: Record<string, unknown>) =>
      tool("session_send")
        .execute("tc", params as never)
        .then(
          (r) => (r.content[0] as { text: string }).text,
          (e: Error) => `ERROR: ${e.message}`,
        );
    assert.equal(await run({ session: aid, text: "x" }), "ERROR: That is this session; it never reads or messages itself.");
    assert.equal(await run({ session: "nope", text: "x" }), "ERROR: No session with id nope that this session can see.");
    const limits = chat.profileState!.limits!;
    const before = limits.counts();
    (chat.profileState!.run as { hop: number }).hop = 1;
    assert.match(await run({ session: eid, text: "x" }), /^ERROR: Hop limit: this message would be hop 2, and this profile allows up to 1/);
    assert.deepEqual(limits.counts(), before, "a refusal takes nothing");
    // The mini overseer sees only its folder.
    const miniChat = await acquireChat(narrow, true);
    const list = await miniChat.session.agent.state.tools.find((t) => t.name === "session_list")!.execute("tc", {} as never);
    assert.ok(!(list.content[0] as { text: string }).text.includes(eid), "a session in another folder is not listed");
    assert.ok(auditLines().some((l) => l.sessionId === aid && l.outcome === "refused" && /Hop limit/.test(l.error)));
  });

  test("a wake-up turn may send, on the day's allowance", async () => {
    await disposeAllChats();
    const a = makeSession({ ...profile("merge-captain"), singleton: false, id: "captain-wake" });
    const b = makeSession(undefined, cwd, true);
    const [aid, bid] = [a, b].map(idOfPath) as [string, string];
    const [ca, cb] = [await acquireChat(a, true), await acquireChat(b, true)];
    fakeRuns(ca);
    fakeRuns(cb);
    calls.set(aid, [() => send(bid, "checking in"), () => undefined]);
    calls.set(bid, [() => undefined]);
    ca.acceptPrompt("[wake_nudge n1] check the teams");
    await until(() => entries(b).some((e) => e.customType === SESSION_SENT_ENTRY));
    await ca.session.waitForIdle();
    assert.deepEqual(ca.profileState!.limits!.counts().own, 1);
    assert.deepEqual(ca.profileState!.limits!.counts().turn, 0);
  });
});

describe("the Overseer may start only profiles marked for it (§app.overseer/tools)", () => {
  function harness(sessions: SessionSummary[]) {
    const requests: string[] = [];
    const host = {
      request: async (path: string, init?: RequestInit) => {
        requests.push(`${path} ${init?.body ?? ""}`);
        return Response.json({ id: "new", path: "/s/new.jsonl", title: "Untitled", cwd }, { status: 201 });
      },
      overseerId: () => "ov",
      confirmed: () => null,
      caps: () => DEFAULT_CAPS,
      sessions: async () => sessions,
      started: () => {},
      runningStarted: () => 0,
      counted: () => false,
      attended: () => true,
    } as unknown as Parameters<typeof overseerTools>[0];
    const create = overseerTools(host, new TurnLimits()).find((t) => t.name === "sova_create_session")!;
    const call = (p: Record<string, unknown>) => create.execute("tc", p as never, undefined, undefined, undefined as never);
    return { call, requests };
  }

  test("a saved profile not marked is refused before anything is created", async () => {
    const { writeProfiles } = await import("./profiles-store");
    writeProfiles({ version: 1, profiles: [{ id: "spec-auditor", label: "Spec auditor", icon: "eye", remove: ["edit"], grant: ["sessions.read"], overseerMayStart: false }], hiddenBuiltins: [] });
    const h = harness([]);
    await assert.rejects(h.call({ cwd, profile: "spec-auditor" }), /isn't marked "The Overseer may start it"/);
    await assert.rejects(h.call({ cwd, profile: "nope" }), /No profile "nope"/);
    assert.deepEqual(h.requests, []);
  });

  test("a live One at a time profile answers with its card and creates nothing; a free one is passed to the route", async () => {
    const holder = { id: "cap1", path: "/s/cap1.jsonl", title: "Merge round", archived: false, profile: { id: "merge-captain", label: "Merge captain", icon: "branch", singleton: true } } as SessionSummary;
    const busy = harness([holder]);
    const r = await busy.call({ cwd, profile: "merge-captain" });
    assert.deepEqual((r.details as { refused?: string; running?: { id: string } }).refused, "singleton");
    assert.equal((r.details as { open: string }).open, "Open the Running Merge Captain");
    assert.deepEqual(busy.requests, []);
    const free = harness([]);
    await free.call({ cwd, profile: "reviewer" });
    assert.match(free.requests[0] ?? "", /^\/api\/sessions .*"profile":"reviewer"/);
  });
});
