import assert from "node:assert/strict";
import { test } from "node:test";
import { Admission, INTERNET_PROFILE, LAN_PROFILE } from "./lan-admission";

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

test("5 failed handshakes within 60 s ban the address: 5 min on a LAN, 15 on the internet", () => {
  for (const [profile, banMs] of [[LAN_PROFILE, 300_000], [INTERNET_PROFILE, 900_000]] as const) {
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

test("at most 64 connections overall", () => {
  const a = new Admission(LAN_PROFILE);
  for (let i = 0; i < 64; i++) {
    const ip = `198.51.100.${i}`;
    assert.equal(a.admit(ip, 0).ok, true);
    a.handshakeDone(ip, true, 0);
  }
  assert.deepEqual(a.admit(B, 1), { ok: false, why: "full" });
  a.closed("198.51.100.0");
  assert.equal(a.admit(B, 2).ok, true);
  assert.equal(a.counts(2).open, 64);
});

test("tracked addresses are bounded; quiet ones are swept to make room", () => {
  const a = new Admission({ ...LAN_PROFILE, maxTracked: 3, maxConnections: 100 });
  for (const ip of ["192.0.2.1", "192.0.2.2", "192.0.2.3"]) {
    assert.equal(a.admit(ip, 0).ok, true);
    a.handshakeDone(ip, true, 0);
  }
  assert.deepEqual(a.admit("192.0.2.4", 10), { ok: false, why: "too many addresses" });
  a.closed("192.0.2.1");
  assert.deepEqual(a.admit("192.0.2.4", 10), { ok: false, why: "too many addresses" }, "still inside its 1 s window");
  assert.equal(a.admit("192.0.2.4", 1500).ok, true, "swept once quiet");
  assert.equal(a.counts(1500).tracked, 3);
});

test("a banned address is never swept before its ban ends", () => {
  const a = new Admission({ ...LAN_PROFILE, maxTracked: 1 });
  for (let i = 0; i < 5; i++) {
    a.admit(A, i);
    a.handshakeDone(A, false, i);
    a.closed(A);
  }
  a.sweep(100_000);
  assert.equal(a.isBanned(A, 100_000), true);
  assert.deepEqual(a.admit(B, 100_000), { ok: false, why: "too many addresses" });
});

test("counts carry numbers only", () => {
  const a = new Admission(LAN_PROFILE);
  a.admit(A, 0);
  const c = a.counts(0);
  assert.doesNotMatch(JSON.stringify(c), /192\.0\.2/);
  assert.equal(c.open, 1);
});

test("closed and handshakeDone for an unknown address are harmless", () => {
  const a = new Admission(LAN_PROFILE);
  a.closed(A);
  a.handshakeDone(A, false, 0);
  assert.equal(a.counts(0).open, 0);
});
