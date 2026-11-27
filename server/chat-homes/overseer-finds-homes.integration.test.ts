// Run: pnpm test:int -- server/chat-homes/overseer-finds-homes.integration.test.ts
// The Overseer keeps finding every chat wherever the chats folder is (§app.chat-homes/chats-folder): on a whole
// hermetic server with the stand-in model, the Overseer's own session tools (sova_list_sessions, sova_search_sessions,
// sova_session, sova_read_session), called by its own chat process, find homed chats (a) after a Chats folder move,
// its process restarted with the new folder, and (b) on a server whose folder is set explicitly: SOVA_CHAT_HOMES to a
// folder that isn't the default, and SOVA_CHAT_HOMES_ROOT, a chat process's own variable a server drops at boot.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync } from "node:fs";
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
type Call = ReturnType<typeof client>["call"];

/** Each chat process of this server, by its session id: the SOVA_CHAT_HOMES_ROOT it was started with. */
function chatProcessRoots(agentDir: string, serverPid: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of readdirSync("/proc").filter((n) => /^\d+$/.test(n) && Number(n) !== serverPid && Number(n) !== process.pid)) {
    try {
      const vars = readFileSync(`/proc/${d}/environ`, "utf8").split("\0");
      const id = vars.find((v) => v.startsWith("SOVA_CHAT_ID="))?.slice("SOVA_CHAT_ID=".length);
      if (!vars.includes(`PI_CODING_AGENT_DIR=${agentDir}`) || !id) continue;
      out.set(id, vars.find((v) => v.startsWith("SOVA_CHAT_HOMES_ROOT="))?.slice("SOVA_CHAT_HOMES_ROOT=".length) ?? "");
    } catch {
      // ended, or not ours
    }
  }
  return out;
}

const replies = async (call: Call, path: string) =>
  ((await call("GET", `/api/transcript?path=${encodeURIComponent(path)}`)).body.items as { kind: string }[]).filter((i) => i.kind === "assistant-text").length;

/** The tool results in a session file, oldest first. */
function toolResults(path: string): { tool: string; text: string; isError: boolean }[] {
  const out: { tool: string; text: string; isError: boolean }[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"toolResult"')) continue;
    try {
      const e = JSON.parse(line);
      const m = e?.message;
      if (e?.type !== "message" || m?.role !== "toolResult") continue;
      const text = Array.isArray(m.content) ? m.content.map((p: { text?: string }) => p.text ?? "").join("") : String(m.content ?? "");
      out.push({ tool: m.toolName, text, isError: !!m.isError });
    } catch {
      // a line being written
    }
  }
  return out;
}

/** The Overseer's own chat calls `tool` (the stand-in model's [[call:…]]); its result's text. */
let server: HermeticServer | null = null;
async function overseerCalls(call: Call, tool: string, args: Record<string, unknown>): Promise<string> {
  const ov = (await call("GET", "/api/overseer")).body as { path: string };
  assert.ok(ov?.path, `the Overseer: ${JSON.stringify(ov)}`);
  const before = toolResults(ov.path).filter((r) => r.tool === tool).length;
  // As the page's composer sends it (the prompt route refuses the Overseer's own conversation).
  const frame = { type: "prompt", text: `[[call:${tool} ${JSON.stringify(args)}]]`, clientId: `t-${tool}-${Date.now()}` };
  const sent = await call("POST", `/api/chat/frames?path=${encodeURIComponent(ov.path)}`, { frames: [frame] });
  assert.ok(sent.status < 300, `prompt the Overseer: ${sent.status} ${JSON.stringify(sent.body)}`);
  const got = await until(`the Overseer's ${tool}`, async () => toolResults(ov.path).filter((r) => r.tool === tool)[before], 90_000).catch((err) => {
    const tail = readFileSync(ov.path, "utf8").trim().split("\n").slice(-6).map((l) => l.slice(0, 400));
    throw new Error(`${err.message}\nthe Overseer's last entries:\n${tail.join("\n")}\nserver log:\n${server?.log().slice(-3000)}`);
  });
  assert.equal(got.isError, false, `${tool}: ${got.text}`);
  // Its turn ends before the next prompt, so each call is a turn of its own.
  await until(`the Overseer's turn after ${tool}`, async () => !(await call("GET", "/api/overseer")).body.busy);
  return got.text;
}

/** A homed chat that said `word`, replied to; {id, path}. */
async function chatSaying(s: HermeticServer, call: Call, word: string): Promise<{ id: string; path: string }> {
  const a = (await call("POST", "/api/sessions", { cwd: s.work })).body as { id: string; path: string };
  assert.ok((await call("POST", "/api/sessions/prompt", { path: a.path, text: `Hello ${word}.` })).status < 300);
  await until("the chat's reply", async () => (await replies(call, a.path)) >= 1);
  return a;
}

/** The Overseer's four session tools each find the chat, and read what it said. */
async function overseerFinds(call: Call, chat: { id: string }, word: string, label: string): Promise<void> {
  const list = await overseerCalls(call, "sova_list_sessions", { region: "all", limit: 50 });
  assert.ok(list.includes(chat.id), `${label}: sova_list_sessions lists the chat: ${list.slice(0, 1500)}`);
  const found = await overseerCalls(call, "sova_search_sessions", { words: word });
  assert.ok(found.includes(chat.id), `${label}: sova_search_sessions finds "${word}": ${found.slice(0, 1500)}`);
  const details = await overseerCalls(call, "sova_session", { session: chat.id });
  assert.ok(details.includes(chat.id) && !/no session|isn't a session|not found/i.test(details), `${label}: sova_session: ${details.slice(0, 1500)}`);
  const read = await overseerCalls(call, "sova_read_session", { session: chat.id, from: "start" });
  assert.ok(read.includes(word), `${label}: sova_read_session reads it: ${read.slice(0, 1500)}`);
}

test("after a Chats folder move the Overseer's session tools find the moved chats, its process on the new folder", { timeout: 360_000 }, async () => {
  // No override: the folder comes from the state root (the default, then its marker), as on a real computer.
  const s = (server = await startHermeticServer({ env: { SOVA_CHAT_HOMES: "" } }));
  const { call, page } = client(s);
  try {
    const a = await chatSaying(s, call, "zebrafinch");
    const from = (await call("GET", "/api/chats-folder")).body.path as string;
    assert.ok(a.path.startsWith(`${from}/${a.id}/`), a.path);
    await overseerFinds(call, a, "zebrafinch", "before the move");
    const ov = (await call("GET", "/api/overseer")).body as { id: string };
    await until("the Overseer's process on the old folder", async () => chatProcessRoots(s.agentDir, s.pid).get(ov.id) === from);

    const to = join(s.scratch, "moved-chats");
    const started = await call("POST", "/api/chats-folder/move", { path: to }, page);
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const info = await until("the move's end", async () => {
      const i = (await call("GET", "/api/chats-folder")).body;
      return i.move && !["stopping", "copying", "switching"].includes(i.move.phase) ? i : undefined;
    });
    assert.equal(info.move.phase, "done", info.move.error);
    assert.equal(info.path, to);
    // The Overseer's process was stopped with every other: none holds the old folder.
    assert.equal([...chatProcessRoots(s.agentDir, s.pid).values()].includes(from), false);

    await overseerFinds(call, a, "zebrafinch", "after the move");
    // Started again for those calls, on the new folder.
    assert.equal(chatProcessRoots(s.agentDir, s.pid).get(ov.id), to, "the Overseer's process has the new folder");
    const listed = (await call("GET", "/api/sessions")).body as { id: string; path: string }[];
    assert.ok(listed.find((r) => r.id === a.id)?.path.startsWith(`${to}/`), "the chat is read from the new folder");
  } finally {
    await s.stop();
    rmSync(s.scratch, { recursive: true, force: true });
  }
});

test("on a server whose chats folder is set by SOVA_CHAT_HOMES, not the default, the Overseer's session tools find its chats", { timeout: 240_000 }, async () => {
  // The hermetic server's own SOVA_CHAT_HOMES: a folder in its scratch root, never the default under the home.
  const s = (server = await startHermeticServer());
  const { call } = client(s);
  try {
    const info = (await call("GET", "/api/chats-folder")).body;
    assert.equal(info.source, "env");
    assert.ok(info.path.startsWith(s.scratch) && !info.path.includes("/.local/state/sova/chats/"), info.path);
    const a = await chatSaying(s, call, "quokkabell");
    assert.ok(a.path.startsWith(`${info.path}/${a.id}/`), a.path);
    await overseerFinds(call, a, "quokkabell", "SOVA_CHAT_HOMES");
    const ov = (await call("GET", "/api/overseer")).body as { id: string };
    assert.equal(chatProcessRoots(s.agentDir, s.pid).get(ov.id), info.path, "the Overseer's process has that folder");
  } finally {
    await s.stop();
  }
});

test("a server started with SOVA_CHAT_HOMES_ROOT drops it (a chat process's own variable); the Overseer finds the chats where they are", { timeout: 240_000 }, async () => {
  const s = (server = await startHermeticServer({ env: { SOVA_CHAT_HOMES: "", SOVA_CHAT_HOMES_ROOT: join(tmpRoot(), "not-the-servers") } }));
  const { call } = client(s);
  try {
    const a = await chatSaying(s, call, "lemurtide");
    const info = (await call("GET", "/api/chats-folder")).body;
    assert.notEqual(info.source, "env", "the variable is a chat process's, never the server's");
    assert.ok(a.path.startsWith(`${info.path}/${a.id}/`), `${a.path} under ${info.path}`);
    await overseerFinds(call, a, "lemurtide", "SOVA_CHAT_HOMES_ROOT");
    const ov = (await call("GET", "/api/overseer")).body as { id: string };
    assert.equal(chatProcessRoots(s.agentDir, s.pid).get(ov.id), info.path, "the Overseer's process gets the server's folder");
  } finally {
    await s.stop();
    rmSync(s.scratch, { recursive: true, force: true });
  }
});

/** A folder outside any server's scratch root (never made: the server must not use it). */
function tmpRoot(): string {
  return join(process.env.TMPDIR || "/tmp", `sova-homes-root-${process.pid}`);
}
