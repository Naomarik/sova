// Run: pnpm test -- server/mesh/lan-tls.test.ts
// The dial-out side's rules that need no handshake (§mesh.lan/handshake, §mesh.lan/pairing): where a
// relay may be dialed (an injected resolver), the fixed failure phrases, and pins from certificates.
// The pinning itself, over real handshakes: lan-tls.integration.test.ts.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { mintLanIdentity, spkiPin } from "./lan-cert";
import { connectPinned, dialFailure, relayTarget } from "./lan-tls";

const mac = mintLanIdentity();
const relayId = mintLanIdentity();

test("dial failures are fixed phrases: never raw error text, an address or a code", () => {
  for (const [err, want] of [
    [{ code: "ECONNREFUSED" }, "refused"],
    [{ message: "pin mismatch" }, "relay's pin didn't match"],
    [{ code: "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION" }, "TLS version refused"],
    [{ code: "ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED" }, "rejected by the relay"],
    [{ message: "secret-ish details 192.0.2.1" }, "closed"],
    [null, "closed"],
  ] as const) assert.equal(dialFailure(err), want, JSON.stringify(err));
});

test("a dial-out host never dials a public relay address, nor a name that resolves only to one", async () => {
  const names: Record<string, string[]> = { "lan.example": ["198.51.100.4", "10.0.0.4"], "public.example": ["198.51.100.4", "2001:db8::4"], "v6.example": ["fd00::4"] };
  const lookup = async (h: string) => {
    if (!names[h]) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    return names[h]!.map((address) => ({ address }));
  };
  assert.equal(await relayTarget("10.0.0.4", lookup), "10.0.0.4");
  assert.equal(await relayTarget("::ffff:10.0.0.4", lookup), "10.0.0.4");
  assert.equal(await relayTarget("lan.example", lookup), "10.0.0.4", "a name's first local-network address");
  assert.equal(await relayTarget("v6.example", lookup), "fd00::4");
  for (const h of ["198.51.100.4", "2001:db8::4", "0.0.0.0", "0::", "public.example"]) assert.equal(await relayTarget(h, lookup), null, h);
  await assert.rejects(relayTarget("missing.example", lookup), /^Error: closed$/, "a fixed phrase, never the resolver's text");
  // And connectPinned refuses before any socket: nothing listens at that documentation address.
  await assert.rejects(connectPinned(mac, relayId.pin, "192.0.2.1", 9, "answer", 300), /^Error: relay address isn't private$/);
});

test("a pairing marked as on the internet may dial a public relay, or a name's first unicast answer; never every interface or a group address", async () => {
  const names: Record<string, string[]> = { "vps.example": ["0.0.0.0", "224.0.0.9", "203.0.113.10", "10.0.0.4"], "groups.example": ["255.255.255.255", "ff02::1"] };
  const lookup = async (h: string) => {
    if (!names[h]) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    return names[h]!.map((address) => ({ address }));
  };
  for (const h of ["203.0.113.10", "2001:db8::4", "100.64.0.9", "10.0.0.4"]) assert.equal(await relayTarget(h, lookup, true), h, h);
  assert.equal(await relayTarget("::ffff:203.0.113.10", lookup, true), "203.0.113.10");
  assert.equal(await relayTarget("vps.example", lookup, true), "203.0.113.10", "skips every-interface and multicast answers");
  for (const h of ["0.0.0.0", "::", "224.0.0.1", "255.255.255.255", "ff02::1", "groups.example"]) assert.equal(await relayTarget(h, lookup, true), null, h);
  // Without the mark the very same names and addresses keep the local-network rule.
  assert.equal(await relayTarget("vps.example", lookup), "10.0.0.4");
  assert.equal(await relayTarget("203.0.113.10", lookup), null);
});

test("pins come from the certificate's key", () => {
  assert.ok(spkiPin(new crypto.X509Certificate(mac.certPem)) === mac.pin);
});
