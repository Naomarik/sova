// Run: npx tsx --test server/overseer-markers.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR and cwd in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { OVERSEER_DIALOG_ANSWER_ENTRY, OVERSEER_ENTRY, OVERSEER_SENT_ENTRY, type ChatServerMessage } from "../shared/protocol";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-overseer-markers-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
const sessionsDir = join(agentDir, "sessions", "--tmp-overseer--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, BusyError, disposeAllChats, isOverseerFile, REWIND_ENTRY, resolveRegenerate } = await import("./chat-manager");
const { normalizeEntries, normalizeEntry } = await import("./transcript");
const { canonicalPath } = await import("./paths");
const { getSessionSummary } = await import("./sessions-index");
// Registers the Overseer runtime loadout with chat-manager, as index.ts does.
const overseer = await import("./overseer");
const { writeOverseerState } = await import("./overseer-store");

after(async () => {
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

const user = (id: string, parentId: string | null, text: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-09-20T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});
const assistant = (id: string, parentId: string, text: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2026-09-20T00:00:01.000Z",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    provider: "anthropic",
    model: "claude-opus-5",
    api: "anthropic-messages",
    stopReason: "stop",
    timestamp: 0,
    usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  },
});
const sent = (id: string, parentId: string, targetId: string) => ({
  type: "custom",
  id,
  parentId,
  timestamp: "2026-09-20T00:00:00.500Z",
  customType: OVERSEER_SENT_ENTRY,
  data: { v: 1, targetId, overseerId: "ov" },
});

describe("marker entries in the transcript", () => {
  test("a sent marker is an info row with no text, pointing at its user row; the user row itself is untouched", () => {
    const items = normalizeEntries([user("u1", null, "run the tests"), sent("m1", "u1", "u1"), assistant("a1", "m1", "ok")]);
    const marker = items.find((i) => i.id === "m1");
    assert.deepEqual({ kind: marker?.kind, text: marker?.text, mark: marker?.overseerMark }, { kind: "info", text: undefined, mark: { kind: "sent", targetId: "u1" } });
    const u = items.find((i) => i.id === "u1");
    assert.equal(u?.kind, "user");
    assert.equal(u?.text, "run the tests");
  });

  test("a dialog answer is the machine row 'Overseer chose: X'", () => {
    const [row] = normalizeEntry({ type: "custom", id: "d1", customType: OVERSEER_DIALOG_ANSWER_ENTRY, data: { v: 1, title: "Overwrite?", answer: "Yes" } });
    assert.equal(row?.kind, "info");
    assert.equal(row?.text, "Overseer chose: Yes");
    assert.deepEqual(row?.overseerMark, { kind: "dialog-answer", title: "Overwrite?", answer: "Yes" });
  });

  test("the Overseer marker itself renders nothing; a sent marker without a target renders nothing", () => {
    assert.deepEqual(normalizeEntry({ type: "custom", id: "o", customType: OVERSEER_ENTRY, data: { v: 1 } }), []);
    assert.deepEqual(normalizeEntry({ type: "custom", id: "s", customType: OVERSEER_SENT_ENTRY, data: { v: 1 } }), []);
  });

  test("regenerating the reply to an Overseer-sent message walks back past the marker to that message", () => {
    const branch = [user("u1", null, "run the tests"), sent("m1", "u1", "u1"), assistant("a1", "m1", "ok")];
    const r = resolveRegenerate(branch, "a1:0");
    assert.deepEqual(r, { ok: true, userId: "u1", text: "run the tests" });
  });
});

describe("rewind on an Overseer-sent user row (real runtime)", () => {
  test("rewinding to the marked message behaves exactly as on any user turn, and survives a reopen", async () => {
    const path = canonicalPath(join(sessionsDir, "2026-09-20T00-00-00-000Z_ovs1.jsonl"));
    const header = { type: "session", version: 3, id: "ovs1", timestamp: "2026-09-20T00:00:00.000Z", cwd };
    const entries = [user("u1", null, "first ask"), assistant("a1", "u1", "first answer"), user("u2", "a1", "sent by the overseer"), sent("m2", "u2", "u2"), assistant("a2", "m2", "second answer")];
    writeFileSync(path, [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");

    const chat = await acquireChat(path, true);
    const got: ChatServerMessage[] = [];
    const me = { send: (m: ChatServerMessage) => void got.push(m) };
    chat.attach(me);
    const hello = got.find((m) => m.type === "hello") as Extract<ChatServerMessage, { type: "hello" }>;
    assert.ok(hello.items.some((i) => i.overseerMark?.kind === "sent" && i.overseerMark.targetId === "u2"));
    got.length = 0;

    chat.handle(me, { type: "rewind", id: "r1", entryId: "u2" });
    for (let i = 0; i < 50 && !got.some((m) => m.type === "rewound" || m.type === "rewind_refused"); i++) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(got.at(-1), { type: "rewound", id: "r1", entryId: "u2", editorText: "sent by the overseer" });

    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const last = lines.at(-1);
    assert.equal(last.customType, REWIND_ENTRY);
    assert.deepEqual(last.data, { targetId: "u2", fromLeafId: "a2" });
    // The new branch reaches a1 and never the marked message or its marker (the open-time appends
    // flushed before the rewind marker may sit between).
    const byId = new Map(lines.map((e) => [e.id, e]));
    const ancestry: string[] = [];
    for (let e = byId.get(last.parentId); e; e = byId.get(e.parentId)) ancestry.push(e.id);
    assert.ok(ancestry.includes("a1") && !ancestry.includes("u2") && !ancestry.includes("m2"), ancestry.join(" <- "));

    await disposeAllChats();
    const reopened = await acquireChat(path, true);
    const again: ChatServerMessage[] = [];
    reopened.attach({ send: (m) => void again.push(m) });
    const h2 = again.find((m) => m.type === "hello") as Extract<ChatServerMessage, { type: "hello" }>;
    assert.deepEqual(h2.items.filter((i) => i.kind === "user" || i.kind === "assistant-text").map((i) => i.id), ["u1", "a1:0"]);
    assert.ok(!h2.items.some((i) => i.overseerMark), "the marker went with its message");
  });
});

describe("the Overseer file", () => {
  test("ensureOverseer makes one marked file, hidden by its summary flag, and returns the same one after", async () => {
    const first = await overseer.ensureOverseer();
    const again = await overseer.ensureOverseer();
    assert.equal(again.path, first.path);
    const lines = readFileSync(first.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines[1].customType, OVERSEER_ENTRY);
    assert.equal((await getSessionSummary(first.path))?.overseer, true);
    assert.equal(overseer.hasOverseerMarker(first.path), true);
  });

  test("its runtime gets only the allowlisted tools and the Overseer prompt, appended", async () => {
    const { path } = await overseer.ensureOverseer();
    const chat = await acquireChat(path);
    assert.equal(chat.overseer, true);
    assert.ok(isOverseerFile(chat.session.sessionManager));
    const active = chat.session.getActiveToolNames();
    assert.ok(active.includes("sova_attention") && active.includes("sova_confirm"), active.join(","));
    for (const banned of ["bash", "edit", "write"]) assert.ok(!active.includes(banned), `${banned} must not be active`);
    assert.ok(active.every((n) => n.startsWith("sova_") || ["read", "grep", "find", "ls", "wake_nudge"].includes(n)), active.join(","));
    assert.match(chat.session.systemPrompt, /You are the one Overseer/);
  });

  test("its read/grep/find/ls refuse secret files; an ordinary session's are pi's own", async () => {
    const { SECRET_REFUSAL } = await import("./overseer-deny");
    writeFileSync(join(agentDir, "auth.json"), '{"zai":{"key":"SECRET-KEY-MARKER"}}\n');
    writeFileSync(join(cwd, "plain.txt"), "plain words\n");
    const run = async (chat: Awaited<ReturnType<typeof acquireChat>>, name: string, params: Record<string, unknown>) => {
      const tool = chat.session.agent.state.tools.find((t) => t.name === name)!;
      try {
        const r = await tool.execute("tc", params as never);
        return (r.content as { text?: string }[]).map((c) => c.text ?? "").join("");
      } catch (err) {
        return `ERROR: ${err instanceof Error ? err.message : String(err)}`;
      }
    };
    const ov = await acquireChat((await overseer.ensureOverseer()).path);
    assert.equal(await run(ov, "read", { path: join(agentDir, "auth.json") }), `ERROR: ${SECRET_REFUSAL}`);
    assert.equal(await run(ov, "grep", { pattern: "SECRET-KEY-MARKER", path: agentDir }), "No matches found");
    assert.doesNotMatch(await run(ov, "ls", { path: agentDir }), /auth\.json/);
    assert.doesNotMatch(await run(ov, "find", { pattern: "*.json", path: agentDir }), /auth\.json/);
    assert.match(await run(ov, "read", { path: join(cwd, "plain.txt") }), /plain words/);

    const path = canonicalPath(join(sessionsDir, "2026-09-20T00-00-00-000Z_plainread.jsonl"));
    const header = { type: "session", version: 3, id: "plainread", timestamp: "2026-09-20T00:00:00.000Z", cwd };
    writeFileSync(path, [header, user("u1", null, "hi"), assistant("a1", "u1", "hello")].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const plain = await acquireChat(path, true);
    assert.match(await run(plain, "read", { path: join(agentDir, "auth.json") }), /SECRET-KEY-MARKER/, "other sessions are unchanged");
    rmSync(join(agentDir, "auth.json"));
  });

  test("a previous Overseer file is read-only: its chat is refused as busy", async () => {
    const old = await overseer.ensureOverseer();
    const info = await overseer.clearOverseer();
    assert.notEqual(info.path, old.path);
    assert.deepEqual(info.history.map((h) => h.path), [old.path]);
    await assert.rejects(acquireChat(old.path, true), (err: unknown) => err instanceof BusyError && err.code === "busy");
    const cur = await acquireChat(info.path);
    assert.equal(cur.overseer, true);
  });

  test("a fork of an Overseer file (what /explain's `pi --fork` makes) carries the marker but is an ordinary session", async () => {
    const cur = await overseer.ensureOverseer();
    const { dirname } = await import("node:path");
    // The fork: the Overseer file's entries (marker included) under a new header, beside it.
    const forkId = "01a0d000-0000-7000-8000-00000000f0c1";
    const forkPath = canonicalPath(join(dirname(cur.path), `2026-09-20T00-00-00-000Z_${forkId}.jsonl`));
    const [, ...entries] = readFileSync(cur.path, "utf8").trim().split("\n");
    const header = { type: "session", version: 3, id: forkId, timestamp: "2026-09-20T00:00:00.000Z", cwd, parentSession: cur.path };
    const marker = entries.map((l) => JSON.parse(l)).find((e) => e.customType === OVERSEER_ENTRY);
    writeFileSync(forkPath, [JSON.stringify(header), ...entries, JSON.stringify(user("fu1", marker.id, "explain this")), JSON.stringify(assistant("fa1", "fu1", "sure"))].join("\n") + "\n");
    assert.equal(overseer.hasOverseerMarker(forkPath), true, "the fork does carry the marker, so the checks below mean something");

    assert.equal((await getSessionSummary(forkPath))?.overseer, undefined, "listed, searchable, counted like any session");
    assert.equal((await getSessionSummary(cur.path))?.overseer, true, "the current one still is the Overseer");
    const chat = await acquireChat(forkPath, true);
    assert.equal(chat.overseer, false);
    assert.equal(isOverseerFile(chat.session.sessionManager), false);
    const active = chat.session.getActiveToolNames();
    assert.ok(!active.some((n) => n.startsWith("sova_")), `the ordinary loadout: ${active.join(",")}`);
    assert.doesNotMatch(chat.session.systemPrompt, /You are the one Overseer/);

    // History files stay the Overseer's (read-only) after a clear; the fork stays ordinary.
    const info = await overseer.clearOverseer();
    assert.ok(info.history.some((h) => h.id === cur.id));
    assert.equal((await getSessionSummary(cur.path))?.overseer, true);
    assert.equal((await getSessionSummary(forkPath))?.overseer, undefined);
  });

  test("a stale state pointing at a missing file gets a fresh Overseer", async () => {
    writeOverseerState({ version: 1, current: "gone-id", history: [] });
    const made = await overseer.ensureOverseer();
    assert.notEqual(made.id, "gone-id");
    assert.equal(overseer.hasOverseerMarker(made.path), true);
  });
});

describe("POST /api/sessions/prompt's rule (promptIdleSession)", () => {
  const make = (id: string) => {
    const path = canonicalPath(join(sessionsDir, `2026-09-20T00-00-00-000Z_${id}.jsonl`));
    const header = { type: "session", version: 3, id, timestamp: "2026-09-20T00:00:00.000Z", cwd };
    writeFileSync(path, [header, user("u1", null, "hi"), assistant("a1", "u1", "hello")].map((e) => JSON.stringify(e)).join("\n") + "\n");
    return path;
  };
  const liveRecord = (name: string, pid: number, path: string, working = 0) =>
    writeFileSync(
      join(agentDir, "sessions", "live", name),
      JSON.stringify({
        heartbeat: Date.now(),
        session: { sessionFile: path, pid, mode: "tui", status: "idle" },
        presence: { status: "idle", workerCounts: { total: working, working, waiting: 0, done: 0, error: 0, killed: 0 } },
      }),
    );

  test("refuses a session open in a terminal (another live pid), and writes nothing", async () => {
    const path = make("pl1");
    const before = readFileSync(path, "utf8");
    liveRecord("p-other-pl1.json", process.ppid, path);
    const r = await overseer.promptIdleSession(path, "do it", "x");
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.error : "", /open in a terminal/);
    assert.equal(readFileSync(path, "utf8"), before);
  });

  test("refuses mid-turn work: a session whose subagents are working", async () => {
    const path = make("pl2");
    liveRecord(`p${process.pid}-pl2.json`, process.pid, path, 1);
    const r = await overseer.promptIdleSession(path, "do it");
    assert.deepEqual(r.ok ? null : [r.status, /mid-turn/.test(r.error)], [409, true]);
  });

  test("refuses the Overseer itself, and blank text", async () => {
    const { path } = await overseer.ensureOverseer();
    const r = await overseer.promptIdleSession(path, "hello me");
    assert.deepEqual(r.ok ? null : r.status, 409);
    assert.deepEqual(await overseer.promptIdleSession(make("pl3"), "   "), { ok: false, status: 400, error: "text must not be blank" });
  });
});

describe("a pending Overseer mark never outlives its prompt", () => {
  test("a prompt that fails before its message exists drops its mark, so a later identical message is not tagged", async () => {
    const path = canonicalPath(join(sessionsDir, "2026-09-20T00-00-00-000Z_leak1.jsonl"));
    const header = { type: "session", version: 3, id: "leak1", timestamp: "2026-09-20T00:00:00.000Z", cwd };
    writeFileSync(path, [header, user("u1", null, "hi"), assistant("a1", "u1", "hello")].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const chat = await acquireChat(path, true);
    const pending = () => (chat as unknown as { overseerSends: unknown[] }).overseerSends;
    // This throwaway agent dir has no credentials: the turn fails before any user message is saved.
    const { turn } = chat.acceptPrompt("same text", undefined, "server", undefined, { sentByOverseer: { overseerId: "ov" } });
    await turn.catch(() => {});
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(pending(), []);
    assert.ok(!readFileSync(path, "utf8").includes(OVERSEER_SENT_ENTRY));
  });
});
