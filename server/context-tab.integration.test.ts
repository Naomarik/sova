// Run: pnpm test:int -- server/context-tab.integration.test.ts
// The Context tab's read on a whole hermetic server with the stand-in model (server/testing/hermetic-server.ts):
// GET /api/sessions/context-view's 400 and 404; an open chat before its first reply (nothing sent, its
// instruction file, its prompt's sections and tools, a subfolder file not yet loaded) and after it (a total and
// a window); and /api/sessions/context/file opening that subfolder file, while a file nothing lists stays a 404.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { startHermeticServer, type HermeticServer } from "./testing/hermetic-server";

let s: HermeticServer;
before(async () => {
  s = await startHermeticServer();
  writeFileSync(join(s.work, "AGENTS.md"), "# Root rules\n\nBe brief.\n");
  mkdirSync(join(s.work, "api"));
  writeFileSync(join(s.work, "api", "AGENTS.md"), "# API rules\n\nValidate input.\n");
  writeFileSync(join(s.work, "api", "notes.md"), "not an instruction file\n");
});
after(async () => {
  await s?.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${s.base}${path}`, { method, headers: { "x-sova-token": s.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}
async function until<T>(what: string, fn: () => Promise<T | undefined | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}
const view = async (path: string) => (await api("GET", `/api/sessions/context-view?path=${encodeURIComponent(path)}`)).body;

test("context-view: 400 a bad path, 404 a missing session file", async () => {
  assert.equal((await api("GET", "/api/sessions/context-view")).status, 400);
  assert.equal((await api("GET", "/api/sessions/context-view?path=/etc/passwd")).status, 400);
  assert.equal((await api("GET", `/api/sessions/context-view?path=${encodeURIComponent(join(s.agentDir, "sessions", "nope", "x.jsonl"))}`)).status, 404);
});

test("an open chat: its files, prompt and tools before the first reply; the total and window after it; its subfolder file opens", async () => {
  const ses = (await api("POST", "/api/sessions", { cwd: s.work })).body as { id: string; path: string };
  // Not open in this server yet: the files and the nested file, no prompt, nothing sent.
  const before = await view(ses.path);
  assert.equal(before.state, "ok", JSON.stringify(before));
  assert.equal(before.total, null, "nothing sent yet");
  assert.ok(before.instructions.some((p: any) => p.label === "AGENTS.md" && p.path === join(s.work, "AGENTS.md") && p.tokens > 0));
  assert.deepEqual(before.nested, [{ path: "api/AGENTS.md", abs: join(s.work, "api", "AGENTS.md"), folder: "api", tokens: 8, loaded: false }]);

  const file = await api("GET", `/api/sessions/context/file?path=${encodeURIComponent(ses.path)}&file=${encodeURIComponent(join(s.work, "api", "AGENTS.md"))}`);
  assert.equal(file.status, 200);
  assert.match(file.body.text, /Validate input/);
  assert.equal((await api("GET", `/api/sessions/context/file?path=${encodeURIComponent(ses.path)}&file=${encodeURIComponent(join(s.work, "api", "notes.md"))}`)).status, 404);

  const sent = await api("POST", "/api/sessions/prompt", { path: ses.path, text: "hello there" });
  assert.ok(sent.status < 300, JSON.stringify(sent));
  await until("the reply", async () => ((await api("GET", `/api/transcript?path=${encodeURIComponent(ses.path)}`)).body.items as any[]).some((i) => i.kind === "assistant-text"));
  let last: unknown;
  // Held now: its prompt's sections and its tools, and the reply's total.
  const afterReply = await until("a total", async () => {
    const v = (last = await view(ses.path));
    return v.state === "ok" && v.total !== null ? v : undefined;
  }).catch((e) => assert.fail(`${e.message}: ${JSON.stringify(last).slice(0, 600)}`));
  assert.ok(afterReply.total > 0);
  assert.ok(typeof afterReply.window === "number" && afterReply.window > 0, "the model's window");
  assert.ok(afterReply.conversation > 0);
  assert.equal(afterReply.prompt, true);
  assert.ok(afterReply.rules.some((p: any) => p.label === "Rules" && p.text.length > 0));
  assert.ok(afterReply.tools.some((p: any) => p.label === "read" && JSON.parse(p.text).name === "read"));
});
