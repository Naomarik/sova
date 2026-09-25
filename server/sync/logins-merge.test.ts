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
  loginKindsPin,
  parseEntryKey,
  plan,
  resolve,
  sameLineage,
  syncsRecord,
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
  // ... and a local expired entry of the same lineage (the same loginAt: rotated elsewhere) likewise
  const expired = oauth({ expires: NOW - 1, issuedAt: NOW });
  assert.equal(resolve({ meta: expired }, { meta: live }, NOW).action, "adopt");
});

// ---------------------------------------------------------------- idle hosts (access token expired)

test("qa F2 case 1: pre-sync, A's idle (expired) personal login vs B's live work login is a conflict, not an overwrite", () => {
  // qa-reviewer's idle-expired.mts, case 1, verbatim stamps.
  const DAY = 24 * H;
  const A1 = { meta: oauth({ expires: NOW - 2 * H, issuedAt: NOW - 3 * DAY, loginAt: 0, fingerprint: fp("a"), origin: "a", account: "personal" }) };
  const B1 = { meta: oauth({ expires: NOW + 6 * H, issuedAt: NOW - 1 * DAY, loginAt: 0, fingerprint: fp("b"), origin: "b", account: "work" }) };
  assert.deepEqual(resolve(A1, B1, NOW), { action: "keep", record: { meta: A1.meta }, rejected: "conflict" });
  assert.deepEqual(resolve(B1, A1, NOW), { action: "keep", record: { meta: B1.meta }, rejected: "dead" }, "an expired entry is still never taken");
  assert.deepEqual(plan({ k: A1 }, { k: B1 }, NOW), { pull: [], delete: [], push: [], tombstones: [] }, "nothing pulled, nothing pushed");
});

test("qa F2 case 2: A's newer login, idle, is not replaced by B's older live login; B does not take the expired one", () => {
  const DAY = 24 * H;
  const A2 = { meta: oauth({ expires: NOW - 1 * H, issuedAt: NOW - 1 * DAY, loginAt: NOW - 1 * DAY, fingerprint: fp("c"), origin: "a", account: "X" }) };
  const B2 = { meta: oauth({ expires: NOW + 6 * H, issuedAt: NOW - 1 * H, loginAt: NOW - 10 * DAY, fingerprint: fp("d"), origin: "b", account: "Y" }) };
  assert.deepEqual(resolve(A2, B2, NOW), { action: "keep", record: { meta: A2.meta }, rejected: "older" });
  assert.deepEqual(resolve(B2, A2, NOW), { action: "keep", record: { meta: B2.meta }, rejected: "dead" });
  // Once A's own consumer refreshes it (same loginAt, new expiry), the newer login spreads.
  const refreshed = { meta: { ...A2.meta, expires: NOW + 8 * H, issuedAt: NOW, fingerprint: fp("c2") } };
  assert.equal(resolve(B2, refreshed, NOW).action, "adopt");
  assert.equal(resolve(refreshed, B2, NOW).action, "keep");
});

test("an idle entry still gives way to its own lineage refreshed elsewhere, and to a newer login", () => {
  // Rotation: B refreshed the lineage while A slept, so A's refresh token is dead weight.
  const idle = oauth({ expires: NOW - H, loginAt: NOW - 5 * H, fingerprint: fp("i") });
  const rotated = oauth({ expires: NOW + H, loginAt: NOW - 5 * H, fingerprint: fp("r"), origin: "b" });
  assert.equal(sameLineage(idle, rotated), true, "the same loginAt, no account");
  assert.equal(resolve({ meta: idle }, { meta: rotated }, NOW).action, "adopt");
  // The same account from before sync (a copied lineage, refreshed on B).
  const idlePre = oauth({ expires: NOW - H, loginAt: 0, account: "acct", fingerprint: fp("p1") });
  const livePre = oauth({ expires: NOW + H, loginAt: 0, account: "acct", fingerprint: fp("p2"), origin: "b" });
  assert.equal(resolve({ meta: idlePre }, { meta: livePre }, NOW).action, "adopt");
  // Two pre-sync entries with no account: nothing proves a lineage (loginAt 0 says nothing).
  assert.equal(sameLineage(oauth({ expires: NOW - H, loginAt: 0, fingerprint: fp("x") }), oauth({ expires: NOW + H, loginAt: 0, fingerprint: fp("y") })), false);
  // A newer login anywhere wins, over a pre-sync idle entry too.
  const newer = oauth({ expires: NOW + H, loginAt: NOW - H, fingerprint: fp("n"), origin: "b", account: "other" });
  assert.equal(resolve({ meta: idle }, { meta: newer }, NOW).action, "adopt");
  assert.equal(resolve({ meta: idlePre }, { meta: newer }, NOW).action, "adopt");
  // An older different login does not; a dead marker still takes anything live.
  const older = oauth({ expires: NOW + H, loginAt: NOW - 9 * H, fingerprint: fp("o"), origin: "b" });
  assert.deepEqual(resolve({ meta: idle }, { meta: older }, NOW), { action: "keep", record: { meta: idle }, rejected: "older" });
  assert.equal(resolve({ meta: { ...idle, dead: true } }, { meta: older }, NOW).action, "adopt");
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
    const loginAt = NOW - (small() + 2) * H;
    const meta: EntryMeta = {
      kind,
      issuedAt,
      loginAt,
      // Collisions happen, but only within one login: a fingerprint is a hash of the entry itself.
      fingerprint: fp(`${Math.floor(r() * 8)}@${loginAt}`),
      origin: pick(hosts),
      ...(kind === "oauth" ? { expires: NOW + (small() - 2) * H } : {}),
      ...(r() < 0.1 ? { dead: true } : {}),
    };
    rec.meta = meta;
  }
  if (r() < 0.3) rec.tombstone = { at: NOW - (small() + 1) * H, by: pick(hosts) };
  return rec;
}

/** `local` holds an idle (expired, not dead) admissible login that `remote`'s live entry does not replace. */
function keepsIdle(local: KeyRecord, remote: KeyRecord): boolean {
  const tomb = laterTombstone(local.tombstone, remote.tombstone);
  const l = local.meta;
  const r = remote.meta;
  if (!l || l.dead || isLive(l, NOW) || !admissible(l, tomb)) return false;
  if (!r || !isLive(r, NOW) || !admissible(r, tomb)) return false;
  return !sameLineage(l, r) && r.loginAt <= l.loginAt;
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
    if (keepsIdle(a, b) || keepsIdle(b, a)) {
      // An idle login against a different, older live one: each side keeps its own.
      const [idleSide, liveSide, idleRes, liveRes] = keepsIdle(a, b) ? [a, b, ab, ba] : [b, a, ba, ab];
      assert.deepEqual(idleRes.meta, idleSide.meta, `seed ${seed}: the idle side keeps its login`);
      assert.deepEqual(winner(liveRes), winner(liveSide), `seed ${seed}: the live side keeps its own`);
    } else if (la || lb) {
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
      // A host whose own idle login is newer than (and not the lineage of) the live winner keeps
      // it: expired entries never travel, so it can only be the one it started with.
      const own = initial[i]!.meta;
      if (expected && own && keepsIdle({ meta: own, tombstone: tomb }, { meta: expected, tombstone: tomb })) {
        assert.deepEqual(state[i]!.meta, own, `seed ${seed} host ${hosts[i]} keeps its idle login`);
        assert.deepEqual(state[i]!.tombstone, tomb, `seed ${seed} host ${hosts[i]} tombstone`);
        continue;
      }
      assert.deepEqual(winner(state[i]!), expected, `seed ${seed} host ${hosts[i]}`);
      assert.deepEqual(state[i]!.tombstone, tomb, `seed ${seed} host ${hosts[i]} tombstone`);
      // "no host ever ends with an empty entry while another has a live one" (H11)
      if (expected) assert.ok(state[i]!.meta && isLive(state[i]!.meta!, NOW), `seed ${seed} host ${hosts[i]} empty`);
    }
  }
});

// ---------------------------------------------------------------- pre-sync entries (loginAt 0)

test("qa repro: two hosts with DIFFERENT pre-sync api keys are a conflict, never an overwrite", () => {
  // qa-reviewer's first-pair.mts: A holds the current key (first scanned 2 days ago), B an old
  // revoked one (its sync started a day later). Before the fix, A adopted B's key.
  const DAY = 86_400_000;
  const A = { meta: key({ issuedAt: NOW - 2 * DAY, loginAt: 0, fingerprint: fp("a"), origin: "a" }) };
  const B = { meta: key({ issuedAt: NOW - 1 * DAY, loginAt: 0, fingerprint: fp("b"), origin: "b" }) };
  assert.deepEqual(resolve(A, B, NOW), { action: "keep", record: { meta: A.meta }, rejected: "conflict" });
  assert.deepEqual(resolve(B, A, NOW), { action: "keep", record: { meta: B.meta }, rejected: "conflict" });
  assert.deepEqual(plan({ "pi:zai": A }, { "pi:zai": B }, NOW), { pull: [], delete: [], push: [], tombstones: [] });
});

test("pre-sync OAuth: different accounts conflict; the same account (a copied, refreshed lineage) converges by expiry", () => {
  const personal = oauth({ expires: NOW + H, loginAt: 0, account: "personal", fingerprint: fp("p") });
  const work = oauth({ expires: NOW + 2 * H, loginAt: 0, account: "work", fingerprint: fp("w"), origin: "b" });
  assert.equal(resolve({ meta: personal }, { meta: work }, NOW).action, "keep");
  assert.equal((resolve({ meta: personal }, { meta: work }, NOW) as { rejected?: string }).rejected, "conflict");
  const refreshedCopy = oauth({ expires: NOW + 2 * H, loginAt: 0, account: "personal", fingerprint: fp("p2"), origin: "b" });
  assert.equal(resolve({ meta: personal }, { meta: refreshedCopy }, NOW).action, "adopt");
  // No account on either side: nothing proves it is the same login, so it is a conflict too.
  const anonA = oauth({ expires: NOW + H, loginAt: 0, fingerprint: fp("x") });
  const anonB = oauth({ expires: NOW + 2 * H, loginAt: 0, fingerprint: fp("y"), origin: "b" });
  assert.equal((resolve({ meta: anonA }, { meta: anonB }, NOW) as { rejected?: string }).rejected, "conflict");
});

test("a pre-sync conflict clears itself when one side's login dies, or when anyone logs in afresh", () => {
  const mineDead = oauth({ expires: 0, dead: true, loginAt: 0, fingerprint: fp("d") });
  const theirs = oauth({ expires: NOW + H, loginAt: 0, fingerprint: fp("t"), origin: "b" });
  assert.equal(resolve({ meta: mineDead }, { meta: theirs }, NOW).action, "adopt", "a dead entry takes the live one");
  const mine = oauth({ expires: NOW + H, loginAt: 0, fingerprint: fp("m") });
  const fresh = oauth({ expires: NOW + H, loginAt: NOW - 1000, fingerprint: fp("f"), origin: "b" });
  assert.equal(resolve({ meta: mine }, { meta: fresh }, NOW).action, "adopt", "a login made during sync is authoritative");
});

test("a logout removes a pre-sync entry only if it is the login logged out; later logins as before", () => {
  const t = { at: NOW - H, by: "a", of: { fingerprint: fp("k1") } };
  const same = key({ issuedAt: NOW - 2 * H, loginAt: 0, fingerprint: fp("k1") });
  const other = key({ issuedAt: NOW - 2 * H, loginAt: 0, fingerprint: fp("k2"), origin: "b" });
  assert.equal(admissible(same, t), false);
  assert.equal(admissible(other, t), true, "B's different pre-sync key survives A's logout");
  const acct = { at: NOW - H, by: "a", of: { fingerprint: fp("o1"), account: "acct" } };
  assert.equal(admissible(oauth({ expires: NOW + H, loginAt: 0, account: "acct", fingerprint: fp("o2") }), acct), false, "same account: refreshed copy");
  // An entry logged in during sync is ruled out by any later logout, whatever `of` names.
  assert.equal(admissible(key({ issuedAt: NOW - 3 * H, loginAt: NOW - 3 * H, fingerprint: fp("k3") }), t), false);
  assert.equal(isKeyRecord({ tombstone: t }), true);
  assert.equal(isKeyRecord({ tombstone: { ...t, of: { fingerprint: 3 } } }), false);
});

test("a pre-sync entry that survived a logout stays on its host and is not taken by the host that logged out", () => {
  const t = { at: NOW - H, by: "a", of: { fingerprint: fp("k1") } };
  const bKey = key({ issuedAt: NOW - 2 * H, loginAt: 0, fingerprint: fp("k2"), origin: "b" });
  assert.deepEqual(resolve({ tombstone: t }, { meta: bKey }, NOW), { action: "keep", record: { meta: undefined, tombstone: t }, rejected: "tombstoned" });
  assert.deepEqual(resolve({ meta: bKey }, { tombstone: t }, NOW), { action: "keep", record: { meta: bKey, tombstone: t } });
  // Claimed on B (a login made now): it spreads, logout or not.
  const claimed = { ...bKey, loginAt: NOW - 1000, issuedAt: NOW - 1000 };
  assert.equal(resolve({ tombstone: t }, { meta: claimed }, NOW).action, "adopt");
});

test("api-keys mode: which records sync, and the env pin", () => {
  const api = { meta: key({ issuedAt: NOW }) };
  const login = { meta: oauth({ expires: NOW + H }) };
  assert.equal(syncsRecord("all", "pi:x", login), true);
  assert.equal(syncsRecord("all", "claude:claudeAiOauth", login), true);
  assert.equal(syncsRecord("api-keys", "pi:zai", api), true);
  assert.equal(syncsRecord("api-keys", "pi:zai", undefined), true, "nothing known yet");
  assert.equal(syncsRecord("api-keys", "pi:x", login), false);
  assert.equal(syncsRecord("api-keys", "claude:claudeAiOauth", undefined), false, "Claude Code's store is a subscription login");
  assert.equal(syncsRecord("api-keys", "pi:x", { tombstone: { at: 1, by: "a", of: { fingerprint: "f", kind: "oauth" } } }), false);
  assert.equal(syncsRecord("api-keys", "pi:x", { tombstone: { at: 1, by: "a", of: { fingerprint: "f", kind: "api_key" } } }), true);
  assert.equal(syncsRecord("api-keys", "pi:x", { tombstone: { at: 1, by: "a" } }), true, "a logout that names no kind is harmless");
  assert.equal(loginKindsPin({ SOVA_SYNC_LOGIN_KINDS: "api-keys" }), "api-keys");
  assert.equal(loginKindsPin({ SOVA_SYNC_LOGIN_KINDS: " all " }), "all");
  assert.equal(loginKindsPin({ SOVA_SYNC_LOGIN_KINDS: "api-key" }), "api-keys", "a typo keeps subscriptions off");
  assert.equal(loginKindsPin({ SOVA_SYNC_LOGIN_KINDS: " " }), null);
  assert.equal(loginKindsPin({}), null);
  assert.equal(isKeyRecord({ tombstone: { at: 1, by: "a", of: { fingerprint: "f", kind: "oauth" } } }), true);
  assert.equal(isKeyRecord({ tombstone: { at: 1, by: "a", of: { fingerprint: "f", kind: "password" } } }), false);
});

test("a refreshed pre-sync entry (no account) is the same login as its lineage's older copy, both ways and across refreshes", () => {
  const old = oauth({ expires: NOW + H, loginAt: 0 });
  const once = oauth({ expires: NOW + 8 * H, loginAt: 0, lineage: old.fingerprint });
  const twice = oauth({ expires: NOW + 16 * H, loginAt: 0, lineage: old.fingerprint });
  const other = oauth({ expires: NOW + 2 * H, loginAt: 0 });
  const rejected = (l: EntryMeta, r: EntryMeta) => {
    const res = resolve({ meta: l }, { meta: r }, NOW);
    return "rejected" in res ? res.rejected : undefined;
  };
  assert.equal(resolve({ meta: old }, { meta: once }, NOW).action, "adopt", "the peer's older copy takes the refresh");
  assert.equal(rejected(once, old), "older", "and the refresher keeps it");
  assert.equal(resolve({ meta: once }, { meta: twice }, NOW).action, "adopt");
  assert.equal(rejected(other, once), "conflict", "a different pre-sync login is still a conflict");
  // A logout of the refreshed lineage rules out the peer's copy from before the refresh.
  const logout: Tombstone = { at: NOW, by: "a", of: { fingerprint: once.fingerprint, lineage: old.fingerprint, kind: "oauth" } };
  assert.equal(admissible(old, logout), false);
  assert.equal(admissible(other, logout), true);
  // And the other way: a peer's logout of the copy from before the refresh rules out the refreshed entry.
  const oldLogout: Tombstone = { at: NOW, by: "b", of: { fingerprint: old.fingerprint, kind: "oauth" } };
  assert.equal(admissible(once, oldLogout), false);
  assert.equal(admissible(twice, oldLogout), false);
  assert.equal(admissible(other, oldLogout), true);
  assert.ok(isEntryMeta(once) && isKeyRecord({ tombstone: logout }));
  assert.equal(isEntryMeta({ ...once, lineage: "not-a-fingerprint" }), false);
  assert.equal(isKeyRecord({ tombstone: { ...logout, of: { ...logout.of!, lineage: 7 } } }), false);
});
