// Run: npx tsx --test server/chat-rewind.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR and cwd in the OS temp dir; ~/.pi is never read or written.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-rewind-test-")));
process.env.PI_CODING_AGENT_DIR = agentDir; // before chat-manager computes its paths
const sessionsDir = join(agentDir, "sessions", "--tmp-rewind--");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const cwd = join(agentDir, "cwd");
mkdirSync(cwd, { recursive: true });

const { acquireChat, BusyError, disposeAllChats, REWIND_ENTRY, rewindSession } = await import("./chat-manager");
const { normalizeEntries, normalizeEntry } = await import("./transcript");
const { canonicalPath } = await import("./paths");

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
const assistant = (id: string, parentId: string, text: string, input: number) => ({
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
    usage: { input, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: input + 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  },
});
/** u1 → a1 → u2 → a2: two turns on one branch. */
const twoTurns = () => [user("u1", null, "first ask"), assistant("a1", "u1", "first answer", 100), user("u2", "a1", "second ask"), assistant("a2", "u2", "second answer", 200)];

/** A fake session for rewindSession: records navigation and appends, with switchable guards. */
function fake(entries: any[], opts: { streaming?: boolean; compacting?: boolean; cancel?: boolean; throws?: string; queued?: boolean } = {}) {
  let leaf: string | null = entries.at(-1)?.id ?? null;
  const calls: string[] = [];
  const appended: Array<{ customType: string; data: unknown; parentId: string | null }> = [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  const branch = () => {
    const out: any[] = [];
    for (let e = leaf ? byId.get(leaf) : undefined; e; e = e.parentId ? byId.get(e.parentId) : undefined) out.unshift(e);
    return out;
  };
  const session = {
    isStreaming: !!opts.streaming,
    isCompacting: !!opts.compacting,
    sessionManager: {
      getBranch: branch,
      getLeafId: () => leaf,
      appendCustomEntry(customType: string, data?: unknown) {
        calls.push("marker");
        appended.push({ customType, data, parentId: leaf });
        return "m1";
      },
    } as any,
    async navigateTree(targetId: string) {
      calls.push(`navigate:${targetId}`);
      if (opts.throws) throw new Error(opts.throws);
      if (opts.cancel) return { cancelled: true };
      const t = byId.get(targetId);
      leaf = t.parentId;
      return { cancelled: false, editorText: t.message.content[0].text };
    },
  };
  const hooks = {
    guard: () => void calls.push("guard"),
    queued: () => opts.queued ?? false,
    beforeMarker: () => void calls.push("flush"),
  };
  return { session, hooks, calls, appended, leaf: () => leaf };
}

describe("rewindSession", () => {
  test("a rewind is REFUSED while a message is still on its way out, and writes nothing", async () => {
    // The window this exists for is NOT covered by the isStreaming check: `steer()` awaits the
    // extension `input` handlers before queueing, so a steer carrying images on a non-vision model
    // can still be in flight after the turn it meant to interrupt has ended (CLAUDE.md). Rewinding
    // then moves the leaf, and the queued message is delivered into the NEW branch on the next
    // run — the abandoned message resurrecting on the branch the user rewound TO.
    const f = fake(twoTurns(), { streaming: false, queued: true });
    const out = await rewindSession(f.session, "u2", f.hooks);
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.reason, "queued");
    // Stated as a state, not a code: the branch did not move and nothing was appended.
    assert.deepEqual(f.appended, [], "no marker was written");
    assert.ok(!f.calls.includes("navigate"), `navigateTree must not run: ${f.calls.join(", ")}`);
  });

  test("moves the leaf to the input's parent, hands its text back, then pins the move with the marker", async () => {
    const f = fake(twoTurns());
    const out = await rewindSession(f.session, "u2", f.hooks);
    assert.deepEqual(out, { ok: true, editorText: "second ask" });
    assert.equal(f.leaf(), "a1");
    // Guards before navigating; the deferred appends and the marker after, on the new branch.
    assert.deepEqual(f.calls, ["guard", "navigate:u2", "guard", "flush", "marker"]);
    assert.deepEqual(f.appended, [{ customType: REWIND_ENTRY, data: { targetId: "u2", fromLeafId: "a2" }, parentId: "a1" }]);
  });

  test("rewinding to the first input empties the branch", async () => {
    const f = fake(twoTurns());
    const out = await rewindSession(f.session, "u1", f.hooks);
    assert.deepEqual(out, { ok: true, editorText: "first ask" });
    assert.equal(f.leaf(), null);
    assert.equal(f.appended[0]?.parentId, null);
  });

  test("refuses while streaming, and says to stop first; nothing is navigated or written", async () => {
    const f = fake(twoTurns(), { streaming: true });
    const out = await rewindSession(f.session, "u2", f.hooks);
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.reason, "streaming");
    assert.match(!out.ok ? out.message : "", /Stop the turn first/);
    assert.deepEqual(f.calls, ["guard"]);
  });

  test("refuses while compacting", async () => {
    const f = fake(twoTurns(), { compacting: true });
    const out = await rewindSession(f.session, "u2", f.hooks);
    assert.equal(!out.ok && out.reason, "compacting");
    assert.deepEqual(f.appended, []);
  });

  test("a TUI-owned session is refused as busy, an unknown writer as recent", async () => {
    for (const code of ["busy", "recent"] as const) {
      const f = fake(twoTurns());
      const out = await rewindSession(f.session, "u2", {
        ...f.hooks,
        queued: () => false,
        guard: () => {
          throw new BusyError(`owned (${code})`, code);
        },
      });
      assert.deepEqual(out, { ok: false, reason: code, message: `owned (${code})` });
      assert.deepEqual(f.calls, []);
    }
  });

  test("an unknown id, a non-user entry, or an off-branch input is not_on_branch", async () => {
    const entries = [...twoTurns(), user("u9", "a1", "sibling ask")]; // u9 is a sibling of u2
    for (const id of ["nope", "a1", "u2"]) {
      const f = fake(entries); // leaf = u9, so u2 is off the active branch
      const out = await rewindSession(f.session, id, f.hooks);
      assert.equal(!out.ok && out.reason, "not_on_branch", id);
      assert.deepEqual(f.appended, []);
    }
  });

  test("a cancelled navigation and a thrown one write no marker", async () => {
    const cancelled = fake(twoTurns(), { cancel: true });
    assert.equal(((await rewindSession(cancelled.session, "u2", cancelled.hooks)) as any).reason, "cancelled");
    const thrown = fake(twoTurns(), { throws: "boom" });
    assert.deepEqual(await rewindSession(thrown.session, "u2", thrown.hooks), { ok: false, reason: "internal", message: "boom" });
    assert.deepEqual([...cancelled.appended, ...thrown.appended], []);
  });
});

describe("the rewind marker in the transcript", () => {
  const marker = { type: "custom", id: "m1", parentId: "a1", timestamp: "2026-09-20T00:00:02.000Z", customType: REWIND_ENTRY, data: { targetId: "u2", fromLeafId: "a2" } };

  test("renders as nothing", () => {
    assert.deepEqual(normalizeEntry(marker), []);
    const rows = normalizeEntries([...twoTurns().slice(0, 2), marker] as any);
    assert.deepEqual(rows.map((r) => r.id), ["u1", "a1:0"]); // assistant text rows are "<id>:<block>"
  });
});

describe("a rewind through a real chat runtime", () => {
  /** The conversation rows of a hello, without the info rows the open-time appends add. */
  const talk = (m: ChatServerMessage | undefined) =>
    m?.type === "hello" ? m.items.filter((i) => i.kind === "user" || i.kind === "assistant-text").map((i) => i.id) : null;

  test("re-sends hello, workers and mode to every client, the text to the requester, and survives a reopen", async () => {
    const path = canonicalPath(join(sessionsDir, "2026-09-20T00-00-00-000Z_rw1.jsonl"));
    const header = { type: "session", version: 3, id: "rw1", timestamp: "2026-09-20T00:00:00.000Z", cwd };
    writeFileSync(path, [header, ...twoTurns()].map((e) => JSON.stringify(e)).join("\n") + "\n");
    // This server's own live record with a worker, so attach() already sent the snapshot once.
    writeFileSync(
      join(agentDir, "sessions", "live", `p${process.pid}-rw1.json`),
      JSON.stringify({
        heartbeat: Date.now(),
        session: { sessionFile: path, pid: process.pid, mode: "rpc", status: "idle" },
        presence: { status: "idle", workerCounts: { total: 1, working: 1, waiting: 0, done: 0, error: 0, killed: 0 } },
      }),
    );

    const chat = await acquireChat(path, true);
    const mine: ChatServerMessage[] = [];
    const theirs: ChatServerMessage[] = [];
    const me = { send: (m: ChatServerMessage) => void mine.push(m) };
    chat.attach(me);
    chat.attach({ send: (m) => void theirs.push(m) });
    assert.ok(theirs.some((m) => m.type === "workers"));
    mine.length = 0;
    theirs.length = 0;

    chat.handle(me, { type: "rewind", id: "r1", entryId: "u2" });
    for (let i = 0; i < 50 && !mine.some((m) => m.type === "rewound" || m.type === "rewind_refused"); i++) await new Promise((r) => setTimeout(r, 20));

    // The worker set did not change, and still follows the hello that blanked it client-side.
    assert.deepEqual(theirs.map((m) => m.type), ["hello", "workers", "mode"]);
    assert.deepEqual(mine.map((m) => m.type), ["hello", "workers", "mode", "rewound"]);
    assert.deepEqual(talk(theirs[0]), ["u1", "a1:0"]);
    assert.equal((theirs[0] as Extract<ChatServerMessage, { type: "hello" }>).context?.tokens, 100); // fill follows the new branch
    assert.deepEqual(mine.at(-1), { type: "rewound", id: "r1", entryId: "u2", editorText: "second ask" });

    // The marker is the file's last line, on the new branch: its ancestry reaches a1, never a2.
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const byId = new Map(lines.map((e) => [e.id, e]));
    const last = lines.at(-1);
    assert.equal(last.type, "custom");
    assert.equal(last.customType, REWIND_ENTRY);
    assert.deepEqual(last.data, { targetId: "u2", fromLeafId: "a2" });
    const ancestry: string[] = [];
    for (let e = byId.get(last.parentId); e; e = byId.get(e.parentId)) ancestry.push(e.id);
    assert.ok(ancestry.includes("a1") && !ancestry.includes("a2"), ancestry.join(" <- "));

    // Reopen from disk: the leaf is the marker, so the abandoned turn stays gone.
    await disposeAllChats();
    const reopened = await acquireChat(path, true);
    const again: ChatServerMessage[] = [];
    reopened.attach({ send: (m) => void again.push(m) });
    assert.deepEqual(talk(again[0]), ["u1", "a1:0"]);
  });

  test("a rewind to the first input leaves an empty branch, and the marker is its only entry", async () => {
    const path = canonicalPath(join(sessionsDir, "2026-09-20T00-00-00-000Z_rw2.jsonl"));
    const header = { type: "session", version: 3, id: "rw2", timestamp: "2026-09-20T00:00:00.000Z", cwd };
    writeFileSync(path, [header, ...twoTurns()].map((e) => JSON.stringify(e)).join("\n") + "\n");

    const chat = await acquireChat(path, true);
    const sent: ChatServerMessage[] = [];
    const me = { send: (m: ChatServerMessage) => void sent.push(m) };
    chat.attach(me);
    sent.length = 0;
    chat.handle(me, { type: "rewind", id: "r2", entryId: "u1" });
    for (let i = 0; i < 50 && !sent.some((m) => m.type === "rewound" || m.type === "rewind_refused"); i++) await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(sent.at(-1), { type: "rewound", id: "r2", entryId: "u1", editorText: "first ask" });
    assert.deepEqual(talk(sent[0]), []); // nothing left to say
    const marker = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    assert.equal(marker.customType, REWIND_ENTRY);
    assert.deepEqual(marker.data, { targetId: "u1", fromLeafId: "a2" });
  });
});
