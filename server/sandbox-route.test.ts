// Run: npx tsx --test server/sandbox-route.test.ts (or npm test)
// POST /api/sandbox against a REAL hosted runtime, opened in a throwaway PI_CODING_AGENT_DIR whose
// only extension is this repo's sandbox extension (linked in). The agent dir is per process, so
// the extension-absent case is sandbox-route-absent.test.ts, which runs this file with
// PI_SANDBOX_ROUTE_ABSENT=1 (no extension linked). No model request is made: the flip runs the
// extension's command handler, never a prompt.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { ChatServerMessage } from "../shared/protocol";
import { piSession } from "./harness/pi/testing/handle";

const absent = process.env.PI_SANDBOX_ROUTE_ABSENT === "1";
const here = dirname(fileURLToPath(import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-sandbox-route-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sova-sandbox-route-cwd-")));
// A hosted runtime can still write here after after() ran (pi's catalogs, usage cache): exit is last.
process.on("exit", () => rmSync(cwd, { recursive: true, force: true }));
mkdirSync(join(dir, "extensions"), { recursive: true });
if (!absent) symlinkSync(resolve(here, "../pi-config/extensions/sandbox"), join(dir, "extensions", "sandbox"));
process.env.PI_CODING_AGENT_DIR = dir;
await import("./testing/in-process-chats"); // chats open in this process (the server hosts none)
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const { acquireChat, disposeAllChats } = await import("./chat-manager");
after(async () => {
  await disposeAllChats();
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

  /** Every sandbox state clients heard, in order. The server pushes the newest state once per stored
      entry (server/sandbox-state.ts onSandboxAppend) and once more when the route's change settles
      (applySandbox): Off and Subagents only are heard twice, On as "turning on", then the real state
      twice. */
  const heard = (sent: { type: string; on?: unknown; state?: unknown; starting?: unknown }[]) =>
    sent.filter((m) => m.type === "sandbox").map((m) => `${String(m.state)}${m.starting ? " (starting)" : ""}`);

  test("present: attach says off, a flip reaches every client and the branch, and off again", async () => {
    const { path, chat, sent } = await openChat();
    // No entry yet: Subagents only, the default (§chat.sandbox/states).
    assert.deepEqual(sent.find((m) => m.type === "sandbox"), { type: "sandbox", on: false, state: "subagents", enforcement: "none", status: "Sandbox subagents only · workers in tracked worktrees write only there" });
    sent.length = 0;
    const res = await post(path, { on: true });
    const body = (await res.json()) as { outcome: string; sandbox: { on: boolean; enforcement: string } };
    assert.equal(body.outcome, "command");
    assert.equal(body.sandbox.on, true);
    // Whatever this machine can enforce (no policy file here: unavailable), it is on and says so.
    assert.ok(["full", "partial", "unavailable"].includes(body.sandbox.enforcement));
    assert.ok(sent.some((m) => m.type === "sandbox" && m.on));
    // Turning On records a provisional On entry (reason "starting") before the confined tools exist,
    // then the real state (§chat.sandbox/states "Turning on"): two entries, the real one newest.
    const entries = piSession(chat).sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "sandbox").map((e) => (e as { data: { on: boolean; enforcement?: string; reasons?: string[] } }).data);
    assert.equal(entries.length, 2);
    assert.deepEqual({ on: entries[0]!.on, enforcement: entries[0]!.enforcement, reasons: entries[0]!.reasons }, { on: true, enforcement: "unavailable", reasons: ["starting"] });
    assert.equal(entries[1]!.on, true);
    assert.notDeepEqual(entries[1]!.reasons, ["starting"], "the real state is newest");
    // Clients hear "turning on" (the provisional entry), then the real state (its entry, then the settled change).
    assert.deepEqual(heard(sent), ["on (starting)", "on", "on"]);
    // No transcript row for it: nothing was appended to the pane.
    assert.ok(!sent.some((m) => m.type === "append"));

    sent.length = 0;
    // The older body: on false is Subagents only, never Off.
    const off = (await (await post(path, { on: false })).json()) as { sandbox: { on: boolean; state: string } };
    assert.equal(off.sandbox.on, false);
    assert.equal(off.sandbox.state, "subagents");
    assert.ok(sent.some((m) => m.type === "sandbox" && !m.on));
  });

  test("three states: { state } sets Off, Subagents only and On, each a real entry of its own (On after its provisional entry), and every client hears it", async () => {
    const { path, chat, sent } = await openChat();
    const entries = () => piSession(chat).sessionManager.getBranch().filter((e) => e.type === "custom" && e.customType === "sandbox").map((e) => (e as { data: Record<string, unknown> }).data);
    sent.length = 0;
    const off = (await (await post(path, { state: "off", on: false })).json()) as { outcome: string; sandbox: { on: boolean; state: string; status: string } };
    assert.equal(off.outcome, "command");
    assert.deepEqual([off.sandbox.on, off.sandbox.state, off.sandbox.status], [false, "off", "Sandbox off · workers unconfined"]);
    assert.equal(entries().at(-1)?.workers, "off");
    assert.ok(sent.some((m) => m.type === "sandbox" && m.state === "off"));
    const sub = (await (await post(path, { state: "subagents" })).json()) as { sandbox: { state: string } };
    assert.equal(sub.sandbox.state, "subagents");
    assert.equal(entries().at(-1)?.workers, undefined);
    const on = (await (await post(path, { state: "on" })).json()) as { sandbox: { on: boolean; state: string } };
    assert.deepEqual([on.sandbox.on, on.sandbox.state], [true, "on"]);
    // One real state per change; turning On also records its provisional entry first, never left
    // newest (§chat.sandbox/states "Turning on"). A dropped provisional entry or a doubled change
    // breaks this sequence.
    assert.deepEqual(heard(sent), ["off", "off", "subagents", "subagents", "on (starting)", "on", "on"], "one push per stored entry plus one as each change settles, in order");
    const shape = () => entries().map((e) => `${e.on ? "on" : e.workers === "off" ? "off" : "subagents"}${(e.reasons as string[] | undefined)?.[0] === "starting" ? " (starting)" : ""}`);
    assert.deepEqual(shape(), ["off", "subagents", "on (starting)", "on"], "one real entry per change, On preceded by its provisional entry");
    // A body whose state and on disagree changes nothing.
    const bad = await post(path, { state: "off", on: true });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: "state and on disagree" });
    assert.deepEqual(shape(), ["off", "subagents", "on (starting)", "on"]);
    // Asking for On again while On records nothing new: no second provisional entry.
    await post(path, { state: "on" });
    assert.deepEqual(shape(), ["off", "subagents", "on (starting)", "on"], "a repeated On records nothing new");
  });
}
