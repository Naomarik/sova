// M6 linked sessions, phase 2: file offers and transfers across real hosts (§mesh.links/offers,
// §mesh.links/transfer), through links-lib.mjs:
//   1. two hosts, dest given: implicit accept, no receiver turn before the landing, one wake each side;
//   2. two hosts, no dest: the offer message, link_accept (the local act, and b's glm agent), link_decline,
//      and expiry under a shortened TTL;
//   3. three hosts, one offer to both: packed once, c's Sova down at offer time (outbox → peer-up),
//      a per-recipient dest map, a result per recipient and exactly one sender wake;
//   4. a 2 GiB tree + 50 000 files, throttled on a's tailnet link, resumed after a partition, a
//      restart of b and a restart of a, sha verified, served bytes < 1.15 × the spool;
//   5. the sandbox binding: sender `hidden` (global and project), receiver `not-writable` at the offer
//      and in the pre-scan (a `.git/hooks` member);
//   6. the gitlink warning (a worktree warns, the main checkout doesn't);
//   7. a refused state-root / sessions-dir dest (`protected`), and a sibling that isn't;
//   8. e on 740461a (phase-1 links, no offers): `refused old-build`, final, while link_send works;
//   9. d as a phone-style host (SOVA_MESH_IDENTITY=addresses) receiving and sending;
//  10. the Agents tab's transfer chip and the thread's offer rows in a real browser (Playwright, as
//      m6-links-browser finds it).
//   LAB_STATE=… scripts/mesh-lab/lab e2e m6-links-transfer     (spends a few short glm-5.3 turns)
// Needs `lab up --hosts 5`. Takes the lab LOCK; leaves a,b,c paired, d and e unpaired and on the
// built code, no qdisc, no sandbox, and deletes every tree it made (they exist only in the containers).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chaos, container, hostUrl, lab, labTokenHeaders, laptopFetch, readAgentFile, requireLab, sh, tailnetIp, waitFor, writeAgentFile } from "./lib.mjs";
import { accept, api, byId, decline, inbox, link, makeTree, MODEL, newSession, offer, offers, prompt, releaseLock, rowOf, send, takeLock, transcript, treeHash, unlink, waitIdle, waitInbox, waitOffer, writeLinksFile } from "./links-lib.mjs";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
/** Phase-1 links, no offers: every offer route answers the plain 404. */
const OLD_BUILD = "740461a";
/** The offer TTL override (test only) for the expiry case, in ms. */
const SHORT_TTL_MS = 30000;
const FINAL = new Set(["done", "declined", "failed", "expired", "cancelled", "refused"]);
const CWD = "/root/work";
const MiB = 1048576;

const meshOf = async (n) => (await laptopFetch(n, "/api/mesh", { timeoutMs: 20000 })).json();
const peerState = async (n, id) => (await meshOf(n)).peers?.find((p) => p.id === id)?.state;
const waitUp = (from, to, states = ["up"]) =>
  waitFor(async () => states.includes(await peerState(from, to)), { timeoutMs: 90000, intervalMs: 2000, what: `${from} sees ${to} ${states.join("/")}` });
const outboxOf = (n) => (readAgentFile(n, "sova/mesh-links/outbox.jsonl") ?? "").split("\n").filter(Boolean);
/** Files in a host's spool (sender) or incoming (receiver) dir. */
const filesIn = (n, sub) => {
  const r = sh(n, `ls -1 "$PI_CODING_AGENT_DIR/sova/mesh-links/${sub}" 2>/dev/null || true`);
  return r.out.split("\n").filter(Boolean);
};
const spool = (n, of) => filesIn(n, "spool").filter((f) => f.startsWith(of));
const partSize = (n, of) => Number(sh(n, `stat -c %s "$PI_CODING_AGENT_DIR/sova/mesh-links/incoming/${of}.tar.zst.part" 2>/dev/null || echo -1`).out);
const nonce = () => Math.random().toString(36).slice(2, 8);
const rm = (n, ...paths) => sh(n, `rm -rf ${paths.map((p) => `"${p}"`).join(" ")}`, { timeoutMs: 10 * 60000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The session's link rows (kind "link") that are its host's notices for offer `of` (the offer, a
    landing, the sender's wake): by the inbox record's `offer` field, never by text, since a
    partner's agent may quote the offer id in a message of its own. */
const noticeRows = async (host, session, of) => {
  const ids = new Set((await inbox(host, session.id)).filter((x) => x.dir === "in" && x.offer?.id === of).map((x) => x.id));
  return (await transcript(host, session.path)).filter((i) => i.kind === "link" && ids.has(i.link?.messageId));
};
/** The transcript without its `info` rows (the model and thinking that configure wrote): what a turn adds. */
const turnRows = async (host, path) => (await transcript(host, path)).filter((i) => i.kind !== "info");
const sandbox = (host, s, on) => api(host, `/api/sandbox?path=${encodeURIComponent(s.path)}`, { method: "POST", body: { on }, timeoutMs: 60000 });
/** Hold a session again (its runtime opened) after its host's Sova restarted: local acts need it.
    The busy rule may refuse it for a few seconds after the last write (a wake's turn): retried. */
const hold = (host, s) =>
  waitFor(
    async () => {
      const r = await api(host, "/api/sessions/configure", { method: "POST", body: { path: s.path, model: MODEL }, timeoutMs: 60000 });
      if (r.status !== 200) throw new Error(`${host}: hold ${s.id}: ${r.status} ${r.text}`);
      return true;
    },
    { timeoutMs: 90000, intervalMs: 3000, what: `${host} holds ${s.id}` },
  );
const allFinal = (o) => o.recipients.every((r) => FINAL.has(r.state));
const refusal = (r) => `${r.status} ${JSON.stringify(r.json)}`;

/** Links this run made, ended at the end so no partner keeps answering. */
const made = [];
/** [host, path] of every tree this run made, deleted at the end. */
const trees = [];
const tree = (host, dir, spec) => {
  trees.push([host, dir]);
  makeTree(host, dir, spec);
  return dir;
};
/** A live link between sessions on `hosts` (first = the maker); returns { id, s: {host: session} }. */
async function linked(hosts, extra = {}) {
  const s = {};
  for (const h of hosts) s[h] = await newSession(h, extra[h]);
  const r = await link(hosts[0], hosts.map((h, i) => (i === 0 ? { session: s[h].id } : { host: h, session: s[h].id })));
  assert.equal(r.status, 200, JSON.stringify(r.json));
  made.push([hosts[0], r.json.link.id]);
  return { id: r.json.link.id, s };
}

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
  for (const [h, dir] of trees) rm(h, dir);
  try {
    sh("a", "tc qdisc del dev tailscale0 root 2>/dev/null || true");
    for (const h of ["a", "b", "d"]) lab("sova-env", h, "--clear");
    lab("unpair", "d,e");
    lab("pair", "a,b,c");
  } finally {
    releaseLock();
  }
});

describe("1. two hosts, dest given: implicit accept", () => {
  test("a offers a git repo of 5 000 files to b with dest: it lands with no b turn before it, one wake each side", async () => {
    const { id, s } = await linked(["a", "b"]);
    const src = tree("a", `${CWD}/proj`, { files: 5000, extra: { "README.md": "the lab's project\n" }, symlinks: { "link-to-readme": "README.md" }, git: true });
    trees.push(["b", "/root/in"]);
    const r = await offer("a", { session: s.a.id, paths: ["proj"], dest: "/root/in", note: "the whole repo" });
    assert.equal(r.status, 200, refusal(r));
    const of = r.json.offer.id;
    assert.match(of, /^of_[0-9a-f]{16}$/);
    assert.deepEqual(r.json.offer.roots.map((x) => x.name), ["proj"]);
    assert.ok(r.json.offer.files >= 5002, `files counted: ${r.json.offer.files}`);
    assert.deepEqual(r.json.deliveries.map((d) => [d.to.sessionId, d.state, d.resolvedDest]), [[s.b.id, "accepted", "/root/in"]]);
    assert.equal(rowOf(r.json.offer, s.b.id).implicit, true);

    // No agent turn on b while the bytes move: its transcript stays empty until the landing.
    // (The transcript is read before b's own row: a row read later that isn't done yet can't have woken b.)
    let early = null;
    await waitFor(
      async () => {
        const items = await turnRows("b", s.b.path);
        const st = rowOf((await offers("b", s.b.id)).find((x) => x.id === of), s.b.id)?.state;
        if (items.length && st !== "done") early = { st, items };
        return early || st === "done";
      },
      { timeoutMs: 5 * 60000, intervalMs: 1000, what: "b's row done on b" },
    );
    assert.equal(early, null, `a turn on b before the landing: ${JSON.stringify(early)}`);
    const quiet = await waitOffer("a", s.a.id, of, (o) => rowOf(o, s.b.id).state === "done", { what: "b's row done on a" });
    assert.ok(quiet.snapshot?.sha256, "a snapshot");
    const bRows = await waitFor(async () => {
      const rows = await noticeRows("b", s.b, of);
      return rows.length ? rows : null;
    }, { what: "b's wake" });
    assert.equal(bRows.length, 1, "one wake on b");
    assert.match(bRows[0].link?.text ?? bRows[0].text, /landed/);
    assert.equal((await turnRows("b", s.b.path))[0].kind, "link", "b's first row is the wake");
    const bIn = await inbox("b", s.b.id);
    assert.ok(bIn.some((x) => x.offer?.id === of && x.offer.event === "landed"), JSON.stringify(bIn));
    const bCopy = (await offers("b", s.b.id)).find((x) => x.id === of);
    assert.equal(rowOf(bCopy, s.b.id).state, "done");
    assert.equal(bCopy.recipients.length, 1, "b's copy holds its own row only");

    assert.equal(treeHash("b", "/root/in/proj"), treeHash("a", src), "the same tree on both sides");
    const log = sh("b", "git -C /root/in/proj log --oneline");
    assert.equal(log.code, 0, log.err);
    assert.match(log.out, /tree/);

    // The sender's single wake (every row final), and the spool gone.
    await waitFor(async () => (await noticeRows("a", s.a, of)).length >= 1, { what: "a's wake" });
    await sleep(5000);
    assert.equal((await noticeRows("a", s.a, of)).length, 1, "a woken exactly once");
    await waitFor(() => spool("a", of).length === 0, { what: "a's spool deleted" });
    assert.deepEqual(filesIn("b", "incoming").filter((f) => f.startsWith(of)), [], "b's .part deleted");
    await waitIdle("b", s.b.id).catch(() => {});
    await waitIdle("a", s.a.id).catch(() => {});
    await unlink("a", id);
  });
});

describe("2. two hosts, no dest: the recipient answers", () => {
  let L;
  before(async () => {
    L = await linked(["a", "b"]);
    tree("a", `${CWD}/small`, { files: 300, extra: { "notes.md": "notes\n" } });
  });
  const HANDS_OFF = "The lab harness answers this offer itself: do not call link_accept, link_decline or any other tool; answer only ok.";

  test("the offer message reaches b's agent; link_accept (the local act) lands it", async () => {
    const r = await offer("a", { session: L.s.a.id, paths: ["small"], note: HANDS_OFF });
    assert.equal(r.status, 200, refusal(r));
    const of = r.json.offer.id;
    assert.deepEqual(r.json.deliveries.map((d) => d.state), ["offered"], JSON.stringify(r.json.deliveries));
    assert.equal(rowOf(r.json.offer, L.s.b.id).state, "offered");
    const acc = await accept("b", L.s.b.id, of, "got");
    assert.equal(acc.status, 200, refusal(acc));
    trees.push(["b", `${CWD}/got`]);
    // b's session was told: one link row naming the offer and how to answer it.
    const rows = await waitFor(async () => {
      const x = await noticeRows("b", L.s.b, of);
      return x.length ? x : null;
    }, { what: "the offer message on b" });
    assert.match(rows[0].link?.text ?? rows[0].text, /link_accept/);
    assert.ok((await inbox("b", L.s.b.id)).some((x) => x.offer?.id === of && x.offer.event === "offered"));
    const o = await waitOffer("a", L.s.a.id, of, (x) => rowOf(x, L.s.b.id).state === "done", { timeoutMs: 180000, what: "done after link_accept" });
    assert.equal(rowOf(o, L.s.b.id).resolvedDest, `${CWD}/got`, "relative dest = under b's cwd");
    assert.equal(treeHash("b", `${CWD}/got/small`), treeHash("a", `${CWD}/small`));
    // A second answer is refused: the row is no longer offered.
    assert.notEqual((await accept("b", L.s.b.id, of, "again")).status, 200);
    await waitIdle("b", L.s.b.id).catch(() => {});
  });

  test("b's glm agent answers with link_accept (best effort; the API answers when the model won't)", async () => {
    const dest = `${CWD}/from-a-${nonce()}`;
    trees.push(["b", dest]);
    const r = await offer("a", { session: L.s.a.id, paths: ["small"], note: `Accept this offer with link_accept into the directory ${dest}. Do nothing else.` });
    assert.equal(r.status, 200, refusal(r));
    const of = r.json.offer.id;
    let byModel = true;
    try {
      await waitOffer("a", L.s.a.id, of, (x) => rowOf(x, L.s.b.id).state !== "offered", { timeoutMs: 180000, what: "b's model answering" });
    } catch {
      byModel = false;
      console.log("# b's model did not call link_accept in time: accepting through the API (the offer message is proven above)");
      await waitIdle("b", L.s.b.id);
      assert.equal((await accept("b", L.s.b.id, of, dest)).status, 200);
    }
    const o = await waitOffer("a", L.s.a.id, of, (x) => FINAL.has(rowOf(x, L.s.b.id).state), { timeoutMs: 180000 });
    assert.equal(rowOf(o, L.s.b.id).state, "done", JSON.stringify(rowOf(o, L.s.b.id)));
    console.log(`# accepted by ${byModel ? `b's model into ${rowOf(o, L.s.b.id).resolvedDest}` : "the API"}`);
    await waitIdle("b", L.s.b.id).catch(() => {});
  });

  test("link_decline: the sender's row is declined with the reason, one wake, the spool deleted", async () => {
    const r = await offer("a", { session: L.s.a.id, paths: ["small"], note: HANDS_OFF });
    assert.equal(r.status, 200, refusal(r));
    const of = r.json.offer.id;
    const dec = await decline("b", L.s.b.id, of, "not needed here");
    assert.equal(dec.status, 200, refusal(dec));
    const o = await waitOffer("a", L.s.a.id, of, (x) => rowOf(x, L.s.b.id).state === "declined", { what: "declined on a" });
    assert.match(rowOf(o, L.s.b.id).message ?? "", /not needed here/);
    await waitFor(() => spool("a", of).length === 0, { what: "a's spool deleted at the last decline" });
    // a may be mid-turn (b's agent answers with chatter): the wake is steered in and reaches the
    // transcript at a's next step, which a slow model step can hold back well past 30 s.
    await waitFor(async () => (await noticeRows("a", L.s.a, of)).length >= 1, { timeoutMs: 120000, what: "a's wake" });
    await sleep(3000);
    assert.equal((await noticeRows("a", L.s.a, of)).length, 1, "a woken once");
    await waitIdle("a", L.s.a.id).catch(() => {});
    await waitIdle("b", L.s.b.id).catch(() => {});
  });

  test("a decline while a is finishing a turn: the wake is steered in and still reaches a", async () => {
    await waitIdle("a", L.s.a.id).catch(() => {});
    const r = await offer("a", { session: L.s.a.id, paths: ["small"], note: HANDS_OFF });
    assert.equal(r.status, 200, refusal(r));
    const of = r.json.offer.id;
    // A one-word turn has no tool call, so no next step: a steer arriving now lands as it ends.
    assert.equal((await prompt("a", L.s.a.path, "Reply with the single word: ok")).status, 200);
    await waitFor(async () => (await byId("a", L.s.a.id))?.busy, { timeoutMs: 20000, intervalMs: 200, what: "a busy" });
    const dec = await decline("b", L.s.b.id, of, "declined while you were busy");
    assert.equal(dec.status, 200, refusal(dec));
    const wake = await waitInbox("a", L.s.a.id, (xs) => xs.some((x) => x.dir === "in" && x.offer?.id === of), { what: "a's wake record" });
    const state = wake.find((x) => x.dir === "in" && x.offer?.id === of).delivery?.state;
    console.log(`# a's wake was ${state}`);
    await waitFor(async () => (await noticeRows("a", L.s.a, of)).length >= 1, { timeoutMs: 120000, what: "a's wake on its transcript" });
    await sleep(3000);
    assert.equal((await noticeRows("a", L.s.a, of)).length, 1, "taken in once");
    await waitIdle("a", L.s.a.id).catch(() => {});
    await waitIdle("b", L.s.b.id).catch(() => {});
  });

  test("an unanswered offer expires on both copies under a shortened TTL", async () => {
    for (const h of ["a", "b"]) {
      lab("sova-env", h, `SOVA_LINK_OFFER_TTL_MS=${SHORT_TTL_MS}`);
      chaos.sovaRestart(h);
    }
    try {
      await waitUp("a", "b");
      // Fresh sessions: the busy rule keeps refusing to reopen a session the previous process wrote.
      const E = await linked(["a", "b"]);
      const r = await offer("a", { session: E.s.a.id, paths: ["small"], note: HANDS_OFF });
      assert.equal(r.status, 200, refusal(r));
      const of = r.json.offer.id;
      assert.ok(r.json.offer.expiresAt - r.json.offer.at <= SHORT_TTL_MS + 1000, `the TTL override applies: ${r.json.offer.expiresAt - r.json.offer.at} ms`);
      await waitOffer("a", E.s.a.id, of, (x) => rowOf(x, E.s.b.id).state === "expired", { timeoutMs: SHORT_TTL_MS + 5 * 60000, intervalMs: 3000, what: "expired on a" });
      await waitOffer("b", E.s.b.id, of, (x) => rowOf(x, E.s.b.id).state === "expired", { timeoutMs: 5 * 60000, intervalMs: 3000, what: "expired on b" });
      await waitFor(() => spool("a", of).length === 0, { timeoutMs: 5 * 60000, what: "a's spool deleted at expiry" });
      await waitIdle("b", E.s.b.id).catch(() => {});
    } finally {
      for (const h of ["a", "b"]) {
        lab("sova-env", h, "--clear");
        chaos.sovaRestart(h);
      }
      await waitUp("a", "b");
    }
  });
});

describe("3. three hosts: one offer, packed once, a result per recipient", () => {
  test("to all with a dest map; c's Sova down at offer time pulls after peer-up; one sender wake", async () => {
    const { id, s } = await linked(["a", "b", "c"]);
    const src = tree("a", `${CWD}/multi`, { files: 2000, blobs: 1, blobMiB: 50 });
    trees.push(["b", "/root/multi-b"], ["c", "/root/multi-c"]);
    chaos.sovaStop("c");
    let r;
    let of;
    try {
      r = await offer("a", { session: s.a.id, paths: ["multi"], to: "all", dest: { b: "/root/multi-b", c: "/root/multi-c" } });
      assert.equal(r.status, 200, refusal(r));
      of = r.json.offer.id;
      const byTo = Object.fromEntries(r.json.deliveries.map((d) => [d.to.sessionId, d.state]));
      assert.deepEqual(byTo, { [s.b.id]: "accepted", [s.c.id]: "outbox" }, JSON.stringify(r.json.deliveries));
      assert.ok(outboxOf("a").some((l) => l.includes(of)), "c's offer held in a's outbox");
      await waitOffer("a", s.a.id, of, (o) => rowOf(o, s.b.id).state === "done", { timeoutMs: 180000, what: "b done" });
      // One spool for both recipients, kept while c still has to pull from it.
      assert.equal(spool("a", of).length, 1, `one spool: ${spool("a", of).join(" ")}`);
      assert.equal(rowOf((await offers("a", s.a.id)).find((x) => x.id === of), s.c.id).state, "accepted", "c's row waits");
    } finally {
      chaos.sovaStart("c");
    }
    const o = await waitOffer("a", s.a.id, of, allFinal, { timeoutMs: 5 * 60000, what: "every row final" });
    assert.deepEqual(o.recipients.map((x) => [x.to.sessionId, x.state, x.resolvedDest]), [
      [s.b.id, "done", "/root/multi-b"],
      [s.c.id, "done", "/root/multi-c"],
    ]);
    await hold("c", s.c); // c's Sova restarted: its session must be held to list its offers
    const shaB = (await offers("b", s.b.id)).find((x) => x.id === of).snapshot.sha256;
    const shaC = (await offers("c", s.c.id)).find((x) => x.id === of).snapshot.sha256;
    assert.equal(shaB, o.snapshot.sha256);
    assert.equal(shaC, o.snapshot.sha256, "both pulled the same snapshot");
    const want = treeHash("a", src);
    assert.equal(treeHash("b", "/root/multi-b/multi"), want);
    assert.equal(treeHash("c", "/root/multi-c/multi"), want);
    await waitFor(async () => (await noticeRows("a", s.a, of)).length >= 1, { what: "a's wake" });
    await sleep(8000);
    assert.equal((await noticeRows("a", s.a, of)).length, 1, "a woken exactly once for two recipients");
    await waitFor(() => spool("a", of).length === 0, { what: "the spool deleted when every row is final" });
    assert.equal(outboxOf("a").length, 0, "outbox drained");
    for (const h of ["a", "b", "c"]) await waitIdle(h, s[h].id).catch(() => {});
    await unlink("a", id);
  });
});

describe("4. a 2 GiB tree, throttled, resumed", () => {
  test("2 GiB + 50 000 files at 40 mbit: a partition, a restart of b, a restart of a; sha verified", { timeout: 60 * 60000 }, async () => {
    const { id, s } = await linked(["a", "b"]);
    const t0 = Date.now();
    const src = tree("a", `${CWD}/big`, { files: 50000, blobs: 8, blobMiB: 256 });
    trees.push(["b", "/root/inbig"]);
    console.log(`# made the 2 GiB tree in ${Math.round((Date.now() - t0) / 1000)} s`);
    const tc = sh("a", "tc qdisc replace dev tailscale0 root tbf rate 40mbit burst 256kb latency 400ms");
    assert.equal(tc.code, 0, tc.err);
    const tcSent = () => Number(/Sent (\d+) bytes/.exec(sh("a", "tc -s qdisc show dev tailscale0").out)?.[1] ?? NaN);
    try {
      const r = await offer("a", { session: s.a.id, paths: ["big"], dest: "/root/inbig" });
      assert.equal(r.status, 200, refusal(r));
      const of = r.json.offer.id;
      assert.ok(r.json.offer.bytes >= 2048 * MiB, `bytes listed: ${r.json.offer.bytes}`);
      const packed = await waitOffer("a", s.a.id, of, (o) => o.snapshot?.size, { timeoutMs: 10 * 60000, intervalMs: 3000, what: "the spool packed" });
      const size = packed.snapshot.size;
      const sent0 = tcSent();
      console.log(`# spool ${Math.round(size / MiB)} MiB, packed ${Math.round((packed.snapshot.packedAt - packed.at) / 1000)} s after the offer`);
      const at = (frac, what) => waitFor(() => partSize("b", of) >= frac * size, { timeoutMs: 20 * 60000, intervalMs: 1000, what });
      /** After a disruption at `from` bytes: the .part never shrinks, and grows past it (a resume, not a restart). */
      const resumed = async (from, what) => {
        let shrunk;
        await waitFor(
          () => {
            const n = partSize("b", of);
            if (n !== -1 && n < from) shrunk = n;
            return shrunk !== undefined || n > from + 4 * MiB;
          },
          { timeoutMs: 10 * 60000, intervalMs: 1000, what },
        );
        assert.equal(shrunk, undefined, `${what}: the .part went back to ${shrunk} from ${from}`);
      };

      await at(0.3, "30 %");
      const p1 = partSize("b", of);
      chaos.partition("b", "--reject");
      await sleep(20000);
      chaos.restore("b");
      await resumed(p1, "resumed after the partition");

      await at(0.6, "60 %");
      const p2 = partSize("b", of);
      chaos.sovaRestart("b");
      await resumed(p2, "resumed after b's restart");
      await hold("b", s.b);

      await at(0.75, "75 %");
      const p3 = partSize("b", of);
      chaos.sovaRestart("a");
      await resumed(p3, "resumed after a's restart (the spool survived it)");
      await hold("a", s.a);

      const o = await waitOffer("a", s.a.id, of, (x) => FINAL.has(rowOf(x, s.b.id).state), { timeoutMs: 30 * 60000, intervalMs: 5000, what: "b's row final" });
      const row = rowOf(o, s.b.id);
      assert.equal(row.state, "done", JSON.stringify(row));
      const bRow = rowOf((await offers("b", s.b.id)).find((x) => x.id === of), s.b.id);
      assert.ok((bRow.retries ?? 0) >= 2, `b's pull retried: ${JSON.stringify(bRow)}`);
      const served = tcSent() - sent0;
      console.log(`# served ${Math.round(served / MiB)} MiB for a ${Math.round(size / MiB)} MiB spool (${(served / size).toFixed(3)}×), ${bRow.retries} retries, took ${Math.round((row.doneAt - row.startedAt) / 1000)} s`);
      assert.ok(served < 1.15 * size, `resumed, never re-sent: ${served} bytes on the wire for ${size}`);
      const ranged = sh("a", "grep -a -E 'tar.*(206|bytes=[1-9])' /var/log/lab/sova.log | tail -3 || true").out;
      if (ranged) console.log(`# a's log: ${ranged.split("\n").join(" | ")}`);
      assert.equal(treeHash("b", "/root/inbig/big"), treeHash("a", src), "the same 2 GiB tree");
      await waitFor(() => spool("a", of).length === 0, { what: "a's spool deleted" });
    } finally {
      sh("a", "tc qdisc del dev tailscale0 root 2>/dev/null || true");
      rm("a", src);
      rm("b", "/root/inbig");
    }
    await waitIdle("b", s.b.id).catch(() => {});
    await waitIdle("a", s.a.id).catch(() => {});
    await unlink("a", id);
  });
});

describe("5. the sandbox binds the server", () => {
  let L;
  before(async () => {
    L = await linked(["a", "b"]);
    tree("a", `${CWD}/sbx`, { files: 20, extra: { "secret/key.txt": "hidden\n", "open.txt": "open\n" } });
    tree("a", `${CWD}/gitdir-src/.git`, { extra: { "hooks/post-commit": "#!/bin/sh\necho planted\n", "HEAD": "ref: refs/heads/master\n" } });
    tree("a", `${CWD}/scan-src/pj`, { extra: { "open.txt": "open\n", "locked/planted.txt": "planted\n" } });
    sh("a", "mkdir -p /root/.ssh && echo x > /root/.ssh/lab-key");
  });
  after(async () => {
    await sandbox("a", L.s.a, false).catch(() => {});
    await sandbox("b", L.s.b, false).catch(() => {});
    rm("a", `${CWD}/.sova/sandbox.json`, "/root/.ssh/lab-key");
    rm("b", `${CWD}/sbx-in`, "/srv/landing", `${CWD}/.sova/sandbox.json`, `${CWD}/pre`);
  });

  test("receiver on: a dest outside its writable roots is refused not-writable; under its cwd lands", async () => {
    const on = await sandbox("b", L.s.b, true);
    assert.equal(on.status, 200, refusal(on));
    assert.equal(on.json.sandbox?.on, true, JSON.stringify(on.json));
    const r = await offer("a", { session: L.s.a.id, paths: ["sbx"], dest: "/srv/landing" });
    assert.equal(r.status, 200, refusal(r));
    assert.deepEqual(r.json.deliveries.map((d) => [d.state, d.reason]), [["refused", "not-writable"]], JSON.stringify(r.json.deliveries));
    assert.equal(sh("b", "test -e /srv/landing").code, 1, "nothing written");
    const ok = await offer("a", { session: L.s.a.id, paths: ["sbx"], dest: "sbx-in" });
    assert.equal(ok.status, 200, refusal(ok));
    await waitOffer("a", L.s.a.id, ok.json.offer.id, (o) => rowOf(o, L.s.b.id).state === "done", { what: "landed under b's cwd" });
    // Its own cwd (which holds the read-only .git/hooks, .git/config, .envrc) is written into, not created.
    trees.push(["b", `${CWD}/sbx`]);
    const here = await offer("a", { session: L.s.a.id, paths: ["sbx"], dest: "." });
    assert.equal(here.status, 200, refusal(here));
    assert.deepEqual(here.json.deliveries.map((d) => [d.state, d.resolvedDest]), [["accepted", CWD]], JSON.stringify(here.json.deliveries));
    await waitOffer("a", L.s.a.id, here.json.offer.id, (o) => rowOf(o, L.s.b.id).state === "done", { what: "landed in b's cwd" });
    await waitIdle("b", L.s.b.id).catch(() => {});
  });

  test("receiver on: a `.git` root is refused not-writable at the offer (the top-level check)", async () => {
    const r = await offer("a", { session: L.s.a.id, paths: ["gitdir-src/.git"], dest: "." });
    assert.equal(r.status, 200, refusal(r));
    assert.deepEqual(r.json.deliveries.map((d) => [d.state, d.reason]), [["refused", "not-writable"]], JSON.stringify(r.json.deliveries));
    assert.match(r.json.deliveries[0].message, /\.git/);
    assert.equal(sh("b", `test -e ${CWD}/.git/hooks/post-commit`).code, 1, "nothing extracted");
  });

  test("receiver on: the pre-scan refuses a member under a read-only path below the root, nothing extracted", async () => {
    // b's project file makes pre/pj/locked read-only. pj is already at dest, so the offer only writes
    // into it: only the pre-scan of the downloaded archive can see the member under locked/.
    writeFileOn("b", `${CWD}/.sova/sandbox.json`, JSON.stringify({ readOnlyWithinWritable: ["pre/pj/locked"] }));
    assert.equal(sh("b", `mkdir -p ${CWD}/pre/pj`).code, 0);
    const r = await offer("a", { session: L.s.a.id, paths: ["scan-src/pj"], dest: "pre" });
    assert.equal(r.status, 200, refusal(r));
    assert.deepEqual(r.json.deliveries.map((d) => d.state), ["accepted"], `passes the top-level check: ${JSON.stringify(r.json.deliveries)}`);
    const of = r.json.offer.id;
    const o = await waitOffer("a", L.s.a.id, of, (x) => FINAL.has(rowOf(x, L.s.b.id).state), { timeoutMs: 180000, what: "b's row final" });
    const row = rowOf(o, L.s.b.id);
    assert.deepEqual([row.state, row.reason], ["refused", "not-writable"], JSON.stringify(row));
    assert.match(row.message ?? "", /pj\/locked/);
    assert.equal(sh("b", `ls -A ${CWD}/pre/pj`).out, "", "nothing extracted");
    assert.deepEqual(filesIn("b", "incoming").filter((f) => f.startsWith(of)), [], "the .part deleted");
    rm("b", `${CWD}/.sova/sandbox.json`);
    await sandbox("b", L.s.b, false);
    await waitIdle("b", L.s.b.id).catch(() => {});
  });

  test("sender on: a hidden root, and a hidden path below a root, are refused hidden; exclude lets it go", async () => {
    const on = await sandbox("a", L.s.a, true);
    assert.equal(on.json?.sandbox?.on, true, refusal(on));
    const ssh = await offer("a", { session: L.s.a.id, paths: ["~/.ssh"], dest: "/root/nope" });
    assert.notEqual(ssh.status, 200, refusal(ssh));
    assert.equal(ssh.json.reason, "hidden", refusal(ssh));
    // The project's tighten-only file hides one directory of the tree.
    writeFileOn("a", `${CWD}/.sova/sandbox.json`, JSON.stringify({ hidden: [`${CWD}/sbx/secret`] }));
    const below = await offer("a", { session: L.s.a.id, paths: ["sbx"], dest: "/root/nope" });
    assert.notEqual(below.status, 200, refusal(below));
    assert.equal(below.json.reason, "hidden", refusal(below));
    assert.match(below.json.error ?? below.json.message ?? "", /secret/, "names the hidden path");
    const excl = await offer("a", { session: L.s.a.id, paths: ["sbx"], exclude: ["secret"], dest: "sbx-excl" });
    assert.equal(excl.status, 200, refusal(excl));
    trees.push(["b", `${CWD}/sbx-excl`]);
    await waitOffer("a", L.s.a.id, excl.json.offer.id, (o) => rowOf(o, L.s.b.id).state === "done", { what: "landed without secret/" });
    assert.equal(sh("b", `test -e ${CWD}/sbx-excl/sbx/secret`).code, 1, "secret/ stayed home");
    assert.equal(sh("b", `test -f ${CWD}/sbx-excl/sbx/open.txt`).code, 0);
    await sandbox("a", L.s.a, false);
    await waitIdle("b", L.s.b.id).catch(() => {});
  });
});

/** A file anywhere on a host, outside the agent dir. */
function writeFileOn(host, path, content) {
  const r = sh(host, `mkdir -p "$(dirname "${path}")" && cat > "${path}"`, { input: content });
  if (r.code !== 0) throw new Error(`write ${host}:${path}: ${r.err}`);
}

describe("6. the gitlink warning", () => {
  test("a worktree warns (result and wake); the main checkout doesn't", async () => {
    const { id, s } = await linked(["a", "b"]);
    const main = tree("a", `${CWD}/gl-main`, { files: 10, git: true });
    const wt = `${CWD}/gl-wt`;
    trees.push(["a", wt], ["b", "/root/gl-in"]);
    assert.equal(sh("a", `git -C ${main} worktree add -q ${wt} -b lab-wt`).code, 0);
    const w = await offer("a", { session: s.a.id, paths: ["gl-wt"], dest: "/root/gl-in" });
    assert.equal(w.status, 200, refusal(w));
    assert.deepEqual(w.json.offer.warnings?.map((x) => [x.kind, x.root, x.path]), [["gitlink", "gl-wt", "gl-wt/.git"]], JSON.stringify(w.json.offer.warnings));
    assert.match(w.json.offer.warnings[0].gitdir, /gl-main\/\.git\/worktrees/);
    const rows = await waitFor(async () => {
      const x = await noticeRows("b", s.b, w.json.offer.id);
      return x.length ? x : null;
    }, { timeoutMs: 180000, what: "b's wake" });
    assert.match(rows[0].link?.text ?? rows[0].text, /\.git/, "the wake carries the warning");
    const m = await offer("a", { session: s.a.id, paths: ["gl-main"], dest: "/root/gl-in" });
    assert.equal(m.status, 200, refusal(m));
    assert.deepEqual(m.json.offer.warnings ?? [], [], "no warning for the main checkout");
    await waitOffer("a", s.a.id, m.json.offer.id, allFinal, { timeoutMs: 180000 });
    await waitIdle("b", s.b.id).catch(() => {});
    await waitIdle("a", s.a.id).catch(() => {});
    await unlink("a", id);
  });
});

describe("7. protected destinations", () => {
  test("the state root, the sessions dir, and their parent with a colliding root name are refused protected", async () => {
    const { id, s } = await linked(["a", "b"]);
    const agent = sh("b", 'readlink -f "$PI_CODING_AGENT_DIR"').out; // /sova/.agent
    const parent = agent.replace(/\/[^/]+$/, "");
    const top = agent.slice(parent.length + 1); // ".agent"
    tree("a", `${CWD}/prot/${top}`, { extra: { "sova/mesh-links.json": "{}\n" } });
    const ctl = `m6-control-${nonce()}`;
    tree("a", `${CWD}/prot/${ctl}`, { extra: { "x.txt": "x\n" } });
    trees.push(["b", `${parent}/${ctl}`]);
    for (const [paths, dest] of [
      [[`prot/${top}`], parent],
      [[`prot/${ctl}`], `${agent}/sova/landing`],
      [[`prot/${ctl}`], `${agent}/sessions`],
    ]) {
      const r = await offer("a", { session: s.a.id, paths, dest });
      assert.equal(r.status, 200, refusal(r));
      assert.deepEqual(r.json.deliveries.map((d) => [d.state, d.reason]), [["refused", "protected"]], `${dest}: ${JSON.stringify(r.json.deliveries)}`);
    }
    // Their parent itself is fine when no root collides.
    const ok = await offer("a", { session: s.a.id, paths: [`prot/${ctl}`], dest: parent });
    assert.equal(ok.status, 200, refusal(ok));
    await waitOffer("a", s.a.id, ok.json.offer.id, (o) => rowOf(o, s.b.id).state === "done", { what: "the control landed" });
    assert.equal(sh("b", `test -f ${parent}/${ctl}/x.txt`).code, 0);
    await waitIdle("b", s.b.id).catch(() => {});
    await unlink("a", id);
  });
});

describe("8. a host on the phase-1 build", () => {
  test(`e on ${OLD_BUILD}: an offer is refused old-build, final, never held; link_send still works`, async () => {
    const E = "e";
    lab("pair", "a,b,c,e");
    await waitUp("a", E);
    // The link first: after the swap e's protocol differs (skewed), and no new link is made with it.
    const { s } = await linked(["a", E]);
    tree("a", `${CWD}/old`, { files: 5 });
    assert.equal(sh(E, "cd /sova && tar -cf /tmp/m6t-head.tar server shared").code, 0);
    try {
      const swap = spawnSync("sh", ["-c", `git -C "${REPO}" archive ${OLD_BUILD} server shared | docker exec -i ${container(E)} sh -c 'cd /sova && rm -rf server shared && tar -xf -'`], { encoding: "utf8" });
      assert.equal(swap.status, 0, swap.stderr);
      chaos.sovaRestart(E);
      await waitUp("a", E, ["up", "skewed"]);
      const r = await offer("a", { session: s.a.id, paths: ["old"], dest: "/root/old-in" });
      assert.equal(r.status, 200, refusal(r));
      assert.deepEqual(r.json.deliveries.map((d) => [d.state, d.reason]), [["refused", "old-build"]], JSON.stringify(r.json.deliveries));
      assert.equal(rowOf(r.json.offer, s[E].id).state, "refused");
      assert.equal(outboxOf("a").length, 0, "never held");
      const sent = await send("a", s.a.id, "A plain link message to the phase-1 host. No reply needed: answer only ok.");
      assert.equal(sent.status, 200, JSON.stringify(sent.json));
      assert.deepEqual(sent.json.deliveries.map((d) => d.state), ["started"], JSON.stringify(sent.json));
      await sleep(5000);
      assert.equal(outboxOf("a").length, 0, "still nothing held");
      await waitFor(() => spool("a", r.json.offer.id).length === 0, { what: "no spool kept for an all-refused offer" });
      await waitIdle(E, s[E].id).catch(() => {});
    } finally {
      sh(E, "cd /sova && rm -rf server shared && tar -xf /tmp/m6t-head.tar && rm -f /tmp/m6t-head.tar");
      chaos.sovaRestart(E);
      lab("unpair", "e");
      lab("pair", "a,b,c");
    }
  });
});

describe("9. a phone-style host (identity by address)", () => {
  const D = "d";
  before(async () => {
    lab("pair", "a,b,c,d");
    const file = JSON.parse(readAgentFile(D, "sova/peers.json"));
    file.peers = file.peers.map((p) => ({ ...p, dnsName: tailnetIp(p.id) }));
    writeAgentFile(D, "sova/peers.json", `${JSON.stringify(file, null, 2)}\n`);
    writeLinksFile(D, null);
    lab("sova-env", D, "SOVA_MESH_IDENTITY=addresses", `SOVA_PEER_HOST=${tailnetIp(D)}`);
    chaos.sovaRestart(D);
    await waitUp("a", D);
    await waitUp(D, "a");
  });

  test("d receives a dest offer into ~ and sends one back to a", async () => {
    const { id, s } = await linked(["a", D]);
    const src = tree("a", `${CWD}/tophone`, { files: 200, git: true });
    trees.push([D, "/root/projects"]);
    const r = await offer("a", { session: s.a.id, paths: ["tophone"], dest: "~/projects" });
    assert.equal(r.status, 200, refusal(r));
    assert.deepEqual(r.json.deliveries.map((d) => [d.state, d.resolvedDest]), [["accepted", "/root/projects"]], JSON.stringify(r.json.deliveries));
    await waitOffer("a", s.a.id, r.json.offer.id, (o) => rowOf(o, s[D].id).state === "done", { timeoutMs: 180000, what: "landed on d" });
    assert.equal(treeHash(D, "/root/projects/tophone"), treeHash("a", src));
    assert.equal(sh(D, "git -C /root/projects/tophone status --short").code, 0);

    const back = tree(D, `${CWD}/fromphone`, { files: 50, extra: { "photo.bin": "not really\n" } });
    trees.push(["a", "/root/from-d"]);
    await waitIdle(D, s[D].id).catch(() => {});
    const r2 = await offer(D, { session: s[D].id, paths: ["fromphone"], dest: "/root/from-d" });
    assert.equal(r2.status, 200, refusal(r2));
    assert.deepEqual(r2.json.deliveries.map((d) => d.state), ["accepted"], JSON.stringify(r2.json.deliveries));
    await waitOffer(D, s[D].id, r2.json.offer.id, (o) => rowOf(o, s.a.id).state === "done", { timeoutMs: 180000, what: "landed on a" });
    assert.equal(treeHash("a", "/root/from-d/fromphone"), treeHash(D, back));
    for (const h of ["a", D]) await waitIdle(h, s[h].id).catch(() => {});
    await unlink("a", id);
    lab("sova-env", D, "--clear");
    lab("unpair", "d");
    lab("pair", "a,b,c");
  });
});

// ---- 10. the Agents tab in a real browser -------------------------------------------------------------

const PW = process.env.PLAYWRIGHT_MODULE ?? join(REPO, ".claude/skills/playwright/scripts/node_modules/playwright/index.mjs");
function chromiumBin() {
  if (process.env.CHROMIUM_BIN) return process.env.CHROMIUM_BIN;
  const cache = join(homedir(), ".cache/ms-playwright");
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort((x, y) => Number(y.slice(9)) - Number(x.slice(9)));
  for (const d of builds) for (const sub of ["chrome-linux64/chrome", "chrome-linux/chrome"]) if (existsSync(join(cache, d, sub))) return join(cache, d, sub);
  return undefined;
}

describe("10. the Agents tab: transfer chip and offer rows", () => {
  let browser, page;
  before(async () => {
    if (!existsSync(PW)) throw new Error(`Playwright not found at ${PW}: install the playwright skill or set PLAYWRIGHT_MODULE`);
    const { chromium } = await import(pathToFileURL(PW).href);
    browser = await chromium.launch({ headless: true, executablePath: chromiumBin() });
    page = await (await browser.newContext({ serviceWorkers: "block", extraHTTPHeaders: labTokenHeaders() })).newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
  });
  after(async () => {
    sh("a", "tc qdisc del dev tailscale0 root 2>/dev/null || true");
    await browser?.close().catch(() => {});
  });
  const shot = (name) => page.screenshot({ path: join(homedir(), ".cache", `mesh-links-transfer-lab-${name}.png`) });

  test("a's page: the row's chip reads sending while b pulls, and the thread shows the offer and b's row", async () => {
    const { id, s } = await linked(["a", "b"]);
    // A session lists (and so opens by URL) once it has a message.
    assert.equal((await prompt("a", s.a.path, "Reply with the single word: ready")).status, 200);
    await waitIdle("a", s.a.id);
    await api("b", "/api/sessions/title", { method: "POST", body: { path: s.b.path, title: "Receiver on B" } });
    const root = `shown-${nonce()}`;
    tree("a", `${CWD}/${root}`, { files: 100, blobs: 2, blobMiB: 200 });
    trees.push(["b", "/root/shown-in"]);
    assert.equal(sh("a", "tc qdisc replace dev tailscale0 root tbf rate 40mbit burst 256kb latency 400ms").code, 0);

    await page.goto(`${hostUrl("a")}/#/s/${encodeURIComponent(s.a.path)}`);
    await page.getByRole("button", { name: "Session details" }).first().click({ timeout: 20000 });
    await page.getByRole("tab", { name: "Agents" }).click({ timeout: 10000 });
    await page.getByRole("heading", { name: /Remotely linked agents/ }).waitFor({ timeout: 30000 });
    const row = page.locator(".subagents-group", { has: page.getByRole("heading", { name: /Remotely linked agents/ }) }).locator(".subagent-row");
    await row.first().waitFor({ timeout: 30000 });

    const r = await offer("a", { session: s.a.id, paths: [root], dest: "/root/shown-in", note: "for the browser check" });
    assert.equal(r.status, 200, refusal(r));
    const of = r.json.offer.id;
    // The chip speaks for the row's member: b is receiving.
    const chipEl = row.first().locator(".link-transfer-chip");
    const chip = await waitFor(
      async () => (await chipEl.count()) && (await chipEl.getAttribute("data-transfer-state")) === "pulling" && /^Receiving [\d.,]+ \S+ \/ [\d.,]+ \S+$/.exec((await chipEl.innerText()).trim())?.[0],
      { timeoutMs: 120000, intervalMs: 1000, what: "the chip: Receiving x / y (pulling)" },
    );
    console.log(`# chip: ${chip}`);
    await shot("receiving");
    sh("a", "tc qdisc del dev tailscale0 root 2>/dev/null || true");
    await waitOffer("a", s.a.id, of, allFinal, { timeoutMs: 5 * 60000 });
    await waitFor(async () => (await row.first().locator(".link-transfer-chip").count()) === 0, { timeoutMs: 30000, what: "the chip gone once final" });

    await row.first().click();
    const status = page.locator(`.link-thread .link-offer[data-offer="${of}"]`);
    await status.waitFor({ timeout: 30000 });
    assert.match(await status.innerText(), new RegExp(`${root}/`), "the offered root");
    assert.match(await status.locator(".link-offer-note").innerText(), /for the browser check/);
    const line = status.locator(".link-offer-recipient");
    await line.and(page.locator('[data-state="done"]')).waitFor({ timeout: 30000 });
    assert.equal(await line.count(), 1, "one line: b's");
    assert.match(await line.locator(".link-offer-dest").innerText(), /\/root\/shown-in/);
    assert.match(await line.innerText(), /landed/i); // the chip is uppercased by CSS
    await shot("thread");
    await waitIdle("b", s.b.id).catch(() => {});
    await unlink("a", id);
  });
});
