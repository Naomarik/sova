// Run: pnpm test:int -- server/create-mode.integration.test.ts
// Create end to end on a throwaway server (server/testing/hermetic-server.ts: a real chat process, the stand-in model):
// the switch passes the Sova-only check in the chat's own process, and the request that reaches the model carries
// Delegate's block, the align bridge, Create's block and the create_guide tool (§chat.create-mode/delegate-parity).
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { startHermeticServer } from "./testing/hermetic-server";


/** A loopback proxy before the stand-in model that keeps every request body. */
async function recorder(mockPort: number): Promise<{ port: number; bodies: string[]; close: () => void }> {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      bodies.push(body.toString("utf8"));
      const out = request({ host: "127.0.0.1", port: mockPort, path: req.url, method: req.method, headers: req.headers }, (back) => {
        res.writeHead(back.statusCode ?? 502, back.headers);
        back.pipe(res);
      });
      out.end(body);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { port: (server.address() as AddressInfo).port, bodies, close: () => server.close() };
}

const toolNames = (body: string): string[] => ((JSON.parse(body) as { tools?: { function?: { name?: string } }[] }).tools ?? []).map((t) => t.function?.name ?? "");

test("a real chat enters Create: the model gets the three blocks and the lookup, and loses edit and write under strict", { timeout: 120_000 }, async () => {
  const server = await startHermeticServer();
  const proxy = await recorder(server.mockPort);
  try {
    const modelsFile = join(server.agentDir, "models.json");
    writeFileSync(modelsFile, readFileSync(modelsFile, "utf8").replaceAll(`127.0.0.1:${server.mockPort}`, `127.0.0.1:${proxy.port}`));
    // Strict is the chat's own flag, taken from the default it starts on.
    writeFileSync(join(server.agentDir, "mode.json"), JSON.stringify({ version: 1, mode: "delegate", strict: true, minorModes: [] }));

    const headers = { "content-type": "application/json", "x-sova-token": server.token };
    const api = (path: string, body?: unknown) => fetch(`${server.base}${path}`, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const res = await api("/api/sessions", { cwd: realpathSync(server.work) });
    assert.equal(res.status, 201, await res.clone().text());
    const { path } = (await res.json()) as { path: string };

    const on = await api(`/api/mode?path=${encodeURIComponent(path)}`, { mode: "create" });
    assert.equal(on.status, 200, await on.clone().text());
    const got = (await on.json()) as { mode: string; minorModes: string[]; saveMode?: string };
    assert.equal(got.mode, "create");
    assert.deepEqual(got.minorModes, ["align"]);
    assert.equal(got.saveMode, "delegate");

    const sent = await api("/api/sessions/prompt", { path, text: "Hello." });
    assert.ok(sent.status < 300, await sent.clone().text());
    const end = Date.now() + 60_000;
    while (proxy.bodies.length === 0) {
      if (Date.now() > end) throw new Error("no request reached the model");
      await new Promise((r) => setTimeout(r, 50));
    }
    const body = proxy.bodies[0]!;
    assert.ok(body.includes("# Mode: delegate"), "Delegate's block");
    assert.ok(body.includes("takes precedence over delegation"), "the align bridge");
    assert.ok(body.includes("# Mode: create"), "Create's block");
    const tools = toolNames(body);
    assert.ok(tools.includes("create_guide"), `the lookup: ${tools}`);
    assert.ok(!tools.includes("edit") && !tools.includes("write"), `strict: ${tools}`);
  } finally {
    proxy.close();
    await server.stop();
  }
});

test("typed /mode strict on in a real chat process reaches the page and the mode route", { timeout: 120_000 }, async () => {
  const server = await startHermeticServer();
  try {
    const headers = { "content-type": "application/json", "x-sova-token": server.token };
    const res = await fetch(`${server.base}/api/sessions`, { method: "POST", headers, body: JSON.stringify({ cwd: realpathSync(server.work) }) });
    const { path } = (await res.json()) as { path: string };
    const modeUrl = `${server.base}/api/mode?path=${encodeURIComponent(path)}`;
    assert.equal((await fetch(modeUrl, { method: "POST", headers, body: JSON.stringify({ mode: "create" }) })).status, 200);

    const ws = new WebSocket(`${server.base.replace("http", "ws")}/ws/chat?path=${encodeURIComponent(path)}&tail=rest&wire=2`, { headers: { "x-sova-token": server.token } } as never);
    const frames: { type: string; strict?: boolean }[] = [];
    ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
    const until = async (what: string, ok: () => boolean | Promise<boolean>) => {
      const end = Date.now() + 20_000;
      while (!(await ok())) {
        if (Date.now() > end) throw new Error(`timed out: ${what}; frames ${JSON.stringify(frames.map((f) => f.type))}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    await until("the socket's hello", () => frames.some((f) => f.type === "hello"));
    // As the page's composer sends it: a steer, even idle (src/lib/send-frame.ts).
    ws.send(JSON.stringify({ type: "steer", text: "/mode strict on", clientId: "typed-strict" }));
    await until("the page's mode frame", () => frames.some((f) => f.type === "mode" && f.strict === true));
    await until("the mode route", async () => ((await (await fetch(modeUrl, { headers })).json()) as { strict: boolean }).strict === true);
    ws.close();
  } finally {
    await server.stop();
  }
});
