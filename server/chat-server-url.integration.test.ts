// Run: pnpm test:int -- server/chat-server-url.integration.test.ts
// A chat knows its own server, on whatever port it runs: a real chat process on a throwaway server (never port 4800)
// holds that server's SOVA_URL and no PORT or SOVA_PORT, and `scripts/sova.mjs` run with the chat's env reaches it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { startHermeticServer } from "./testing/hermetic-server";

const CLI = resolve(import.meta.dirname, "..", "scripts", "sova.mjs");

/** The environment of a chat process of this agent dir, once one runs. */
function chatEnvOf(agentDir: string, serverPid: number): Map<string, string> | null {
  const want = `PI_CODING_AGENT_DIR=${agentDir}`;
  for (const d of readdirSync("/proc").filter((n) => /^\d+$/.test(n) && Number(n) !== serverPid && Number(n) !== process.pid)) {
    try {
      const vars = readFileSync(`/proc/${d}/environ`, "utf8").split("\0");
      if (vars.includes(want) && vars.some((v) => v.startsWith("SOVA_CHAT_ID="))) return new Map(vars.map((v) => [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)]));
    } catch {
      // A process that ended, or isn't ours.
    }
  }
  return null;
}

test("a chat's env names its own server, and the command line finds it there", { timeout: 120_000 }, async () => {
  const server = await startHermeticServer();
  try {
    assert.notEqual(new URL(server.base).port, "4800");
    const headers = { "content-type": "application/json", "x-sova-token": server.token };
    const res = await fetch(`${server.base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ cwd: realpathSync(server.work) }) });
    const { path } = (await res.json()) as { path: string };
    const sent = await fetch(`${server.base}/api/sessions/prompt`, { method: "POST", headers, body: JSON.stringify({ path, text: "Hello." }) });
    assert.ok(sent.status < 300, await sent.clone().text());
    let env: Map<string, string> | null = null;
    const end = Date.now() + 30_000;
    while (!(env = chatEnvOf(server.agentDir, server.pid))) {
      if (Date.now() > end) throw new Error("no chat process");
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(env.get("SOVA_URL"), server.base.replace("localhost", "127.0.0.1"));
    assert.equal(env.get("PORT"), undefined);
    assert.equal(env.get("SOVA_PORT"), undefined, "it would also pick a hermetic server's port");
    const r = spawnSync("node", [CLI, "list", "--json"], { env: { PATH: process.env.PATH ?? "", HOME: server.home, SOVA_URL: env.get("SOVA_URL")!, SOVA_TOKEN: server.token, PI_CODING_AGENT_DIR: server.agentDir }, encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    await server.stop();
  }
});
