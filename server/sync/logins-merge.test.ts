// The login-sync conflict rule, pure: no files, no clock. Property tests use a seeded PRNG so a
// failure names the seed that reproduces it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  admissible,
  advertisable,
  clockSkewed,
  compareEntries,
  entryKey,
  isEntryMeta,
  isKeyRecord,
  isLive,
  laterTombstone,
  parseEntryKey,
  plan,
  resolve,
  type EntryMeta,
  type KeyRecord,
  type Tombstone,
} from "./logins-merge";

const NOW = 1_800_000_000_000;
const H = 3_600_000;
const fp = (n: number | string) => `sha256:${Buffer.from(String(n)).toString("hex").padStart(64, "0").slice(-64)}`;
const oauth = (o: Partial<EntryMeta> & { expires: number }): EntryMeta => ({
  kind: "oauth",
  issuedAt: NOW - H,
  loginAt: NOW - 10 * H,
  fingerprint: fp(o.expires),
  origin: "a",
  ...o,
});
const key = (o: Partial<EntryMeta> & { issuedAt: number }): EntryMeta => ({
  kind: "api_key",
  loginAt: o.issuedAt,
  fingerprint: fp(`k${o.issuedAt}`),
  origin: "a",
  ...o,
});

test("keys: store:provider, the provider may hold colons, unknown stores are refused", () => {
  assert.equal(entryKey("pi", "openai-codex"), "pi:openai-codex");
  assert.deepEqual(parseEntryKey("pi:openai-codex"), { store: "pi", provider: "openai-codex" });
  assert.deepEqual(parseEntryKey("pi:a:b"), { store: "pi", provider: "a:b" });
  assert.deepEqual(parseEntryKey("claude:claudeAiOauth"), { store: "claude", provider: "claudeAiOauth" });
  for (const bad of ["", "pi", "pi:", ":x", "codex:auth", "tailscale:key"]) assert.equal(parseEntryKey(bad), null, bad);
});

test("liveness: a dead marker is never live, an oauth entry only before its expiry, an api key always", () => {
  assert.equal(isLive(oauth({ expires: NOW + 1 }), NOW), true);
  assert.equal(isLive(oauth({ expires: NOW }), NOW), false, "expiring exactly now is expired");
  assert.equal(isLive(oauth({ expires: NOW + H, dead: true }), NOW), false);
  assert.equal(isLive(key({ issuedAt: NOW - H }), NOW), true);
  assert.equal(isLive(key({ issuedAt: NOW - H, dead: true }), NOW), false);
});

test("a tombstone rules out every entry whose lineage began at or before it; a later login survives", () => {
  const t: Tombstone = { at: NOW - H, by: "a" };
  assert.equal(admissible(oauth({ expires: NOW + H, loginAt: NOW - 2 * H }), t), false);
  assert.equal(admissible(oauth({ expires: NOW + H, loginAt: NOW - H }), t), false, "same instant: the logout wins");
  assert.equal(admissible(oauth({ expires: NOW + H, loginAt: NOW - H + 1 }), t), true);
  assert.equal(admissible(oauth({ expires: NOW + H, loginAt: 0 }), undefined), true);
});

test("within one lineage (same login) the larger expiry wins, whichever side holds it", () => {
  const older = oauth({ expires: NOW + H });
  const newer = oauth({ expires: NOW + 2 * H, origin: "b" });
  assert.deepEqual(resolve({ meta: older }, { meta: newer }, NOW), { action: "adopt", record: { meta: newer } });
  assert.deepEqual(resolve({ meta: newer }, { meta: older }, NOW), { action: "keep", record: { meta: newer }, rejected: "older" });
});

test("a newer login beats an older lineage with a later expiry (account switch, re-login)", () => {
  const oldLineage = oauth({ expires: NOW + 9 * H, loginAt: NOW - 20 * H, issuedAt: NOW - 1000 });
  const relogin = oauth({ expires: NOW + H, loginAt: NOW - 2 * H, origin: "b" });
  assert.equal(resolve({ meta: oldLineage }, { meta: relogin }, NOW).action, "adopt");
  assert.equal(resolve({ meta: relogin }, { meta: oldLineage }, NOW).action, "keep");
});

test("the counterexample that orders logins first: a logout between two logins keeps the later one", () => {
  // L1 logged in at -20h and refreshed late (bigger expiry); L2 logged in at -2h; logout at -5h.
  const L1 = oauth({ expires: NOW + 9 * H, loginAt: NOW - 20 * H, origin: "c" });
  const L2 = oauth({ expires: NOW + H, loginAt: NOW - 2 * H, origin: "b" });
  const t = { at: NOW - 5 * H, by: "a" };
  // B hears from C first, then from A (the logout): B must still hold L2.
  const onB = resolve(resolve({ meta: L2 }, { meta: L1 }, NOW).record, { tombstone: t }, NOW).record;
  assert.deepEqual(onB, { meta: L2, tombstone: t });
});

test("ties fall to issuedAt, then origin, then fingerprint, so both sides pick the same winner", () => {
  const a = oauth({ expires: NOW + H, issuedAt: NOW - 5, origin: "a", fingerprint: fp(1) });
  const b = oauth({ expires: NOW + H, issuedAt: NOW - 4, origin: "a", fingerprint: fp(2) });
  const c = oauth({ expires: NOW + H, issuedAt: NOW - 4, origin: "b", fingerprint: fp(1) });
  const d = oauth({ expires: NOW + H, issuedAt: NOW - 4, origin: "b", fingerprint: fp(3) });
  const ordered = [a, b, c, d];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(Math.sign(compareEntries(ordered[i]!, ordered[j]!)), Math.sign(i - j), `${i} vs ${j}`);
    }
  }
});

test("a dead marker or an expired entry from a peer is never taken, even over nothing", () => {
  const dead = oauth({ expires: 0, dead: true });
  const expired = oauth({ expires: NOW - 1 });
  for (const remote of [dead, expired]) {
    assert.deepEqual(resolve({}, { meta: remote }, NOW), { action: "keep", record: { meta: undefined }, rejected: "dead" });
    const live = oauth({ expires: NOW + H });
    assert.deepEqual(resolve({ meta: live }, { meta: remote }, NOW), { action: "keep", record: { meta: live }, rejected: "dead" });
  }
});

test("a local dead marker (Claude's invalid_grant clearing) is replaced by any live peer entry, even an older-issued one", () => {
  const dead = oauth({ expires: 0, dead: true, issuedAt: NOW });
  const live = oauth({ expires: NOW + 60_000, issuedAt: NOW - 2 * H, origin: "b" });
  assert.equal(resolve({ meta: dead }, { meta: live }, NOW).action, "adopt");
  // ... and a local expired entry likewise (it cannot beat a live one whatever its stamps say)
  const expired = oauth({ expires: NOW - 1, issuedAt: NOW });
  assert.equal(resolve({ meta: expired }, { meta: live }, NOW).action, "adopt");
});

test("a dead or expired local entry stays when the peer offers nothing better (pi can still refresh it)", () => {
  const expired = oauth({ expires: NOW - 1 });
  assert.deepEqual(resolve({ meta: expired }, {}, NOW), { action: "keep", record: { meta: expired } });
});

test("logout: a peer tombstone removes the local entry that predates it and is kept", () => {
  const live = oauth({ expires: NOW + H, loginAt: NOW - 5 * H });
  const t = { at: NOW - H, by: "b" };
  assert.deepEqual(resolve({ meta: live }, { tombstone: t }, NOW), { action: "delete", record: { meta: undefined, tombstone: t } });
  // A peer entry that predates our tombstone is refused as such.
  assert.deepEqual(resolve({ tombstone: t }, { meta: live }, NOW), {
    action: "keep",
    record: { meta: undefined, tombstone: t },
    rejected: "tombstoned",
  });
});

test("H7: a refresh after a logout is not a login — the refreshed lineage stays logged out", () => {
  // C missed the logout at T and refreshed afterwards: newer issuedAt and expires, same loginAt.
  const t = { at: NOW - H, by: "a" };
  const refreshedOnC = oauth({ expires: NOW + 10 * H, issuedAt: NOW - 1000, loginAt: NOW - 20 * H, origin: "c" });
  assert.equal(resolve({ tombstone: t }, { meta: refreshedOnC }, NOW).action, "keep");
  assert.equal(resolve({ meta: refreshedOnC }, { tombstone: t }, NOW).action, "delete");
});

test("a login newer than the tombstone resurrects, and the tombstone travels on with it", () => {
  const t = { at: NOW - H, by: "a" };
  const relogin = oauth({ expires: NOW + H, loginAt: NOW - 1000, origin: "b" });
  assert.deepEqual(resolve({ tombstone: t }, { meta: relogin }, NOW), { action: "adopt", record: { meta: relogin, tombstone: t } });
  // An old lineage (before the logout) with a larger expiry still cannot beat the re-login.
  const oldLineage = oauth({ expires: NOW + 50 * H, loginAt: NOW - 30 * H, origin: "c" });
  assert.equal(resolve({ meta: relogin, tombstone: t }, { meta: oldLineage }, NOW).action, "keep");
  assert.equal(resolve({ meta: oldLineage }, { meta: relogin, tombstone: t }, NOW).action, "adopt");
});

test("tombstones merge by the later instant, ties by host id", () => {
  const a = { at: 5, by: "a" };
  const b = { at: 6, by: "a" };
  const c = { at: 6, by: "b" };
  assert.equal(laterTombstone(a, b), b);
  assert.equal(laterTombstone(b, a), b);
  assert.equal(laterTombstone(b, c), c);
  assert.equal(laterTombstone(c, b), c);
  assert.equal(laterTombstone(undefined, a), a);
  assert.equal(laterTombstone(a, undefined), a);
});

test("api keys: the newest issuedAt wins", () => {
  const old = key({ issuedAt: NOW - 2 * H });
  const fresh = key({ issuedAt: NOW - H, origin: "b" });
  assert.equal(resolve({ meta: old }, { meta: fresh }, NOW).action, "adopt");
  assert.equal(resolve({ meta: fresh }, { meta: old }, NOW).action, "keep");
});

test("advertisable: only live and admissible", () => {
  assert.equal(advertisable({ meta: oauth({ expires: NOW + 1 }) }, NOW), true);
  assert.equal(advertisable({ meta: oauth({ expires: NOW - 1 }) }, NOW), false);
  assert.equal(advertisable({ meta: oauth({ expires: NOW + 1, dead: true }) }, NOW), false);
  assert.equal(advertisable({ meta: oauth({ expires: NOW + 1, loginAt: 3 }), tombstone: { at: 3, by: "a" } }, NOW), false);
  assert.equal(advertisable({ tombstone: { at: 3, by: "a" } }, NOW), false);
});

test("clock skew: more than 60s either way refuses", () => {
  assert.equal(clockSkewed(NOW + 60_000, NOW), false);
  assert.equal(clockSkewed(NOW - 60_000, NOW), false);
  assert.equal(clockSkewed(NOW + 60_001, NOW), true);
  assert.equal(clockSkewed(NOW - 3_600_000, NOW), true);
  assert.equal(clockSkewed(Number.NaN, NOW), true);
});

test("plan: pull what beats ours, push what beats theirs, send newer tombstones, skip unknown stores", () => {
  const t = { at: NOW - H, by: "a" };
  const local = {
    "pi:mine-newer": { meta: oauth({ expires: NOW + 2 * H }) },
    "pi:theirs-newer": { meta: oauth({ expires: NOW + H }) },
    "pi:only-mine": { meta: key({ issuedAt: NOW - H }) },
    "pi:logged-out-here": { tombstone: t },
    "pi:dead-here": { meta: oauth({ expires: 0, dead: true }) },
  };
  const remote = {
    "pi:mine-newer": { meta: oauth({ expires: NOW + H, origin: "b" }) },
    "pi:theirs-newer": { meta: oauth({ expires: NOW + 2 * H, origin: "b" }) },
    "pi:only-theirs": { meta: key({ issuedAt: NOW - H, origin: "b" }) },
    "pi:logged-out-here": { meta: oauth({ expires: NOW + H, loginAt: NOW - 2 * H, origin: "b" }) },
    "pi:dead-here": { meta: oauth({ expires: NOW + H, origin: "b" }) },
    "gh:token": { meta: key({ issuedAt: NOW }) },
  };
  const p = plan(local, remote, NOW);
  assert.deepEqual(p.pull.sort(), ["pi:dead-here", "pi:only-theirs", "pi:theirs-newer"]);
  assert.deepEqual(p.push.sort(), ["pi:mine-newer", "pi:only-mine"]);
  assert.deepEqual(p.tombstones, ["pi:logged-out-here"]);
  assert.deepEqual(p.delete, []);
  // Their tombstone over our entry is a delete here, and nothing is sent back.
  const q = plan({ "pi:x": { meta: oauth({ expires: NOW + H, loginAt: NOW - 2 * H }) } }, { "pi:x": { tombstone: t } }, NOW);
  assert.deepEqual(q, { pull: [], delete: ["pi:x"], push: [], tombstones: [] });
  // Equal on both sides: nothing to do.
  const same = { "pi:x": { meta: oauth({ expires: NOW + H }) } };
  assert.deepEqual(plan(same, structuredClone(same), NOW), { pull: [], delete: [], push: [], tombstones: [] });
});

test("received records are checked structurally; a malformed one is not a record", () => {
  const good = oauth({ expires: NOW + H });
  assert.equal(isEntryMeta(good), true);
  assert.equal(isEntryMeta(key({ issuedAt: NOW })), true);
  assert.equal(isKeyRecord({ meta: good, tombstone: { at: 1, by: "a" } }), true);
  assert.equal(isKeyRecord({}), true);
  const bad: unknown[] = [
    null,
    [],
    { ...good, kind: "cookie" },
    { ...good, expires: undefined },
    { ...good, expires: Number.POSITIVE_INFINITY },
    { ...good, fingerprint: "md5:abc" },
    { ...good, fingerprint: `sha256:${"g".repeat(64)}` },
    { ...good, origin: "" },
    { ...good, loginAt: "0" },
    { ...good, dead: "no" },
    { ...good, account: 7 },
  ];
  for (const b of bad) assert.equal(isEntryMeta(b), false, JSON.stringify(b));
  assert.equal(isKeyRecord({ tombstone: { at: "1", by: "a" } }), false);
  assert.equal(isKeyRecord({ meta: { kind: "oauth" } }), false);
});

// ---------------------------------------------------------------- properties

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A random record: a mix of live/expired/dead oauth, api keys, tombstones, and colliding stamps. */
function randomRecord(r: () => number, hosts: string[]): KeyRecord {
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const small = () => Math.floor(r() * 6); // few distinct values, so ties happen often
  const rec: KeyRecord = {};
  if (r() < 0.8) {
    const kind = r() < 0.75 ? "oauth" : "api_key";
    const issuedAt = NOW - small() * H;
    const meta: EntryMeta = {
      kind,
      issuedAt,
      loginAt: NOW - (small() + 2) * H,
      fingerprint: fp(Math.floor(r() * 8)),
      origin: pick(hosts),
      ...(kind === "oauth" ? { expires: NOW + (small() - 2) * H } : {}),
      ...(r() < 0.1 ? { dead: true } : {}),
    };
    rec.meta = meta;
  }
  if (r() < 0.3) rec.tombstone = { at: NOW - (small() + 1) * H, by: pick(hosts) };
  return rec;
}

/** What a host's record says the usable entry is, if any. */
const winner = (rec: KeyRecord) => (rec.meta && advertisable(rec, NOW) ? rec.meta : undefined);

test("property: the live winner does not depend on which side is local (commutative)", () => {
  for (let seed = 1; seed <= 4000; seed++) {
    const r = prng(seed);
    const a = randomRecord(r, ["a", "b", "c"]);
    const b = randomRecord(r, ["a", "b", "c"]);
    const ab = resolve(a, b, NOW).record;
    const ba = resolve(b, a, NOW).record;
    const la = a.meta && isLive(a.meta, NOW);
    const lb = b.meta && isLive(b.meta, NOW);
    if (la || lb) {
      assert.deepEqual(winner(ab), winner(ba), `seed ${seed}`);
    }
    assert.deepEqual(ab.tombstone, ba.tombstone, `seed ${seed}: tombstone`);
  }
});

test("property: merging the same record twice changes nothing (idempotent)", () => {
  for (let seed = 1; seed <= 4000; seed++) {
    const r = prng(seed);
    const a = randomRecord(r, ["a", "b"]);
    const b = randomRecord(r, ["a", "b"]);
    const once = resolve(a, b, NOW).record;
    const twice = resolve(once, b, NOW);
    assert.deepEqual(twice.record, once, `seed ${seed}`);
    assert.notEqual(twice.action, "adopt", `seed ${seed}`);
    assert.deepEqual(resolve(once, once, NOW).record, once, `seed ${seed}: self-merge`);
  }
});

/**
 * Gossip: N hosts each start with a random record; random pairwise one-way exchanges (in random
 * order, some repeated) until every host has heard every other through some path. Every host must
 * end with the same usable winner, and that winner must be the best live admissible entry of the
 * union under the union's latest tombstone — and never a dead one while a live one existed.
 */
test("property: random gossip converges on the same winner on every host", () => {
  for (let seed = 1; seed <= 3000; seed++) {
    const r = prng(seed);
    const hosts = ["a", "b", "c", "d", "e"].slice(0, 2 + Math.floor(r() * 4));
    const initial = hosts.map(() => randomRecord(r, hosts));
    const state = initial.map((x) => structuredClone(x));
    // Enough random exchanges, then two full sweeps so the result is fully mixed.
    const steps = 3 * hosts.length + Math.floor(r() * 10);
    const exchange = (to: number, from: number) => {
      state[to] = resolve(state[to]!, state[from]!, NOW).record;
    };
    for (let s = 0; s < steps; s++) exchange(Math.floor(r() * hosts.length), Math.floor(r() * hosts.length));
    for (let sweep = 0; sweep < 2; sweep++) for (let i = 0; i < hosts.length; i++) for (let j = 0; j < hosts.length; j++) exchange(i, j);

    const tomb = initial.reduce<Tombstone | undefined>((t, x) => laterTombstone(t, x.tombstone), undefined);
    const candidates = initial
      .map((x) => x.meta)
      .filter((m): m is EntryMeta => !!m && isLive(m, NOW) && admissible(m, tomb))
      .sort(compareEntries);
    const expected = candidates.at(-1);
    for (let i = 0; i < hosts.length; i++) {
      assert.deepEqual(winner(state[i]!), expected, `seed ${seed} host ${hosts[i]}`);
      assert.deepEqual(state[i]!.tombstone, tomb, `seed ${seed} host ${hosts[i]} tombstone`);
      // "no host ever ends with an empty entry while another has a live one" (H11)
      if (expected) assert.ok(state[i]!.meta && isLive(state[i]!.meta!, NOW), `seed ${seed} host ${hosts[i]} empty`);
    }
  }
});
