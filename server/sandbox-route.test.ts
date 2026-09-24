// Run: npx tsx --test server/sandbox-route.test.ts (or npm test)
// POST /api/sandbox against a REAL hosted runtime, opened in a throwaway PI_CODING_AGENT_DIR whose
// only extension is this repo's sandbox extension (linked in). The agent dir is per process, so
// the extension-absent case is sandbox-route-absent.test.ts, which runs this file with
// PI_SANDBOX_ROUTE_ABSENT=1 (no extension linked). No model request is made: the flip runs the
// extension's command handler, never a prompt.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";

const absent = process.env.PI_SANDBOX_ROUTE_ABSENT === "1";
const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "sova-sandbox-route-"));
const cwd = mkdtempSync(join(tmpdir(), "sova-sandbox-route-cwd-"));
mkdirSync(join(dir, "extensions"), { recursive: true });
if (!absent) symlinkSync(resolve(here, "../pi-config/extensions/sandbox"), join(dir, "extensions", "sandbox"));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PORT = "0";
const { app, server } = await import("./index");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
after(async () => {
  await disposeAllChats();
  await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  app.request(`/api/sandbox?path=${encodeURIComponent(path)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function openChat() {
  const res = await app.request("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  assert.equal(res.status, 201, await res.clone().text());
  const { path } = (await res.json()) as { path: string };
  const chat = await acquireChat(path);
  const sent: ChatServerMessage[] = [];
  chat.attach({ send: (m: ChatServerMessage) => sent.push(m) } as never);
  return { path, chat, sent };
}

if (absent) {
  test("absent: no sandbox message on attach, and POST answers unsupported with nothing written", async () => {
    const { path, sent } = await openChat();
    assert.ok(!sent.some((m) => m.type === "sandbox"));
    const res = await post(path, { on: true });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { outcome: "unsupported" });
    assert.ok(!sent.some((m) => m.type === "sandbox"));
  });
} else {
  test("the route refuses a bad body and a chat that isn't held", async () => {
    assert.equal((await post(join(dir, "sessions", "x.jsonl"), { on: "yes" })).status, 400);
    assert.equal((await post(join(dir, "sessions", "--x--", "nope.jsonl"), { on: true })).status, 404);
  });

  test("present: attach says off, a flip reaches every client and the branch, and off again", async () => {
    const { path, chat, sent } = await openChat();
    assert.deepEqual(sent.find((m) => m.type === "sandbox"), { type: "sandbox", on: false, enforcement: "none", status: "Sandbox off" });
    sent.length = 0;
    const res = await post(path, { on: true });
    const body = (await res.json()) as { outcome: string; sandbox: { on: boolean; enforcement: string } };
    assert.equal(body.outcome, "command");
    assert.equal(body.sandbox.on, true);
    // Whatever this machine can enforce (no policy file here: unavailable), it is on and says so.
    assert.ok(["full", "partial", "unavailable"].includes(body.sandbox.enforcement));
    assert.ok(sent.some((m) => m.type === "sandbox" && m.on));
    const entries = chat.session.sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "sandbox");
    assert.equal(entries.length, 1);
    // No transcript row for it: nothing was appended to the pane.
    assert.ok(!sent.some((m) => m.type === "append"));

    sent.length = 0;
    const off = (await (await post(path, { on: false })).json()) as { sandbox: { on: boolean } };
    assert.equal(off.sandbox.on, false);
    assert.ok(sent.some((m) => m.type === "sandbox" && !m.on));
  });
}
