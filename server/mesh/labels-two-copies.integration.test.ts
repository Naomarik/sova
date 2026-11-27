// Labels on a chat across two linked copies (opening B): two hermetic servers, each its own agent
// dir, paired through the mesh (a LAN pairing on loopback: A is the relay, B dials it, A grants B
// `sessions`). A's extension sets a label with its key; it reaches B's row of A's chat only while
// B's request names that label pair, and B's rows are byte-identical otherwise, as are A's own rows
// for every request that names none (a malformed declaration included). No linked computer writes
// A's labels, and A's event stream tells `session.labelled`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { WebSocket } from "ws";
import { EXTENSION_CONTRACT } from "../../shared/extension-contract";
import type { MeshSessionsView } from "../../shared/mesh-access";
import type { SessionSummary } from "../../shared/protocol";
import { type HermeticServer, startHermeticServer } from "../testing/hermetic-server";

const EXT = "lab-labels";
const PAIR = `${EXT}:owner`;
let A: HermeticServer;
let B: HermeticServer;
let key = "";
const made: { id: string; path: string }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(what: string, fn: () => Promise<T | undefined | null | false>, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}
const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

async function call(hs: HermeticServer, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; text: string; json: () => any }> {
  const res = await fetch(`${hs.base}${path}`, {
    method,
    headers: { "x-sova-token": hs.token, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: () => JSON.parse(text) };
}
async function ok(hs: HermeticServer, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<any> {
  const r = await call(hs, method, path, body, headers);
  assert.ok(r.status < 300, `${method} ${path} -> ${r.status} ${r.text}`);
  return r.text ? r.json() : null;
}

/** A closed chat on `hs` with one exchange in it, so the list shows it. */
async function chat(hs: HermeticServer, text: string): Promise<{ id: string; path: string }> {
  const s = (await ok(hs, "POST", "/api/sessions", { cwd: hs.work })) as { id: string; path: string };
  const lines = readFileSync(s.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { id?: string });
  let parent = lines.at(-1)?.id ?? null;
  const ts = new Date(Date.now() - 3_600_000).toISOString();
  const put = (e: Record<string, unknown>) => {
    appendFileSync(s.path, `${JSON.stringify(e)}\n`);
    parent = e.id as string;
  };
  put({ type: "message", id: `u${made.length}`, parentId: parent, timestamp: ts, message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(ts) } });
  put({ type: "message", id: `a${made.length}`, parentId: parent, timestamp: ts, message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: "openai-completions", provider: "mock", model: "m1", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.parse(ts) } });
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(s.path, old, old);
  made.push(s);
  return s;
}

/** B's rows of A's chats from one GET /api/mesh/sessions. */
async function peerRows(query = ""): Promise<SessionSummary[]> {
  const view = (await ok(B, "GET", `/api/mesh/sessions${query}`)) as MeshSessionsView;
  const a = view.peers.find((p) => p.id === "a");
  assert.equal(a?.state, "up", JSON.stringify(view));
  return a!.sessions ?? [];
}
const byId = (rows: SessionSummary[]) => [...rows].sort((x, y) => x.id.localeCompare(y.id));
const labelsQ = `?labels=${encodeURIComponent(PAIR)}`;

before(async () => {
  [A, B] = await Promise.all([startHermeticServer({ bootTimeoutMs: 90_000 }), startHermeticServer({ bootTimeoutMs: 90_000 })]);
  // A's extension: listed in A's list file (a test copy counts its entries approved), key only, no program.
  const keyFile = join(A.agentDir, "sova", "extension-keys", `${EXT}-${createHash("sha256").update(EXT).digest("hex").slice(0, 8)}.key`);
  writeFileSync(join(A.agentDir, "sova", "extensions.json"), JSON.stringify({ version: 1, extensions: [{ id: EXT, title: "Labels lab", needsContract: `1.${EXTENSION_CONTRACT}`, api: `http://127.0.0.1:${await freePort()}` }] }));
  key = await until("A's key for the extension", async () => existsSync(keyFile) && readFileSync(keyFile, "utf8").trim());
  await chat(A, "first chat");
  await chat(A, "second chat");
  // The pairing: A is the relay on loopback and grants B `sessions`; B dials it.
  const aPin = (await ok(A, "POST", "/api/mesh/lan/key")).fingerprint as string;
  const bPin = (await ok(B, "POST", "/api/mesh/lan/key")).fingerprint as string;
  const relayPort = await freePort();
  await ok(A, "PUT", "/api/mesh/lan/relay", { relay: { host: "127.0.0.1", port: relayPort } });
  await ok(A, "POST", "/api/mesh/lan/pairings", { id: "b", label: "Copy B", role: "accept", pin: bPin, grant: "sessions" });
  await ok(B, "POST", "/api/mesh/lan/pairings", { id: "a", label: "Copy A", role: "dial", pin: aPin, host: "127.0.0.1", port: relayPort });
  await until("the pairing's channels", async () => {
    const p = ((await ok(B, "GET", "/api/mesh/lan")).pairings as { id: string; channels?: { answer?: { state: string }; ask?: { state: string } } }[]).find((x) => x.id === "a");
    return p?.channels?.answer?.state === "connected" && p?.channels?.ask?.state === "connected";
  });
  await until("A's chats on B", async () => (await peerRows()).length >= 2);
}, { timeout: 240_000 });

after(async () => {
  await Promise.all([A?.stop(), B?.stop()]);
});

describe("labels across two linked copies", { timeout: 180_000 }, () => {
  let plainA = "";
  let plainB = "";

  test("before any label: a declaration changes no byte, on A or through B, and no store is written", async () => {
    plainA = (await call(A, "GET", "/api/sessions")).text;
    assert.equal((await call(A, "GET", `/api/sessions${labelsQ}`)).text, plainA);
    plainB = JSON.stringify(byId(await peerRows()));
    assert.equal(JSON.stringify(byId(await peerRows(labelsQ))), plainB);
    assert.equal(existsSync(join(A.agentDir, "sova", "session-labels.json")), false);
    assert.equal(existsSync(join(B.agentDir, "sova", "session-labels.json")), false);
  });

  test("only A's extension key writes A's labels: not A's token, not B through the mesh", async () => {
    const [s1] = made;
    assert.equal((await call(A, "POST", "/api/sessions/labels", { id: s1!.id, labels: { owner: "kim" } })).status, 403);
    // B's own token, relayed to A's peer listener.
    assert.equal((await call(B, "POST", "/peer/a/api/sessions/labels", { id: s1!.id, labels: { owner: "kim" } })).status, 403);
    // A remote command run on A's peer listener, the entry's own route as that peer.
    const remote = await call(B, "POST", "/peer/a/api/commands/session.labels.set", { session: s1!.id, labels: { owner: "kim" } });
    assert.ok(remote.status >= 400, remote.text);
    assert.equal(existsSync(join(A.agentDir, "sova", "session-labels.json")), false);
  });

  test("A's key sets a label; A tells session.labelled on its event stream", async () => {
    const [s1] = made;
    const ws = new WebSocket(`${A.base.replace(/^http/, "ws")}/ws/events`, { headers: { "x-sova-token": A.token } });
    const frames: Record<string, unknown>[] = [];
    ws.on("message", (d) => frames.push(JSON.parse(String(d))));
    await until("the events hello", async () => frames.some((f) => f.type === "hello"));
    const r = await ok(A, "POST", "/api/sessions/labels", { id: s1!.id, labels: { owner: "kim" } }, { "x-sova-token": key });
    assert.deepEqual(r, { id: s1!.id, labels: { owner: "kim" } });
    const ev = await until("session.labelled", async () => frames.find((f) => f.name === "session.labelled"));
    ws.close();
    assert.deepEqual({ id: ev.id, path: ev.path, extension: ev.extension, source: ev.source }, { id: s1!.id, path: s1!.path, extension: EXT, source: "hosted" });
    assert.deepEqual(await ok(A, "GET", `/api/sessions/labels?id=${s1!.id}`), { id: s1!.id, labels: { [EXT]: { owner: "kim" } } });
    // The read-back is this computer's own door only.
    assert.equal((await call(B, "GET", `/peer/a/api/sessions/labels?id=${s1!.id}`)).status, 403);
  });

  test("A's rows: labels only for a request naming the pair; every other request byte-identical", async () => {
    const [s1, s2] = made;
    assert.equal((await call(A, "GET", "/api/sessions")).text, plainA);
    for (const bad of ["1", EXT, `${EXT}:Owner`, `${PAIR},`, "x:y:z"]) assert.equal((await call(A, "GET", `/api/sessions?labels=${encodeURIComponent(bad)}`)).text, plainA, bad);
    const rows = (await ok(A, "GET", `/api/sessions${labelsQ}`)) as SessionSummary[];
    assert.deepEqual(rows.find((r) => r.id === s1!.id)?.labels, { [EXT]: { owner: "kim" } });
    assert.equal(rows.find((r) => r.id === s2!.id)?.labels, undefined);
    // A pair it doesn't hold: no field at all.
    assert.equal((await call(A, "GET", `/api/sessions?labels=${encodeURIComponent(`${EXT}:where`)}`)).text, plainA);
    // The single-row reads follow the same rule.
    const one = await call(A, "GET", `/api/sessions/summary?id=${s1!.id}`);
    assert.equal(JSON.parse(one.text).labels, undefined);
    assert.deepEqual((await ok(A, "GET", `/api/sessions/summary?id=${s1!.id}&labels=${encodeURIComponent(PAIR)}`)).labels, { [EXT]: { owner: "kim" } });
  });

  test("B's row of A's chat carries the label only when B declares it; B's rows are byte-identical when it doesn't", async () => {
    const [s1, s2] = made;
    assert.equal(JSON.stringify(byId(await peerRows())), plainB);
    const declared = await peerRows(labelsQ);
    assert.deepEqual(declared.find((r) => r.id === s1!.id)?.labels, { [EXT]: { owner: "kim" } });
    assert.equal(declared.find((r) => r.id === s2!.id)?.labels, undefined);
    // And straight after, undeclared again: the label never sticks to B's plain answer.
    assert.equal(JSON.stringify(byId(await peerRows())), plainB);
    assert.equal(existsSync(join(B.agentDir, "sova", "session-labels.json")), false);
  });
});
