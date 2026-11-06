// Run: pnpm test:int -- server/wire-gate.integration.test.ts
// The refusal on a whole server's real socket and through the command line (§mesh.compatibility/
// refusal): a page on another writing number keeps reading, live, and nothing it sends does anything.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { COMPOSER_PARAM, WIRE_AREAS } from "../shared/wire-areas";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

const CLI = join(import.meta.dirname, "..", "scripts", "sova.mjs");
const REPLY = "The package name is in package.json.";
let s: HermeticServer;

before(async () => {
  s = await startHermeticServer();
});
after(async () => {
  await s?.stop();
});

const headers = () => ({ "x-sova-token": s.token, "content-type": "application/json" });
const api = async (method: string, path: string, body?: unknown): Promise<any> => (await fetch(`${s.base}${path}`, { method, headers: headers(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json();
async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A chat socket stating `number`: every frame it hears, in order. */
async function chatSocket(path: string, number: string): Promise<{ ws: WebSocket; heard: any[] }> {
  const url = new URL(`/ws/chat`, s.base.replace(/^http/, "ws"));
  url.searchParams.set("path", path);
  url.searchParams.set(COMPOSER_PARAM, number);
  url.searchParams.set("token", s.token);
  const ws = new WebSocket(url, { headers: { "x-sova-token": s.token } } as never);
  const heard: any[] = [];
  ws.addEventListener("message", (e) => heard.push(JSON.parse(String(e.data))));
  await until("the hello", () => heard.some((f) => f.type === "hello"));
  return { ws, heard };
}

test("a socket on another writing number stays open and live, and every frame is refused", async () => {
  const session = await api("POST", "/api/sessions", { cwd: s.work });
  const ahead = await chatSocket(session.path, String(WIRE_AREAS.composer + 1));
  const heard = ahead.heard;
  const refusals = () => heard.filter((f) => f.type === "error" && f.code === "refused");

  ahead.ws.send(JSON.stringify({ type: "prompt", text: "hello there", clientId: "c1" }));
  await until("the prompt's refusal", () => refusals().length === 1);
  assert.equal(refusals()[0].clientId, "c1", "the page puts that draft back");
  assert.match(refusals()[0].message, /^This host needs an update/);

  // A command from shell mode hears a refusal of its own, so its box stops waiting; nothing runs.
  ahead.ws.send(JSON.stringify({ type: "shell", command: "echo hi", clientId: "c3" }));
  const shellRefused = await until("the command's refusal", () => heard.find((f) => f.type === "shell_refused"));
  assert.equal(shellRefused.clientId, "c3");
  assert.equal(shellRefused.reason, "unavailable");
  assert.match(shellRefused.message, /^This host needs an update/);
  assert.ok(!heard.some((f) => f.type === "shell_start"), "no command started");

  ahead.ws.send(JSON.stringify({ type: "abort" }));
  ahead.ws.send(JSON.stringify({ type: "set_model", ref: "mock/m1" }));
  await until("two more refusals", () => refusals().length === 3);
  assert.equal(refusals()[1].clientId, undefined);

  const rows = await api("GET", `/api/transcript?path=${encodeURIComponent(session.path)}`);
  assert.equal(rows.items.length, 0, "nothing was sent");

  // Another tab on the right number sends; the refused socket hears the reply live.
  const own = await chatSocket(session.path, String(WIRE_AREAS.composer));
  own.ws.send(JSON.stringify({ type: "prompt", text: "hello there", clientId: "c2" }));
  await until("the reply, live on the refused socket", () => JSON.stringify(heard).includes(REPLY));
  assert.equal(ahead.ws.readyState, WebSocket.OPEN);
  ahead.ws.close();
  own.ws.close();
});

test("the command line states its number, so a chat action works, and a server-run first prompt does too", async () => {
  const session = await api("POST", "/api/sessions", { cwd: s.work });
  const r = spawnSync("node", [CLI, "run", "chat.stop", "--session", session.id], {
    env: { PATH: process.env.PATH ?? "", HOME: s.home, LANG: "C.UTF-8", SOVA_URL: s.base, SOVA_TOKEN: s.token, PI_CODING_AGENT_DIR: s.agentDir },
    cwd: s.work,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
});
