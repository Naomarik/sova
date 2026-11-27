// The range rules of trusted networks (server/networks/ranges.ts, §app.access/networks): which typed ranges may
// be trusted, how they normalize, when the confirmation asks for the range again, and the source check.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cidrContains, normalizeRange, parseCidr, rangeRefusal, RETYPE_ABOVE, needsRetype, sizeNumber, sourceCheck, firstHost } from "./ranges";

describe("which ranges may be trusted", () => {
  test("private, carrier-grade NAT and unique-local ranges are accepted, down to a single address", () => {
    for (const r of ["10.0.0.0/8", "10.224.0.0/22", "172.16.0.0/12", "172.31.255.0/24", "192.168.0.0/16", "192.168.1.0/24", "100.64.0.0/10", "100.101.102.0/24", "fd00::/8", "fd7a:115c:a1e0::/48", "10.8.0.7/32", "10.8.0.7"])
      assert.equal(rangeRefusal(r), null, r);
  });

  test("anything not wholly inside one private range is public and refused outright", () => {
    for (const r of ["0.0.0.0/0", "::/0", "8.8.8.0/24", "1.1.1.1/32", "127.0.0.0/8", "127.0.0.1/32", "169.254.0.0/16", "fe80::/10", "2001:db8::/32", "10.0.0.0/7", "172.0.0.0/8", "172.16.0.0/11", "192.168.0.0/15", "100.0.0.0/8", "100.64.0.0/9", "fc00::/7", "224.0.0.0/4"])
      assert.equal(rangeRefusal(r), "public", r);
  });

  test("text that isn't a range is refused as unparsable", () => {
    for (const r of ["", "10.8.0.0/33", "10.8.0.0/-1", "fd00::/129", "10.8.0", "10.8.0.0/24/1", "wg0", "10.8.0.0 /24", "http://10.8.0.0/24"])
      assert.equal(rangeRefusal(r), "unparsable", JSON.stringify(r));
  });
});

describe("normalizing a range", () => {
  test("host bits are cleared and IPv6 is compressed; a bare address is a single host", () => {
    assert.equal(normalizeRange("10.8.0.7/24"), "10.8.0.0/24");
    assert.equal(normalizeRange(" 192.168.1.200/16 "), "192.168.0.0/16");
    assert.equal(normalizeRange("10.8.0.7"), "10.8.0.7/32");
    assert.equal(normalizeRange("FD7A:115C:A1E0:0000:0000:0000:0000:0001/48"), "fd7a:115c:a1e0::/48");
    assert.equal(normalizeRange("fd00::1"), "fd00::1/128");
    assert.equal(normalizeRange("::ffff:10.8.0.7/24"), "10.8.0.0/24", "a v4-mapped address is its v4");
  });
});

describe("the size the confirmation names", () => {
  test("above 65,536 addresses the range must be typed again; at it, not", () => {
    assert.equal(RETYPE_ABOVE, 65_536);
    assert.equal(sizeNumber(parseCidr("10.8.0.0/24")!), 256);
    assert.equal(needsRetype(parseCidr("10.0.0.0/16")!), false, "65,536 exactly");
    assert.equal(needsRetype(parseCidr("10.0.0.0/15")!), true, "131,072");
    assert.equal(needsRetype(parseCidr("10.8.0.1/32")!), false);
    assert.equal(needsRetype(parseCidr("fd00::/112")!), false);
    assert.equal(needsRetype(parseCidr("fd00::/111")!), true);
    assert.equal(sizeNumber(parseCidr("fd00::/8")!), Number.MAX_SAFE_INTEGER, "a count past what a number holds is capped");
  });

  test("the first host is the address a route probe asks for", () => {
    assert.equal(firstHost(parseCidr("10.224.0.0/22")!), "10.224.0.1");
    assert.equal(firstHost(parseCidr("10.8.0.9/32")!), "10.8.0.9");
    assert.equal(firstHost(parseCidr("fd00::/64")!), "fd00::1");
  });
});

describe("the source check of a trusted listener", () => {
  test("admits exactly the addresses inside its ranges, v4-mapped included, and nothing when it has none", () => {
    const check = sourceCheck(["10.8.0.0/24", "fd00:1::/64"]);
    for (const a of ["10.8.0.1", "10.8.0.255", "::ffff:10.8.0.5", "fd00:1::abcd"]) assert.equal(check.allows(a), true, a);
    for (const a of ["10.8.1.0", "10.7.255.255", "127.0.0.1", "::1", "::ffff:127.0.0.1", "fd00:2::1", "", undefined, "not an ip"]) assert.equal(check.allows(a), false, String(a));
    assert.equal(sourceCheck([]).allows("10.8.0.1"), false);
    assert.equal(sourceCheck(["garbage"]).allows("10.8.0.1"), false);
  });

  test("agrees with cidrContains over every address of a small range and its neighbours", () => {
    const range = parseCidr("192.168.7.16/29")!;
    const check = sourceCheck(["192.168.7.16/29"]);
    for (let last = 0; last < 40; last++) {
      const a = `192.168.7.${last}`;
      assert.equal(check.allows(a), last >= 16 && last < 24, a);
      assert.equal(cidrContains(range, a), last >= 16 && last < 24, a);
    }
  });
});
