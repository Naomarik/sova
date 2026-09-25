// M2 at the API/WS level (frontend covers the browser half): from host A's main listener, list B's
// sessions, create a session on B, drive a glm-5.3 chat on it through /peer/b/ws/chat and prove
// the JSONL lands on B's disk only; a 4409 busy refusal passes through the proxy exactly; killing
// B shows it down on A while A's own sessions and chat keep working; B comes back.
//   scripts/mesh-lab/lab e2e m2        (spends two short glm-5.3 turns; needs the zai key on a, b)
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import { chaos, hostUrl, lab, laptopFetch, requireLab, sh, waitFor, writeAgentFile } from "./lib.mjs";

const MODEL = "zai/glm-5.3";
/** ws://127.0.0.1:<node's laptop port> */
const wsBase = (n) => hostUrl(n).replace(/^http/, "ws");
let cfg;
let A, B;
const meshOf = async (n) => (await laptopFetch(n, "/api/mesh")).json();
const peerState = async (n, id) => (await meshOf(n)).peers?.find((p) => p.id === id)?.state;

/** A /ws/chat conversation from the laptop: open, set the model, send one prompt, wait for the
 *  turn to settle. Returns what happened; never throws on a close. */
function chat(url, text, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const r = { opened: false, hello: null, model: null, deltas: "", eventTypes: new Set(), closeCode: null, closeReason: null, error: null };
    const ws = new WebSocket(url);
    const done = () => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      r.eventTypes = [...r.eventTypes];
      resolve(r);
    };
    const timer = setTimeout(() => {
      r.error = "timeout";
      done();
    }, timeoutMs);
    ws.onopen = () => (r.opened = true);
    ws.onclose = (e) => {
      r.closeCode = e.code;
      r.closeReason = e.reason;
      done();
    };
    ws.onerror = () => {};
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "hello") {
        r.hello = m;
        ws.send(JSON.stringify({ type: "set_model", ref: MODEL }));
      } else if (m.type === "model") {
        r.model = m.model;
        if (text !== null && !r.prompted) {
          r.prompted = true;
          ws.send(JSON.stringify({ type: "prompt", text, clientId: `m2-${Date.now()}` }));
        } else if (text === null) done();
      } else if (m.type === "error") {
        r.error = m.message ?? JSON.stringify(m);
      } else if (m.type === "event") {
        const ev = m.event ?? {};
        r.eventTypes.add(ev.type);
        if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") r.deltas += ev.assistantMessageEvent.delta ?? "";
        if (ev.type === "agent_settled" || ev.type === "agent_end") setTimeout(done, 500);
      }
    };
  });
}

/** Does a session file with this id exist on `node`'s disk? */
const onDisk = (node, id) => sh(node, `find "$PI_CODING_AGENT_DIR/sessions" -name "*${id}.jsonl" | grep -q .`).code === 0;
const assistantTextOnDisk = (node, path) => {
  const r = sh(node, `cat '${path.replace(/'/g, "'\\''")}'`);
  return r.out
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "message" && e.message?.role === "assistant")
    .flatMap((e) => (Array.isArray(e.message.content) ? e.message.content : []))
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
};

before(async () => {
  cfg = requireLab();
  [A, B] = cfg.hosts;
  if ((await meshOf(A)).peers?.find((p) => p.id === B)?.state !== "up") lab("pair", cfg.hosts.join(","));
  await waitFor(async () => (await peerState(A, B)) === "up", { timeoutMs: 60000, what: `${A} sees ${B} up` });
});

describe("drive a peer's session from A", () => {
  let created;

  test("A's federated list carries B's sessions, attributed to B", async () => {
    const fed = await (await laptopFetch(A, "/api/mesh/sessions")).json();
    const b = fed.peers.find((p) => p.id === B);
    assert.equal(b?.state, "up");
    const direct = await (await laptopFetch(B, "/api/sessions")).json();
    assert.deepEqual(new Set(b.sessions.map((s) => s.id)), new Set(direct.map((s) => s.id)), "the same sessions B lists itself");
    // the plain list on A stays A's own
    const own = await (await laptopFetch(A, "/api/sessions")).json();
    for (const s of own) assert.ok(!direct.some((d) => d.id === s.id), `A's /api/sessions lists B's ${s.id}`);
    for (const s of own) assert.equal(s.peer, undefined, "plain SessionSummary carries no peer field");
  });

  test("POST /peer/b/api/sessions creates the session on B's disk, not A's", async () => {
    const res = await laptopFetch(A, `/peer/${B}/api/sessions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/root/work" }) });
    assert.ok(res.status === 200 || res.status === 201, `status ${res.status}`);
    created = await res.json();
    assert.ok(created.id && created.path, JSON.stringify(created));
    assert.equal(onDisk(B, created.id), true, "on B");
    assert.equal(onDisk(A, created.id), false, "not on A");
  });

  test("a glm-5.3 turn through /peer/b/ws/chat streams to A and is written on B only", async () => {
    assert.ok(created, "needs the created session");
    const url = `${wsBase(A)}/peer/${B}/ws/chat?path=${encodeURIComponent(created.path)}`;
    const r = await chat(url, "Reply with exactly the word: mesh-ok");
    assert.equal(r.opened, true, JSON.stringify(r));
    assert.ok(r.hello, "hello");
    assert.equal(r.model, MODEL);
    assert.equal(r.error, null, `chat error: ${r.error}`);
    assert.ok(r.eventTypes.includes("agent_start"), `events: ${r.eventTypes}`);
    assert.match(r.deltas, /mesh-ok/i, "streamed reply");
    const text = await waitFor(() => assistantTextOnDisk(B, created.path), { timeoutMs: 15000, what: "reply on B's disk" });
    assert.match(text, /mesh-ok/i);
    assert.equal(onDisk(A, created.id), false, "never on A");
  });
});

describe("close codes through the proxy", () => {
  test("a busy session's 4409 reaches A's client exactly as B sends it", async () => {
    // a session file B does not hold, written seconds ago by "someone else": /ws/chat refuses it
    const id = `m2busy-${Date.now()}`;
    const rel = `sessions/--root-work--/2026-09-25T00-00-00-000Z_${id}.jsonl`;
    writeAgentFile(B, rel, JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/root/work" }) + "\n");
    const path = `/sova/.agent/${rel}`;
    try {
      const direct = await chat(`${wsBase(B)}/ws/chat?path=${encodeURIComponent(path)}`, null, { timeoutMs: 10000 });
      const viaA = await chat(`${wsBase(A)}/peer/${B}/ws/chat?path=${encodeURIComponent(path)}`, null, { timeoutMs: 10000 });
      assert.equal(direct.closeCode, 4409, `direct: ${JSON.stringify(direct)}`);
      assert.equal(viaA.closeCode, direct.closeCode, "same code through the proxy");
      assert.equal(viaA.closeReason, direct.closeReason, "same reason through the proxy");
    } finally {
      sh(B, `rm -f "$PI_CODING_AGENT_DIR/${rel}"`);
    }
  });
});

describe("B down", () => {
  test("killing B: A shows B down, A's own sessions and chat keep working; B comes back", async () => {
    chaos.kill(B);
    try {
      await waitFor(async () => (await peerState(A, B)) === "down", { timeoutMs: 30000, what: `${A} sees ${B} down` });
      const fed = await (await laptopFetch(A, "/api/mesh/sessions", { timeoutMs: 20000 })).json();
      assert.equal(fed.peers.find((p) => p.id === B)?.state, "down");
      const own = await laptopFetch(A, "/api/sessions");
      assert.equal(own.status, 200);
      const t0 = Date.now();
      assert.equal((await laptopFetch(A, `/peer/${B}/api/health`, { timeoutMs: 20000 })).status, 502);
      console.log(`# /peer/${B} on a killed B answered 502 after ${Date.now() - t0} ms`);
      // A's own chat, while B is gone
      const res = await laptopFetch(A, "/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: "/root/work" }) });
      const mine = await res.json();
      const r = await chat(`${wsBase(A)}/ws/chat?path=${encodeURIComponent(mine.path)}`, "Reply with exactly the word: local-ok");
      assert.equal(r.error, null, `A's chat: ${r.error}`);
      assert.match(r.deltas, /local-ok/i);
    } finally {
      chaos.start(B);
    }
    await waitFor(async () => (await peerState(A, B)) === "up", { timeoutMs: 120000, what: `${A} sees ${B} up again` });
  });
});
