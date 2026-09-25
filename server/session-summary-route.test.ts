// Run: npx tsx --test server/session-summary-route.test.ts (or npm test). Uses a throwaway
// PI_CODING_AGENT_DIR in the OS temp dir; ~/.pi is never read or written. The server is imported
// with PORT=0 so it binds an ephemeral port instead of the dev port.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-summary-route-")));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
const sessionsDir = join(agentDir, "sessions", "--tmp-summary--");
mkdirSync(sessionsDir, { recursive: true });

const { app, server } = await import("./index");
const { disposeAllChats } = await import("./chat-manager");

after(async () => {
  server.close();
  await disposeAllChats();
  rmSync(agentDir, { recursive: true, force: true });
});

describe("GET /api/sessions/summary?id=", () => {
  test("answers for a session the list hides (an empty one, header only)", async () => {
    const id = "01a0d000-0000-7000-8000-000000000001";
    writeFileSync(join(sessionsDir, `2026-09-20T00-00-00-000Z_${id}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-20T00:00:00.000Z", cwd: "/tmp" })}\n`);
    const listed = (await (await app.request("/api/sessions")).json()) as { id: string }[];
    assert.ok(!listed.some((s) => s.id === id), "an empty session is not in the list");
    const res = await app.request(`/api/sessions/summary?id=${id}`);
    assert.equal(res.status, 200);
    const s = (await res.json()) as { id: string; title: string };
    assert.equal(s.id, id);
    assert.equal(s.title, "Untitled");
  });

  test("404 for an id no file has; 400 for a missing or malformed id", async () => {
    assert.equal((await app.request("/api/sessions/summary?id=nope-nope")).status, 404);
    assert.equal((await app.request("/api/sessions/summary")).status, 400);
    assert.equal((await app.request("/api/sessions/summary?id=../etc")).status, 400);
  });
});

describe("the Overseer's own folder and notes", () => {
  test("GET /api/cwds never offers the Overseer's folder, even once its file has a conversation", async () => {
    const info = (await (await app.request("/api/overseer")).json()) as { path: string };
    const { overseerDir } = await import("./overseer-store");
    const { appendFileSync } = await import("node:fs");
    appendFileSync(
      info.path,
      `${JSON.stringify({ type: "message", id: "ou1", parentId: null, timestamp: "2026-09-20T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "what needs me" }], timestamp: 0 } })}\n`,
    );
    const listed = (await (await app.request("/api/sessions")).json()) as { path: string; cwd: string; overseer?: true }[];
    assert.ok(
      listed.some((s) => s.overseer && s.cwd === overseerDir()),
      "the Overseer file is in the list (it is hidden by the client), so the check below means something",
    );
    const cwds = (await (await app.request("/api/cwds")).json()) as string[];
    assert.ok(!cwds.includes(overseerDir()), cwds.join(", "));
  });

  test("recentCwds skips Overseer files and the Overseer's folder, keeps order, drops repeats and missing folders", async () => {
    const { recentCwds } = await import("./sessions-index");
    const list = [{ cwd: "/a" }, { cwd: "/ov", overseer: true as const }, { cwd: "/ov" }, { cwd: "/b" }, { cwd: "/a" }, { cwd: "/gone" }];
    assert.deepEqual(recentCwds(list, "/ov", (p) => p !== "/gone"), ["/a", "/b"]);
  });

  test("PUT /api/overseer/notes with a base the file no longer holds is refused, and the file keeps the Overseer's note", async () => {
    const put = (body: unknown) => app.request("/api/overseer/notes", { method: "PUT", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    assert.equal((await put({ text: "first note\n" })).status, 200);
    // sova_note append, while the Settings form still holds "first note".
    assert.equal((await put({ text: "first note\nkiwis\n" })).status, 200);
    const stale = await put({ text: "first note, edited\n", base: "first note\n" });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { text: string }).text, "first note\nkiwis\n");
    assert.equal(((await (await app.request("/api/overseer/notes")).json()) as { text: string }).text, "first note\nkiwis\n");
    assert.equal((await put({ text: "first note, edited\nkiwis\n", base: "first note\nkiwis\n" })).status, 200);
    assert.equal((await put({ text: "x", base: 5 })).status, 400);
  });
});

describe("POST /api/sessions/prompt tags a prompt as the Overseer's only on the Overseer's own calls", () => {
  test("a client sending the header with the Overseer's id (or anything else) is not tagged; the in-process tool call is", async () => {
    const { ensureOverseer, requestAsOverseerForTest } = await import("./overseer");
    const { acquireChat } = await import("./chat-manager");
    const ov = await ensureOverseer();
    const id = "01a0d000-0000-7000-8000-00000000f04e";
    const path = join(sessionsDir, `2026-09-20T00-00-00-000Z_${id}.jsonl`);
    const lines = [
      { type: "session", version: 3, id, timestamp: "2026-09-20T00:00:00.000Z", cwd: "/tmp" },
      { type: "message", id: "u1", parentId: null, timestamp: "2026-09-20T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 } },
    ];
    writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const chat = await acquireChat(path, true); // just written by this test: past the recent-write guard
    // Record who each accepted prompt is marked as, instead of running it (no credentials here).
    const tags: (string | null)[] = [];
    chat.assertModelAllowed = () => {};
    chat.acceptPrompt = ((_text: string, _images: unknown, _origin: unknown, _q: unknown, opts?: { sentByOverseer?: { overseerId?: string } }) => {
      tags.push(opts?.sentByOverseer?.overseerId ?? null);
      return { turn: Promise.resolve() };
    }) as unknown as typeof chat.acceptPrompt;
    const body = JSON.stringify({ path, text: "do it" });
    const post = (headers: Record<string, string>) =>
      app.request("/api/sessions/prompt", { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
    assert.equal((await post({ "x-sova-overseer": ov.id })).status, 200, "the old forgery: the header with the current Overseer's id");
    assert.equal((await post({ "x-sova-overseer": "0".repeat(64) })).status, 200);
    assert.equal((await post({})).status, 200);
    assert.equal((await requestAsOverseerForTest("/api/sessions/prompt", { method: "POST", body, headers: { "content-type": "application/json" } })).status, 200);
    assert.deepEqual(tags, [null, null, null, ov.id]);
  });
});
