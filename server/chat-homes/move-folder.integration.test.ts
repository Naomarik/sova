// Run: pnpm test:int -- server/chat-homes/move-folder.integration.test.ts
// The Chats folder move on a whole hermetic server with the stand-in model (§app.chat-homes/move-folder): an idle open
// chat (its process running) and a compressed chat move with the whole homes folder; only the page's own click starts
// it; afterwards the list shows each chat once from the new folder, the idle chat's next prompt (sent to its old path,
// as a tab still open on it would) writes under the new folder, a new chat lands there, and the old folder is kept.
// A folder set by SOVA_CHAT_HOMES is refused, with the reason.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { authCookieName } from "../auth";
import { startHermeticServer, type HermeticServer } from "../testing/hermetic-server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

function client(s: HermeticServer) {
  const token = { "x-sova-token": s.token, "content-type": "application/json" };
  // The operator's own page: the install's cookie and nothing else.
  const page = { cookie: `${authCookieName(s.agentDir)}=${s.token}`, "content-type": "application/json" };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = token): Promise<{ status: number; body: any }> => {
    const r = await fetch(`${s.base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) };
    } catch {
      return { status: r.status, body: text };
    }
  };
  return { call, page };
}

/** The chat processes of this server (their SOVA_CHAT_HOMES_ROOT), read from /proc. */
function chatProcessRoots(agentDir: string, serverPid: number): string[] {
  const out: string[] = [];
  for (const d of readdirSync("/proc").filter((n) => /^\d+$/.test(n) && Number(n) !== serverPid && Number(n) !== process.pid)) {
    try {
      const vars = readFileSync(`/proc/${d}/environ`, "utf8").split("\0");
      if (!vars.includes(`PI_CODING_AGENT_DIR=${agentDir}`) || !vars.some((v) => v.startsWith("SOVA_CHAT_ID="))) continue;
      out.push(vars.find((v) => v.startsWith("SOVA_CHAT_HOMES_ROOT="))?.slice("SOVA_CHAT_HOMES_ROOT=".length) ?? "");
    } catch {
      // ended, or not ours
    }
  }
  return out;
}

const replies = async (call: ReturnType<typeof client>["call"], path: string) =>
  ((await call("GET", `/api/transcript?path=${encodeURIComponent(path)}`)).body.items as { kind: string }[]).filter((i) => i.kind === "assistant-text").length;

test("an idle open chat and a compressed chat move with the whole folder; afterwards everything is read and written there", { timeout: 240_000 }, async () => {
  // No override: the homes folder comes from the state root (the default, then its marker), as on a real computer.
  const s = await startHermeticServer({ env: { SOVA_CHAT_HOMES: "" } });
  const { call, page } = client(s);
  try {
    // A chat that is compressed later, and the chat that stays open.
    const b = (await call("POST", "/api/sessions", { cwd: s.work })).body as { id: string; path: string };
    assert.equal((await call("POST", "/api/sessions/prompt", { path: b.path, text: "First." })).status < 300, true);
    await until("b's reply", async () => (await replies(call, b.path)) >= 1);
    const a = (await call("POST", "/api/sessions", { cwd: s.work })).body as { id: string; path: string };
    assert.equal((await call("POST", "/api/sessions/prompt", { path: a.path, text: "Hello." })).status < 300, true);
    await until("a's reply", async () => (await replies(call, a.path)) >= 1);
    const before = (await call("GET", "/api/chats-folder")).body;
    const from = before.path as string;
    assert.equal(before.source, "marker", "the first home wrote the marker");
    assert.ok(a.path.startsWith(`${from}/${a.id}/`), a.path);
    assert.equal((await call("POST", "/api/sessions/archive", { path: b.path, archived: true })).status, 200);
    // Compress leaves a file written in the last moments alone: b's last write is made a day old.
    const dayAgo = new Date(Date.now() - 86_400_000);
    utimesSync(b.path, dayAgo, dayAgo);
    const compressed = await call("POST", "/api/sessions/cleanup", { mode: "paths", paths: [b.path], action: "compress" }, page);
    assert.ok(compressed.status < 300, JSON.stringify(compressed.body));
    assert.deepEqual(compressed.body.compressedIds, [b.id], JSON.stringify(compressed.body));
    await until("b compressed", async () => existsSync(join(from, `${b.id}.tar.gz`)));
    // A is idle with its process running.
    await until("a's process", async () => chatProcessRoots(s.agentDir, s.pid).includes(from));

    const to = join(s.scratch, "moved-chats");
    const preview = (await call("GET", `/api/chats-folder/preview?path=${encodeURIComponent(to)}`)).body;
    assert.equal(preview.target, to);
    assert.equal(preview.refusal, undefined, preview.refusal);
    assert.equal(preview.chats, 2);
    // Only the page's own click: the token alone (a script, a chat's terminal) is refused, nothing moves.
    const script = await call("POST", "/api/chats-folder/move", { path: to });
    assert.equal(script.status, 403);
    assert.equal(script.body.yourClick, true);
    assert.equal(existsSync(to), false);
    const started = await call("POST", "/api/chats-folder/move", { path: to }, page);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const info = await until("the move's end", async () => {
      const i = (await call("GET", "/api/chats-folder")).body;
      return i.move && !["stopping", "copying", "switching"].includes(i.move.phase) ? i : undefined;
    });
    assert.equal(info.move.phase, "done", info.move.error);
    assert.equal(info.path, to);
    assert.deepEqual(info.movedFrom, [from]);
    assert.equal(JSON.parse(readFileSync(join(s.agentDir, "sova", "chat-homes.json"), "utf8")).homes, to);
    // Every chat process stopped, the idle one included: none holds the old folder.
    assert.equal(chatProcessRoots(s.agentDir, s.pid).includes(from), false);
    // The old folder is kept, both chats in it; the new one holds them too.
    assert.ok(existsSync(join(from, a.id, "sessions")));
    assert.ok(existsSync(join(from, `${b.id}.tar.gz`)));
    assert.ok(existsSync(join(to, a.id, "sessions")));
    assert.ok(existsSync(join(to, `${b.id}.tar.gz`)));

    // The list: each chat once, from the new folder (the compressed one too).
    const rows = await until("the list from the new folder", async () => {
      const list = (await call("GET", "/api/sessions")).body as { id: string; path: string; compressed?: boolean }[];
      const mine = list.filter((r) => r.id === a.id || r.id === b.id);
      return mine.length === 2 && mine.every((r) => r.path.startsWith(`${to}/`)) ? list : undefined;
    });
    assert.equal(rows.filter((r) => r.id === a.id).length, 1);
    assert.equal(rows.filter((r) => r.id === b.id).length, 1);
    assert.equal(rows.find((r) => r.id === b.id)!.compressed, true);
    const aNew = rows.find((r) => r.id === a.id)!.path;

    // The idle chat's next prompt, to the path a tab still has open: written under the new folder only.
    const oldSize = statSync(a.path).size;
    const repliesBefore = await replies(call, aNew);
    const sent = await call("POST", "/api/sessions/prompt", { path: a.path, text: "Again, after the move." });
    assert.ok(sent.status < 300, JSON.stringify(sent.body));
    await until("the prompt in the new folder", async () => readFileSync(aNew, "utf8").includes("Again, after the move."));
    await until("a's reply to it", async () => (await replies(call, aNew)) > repliesBefore);
    assert.equal(statSync(a.path).size, oldSize, "the old folder is never written");
    await until("a's process on the new folder", async () => chatProcessRoots(s.agentDir, s.pid).includes(to));

    // A new chat lands under the new folder.
    const c = (await call("POST", "/api/sessions", { cwd: s.work })).body as { id: string; path: string };
    assert.ok(c.path.startsWith(`${to}/${c.id}/`), c.path);
  } finally {
    await s.stop();
    // The default folder is under the sentinel home: the scratch root goes whatever it says changed.
    rmSync(s.scratch, { recursive: true, force: true });
  }
});

test("a folder set by SOVA_CHAT_HOMES can't be moved from the page", { timeout: 120_000 }, async () => {
  const s = await startHermeticServer();
  const { call, page } = client(s);
  try {
    const info = (await call("GET", "/api/chats-folder")).body;
    assert.equal(info.source, "env");
    assert.equal(info.env, "SOVA_CHAT_HOMES");
    assert.match(info.locked, /SOVA_CHAT_HOMES sets your chats folder/);
    const to = join(s.scratch, "elsewhere");
    const r = await call("POST", "/api/chats-folder/move", { path: to }, page);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /SOVA_CHAT_HOMES/);
    assert.equal(existsSync(to), false);
  } finally {
    await s.stop();
  }
});
