// M6 linked sessions across hosts (§mesh/links), the record and the routing, against real hosts:
//   1. a 2-host link with Headscale whois identities: send, wake, reply; and a 3-host link whose
//      creator is not a member;
//   2. a phone-style host (d, SOVA_MESH_IDENTITY=addresses, peers.json by tailnet IP, no
//      SOVA_SELF_NODE_ID) learning its own node identity from a copy's `you` and from whoami;
//   3. the outbox across a Sova stop/start (peer-up) and a partition (whichever path drains it,
//      read from a's log), and a host on a build without links (e on a19d588): refused, final.
//   LAB_STATE=… scripts/mesh-lab/lab e2e m6-links     (spends a few short glm-5.3 turns)
// Takes the lab LOCK; leaves a,b,c paired, d and e unpaired and on the built code.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { chaos, container, lab, laptopFetch, nodeId, readAgentFile, requireLab, sh, tailnetIp, waitFor, writeAgentFile } from "./lib.mjs";
import { byId, inbox, link, linksFile, members, newSession, releaseLock, send, takeLock, thread, transcript, unlink, waitIdle, waitInbox, writeLinksFile } from "./links-lib.mjs";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
/** The commit without links (the branch's base). */
const OLD_BUILD = "a19d588";
const meshOf = async (n) => (await laptopFetch(n, "/api/mesh", { timeoutMs: 20000 })).json();
const peerState = async (n, id) => (await meshOf(n)).peers?.find((p) => p.id === id)?.state;
const waitUp = (from, to, states = ["up"]) =>
  waitFor(async () => states.includes(await peerState(from, to)), { timeoutMs: 90000, intervalMs: 2000, what: `${from} sees ${to} ${states.join("/")}` });
const outboxOf = (n) => (readAgentFile(n, "sova/mesh-links/outbox.jsonl") ?? "").split("\n").filter(Boolean);
const outboxLog = (n) => sh(n, "grep -a '\\[links\\] outbox' /var/log/lab/sova.log || true").out.split("\n").filter(Boolean);
const nonce = () => Math.random().toString(36).slice(2, 8);
/** Links this run made, ended at the end so no partner keeps answering. */
const made = [];
const remember = (host, r) => {
  if (r.status === 200) made.push([host, r.json.link.id]);
  return r;
};

let cfg;
before(async () => {
  cfg = requireLab();
  for (const h of ["a", "b", "c", "d", "e"]) assert.ok(cfg.hosts.includes(h), `the lab needs host ${h} (lab up --hosts 5)`);
  await takeLock("mesh-server");
  lab("pair", "a,b,c");
  await waitUp("a", "b");
  await waitUp("a", "c");
  await waitUp("b", "c");
});

after(async () => {
  for (const [h, id] of made) await unlink(h, id).catch(() => {});
  try {
    lab("sova-env", "d", "--clear");
    lab("unpair", "d,e");
    lab("pair", "a,b,c");
  } finally {
    releaseLock();
  }
});

describe("1. linked sessions on real hosts", () => {
  test("a 2-host link: a's message wakes b's session, and a reply comes back", async () => {
    const sa = await newSession("a");
    const sb = await newSession("b");
    const r = remember("a", await link("a", [{ session: sa.id }, { host: "b", session: sb.id }]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.link.id;
    // Members by the real whois identities, and b's copy on its disk.
    assert.deepEqual(r.json.link.members.map((m) => m.nodeId), [nodeId("a"), nodeId("b")]);
    assert.equal(r.json.link.createdBy, nodeId("a"));
    const onB = await waitFor(() => linksFile("b")?.links.find((l) => l.id === id), { what: "b's copy" });
    assert.deepEqual(onB, r.json.link);

    const word = `pong-${nonce()}`;
    const sent = await send("a", sa.id, `Hello from host A. Reply once with the link_send tool, text exactly: ${word}. Then stop; do not send anything else.`);
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.deepEqual(sent.json.deliveries.map((d) => d.state), ["started"], JSON.stringify(sent.json));
    // b's turn is a real turn opened by the link message; the row is kind "link".
    await waitFor(async () => (await transcript("b", sb.path)).some((i) => i.kind === "link" && i.link?.linkId === id), { what: "the link row on b" });
    const bIn = await inbox("b", sb.id);
    assert.ok(bIn.some((x) => x.dir === "in" && x.id === sent.json.messageId && x.delivery?.state === "started"), JSON.stringify(bIn));

    let replied = true;
    try {
      await waitInbox("a", sa.id, (recs) => recs.some((x) => x.dir === "in" && x.text.includes(word)), { timeoutMs: 180000, what: "the model's link_send reply on a" });
    } catch {
      replied = false;
      console.log("# b's model did not reply through link_send in time: replying through the API instead (the wake is proven above)");
      await waitIdle("b", sb.id);
      const back = await send("b", sb.id, word);
      assert.equal(back.status, 200, JSON.stringify(back.json));
    }
    const aRecs = await waitInbox("a", sa.id, (recs) => recs.some((x) => x.dir === "in" && x.text.includes(word)));
    assert.ok(aRecs.some((x) => x.dir === "out" && x.id === sent.json.messageId), "a's inbox has its own message");
    const bRecs = await inbox("b", sb.id);
    assert.ok(bRecs.some((x) => x.dir === "out" && x.text.includes(word)), "b's inbox has its reply");
    console.log(`# reply came back through ${replied ? "b's model (link_send)" : "the API"}`);
    await unlink("a", id);
    await waitIdle("a", sa.id).catch(() => {});
  });

  test("a 3-host link made on a with members on b and c", async () => {
    const sb = await newSession("b");
    const sc = await newSession("c");
    const r = remember("a", await link("a", [{ host: "b", session: sb.id }, { host: "c", session: sc.id }]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const id = r.json.link.id;
    assert.equal(r.json.link.createdBy, nodeId("a"));
    assert.ok(!r.json.link.members.some((m) => m.nodeId === nodeId("a")), "a is not a member");
    assert.ok(linksFile("a").links.some((l) => l.id === id), "a keeps the record");
    for (const h of ["b", "c"]) await waitFor(() => linksFile(h)?.links.some((l) => l.id === id), { what: `${h}'s copy` });
    const sent = await send("b", sb.id, "A note from host B, no reply needed: answer only with the word ok.", "Host C");
    assert.equal(sent.status, 200, JSON.stringify(sent.json));
    assert.deepEqual(sent.json.deliveries.map((d) => [d.to.sessionId, d.state]), [[sc.id, "started"]]);
    await waitInbox("c", sc.id, (recs) => recs.some((x) => x.dir === "in" && x.id === sent.json.messageId));
    assert.deepEqual((await thread("a", id)).json.messages, [], "a holds no inbox for a link it isn't in");
    assert.ok((await thread("b", id)).json.messages.length > 0, "b's thread has the message");
    // a lists it with both members, each on its own host.
    const all = await members("a");
    const view = all.find((v) => v.link.id === id);
    assert.deepEqual(view.members.map((m) => [m.hostId, m.reach]), [["b", "up"], ["c", "up"]]);
    await unlink("a", id);
    await waitFor(() => linksFile("c")?.links.find((l) => l.id === id)?.endedAt, { what: "c hears the end" });
    await waitIdle("c", sc.id).catch(() => {});
  });
});

describe("2. a host that identifies callers by address learns its own node identity", () => {
  const D = "d";
  before(async () => {
    lab("pair", "a,b,c,d");
    // d: peers by tailnet IP, no SOVA_SELF_NODE_ID, identity by address (the phone's way).
    const file = JSON.parse(readAgentFile(D, "sova/peers.json"));
    file.peers = file.peers.map((p) => ({ ...p, dnsName: tailnetIp(p.id) }));
    writeAgentFile(D, "sova/peers.json", `${JSON.stringify(file, null, 2)}\n`);
    writeLinksFile(D, null);
    lab("sova-env", D, "SOVA_MESH_IDENTITY=addresses", `SOVA_PEER_HOST=${tailnetIp(D)}`);
    chaos.sovaRestart(D);
    await waitUp("a", D);
    await waitUp(D, "a");
  });

  test("from a link copy's `you`", async () => {
    assert.equal(linksFile(D)?.selfNodeId, undefined, "d starts not knowing itself");
    const sa = await newSession("a");
    const sd = await newSession(D);
    const r = remember("a", await link("a", [{ session: sa.id }, { host: D, session: sd.id }]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const file = await waitFor(() => (linksFile(D)?.links.some((l) => l.id === r.json.link.id) ? linksFile(D) : null), { what: "d's copy" });
    assert.equal(file.selfNodeId, nodeId(D), "learnt from `you`");
    // And it now knows which member it is: link_members for its session lists the link.
    assert.deepEqual((await members(D, sd.id)).map((v) => v.link.id), [r.json.link.id]);
  });

  test("from whoami, when d makes a link itself", async () => {
    writeLinksFile(D, null);
    chaos.sovaRestart(D);
    await waitUp("a", D);
    await waitUp(D, "a");
    assert.equal(linksFile(D)?.selfNodeId, undefined, "reset");
    const sd = await newSession(D);
    const sa = await newSession("a");
    const r = remember(D, await link(D, [{ session: sd.id }, { host: "a", session: sa.id }]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.link.createdBy, nodeId(D), "createdBy is d's real node identity");
    assert.equal(linksFile(D).selfNodeId, nodeId(D), "on d's disk");
    await waitFor(() => linksFile("a")?.links.some((l) => l.id === r.json.link.id), { what: "a's copy" });
  });
});

describe("3. the outbox and a build without links", () => {
  test("b's Sova stopped: held in a's outbox, delivered when b comes back", async () => {
    const sa = await newSession("a");
    const sb = await newSession("b");
    const r = remember("a", await link("a", [{ session: sa.id }, { host: "b", session: sb.id }]));
    assert.equal(r.status, 200);
    chaos.sovaStop("b");
    let sent;
    try {
      sent = await send("a", sa.id, "Held while you were down. No reply needed: answer only ok.");
      assert.equal(sent.status, 200, JSON.stringify(sent.json));
      assert.deepEqual(sent.json.deliveries.map((d) => d.state), ["outbox"]);
      assert.equal(outboxOf("a").length, 1);
    } finally {
      chaos.sovaStart("b");
    }
    const t0 = Date.now();
    const recs = await waitInbox("a", sa.id, (xs) => xs.find((x) => x.id === sent.json.messageId)?.deliveries?.[0]?.state === "started", {
      timeoutMs: 120000,
      what: "the held message delivered",
    });
    console.log(`# delivered ${Math.round((Date.now() - t0) / 1000)} s after b's Sova started; a's log: ${outboxLog("a").slice(-2).join(" | ")}`);
    assert.ok(recs);
    assert.equal(outboxOf("a").length, 0, "outbox empty");
    assert.ok((await inbox("b", sb.id)).some((x) => x.id === sent.json.messageId), "on b");
    await waitIdle("b", sb.id).catch(() => {});
  });

  test("b partitioned: held, then drained after the partition heals (the path read from the log)", async () => {
    const sa = await newSession("a");
    const sb = await newSession("b");
    const r = remember("a", await link("a", [{ session: sa.id }, { host: "b", session: sb.id }]));
    assert.equal(r.status, 200);
    const before = outboxLog("a").length;
    chaos.partition("b", "--reject");
    let sent;
    let healed;
    try {
      sent = await send("a", sa.id, "Held across a partition. No reply needed: answer only ok.");
      assert.deepEqual(sent.json.deliveries.map((d) => d.state), ["outbox"], JSON.stringify(sent.json));
    } finally {
      chaos.restore("b");
      healed = Date.now();
    }
    await waitInbox("a", sa.id, (xs) => xs.find((x) => x.id === sent.json.messageId)?.deliveries?.[0]?.state === "started", {
      timeoutMs: 150000,
      what: "the held message delivered",
    });
    const took = Math.round((Date.now() - healed) / 1000);
    const lines = outboxLog("a").slice(before);
    const drained = lines.find((l) => /settled \((timer|peer-up [a-z]+)\)/.test(l));
    console.log(`# drained ${took} s after the partition healed by: ${drained}`);
    assert.ok(drained, `a logs the drain: ${lines.join(" | ")}`);
    assert.equal(outboxOf("a").length, 0);
    await waitIdle("b", sb.id).catch(() => {});
  });

  test("e on a build without links: a send is refused old-build, final, never held", async () => {
    const E = "e";
    lab("pair", "a,b,c,e");
    await waitUp("a", E);
    const sa = await newSession("a");
    const se = await newSession(E);
    const r = remember("a", await link("a", [{ session: sa.id }, { host: E, session: se.id }]));
    assert.equal(r.status, 200, JSON.stringify(r.json));
    // Keep e's built code, then put the old build's server and shared in its place.
    assert.equal(sh(E, "cd /sova && tar -cf /tmp/m6-head.tar server shared").code, 0);
    try {
      const swap = spawnSync("sh", ["-c", `git -C "${REPO}" archive ${OLD_BUILD} server shared | docker exec -i ${container(E)} sh -c 'cd /sova && rm -rf server shared && tar -xf -'`], { encoding: "utf8" });
      assert.equal(swap.status, 0, swap.stderr);
      chaos.sovaRestart(E);
      // Its protocol differs, so a sees it skewed; a peer hop still reaches it.
      await waitUp("a", E, ["up", "skewed"]);
      const sent = await send("a", sa.id, "This host runs a build without links.");
      assert.equal(sent.status, 200, JSON.stringify(sent.json));
      assert.equal(sent.json.deliveries[0].state, "refused", JSON.stringify(sent.json));
      assert.equal(sent.json.deliveries[0].reason, "old-build");
      assert.equal(outboxOf("a").length, 0, "never held");
      // A new link with it is refused at once.
      const again = await link("a", [{ session: (await newSession("a")).id }, { host: E, session: se.id }]);
      assert.equal(again.status, 409, JSON.stringify(again.json));
      assert.ok(["skewed", "old-build"].includes(again.json.reason), JSON.stringify(again.json));
      await new Promise((res) => setTimeout(res, 5000));
      assert.equal(outboxOf("a").length, 0, "still nothing held");
    } finally {
      sh(E, "cd /sova && rm -rf server shared && tar -xf /tmp/m6-head.tar && rm -f /tmp/m6-head.tar");
      chaos.sovaRestart(E);
    }
    assert.ok(await byId("a", sa.id));
  });
});
