// Run: pnpm test -- server/mesh/lan-handoff-protocol.test.ts
// The handoff protocol's strict parsers (§mesh.lan/accept-process): one exact shape per kind, or nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanBuild, HEADER_MAX, headerLine, LineReader, parseFromAcceptor, parseHeader, parseToAcceptor } from "./lan-handoff-protocol";

const PIN = "ABCDEF0123456789ABCDEF0123456789";
const line = (o: unknown) => JSON.stringify(o);

test("a header is exactly one of two shapes", () => {
  assert.deepEqual(parseHeader(line({ v: 1, kind: "control", build: "abc123", pin: PIN })), { kind: "control", build: "abc123", pin: PIN });
  assert.deepEqual(parseHeader(line({ v: 1, kind: "conn", pin: PIN, channel: "ask" })), { kind: "conn", pin: PIN, channel: "ask" });
  // headerLine writes what parseHeader takes, newline included.
  const h = headerLine({ kind: "conn", pin: PIN, channel: "answer" });
  assert.ok(h.endsWith("\n"));
  assert.deepEqual(parseHeader(h.slice(0, -1)), { kind: "conn", pin: PIN, channel: "answer" });
});

test("anything else is refused: extra or missing keys, a bad pin, another version or kind, not JSON", () => {
  const bad: unknown[] = [
    { v: 1, kind: "conn", pin: PIN, channel: "ask", from: "192.0.2.1" }, // an extra key (a source address, say)
    { v: 1, kind: "conn", pin: PIN }, // missing channel
    { v: 1, kind: "conn", pin: PIN.toLowerCase(), channel: "ask" }, // pins travel upper case
    { v: 1, kind: "conn", pin: PIN.slice(1), channel: "ask" },
    { v: 1, kind: "conn", pin: PIN, channel: "both" },
    { v: 2, kind: "conn", pin: PIN, channel: "ask" },
    { v: "1", kind: "conn", pin: PIN, channel: "ask" },
    { v: 1, kind: "data", pin: PIN, channel: "ask" },
    { v: 1, kind: "control", build: "abc", pin: PIN, listen: "0.0.0.0" },
    { v: 1, kind: "control", build: "a b", pin: PIN },
    { v: 1, kind: "control", build: "", pin: PIN },
    { v: 1, kind: "control", build: "x".repeat(65), pin: PIN },
    [1, "conn", PIN, "ask"],
    null,
  ];
  for (const b of bad) assert.equal(parseHeader(line(b)), null, line(b));
  assert.equal(parseHeader("not json"), null);
  assert.equal(parseHeader(""), null);
  // Past the size cap, whatever it says.
  const big = line({ v: 1, kind: "control", build: "a".repeat(64), pin: PIN }) + " ".repeat(HEADER_MAX);
  assert.equal(parseHeader(big), null);
});

test("Sova's messages: a config replaces everything, `stale` means exit; nothing else", () => {
  assert.deepEqual(parseToAcceptor(line({ t: "config", pins: [PIN], listen: { host: "203.0.113.10", port: 4803 } })), { t: "config", pins: [PIN], listen: { host: "203.0.113.10", port: 4803 } });
  assert.deepEqual(parseToAcceptor(line({ t: "config", pins: [], listen: null })), { t: "config", pins: [], listen: null });
  assert.deepEqual(parseToAcceptor(line({ t: "stale" })), { t: "stale" });
  for (const b of [
    { t: "config", pins: [PIN] },
    { t: "config", pins: ["nope"], listen: null },
    { t: "config", pins: [PIN], listen: { host: "203.0.113.10", port: 0 } },
    { t: "config", pins: [PIN], listen: { host: "203.0.113.10", port: 70000 } },
    { t: "config", pins: [PIN], listen: { host: "203.0.113.10", port: 4803, any: true } },
    { t: "stale", now: true },
    { t: "exec" },
  ]) {
    assert.equal(parseToAcceptor(line(b)), null, line(b));
  }
  assert.ok(parseToAcceptor(line({ t: "config", pins: [PIN], listen: { host: "127.0.0.1", port: 0 } }), true), "port 0 only for tests");
});

test("the accept process's beat: its port and counts, nothing else", () => {
  assert.deepEqual(parseFromAcceptor(line({ t: "beat", bound: 4803, counts: { open: 1, banned: 0, bans: 2 } })), { t: "beat", bound: 4803, counts: { open: 1, banned: 0, bans: 2 } });
  assert.deepEqual(parseFromAcceptor(line({ t: "beat", bound: null, counts: { open: 0, banned: 0, bans: 0 } }))?.bound, null);
  for (const b of [
    { t: "beat", bound: 4803 },
    { t: "beat", bound: "4803", counts: { open: 0, banned: 0, bans: 0 } },
    { t: "beat", bound: 4803, counts: { open: -1, banned: 0, bans: 0 } },
    { t: "beat", bound: 4803, counts: { open: 0, banned: 0, bans: 0, ip: "192.0.2.1" } },
    { t: "beat", bound: 4803, counts: { open: 0, banned: 0, bans: 0 }, addr: "192.0.2.1" },
  ]) {
    assert.equal(parseFromAcceptor(line(b)), null, line(b));
  }
});

test("LineReader: lines across chunks, and a line past its cap is the end", () => {
  const r = new LineReader(10);
  assert.deepEqual(r.push(Buffer.from("ab")), []);
  assert.deepEqual(r.push(Buffer.from("c\nde\nf")), ["abc", "de"]);
  assert.deepEqual(r.push(Buffer.from("\n")), ["f"]);
  assert.equal(new LineReader(4).push(Buffer.from("12345")), null, "no newline yet, already too long");
  assert.equal(new LineReader(4).push(Buffer.from("12345\n")), null);
});

test("a build stamp is kept only in its own alphabet", () => {
  assert.equal(cleanBuild("0123abcdef"), "0123abcdef");
  for (const b of [undefined, "", "a b", "x".repeat(65), "$(id)"]) assert.equal(cleanBuild(b), "dev", String(b));
});
