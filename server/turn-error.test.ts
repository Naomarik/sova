// Run: npx tsx --test server/turn-error.test.ts (or npm test). Uses a throwaway PI_CODING_AGENT_DIR
// in the OS temp dir; ~/.pi is never read or written.
//
// "The last turn stopped with an error" is a fact of the file, not a judgement: the list's tail
// scan reads the last FINISHED reply's stopReason (server/sessions-index.ts readTailReply) and the
// seen store decides whether it still shows (server/seen.ts turnErrorShows), next to `unread`.
// The second half pins pi's side of that contract against the package the repo actually resolves.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const agentDir = mkdtempSync(join(tmpdir(), "sova-turn-error-"));
process.env.PI_CODING_AGENT_DIR = agentDir; // before the modules below compute their paths
const sessionsDir = join(agentDir, "sessions", "--tmp-turn-error--");
const liveDir = join(agentDir, "sessions", "live");
mkdirSync(sessionsDir, { recursive: true });
mkdirSync(liveDir, { recursive: true });

const { getSessionSummary, readTailReply, REPLY_ERROR_MAX } = await import("./sessions-index");
const seen = await import("./seen");
const { canonicalPath } = await import("./paths");

// A live record's pid must be alive for readLive to see it.
const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
after(() => {
  sleeper.kill();
  rmSync(agentDir, { recursive: true, force: true });
});

// In the past whatever the clock says: a socket stamps "now", which must be after every reply here.
const T0 = Date.parse("2026-01-01T10:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();
type E = Record<string, unknown>;
const user = (id: string, parentId: string | null, t: number): E => ({ type: "message", id, parentId, timestamp: iso(t), message: { role: "user", content: [{ type: "text", text: "do it" }], timestamp: t } });
const reply = (id: string, parentId: string, t: number, stopReason: string, extra: E = {}): E => ({
  type: "message", id, parentId, timestamp: iso(t),
  message: { role: "assistant", content: [{ type: "text", text: "…" }], provider: "anthropic", model: "claude-x", stopReason, timestamp: t, ...extra },
});
const toolResult = (id: string, parentId: string, t: number, isError: boolean): E => ({
  type: "message", id, parentId, timestamp: iso(t),
  message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "Command exited with code 1" }], isError, timestamp: t },
});

let seq = 0;
/** A session file; returns its canonical path and id. */
function session(entries: E[]): { path: string; id: string } {
  const id = `01a0beef-0000-7000-8000-${String(++seq).padStart(12, "0")}`;
  const path = join(sessionsDir, `2026-09-26T10-00-00-000Z_${id}.jsonl`);
  const head = { type: "session", version: 3, id, timestamp: iso(T0 - 60_000), cwd: "/tmp" };
  writeFileSync(path, [head, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n");
  return { path: canonicalPath(path), id };
}
const size = (p: string) => readFileSync(p).length;

describe("readTailReply: the last FINISHED reply, and how it stopped", () => {
  test("an errored reply: its time, stopReason and errorMessage (capped)", async () => {
    const long = `529 overloaded ${"x".repeat(1000)}`;
    const { path } = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "error", { errorMessage: long })]);
    const r = await readTailReply(path, size(path));
    assert.equal(r?.at, T0 + 1000);
    assert.equal(r?.stopReason, "error");
    assert.equal(r?.error?.length, REPLY_ERROR_MAX);
    assert.ok(r?.error?.startsWith("529 overloaded"));
  });

  test("an aborted or stopped reply carries no error, even with an errorMessage on it", async () => {
    const { path } = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "aborted", { errorMessage: "Request was aborted" })]);
    assert.deepEqual(await readTailReply(path, size(path)), { at: T0 + 1000, stopReason: "aborted" });
  });

  test("a turn still open at the tail — toolUse, pending, deferred — is skipped for the reply before it", async () => {
    for (const open of ["toolUse", "pending", "deferred"]) {
      const { path } = session([
        user("u1", null, T0), reply("a1", "u1", T0 + 1000, "error", { errorMessage: "boom" }),
        user("u2", "a1", T0 + 2000), reply("a2", "u2", T0 + 3000, open),
      ]);
      const r = await readTailReply(path, size(path));
      assert.equal(r?.at, T0 + 1000, `${open} is not a finished reply`);
      assert.equal(r?.stopReason, "error");
    }
    const { path } = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "pending")]);
    assert.equal(await readTailReply(path, size(path)), null, "nothing finished at all");
  });
});

describe("turnErrorShows: the rule, beside isUnread", () => {
  const err = { at: 200, stopReason: "error" };
  const base = { seenAt: 100, lastReply: err, viewing: false, running: false };

  test("an errored reply newer than the stamp, idle, not on screen", () => {
    assert.equal(seen.turnErrorShows(base), true);
  });

  test("never while running or on screen; not once seen at or after the reply", () => {
    assert.equal(seen.turnErrorShows({ ...base, running: true }), false);
    assert.equal(seen.turnErrorShows({ ...base, viewing: true }), false);
    assert.equal(seen.turnErrorShows({ ...base, seenAt: 200 }), false);
    assert.equal(seen.turnErrorShows({ ...base, seenAt: 201 }), false);
  });

  test("a session never stamped DOES show it (unread doesn't: the two differ here on purpose)", () => {
    assert.equal(seen.turnErrorShows({ ...base, seenAt: undefined }), true);
    assert.equal(seen.isUnread({ seenAt: undefined, lastReplyAt: 200, viewing: false, running: false }), false);
  });

  test("only stopReason error: aborted, stop, length, or no reply at all never show", () => {
    for (const stopReason of ["aborted", "stop", "length"]) assert.equal(seen.turnErrorShows({ ...base, lastReply: { at: 200, stopReason } }), false, stopReason);
    assert.equal(seen.turnErrorShows({ ...base, lastReply: undefined }), false);
  });
});

describe("SessionSummary.turnError, end to end through the list's own read", () => {
  test("error at the tail, never stamped: shown with the message; not unread (never stamped)", async () => {
    const { path } = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "error", { errorMessage: "429 rate limited" })]);
    const s = await getSessionSummary(path);
    assert.deepEqual(s?.turnError, { message: "429 rate limited", provider: "anthropic" }, "message and the producing turn's own provider");
    assert.equal(s?.unread, undefined);
  });

  test("an errored reply with no errorMessage still shows, with no message", async () => {
    const { path } = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "error")]);
    assert.deepEqual((await getSessionSummary(path))?.turnError, {});
  });

  test("aborted: no mark (unread still fires for it)", async () => {
    const { path, id } = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "aborted")]);
    seen.markSeen(id, T0);
    const s = await getSessionSummary(path);
    assert.equal(s?.turnError, undefined);
    assert.equal(s?.unread, true);
  });

  test("a failed tool call inside a turn that ended 'stop': no mark", async () => {
    const { path } = session([
      user("u1", null, T0),
      reply("a1", "u1", T0 + 1000, "toolUse", { content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "grep -c x f" } }] }),
      toolResult("r1", "a1", T0 + 2000, true),
      reply("a2", "r1", T0 + 3000, "stop"),
    ]);
    assert.equal((await getSessionSummary(path))?.turnError, undefined);
  });

  test("pending / deferred at the tail: judged by the finished reply before them", async () => {
    for (const open of ["pending", "deferred"]) {
      const ok = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "stop"), user("u2", "a1", T0 + 2000), reply("a2", "u2", T0 + 3000, open)]);
      assert.equal((await getSessionSummary(ok.path))?.turnError, undefined, `${open} after a good reply`);
      const bad = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "error"), user("u2", "a1", T0 + 2000), reply("a2", "u2", T0 + 3000, open)]);
      assert.deepEqual((await getSessionSummary(bad.path))?.turnError, {}, `${open} after an errored reply`);
    }
  });

  test("seen after the reply clears it; seen before it does not", async () => {
    const before = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "error")]);
    seen.markSeen(before.id, T0 + 999);
    assert.deepEqual((await getSessionSummary(before.path))?.turnError, {});
    const afterSeen = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "error")]);
    seen.markSeen(afterSeen.id, T0 + 1000);
    assert.equal((await getSessionSummary(afterSeen.path))?.turnError, undefined);
  });

  test("on screen (a socket open) hides it; closing that socket stamps it seen, so it stays gone", async () => {
    const { path, id } = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "error")]);
    seen.trackViewer(id, 1);
    assert.equal((await getSessionSummary(path))?.turnError, undefined);
    seen.trackViewer(id, -1);
    assert.equal((await getSessionSummary(path))?.turnError, undefined);
  });

  test("running (a live record says working) hides it: pi may be mid-retry", async () => {
    const { path } = session([user("u1", null, T0), reply("a1", "u1", T0 + 1000, "error")]);
    const rec = join(liveDir, "p-turn-error.json");
    writeFileSync(rec, JSON.stringify({ session: { pid: sleeper.pid, sessionFile: path, mode: "tui" }, presence: { status: "working", activity: { state: "working", since: T0 } } }));
    try {
      assert.equal((await getSessionSummary(path))?.turnError, undefined);
    } finally {
      rmSync(rec);
    }
    assert.deepEqual((await getSessionSummary(path))?.turnError, {}, "idle again: shows");
  });
});

describe("pi's side of the contract, in the copy the repo resolves", () => {
  // THIS IS WHAT THE MARK STANDS ON. The tail scan compares stopReason with string literals and
  // reads `errorMessage` off a parsed line: nothing ties those to pi's types, so a rename in pi
  // would silently turn the mark off (or on for every row). pi-ai is not a direct dependency: it
  // sits BESIDE the pinned pi-coding-agent's real path under pnpm, so resolve it from there.
  const here = dirname(fileURLToPath(import.meta.url));
  const agentPkg = realpathSync(join(here, "..", "node_modules", "@earendil-works", "pi-coding-agent"));
  const piAi = join(dirname(agentPkg), "pi-ai");
  const types = readFileSync(join(piAi, "dist", "types.d.ts"), "utf8");

  test("StopReason still has the members the scan names", () => {
    const m = types.match(/export type StopReason\s*=\s*([^;]+);/);
    assert.ok(m, "pi-ai dist/types.d.ts declares StopReason");
    const members = [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    for (const needed of ["error", "aborted", "toolUse", "pending", "deferred", "stop"]) {
      assert.ok(members.includes(needed), `StopReason includes "${needed}" (has: ${members.join(", ")})`);
    }
  });

  test("an AssistantMessage still carries stopReason and errorMessage?: string", () => {
    const m = types.match(/export interface AssistantMessage\s*\{([\s\S]*?)\n\}/);
    assert.ok(m, "pi-ai dist/types.d.ts declares AssistantMessage");
    assert.match(m[1]!, /^\s*stopReason: StopReason;$/m);
    assert.match(m[1]!, /^\s*errorMessage\?: string;$/m);
  });
});
