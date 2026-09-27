// M6, Stop while a link message is still queued in the SDK (§mesh.links/delivery, "Stop takes back
// only the user's own queued messages"). B's session is busy in a long bash call when A's partner
// sends it a link message: B answers `delivered` and the message waits in B's SDK steering queue.
// Stop on B, through B's own /ws/chat exactly as the page sends it, must hand nothing of it back
// (no link text in `queue_cleared` or any other frame that returns text to a composer), must not
// have put it on B's branch, and B's next turn must take it in exactly once.
//   LAB_STATE=… scripts/mesh-lab/lab e2e m6-links-stop     (spends two short glm-5.3 turns on b)
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { hostUrl, lab, laptopFetch, requireLab, waitFor } from "./lib.mjs";
import { link, MODEL, newSession, send, transcript, unlink } from "./links-lib.mjs";

const wsBase = (n) => hostUrl(n).replace(/^http/, "ws");
let A, B;

/**
 * A /ws/chat client on `node` for `path` that records every frame, so the test can wait on events
 * and look back at everything the server sent. The model is set before `ready` resolves.
 */
function chatClient(node, path) {
  const frames = [];
  const ws = new WebSocket(`${wsBase(node)}/ws/chat?path=${encodeURIComponent(path)}`);
  let modelSet;
  const ready = new Promise((res, rej) => {
    modelSet = res;
    ws.onerror = () => rej(new Error("ws error"));
  });
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    frames.push(m);
    if (m.type === "hello") ws.send(JSON.stringify({ type: "set_model", ref: MODEL }));
    if (m.type === "model") modelSet();
  };
  const events = () => frames.filter((f) => f.type === "event").map((f) => f.event ?? {});
  return {
    frames,
    events,
    ready,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    /** Resolves once an event matching `pred` arrives after `from` frames (default: any so far). */
    waitEvent: (pred, what, timeoutMs = 120000, from = 0) =>
      waitFor(() => frames.slice(from).some((f) => f.type === "event" && pred(f.event ?? {})), { timeoutMs, intervalMs: 200, what }),
  };
}

before(async () => {
  const cfg = requireLab();
  [A, B] = cfg.hosts;
  const peerUp = async () => (await (await laptopFetch(A, "/api/mesh")).json()).peers?.find((p) => p.id === B)?.state === "up";
  if (!(await peerUp())) lab("pair", "a,b,c");
  await waitFor(peerUp, { timeoutMs: 60000, what: `${A} sees ${B} up` });
});

let client;
let linkId;
// Leave the lab as found: the link ended (its record stays as history), the socket closed.
after(async () => {
  client?.close();
  if (linkId) await unlink(A, linkId);
});

test("Stop on b keeps a link message queued in its SDK out of the composer, and b's next turn takes it in once", async () => {
  const sa = await newSession(A, { model: MODEL });
  const sb = await newSession(B, { model: MODEL });
  const made = await link(A, [{ session: sa.id }, { host: B, session: sb.id }]);
  assert.ok(made.json?.link?.id, `link made: ${made.status} ${JSON.stringify(made.json)}`);
  linkId = made.json.link.id;

  // B busy in a long tool call.
  client = chatClient(B, sb.path);
  await client.ready;
  client.send({ type: "prompt", text: "Use the bash tool to run exactly `sleep 40`, then reply with the single word: slept.", clientId: `m6s-${Date.now()}` });
  await client.waitEvent((e) => e.type === "tool_execution_start" && e.toolName === "bash", "b's bash call to start");

  // A sends while B's tool runs: B takes it into its SDK steering queue, never the web queue.
  const marker = `m6-stop-${Date.now().toString(36)}`;
  const sent = await send(A, sa.id, `Partner note ${marker}: no action needed.`);
  const d = sent.json?.deliveries?.[0];
  assert.equal(d?.state, "delivered", `delivery: ${sent.status} ${JSON.stringify(sent.json)}`);
  await client.waitEvent((e) => e.type === "queue_update" && (e.steering ?? []).some((t) => t.includes(marker)), "the link text in b's SDK steering queue", 15000);
  assert.ok(!client.frames.some((f) => f.type === "queue" && (f.items ?? []).some((it) => String(it.text).includes(marker))), "never a web-queue row");

  // Stop, as the page sends it.
  const beforeStop = client.frames.length;
  client.send({ type: "abort" });
  await client.waitEvent((e) => e.type === "agent_settled" || e.type === "agent_end", "b's turn to stop", 30000, beforeStop);
  await new Promise((r) => setTimeout(r, 1000));
  const handedBack = client.frames
    .slice(beforeStop)
    .filter((f) => f.type === "queue_cleared" || f.type === "queue_item_gone" || f.type === "queue_removed" || (f.type === "error" && f.clientId));
  console.log(`# after Stop: ${handedBack.map((f) => `${f.type}${f.type === "queue_cleared" ? ` steering=${f.steering?.length ?? 0} followUp=${f.followUp?.length ?? 0}` : ""}`).join(", ") || "nothing handed back"}`);
  for (const f of handedBack) assert.ok(!JSON.stringify(f).includes(marker), `link text handed back to a composer: ${JSON.stringify(f)}`);
  const linkRows = async () => (await transcript(B, sb.path)).filter((it) => it.kind === "link" && String(it.text).includes(marker));
  assert.equal((await linkRows()).length, 0, "not on b's branch yet: the model never saw it");

  // B's next turn: the kept message goes in, once.
  const beforeNext = client.frames.length;
  client.send({ type: "prompt", text: "Reply with the single word: resumed.", clientId: `m6s2-${Date.now()}` });
  await client.waitEvent((e) => e.type === "agent_settled", "b's next turn to settle", 180000, beforeNext);
  const rows = await waitFor(async () => {
    const r = await linkRows();
    return r.length ? r : null;
  }, { timeoutMs: 15000, what: "the link row on b's branch" });
  console.log(`# after b's next turn: ${rows.length} link row(s) on the branch`);
  assert.equal(rows.length, 1, `exactly once on the branch: ${JSON.stringify(rows.map((r) => r.id))}`);
});
