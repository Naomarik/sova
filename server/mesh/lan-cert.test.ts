import assert from "node:assert/strict";
import crypto, { X509Certificate } from "node:crypto";
import { test } from "node:test";
import { fingerprint, isLanNodeId, isPin, lanNodeId, mintLanIdentity, parsePin, samePin, spkiPin } from "./lan-cert";

test("mintLanIdentity: a self-signed P-256 v3 cert with the fixed generic profile", () => {
  const id = mintLanIdentity();
  const x = new X509Certificate(id.certPem);
  assert.match(x.subject, /^CN=[0-9a-f]{16}$/, "random, and naming nothing");
  assert.equal(x.issuer, x.subject);
  assert.notEqual(new X509Certificate(mintLanIdentity().certPem).subject, x.subject, "each identity has its own name");
  assert.equal(x.ca, false);
  assert.ok(x.verify(x.publicKey), "self-signature verifies");
  assert.equal(x.publicKey.asymmetricKeyDetails?.namedCurve, "prime256v1");
  assert.match(x.validFrom, /^Jan  1 00:00:00 2000 GMT$/);
  assert.match(x.validTo, /^Dec 31 23:59:59 9999 GMT$/);
  assert.ok(isPin(id.pin));
  assert.equal(id.pin, spkiPin(x));
  assert.equal(id.pin, spkiPin(crypto.createPrivateKey(id.keyPem)));
  // Nothing in the certificate names the host.
  assert.doesNotMatch(x.toString(), /subjectAltName|DNS:|IP Address/);
});

test("mintLanIdentity: serials are random and positive", () => {
  const serials = new Set(Array.from({ length: 20 }, () => new X509Certificate(mintLanIdentity().certPem).serialNumber));
  assert.equal(serials.size, 20);
  for (const s of serials) assert.ok(parseInt(s.charAt(0), 16) < 8, "high bit clear");
});

test("a pin is the first 128 bits of SHA-256(SPKI), as 32 upper-case hex digits", () => {
  const id = mintLanIdentity();
  const spki = new X509Certificate(id.certPem).publicKey.export({ type: "spki", format: "der" });
  assert.ok(id.pin === crypto.createHash("sha256").update(spki).digest().subarray(0, 16).toString("hex").toUpperCase());
  assert.ok(isPin(id.pin));
  assert.equal(isPin(id.pin.toLowerCase()), false);
});

test("fingerprint: 8 groups of 4, and parsePin takes it back however it is pasted", () => {
  const pin = "ABCDEF0123456789ABCDEF0123456789";
  assert.equal(fingerprint(pin), "ABCD-EF01-2345-6789-ABCD-EF01-2345-6789");
  for (const typed of [pin, pin.toLowerCase(), fingerprint(pin), ` ${fingerprint(pin).toLowerCase()} `, "abcd ef01 2345 6789 abcd ef01 2345 6789"]) {
    assert.ok(parsePin(typed) === pin, typed);
  }
  for (const bad of [undefined, 42, "", "ABCD", `${pin}0`, pin.replace("A", "G"), "x".repeat(200), "ABCD-EF01-2345-6789"]) {
    assert.equal(parsePin(bad), null, String(bad).slice(0, 20));
  }
  assert.throws(() => fingerprint("nope"));
});

test("samePin: equal pins only, never a malformed one", () => {
  const { pin } = mintLanIdentity();
  assert.equal(samePin(pin, pin), true);
  assert.equal(samePin(pin, mintLanIdentity().pin), false);
  assert.equal(samePin("x", "x"), false);
});

test("a dial-out pairing's node id is lan:<pin>, and is recognized in any case", () => {
  const pin = "ABCDEF0123456789ABCDEF0123456789";
  assert.equal(lanNodeId(pin), "lan:abcdef0123456789abcdef0123456789");
  assert.equal(isLanNodeId(lanNodeId(pin)), true);
  assert.equal(isLanNodeId("LAN:x"), true);
  assert.equal(isLanNodeId("nABC123CNTRL"), false);
});
