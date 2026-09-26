// M5 — Browser access propagation: a host that turns its Browser access off (no browser-facing
// address, e.g. a phone) is recorded as such by every peer, with the stamp it was set at, and left
// out of every host's front door (the order, the generated Caddyfile with its "Left out" line, the
// noBrowser list). Turned back on from a peer (the peer path, /api/peer/set-browser-access), every
// host follows with a newer stamp. The newest stamp wins a race and an older announcement never
// overrides it; a host changed while partitioned is picked up when it comes back; the settings
// route refuses an exclusion that would leave no host with a browser address.
//   scripts/mesh-lab/lab e2e m5-browser-access      (restores every host to on, unpartitioned, at the end)
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { chaos, curlFrom, lab, laptopFetch, PEER_PORT, readAgentFile, requireLab, tailnetIp, waitFor } from "./lib.mjs";

let cfg;
let H; // every host, e.g. [a, b, c]
let A, C; // A turns C back on; C is the host whose Browser access changes

const json = async (n, path, init) => {
  const r = await laptopFetch(n, path, { timeoutMs: 30000, ...init });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const put = (n, path, body) => json(n, path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** PUT /api/mesh/browser-access on `on`, for host `id` (its own, or a peer's through the peer path). */
const setAccess = (on, id, browserAccess) => put(on, "/api/mesh/browser-access", { id, browserAccess });
const peersDoc = (n) => JSON.parse(readAgentFile(n, "sova/peers.json") ?? "null");

/** What `n` has recorded about `id`'s Browser access (its own setting for itself), from peers.json. */
function recorded(n, id) {
  const doc = peersDoc(n);
  if (id === n) return { on: doc.self.browserAccess !== false, at: doc.self.browserAccessAt };
  const p = doc.peers.find((x) => x.id === id);
  return { on: p.browserAccess !== false, at: p.browserAccessAt };
}

/** Every view `n` gives of `id`: peers.json, GET /api/mesh/details, GET /api/mesh/front-door. */
async function viewOn(n, id) {
  const details = (await json(n, "/api/mesh/details")).body;
  const fd = (await json(n, "/api/mesh/front-door")).body;
  const row = details.hosts.find((h) => h.id === id);
  return {
    ...recorded(n, id),
    detailsOn: row.browserAccess,
    inOrder: fd.order.some((h) => h.id === id),
    noBrowser: (fd.noBrowser ?? []).some((h) => h.id === id),
    leftOutLine: new RegExp(`^# Left out: .*\\b${id}\\b.* no browser address`, "m").test(fd.caddyfile),
    inCaddyfile: new RegExp(`reverse_proxy [^\\n]*\\b${id}\\.mesh\\.lab`).test(fd.caddyfile),
    order: fd.order.map((h) => h.id),
  };
}

/** Wait until every host shows `id` with Browser access `on`, stamped `at` (the host's own stamp). */
async function converged(id, on, at, what) {
  return waitFor(
    async () => {
      const views = {};
      for (const n of H) {
        const v = await viewOn(n, id);
        const ok = v.on === on && v.at === at && v.detailsOn === on && v.inOrder === on && v.noBrowser === !on && v.leftOutLine === !on && v.inCaddyfile === on;
        if (!ok) return false;
        views[n] = v;
      }
      return views;
    },
    { timeoutMs: 45000, intervalMs: 1000, what },
  );
}

before(() => {
  cfg = requireLab();
  H = cfg.hosts;
  assert.ok(H.length >= 3, "M5 needs 3 hosts");
  [A, , C] = H;
});

after(async () => {
  try {
    lab("restore", C);
  } catch {}
  for (const n of H) await setAccess(n, n, true).catch(() => {});
  await put(A, "/api/mesh/settings", { frontDoorExclude: null }).catch(() => {});
});

describe("Browser access propagation", () => {
  let offAt;
  let onAt;

  test("a. baseline: every host has Browser access on, and every front door orders all hosts", async () => {
    for (const n of H) {
      for (const id of H) {
        const v = await viewOn(n, id);
        assert.equal(v.on, true, `${n} records ${id} on`);
        assert.equal(v.detailsOn, true, `${n} details: ${id} on`);
        assert.equal(v.noBrowser, false, `${n}: ${id} not under noBrowser`);
      }
      const fd = (await json(n, "/api/mesh/front-door")).body;
      assert.deepEqual([...fd.order.map((h) => h.id)].sort(), [...H].sort(), `${n}'s order has every host`);
      assert.doesNotMatch(fd.caddyfile, /^# Left out:/m, `${n}'s Caddyfile leaves nobody out`);
    }
  });

  test("b. the host turns its own off: every peer records off with its stamp; every front door leaves it out", async () => {
    const r = await setAccess(C, C, false);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.browserAccess, false);
    offAt = recorded(C, C).at;
    assert.equal(typeof offAt, "number", `${C} stamped its own setting`);
    // pushed by the announcement, before anyone asks for details
    for (const n of H.filter((x) => x !== C)) {
      await waitFor(() => recorded(n, C).on === false && recorded(n, C).at === offAt, { timeoutMs: 20000, what: `${n} records ${C} off at ${offAt}` });
    }
    const views = await converged(C, false, offAt, `every host leaves ${C} out`);
    for (const n of H) assert.ok(!views[n].order.includes(C) && views[n].order.length === H.length - 1, `${n}: order ${views[n].order}`);
  });

  test("c. a peer turns it back on (the peer path): the host flips and every host follows with a newer stamp", async () => {
    const r = await setAccess(A, C, true);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.browserAccess, true);
    const own = recorded(C, C);
    assert.equal(own.on, true, `${C} itself is on`);
    assert.ok(own.at > offAt, `newer stamp (${own.at} > ${offAt})`);
    onAt = own.at;
    await converged(C, true, onAt, `every host has ${C} back on`);
  });

  test("d. race: two quick toggles; the newest stamp wins everywhere, and an older announcement never overrides it", async () => {
    // off then on, the second sent 30 ms after the first without waiting for it
    for (const [first, second] of [
      [false, true],
      [true, false],
    ]) {
      const p1 = setAccess(C, C, first);
      await new Promise((r) => setTimeout(r, 30));
      const p2 = setAccess(A, C, second);
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
      const own = recorded(C, C);
      assert.equal(own.on, second, `${C} ends ${second ? "on" : "off"}`);
      assert.ok(own.at > onAt, "a newer stamp than before the race");
      await converged(C, second, own.at, `every host ends ${second ? "on" : "off"} (newest stamp)`);
      onAt = own.at;
    }
    // C is off at onAt now. A stale "on" from C with an older stamp (the one it had before the race)
    // reaches A and B straight on their peer listeners, from C itself: it must change nothing.
    const stale = offAt;
    for (const n of H.filter((x) => x !== C)) {
      const r = curlFrom(C, `http://${tailnetIp(n)}:${PEER_PORT}/api/peer/browser-access`, { method: "POST", body: { browserAccess: true, browserAccessAt: stale } });
      assert.equal(r.status, 200, `${n} answered the stale announcement: ${r.body}`);
      assert.deepEqual(recorded(n, C), { on: false, at: onAt }, `${n} kept the newer off`);
    }
    await converged(C, false, onAt, "still off everywhere after the stale announcement");
    const r = await setAccess(C, C, true);
    assert.equal(r.status, 200);
    onAt = recorded(C, C).at;
    await converged(C, true, onAt, "on again");
  });

  test("e. changed while partitioned: the peers pick it up when it comes back, never a stale on", async () => {
    if (!recorded(C, C).on) assert.equal((await setAccess(C, C, true)).status, 200); // start from on even if d stopped midway
    onAt = recorded(C, C).at;
    await converged(C, true, onAt, "on everywhere before the partition");
    chaos.partition(C);
    let partitioned = true;
    try {
      const r = await setAccess(C, C, false); // its announcements can't get out
      assert.equal(r.status, 200, JSON.stringify(r.body));
      offAt = recorded(C, C).at;
      assert.ok(offAt > onAt);
      for (const n of H.filter((x) => x !== C)) assert.deepEqual(recorded(n, C), { on: true, at: onAt }, `${n} can't have heard yet`);
      chaos.restore(C);
      partitioned = false;
      await converged(C, false, offAt, `after healing, every host has ${C} off`);
      // and it stays so: nothing stale comes back from anyone
      await new Promise((r) => setTimeout(r, 10000));
      await converged(C, false, offAt, "still off 10 s later");
    } finally {
      if (partitioned) chaos.restore(C);
    }
  });

  test("f. refusal: an exclusion that leaves no host with a browser address is refused (400)", async () => {
    // C is off: excluding every other host leaves none with a browser address
    for (const n of H) {
      const r = await put(n, "/api/mesh/settings", { frontDoorExclude: H.filter((x) => x !== C) });
      assert.equal(r.status, 400, `${n}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /browser address/);
    }
    const r = await setAccess(C, C, true);
    assert.equal(r.status, 200);
    onAt = recorded(C, C).at;
    await converged(C, true, onAt, "on again before the all-on refusal");
    // every host has one: excluding them all is refused
    for (const n of H) {
      const r = await put(n, "/api/mesh/settings", { frontDoorExclude: H });
      assert.equal(r.status, 400, `${n}: ${JSON.stringify(r.body)}`);
      assert.equal(peersDoc(n).frontDoorExclude, undefined, `${n} wrote nothing`);
    }
  });

  test("g. restore: every host on, nobody partitioned, nobody left out", async () => {
    for (const n of H) assert.equal((await setAccess(n, n, true)).status, 200);
    for (const id of H) await converged(id, true, recorded(id, id).at, `${id} on everywhere`);
    const { rows } = JSON.parse(lab("status", "--json"));
    for (const n of H) assert.equal(rows.find((x) => x.name === n)?.partitioned, false, `${n} not partitioned`);
  });
});
