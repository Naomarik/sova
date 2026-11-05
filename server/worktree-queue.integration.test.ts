// Run: pnpm test:int -- server/worktree-queue.integration.test.ts
// The `worktree` tool in a real chat process, launched by the real chat host on a throwaway server, in a repo the merge
// queue serves (§chat.worktrees/land-own-word, §app.merge-queue/served): `merge` into the target is refused and `land`
// records a go-ahead, master unmoved. Only the model is scripted: it calls the tool, and the tool's answers are read back
// from what it is sent next. The served file is written by this test, as the server's writer would for a listed project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { startHermeticServer } from "./testing/hermetic-server";

const ROOT = resolve(import.meta.dirname, "..");

type Ask = { messages?: { role: string; content?: unknown }[] };

/** The stand-in model: each request gets the next step, a `worktree` call or a closing text. */
async function scriptedModel(steps: (Record<string, unknown> | string)[]): Promise<{ port: number; results: string[]; close: () => void }> {
  const results: string[] = [];
  let n = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const ask = JSON.parse(body || "{}") as Ask;
    const last = ask.messages?.at(-1);
    if (last?.role === "tool") results.push(typeof last.content === "string" ? last.content : JSON.stringify(last.content));
    const step = steps[n++] ?? "Done.";
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, extra: object = {}) =>
      res.write(`data: ${JSON.stringify({ id: `c${n}`, object: "chat.completion.chunk", created: 1, model: "m1", choices: [{ index: 0, delta, ...extra }] })}\n\n`);
    if (typeof step === "string") {
      chunk({ role: "assistant", content: step });
      chunk({}, { finish_reason: "stop" });
    } else {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: "worktree", arguments: JSON.stringify(step) } }] });
      chunk({}, { finish_reason: "tool_calls" });
    }
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as AddressInfo).port, results, close: () => server.close() };
}

test("in a served repo, a chat's `worktree merge` is refused and `land` records a go-ahead; master doesn't move", { timeout: 120_000 }, async () => {
  const server = await startHermeticServer();
  const model = await scriptedModel([
    { action: "create", name: "probe" },
    { action: "merge", path: "feat/probe" },
    "Merge done with.",
    { action: "land", path: "feat/probe" },
    "Land done with.",
    { action: "land", path: "feat/probe" },
    "Plain land done with.",
  ]);
  try {
    const work = realpathSync(server.work);
    const git = (...args: string[]) => {
      const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: work, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: server.home } });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    };
    git("init", "-q", "-b", "master");
    writeFileSync(join(work, "a.txt"), "a\n");
    git("add", "a.txt");
    git("commit", "-q", "-m", "first");
    const master = git("rev-parse", "master");

    const settingsFile = join(server.agentDir, "settings.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    writeFileSync(settingsFile, JSON.stringify({ ...settings, extensions: [join(ROOT, "pi-config", "extensions", "worktrees")] }, null, 2));
    const modelsFile = join(server.agentDir, "models.json");
    writeFileSync(modelsFile, readFileSync(modelsFile, "utf8").replaceAll(`127.0.0.1:${server.mockPort}`, `127.0.0.1:${model.port}`));
    // The server's writer first, then this repo as served.
    const servedFile = join(server.agentDir, "sova", "merge-served.json");
    const end = Date.now() + 30_000;
    const until = async (what: string, ok: () => boolean) => {
      while (!ok()) {
        if (Date.now() > end) throw new Error(`timed out: ${what}; the tool said ${JSON.stringify(model.results)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await until("the server's served file", () => existsSync(servedFile));
    writeFileSync(servedFile, JSON.stringify({ v: 1, at: new Date().toISOString(), roots: [{ root: work, target: "master" }] }));

    const headers = { "content-type": "application/json", "x-sova-token": server.token };
    const res = await fetch(`${server.base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ cwd: work }) });
    const { path } = (await res.json()) as { path: string };
    const ws = new WebSocket(`${server.base.replace("http", "ws")}/ws/chat?path=${encodeURIComponent(path)}&tail=rest&wire=2`, { headers: { "x-sova-token": server.token } } as never);
    const frames: { type: string }[] = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
    await until("the socket's hello", () => frames.some((f) => f.type === "hello"));

    ws.send(JSON.stringify({ type: "prompt", text: "Make a worktree and merge it.", clientId: "one" }));
    await until("the merge's answer", () => model.results.length >= 2);
    assert.match(model.results[1]!, /is the branch others land into/);

    ws.send(JSON.stringify({ type: "prompt", text: "land it", clientId: "two" }));
    await until("the land's answer", () => model.results.length >= 3);
    assert.match(model.results[2]!, /Queued feat\/probe at /);
    const landing = JSON.parse(readFileSync(join(server.agentDir, "sova", "landing.json"), "utf8")) as { goAheads: { branch: string; by: string }[] };
    assert.deepEqual(landing.goAheads.map((g) => [g.branch, g.by]), [["feat/probe", "owner-chat"]]);
    assert.equal(git("rev-parse", "master"), master, "nothing went around the queue");

    // The chat reads the file its server named, so a repo no longer served merges plainly: not a fail-closed "served".
    writeFileSync(servedFile, JSON.stringify({ v: 1, at: new Date().toISOString(), roots: [] }));
    ws.send(JSON.stringify({ type: "prompt", text: "land it", clientId: "three" }));
    await until("the plain land's answer", () => model.results.length >= 4);
    assert.doesNotMatch(model.results[3]!, /Queued/);
    assert.match(model.results[3]!, /already merged into master/, "the plain merge's own answer: the branch has no commit of its own");
    ws.close();
  } finally {
    model.close();
    await server.stop();
  }
});
