import assert from "node:assert/strict";
import { test } from "node:test";
import * as admission from "./lan-admission";
import { Admission, LAN_PROFILE, sourceOf } from "./lan-admission";

const A = "192.0.2.10";
const B = "192.0.2.11";

test("per address: at most 4 handshakes in progress", () => {
  const a = new Admission(LAN_PROFILE);
  for (let i = 0; i < 4; i++) assert.deepEqual(a.admit(A, i * 200), { ok: true });
  assert.deepEqual(a.admit(A, 900), { ok: false, why: "too many handshakes" });
  assert.deepEqual(a.admit(B, 900), { ok: true }, "another address is unaffected");
  a.handshakeDone(A, true, 950);
  assert.deepEqual(a.admit(A, 2000), { ok: true }, "a finished handshake frees a slot");
});

test("per address: at most 10 new connections in any second, refused ones included", () => {
  const a = new Admission(LAN_PROFILE);
  for (let i = 0; i < 10; i++) {
    assert.equal(a.admit(A, i).ok, true);
    a.handshakeDone(A, true, i);
  }
  assert.deepEqual(a.admit(A, 500), { ok: false, why: "too fast" });
  assert.deepEqual(a.admit(A, 999), { ok: false, why: "too fast" });
  assert.equal(a.admit(A, 1000).ok, true, "the window slides");
});

test("5 failed handshakes within 60 s ban the address for 5 min", () => {
  for (const [profile, banMs] of [[LAN_PROFILE, 300_000]] as const) {
    const a = new Admission(profile);
    for (let i = 0; i < 5; i++) {
      const t = i * 10_000;
      assert.equal(a.admit(A, t).ok, true);
      a.handshakeDone(A, false, t);
    }
    assert.equal(a.isBanned(A, 40_000), true);
    assert.deepEqual(a.admit(A, 40_001), { ok: false, why: "banned" });
    assert.equal(a.admit(B, 40_001).ok, true);
    assert.equal(a.isBanned(A, 40_000 + banMs - 1), true);
    assert.equal(a.isBanned(A, 40_000 + banMs), false);
    assert.equal(a.admit(A, 40_000 + banMs).ok, true);
    assert.equal(a.counts(40_001).bans, 1);
  }
});

test("failures spread over more than 60 s don't ban", () => {
  const a = new Admission(LAN_PROFILE);
  for (let i = 0; i < 10; i++) {
    const t = i * 16_000;
    assert.equal(a.admit(A, t).ok, true, `attempt ${i}`);
    a.handshakeDone(A, false, t);
    a.closed(A);
  }
  assert.equal(a.isBanned(A, 200_000), false);
});

test("at most 64 connections overall, 8 of them kept for sources that paired recently", () => {
  const a = new Admission(LAN_PROFILE);
  // A paired host's address, from an earlier visit.
  a.admit(B, 0);
  a.handshakeDone(B, true, 0);
  a.closed(B);
  for (let i = 0; i < 56; i++) assert.equal(a.admit(`198.51.100.${i}`, 1).ok, true, `stranger ${i}`);
  assert.deepEqual(a.admit("198.51.100.200", 2), { ok: false, why: "full" }, "strangers stop at 56");
  assert.equal(a.admit(B, 2).ok, true, "a source that paired recently gets a reserved slot");
  for (let i = 0; i < 7; i++) {
    const ip = `203.0.113.${i}`;
    a.admit(ip, 3); // fill the reserve with other paired sources
    a.handshakeDone(ip, true, 3);
    a.closed(ip);
    a.admit(ip, 3);
  }
  assert.equal(a.counts(3).open, 64);
  assert.deepEqual(a.admit(B, 4), { ok: false, why: "full" }, "64 is the hard cap");
  a.closed("198.51.100.0");
  assert.equal(a.admit(B, 5).ok, true);
});

test("a paired source's trust expires after a day", () => {
  const a = new Admission({ ...LAN_PROFILE, maxConnections: 2, reservedConnections: 1 });
  a.admit(B, 0);
  a.handshakeDone(B, true, 0);
  a.closed(B);
  a.admit(A, 1);
  assert.equal(a.admit(B, 2).ok, true, "trusted: the reserved slot");
  a.closed(B);
  assert.deepEqual(a.admit(B, LAN_PROFILE.trustMs + 10), { ok: false, why: "full" }, "a day later it is a stranger again");
});

test("tracked sources are bounded; a full table forgets the least recently seen idle one (M3)", () => {
  const a = new Admission({ ...LAN_PROFILE, maxTracked: 3, maxConnections: 100, reservedConnections: 0 });
  // Three failing strangers fill the table: none quiet (failures inside the window).
  for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
    assert.equal(a.admit(ip, 0).ok, true);
    a.handshakeDone(ip, false, 0);
    a.closed(ip);
  }
  a.admit("192.0.2.1", 5); // seen again: now the most recent
  a.handshakeDone("192.0.2.1", false, 5);
  a.closed("192.0.2.1");
  assert.equal(a.admit("192.0.2.4", 10).ok, true, "a new source is admitted, never refused for a flood of failures");
  assert.equal(a.counts(10).tracked, 3);
  // 192.0.2.2 was the least recently seen: it was forgotten, the others kept their failures.
  for (let i = 0; i < 4; i++) {
    a.admit("192.0.2.1", 20 + i);
    a.handshakeDone("192.0.2.1", false, 20 + i);
    a.closed("192.0.2.1");
  }
  assert.equal(a.isBanned("192.0.2.1", 30), true, "the kept entry still counted its earlier failures");
});

test("a source with something open, or banned, is never forgotten to make room", () => {
  const a = new Admission({ ...LAN_PROFILE, maxTracked: 2, maxConnections: 100, reservedConnections: 0, maxTrusted: 1 });
  for (let i = 0; i < 5; i++) {
    a.admit(A, i);
    a.handshakeDone(A, false, i);
    a.closed(A);
  }
  assert.equal(a.admit("192.0.2.50", 10).ok, true); // still handshaking: open
  assert.deepEqual(a.admit("192.0.2.51", 11), { ok: false, why: "too many addresses" });
  a.sweep(100_000);
  assert.equal(a.isBanned(A, 100_000), true, "a ban outlives any sweep");
  // A source that paired recently still gets in, past a full table (its own reserve).
  a.handshakeDone("192.0.2.50", true, 11);
  a.closed("192.0.2.50");
  const b = new Admission({ ...LAN_PROFILE, maxTracked: 1, maxConnections: 100, reservedConnections: 0 });
  b.admit(B, 0);
  b.handshakeDone(B, true, 0);
  b.closed(B);
  b.sweep(5000); // B is quiet and forgotten from the main table, but stays trusted
  b.admit(A, 6000); // A holds the one entry, handshaking
  assert.deepEqual(b.admit("192.0.2.60", 6001), { ok: false, why: "too many addresses" });
  assert.equal(b.admit(B, 6002).ok, true, "the paired source has room of its own");
});

test("a global IPv6 source counts per /64; private and link-local IPv6 per address", () => {
  assert.equal(sourceOf("2001:db8:1:2:aaaa::1"), sourceOf("2001:db8:1:2:bbbb::2"));
  assert.notEqual(sourceOf("2001:db8:1:2::1"), sourceOf("2001:db8:1:3::1"));
  assert.notEqual(sourceOf("fd00::1"), sourceOf("fd00::2"));
  assert.notEqual(sourceOf("fe80::1"), sourceOf("fe80::2"));
  assert.equal(sourceOf("::ffff:10.0.0.1"), "10.0.0.1", "a v4-mapped address is its IPv4 address");
  const a = new Admission(LAN_PROFILE);
  for (let i = 0; i < 5; i++) {
    const ip = `2001:db8:1:2::${(i + 1).toString(16)}`; // a new address each time, one /64
    assert.equal(a.admit(ip, i).ok, true);
    a.handshakeDone(ip, false, i);
    a.closed(ip);
  }
  assert.deepEqual(a.admit("2001:db8:1:2::ffff", 10), { ok: false, why: "banned" }, "the whole /64 is banned");
  assert.equal(a.admit("2001:db8:1:3::1", 10).ok, true, "the next /64 is not");
  assert.equal(a.counts(10).tracked, 2);
});

test("a source that paired recently is banned only briefly (a neighbour behind its NAT failing)", () => {
  const a = new Admission(LAN_PROFILE);
  a.admit(B, 0);
  a.handshakeDone(B, true, 0);
  a.closed(B);
  for (let i = 0; i < 5; i++) {
    a.admit(B, 1000 + i);
    a.handshakeDone(B, false, 1000 + i);
    a.closed(B);
  }
  assert.equal(a.isBanned(B, 1004), true);
  assert.equal(a.isBanned(B, 1004 + LAN_PROFILE.trustedBanMs), false, `${LAN_PROFILE.trustedBanMs} ms, not ${LAN_PROFILE.banMs}`);
});

test("counts carry numbers only", () => {
  const a = new Admission(LAN_PROFILE);
  a.admit(A, 0);
  const c = a.counts(0);
  assert.doesNotMatch(JSON.stringify(c), /192\.0\.2/);
  assert.equal(c.open, 1);
});

test("there is no internet profile until the separate accept process exists", () => {
  assert.deepEqual(Object.keys(admission).filter((k) => k.endsWith("_PROFILE")), ["LAN_PROFILE"]);
});

test("closed and handshakeDone for an unknown address are harmless", () => {
  const a = new Admission(LAN_PROFILE);
  a.closed(A);
  a.handshakeDone(A, false, 0);
  assert.equal(a.counts(0).open, 0);
});
