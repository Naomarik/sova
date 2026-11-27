// Who typed it, over the live road (§app.extensions/senders): a linked computer's page sends through the peer
// listener's gate to /ws/chat, the chat runs in its own process, and the marker names that computer while an
// extension asks for senders. The stand-in model records every request it is sent: none names the computer, and no
// "[From X]" line is added. With nothing asking, the same road writes nothing new.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";

for (const k of Object.keys(process.env)) if (/_API_KEY$|_AUTH_TOKEN$/.test(k)) delete process.env[k];

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "sova-senders-int-")));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
const agentDir = join(tmp, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PORT = "0";
mkdirSync(join(agentDir, "sessions", "live"), { recursive: true });
const dist = join(tmp, "dist");
mkdirSync(dist);
writeFileSync(join(dist, "index.html"), "<!doctype html><title>stub</title>");
const cwd = join(tmp, "work");
mkdirSync(cwd);

// The stand-in model: an OpenAI-style stream answering "ok", keeping each request's body.
const bodies: string[] = [];
const model: Server = createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    bodies.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] });
    chunk({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
const modelPort = (model.address() as { port: number }).port;
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({ providers: { standin: { baseUrl: `http://127.0.0.1:${modelPort}/v1`, api: "openai-completions", apiKey: "standin", compat: { supportsDeveloperRole: false, supportsReasoningEffort: false }, models: [{ id: "m", contextWindow: 100000, maxTokens: 1000 }] } } }),
);
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "standin", defaultModel: "m", retry: { enabled: false } }));
const extFile = join(tmp, "extensions-list.json");
process.env.SOVA_EXTENSIONS_FILE = extFile;
writeFileSync(extFile, JSON.stringify({ version: 1, extensions: [] }));

const { server } = await import("./index");
const { sovaToken, TOKEN_HEADER } = await import("./auth");
const { PeerGate } = await import("./mesh/listener");
const { upgradeSovaSocket } = await import("./ws");
const { readExtensions } = await import("./extensions");

const PEER = { id: "kim", label: "Kim's laptop", nodeId: "nKIM7CNTRL", dnsName: "kim.example" };
const gate = new PeerGate({ fetch: () => new Response("no"), upgrade: upgradeSovaSocket, allows: () => true });
const peerServer: Server = gate.server(() => PEER as never);
let host = "";
let peerPort = 0;

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  await new Promise<void>((r) => peerServer.listen(0, "127.0.0.1", r));
  peerPort = (peerServer.address() as { port: number }).port;
});
after(async () => {
  peerServer.close();
  server.close();
  model.close();
});

function installed(asking: boolean): void {
  writeFileSync(extFile, JSON.stringify({ version: 1, extensions: asking ? [{ id: "team-bar", title: "Team bar", records: ["senders"] }] : [] }));
  readExtensions(); // as the key sync's next read does
}

async function newSession(): Promise<string> {
  const res = await fetch(`http://${host}/api/sessions`, { method: "POST", headers: { [TOKEN_HEADER]: sovaToken(), "content-type": "application/json" }, body: JSON.stringify({ cwd }) });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { path: string }).path;
}

/** One prompt from the linked computer's socket, through the peer listener, answered. */
async function sendFromPeer(path: string, text: string): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${peerPort}/ws/chat?path=${encodeURIComponent(path)}&wire=2`);
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  const before = bodies.length;
  ws.send(JSON.stringify({ type: "prompt", text, clientId: `c-${text.length}` }));
  const end = Date.now() + 30_000;
  while (!(bodies.length > before && readFileSync(path, "utf8").includes('"ok"'))) {
    if (Date.now() > end) throw new Error(`no reply to "${text}"`);
    await new Promise((r) => setTimeout(r, 25));
  }
  // The reply is in the file; give its marker's microtask a moment by waiting for the file to settle.
  let last = "";
  for (let i = 0; i < 40 && readFileSync(path, "utf8") !== last; i++) {
    last = readFileSync(path, "utf8");
    await new Promise((r) => setTimeout(r, 50));
  }
  ws.close();
}

/** A file's entries as their kinds, in order: what a run wrote, without its ids, times and texts. */
const shapeOf = (path: string): string[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; customType?: string; message?: { role?: string } })
    .map((e) => [e.type, e.customType ?? e.message?.role ?? ""].join(":"));
/** A model request without what differs between two runs of one message: the session's own id and times. */
const requestShape = (body: string, path: string): string => body.split(path.split("_").pop()!.replace(".jsonl", "")).join("<id>").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<t>");

let inert: { shape: string[]; request: string } | null = null;

test("with nothing asking, a linked computer's message leaves no marker", async () => {
  installed(false);
  const path = await newSession();
  const from = bodies.length;
  await sendFromPeer(path, "hello from the laptop");
  assert.ok(readFileSync(path, "utf8").includes("hello from the laptop"));
  assert.ok(!readFileSync(path, "utf8").includes("sova-member-sent"));
  inert = { shape: shapeOf(path), request: requestShape(bodies.slice(from).join("\n"), path) };
});

test("while an extension asks, the marker names the linked computer and the model never reads it", async () => {
  installed(true);
  const path = await newSession();
  const from = bodies.length;
  await sendFromPeer(path, "hello from the laptop");
  const marks = readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; customType?: string; data?: { by?: string; label?: string; targetId?: string }; id?: string; message?: { role?: string } })
    .filter((e) => e.customType === "sova-member-sent");
  assert.equal(marks.length, 1, "one marker");
  assert.deepEqual({ by: marks[0]!.data!.by, label: marks[0]!.data!.label }, { by: `peer:${PEER.nodeId}`, label: PEER.label });
  const read = (await (await fetch(`http://${host}/api/sessions/senders?path=${encodeURIComponent(path)}`, { headers: { [TOKEN_HEADER]: sovaToken() } })).json()) as { messages: { by: string }[] };
  assert.deepEqual(read.messages.map((m) => m.by), [`peer:${PEER.nodeId}`]);
  // Exactly one entry more than the same message with nothing asking, right after the message; the model's request the same.
  assert.ok(inert, "the inert run went first");
  const shape = shapeOf(path);
  const at = shape.indexOf("custom:sova-member-sent");
  assert.deepEqual([...shape.slice(0, at), ...shape.slice(at + 1)], inert!.shape);
  assert.equal(shape[at - 1], "message:user");
  assert.equal(requestShape(bodies.slice(from).join("\n"), path), inert!.request, "the model was sent the same request");
  const seen = bodies.slice(from).join("\n");
  assert.ok(seen.includes("hello from the laptop"), "the model got the message");
  for (const leak of [PEER.nodeId, PEER.label, "sova-member-sent", "[From"]) assert.ok(!seen.includes(leak), `the model was sent ${leak}`);
});
