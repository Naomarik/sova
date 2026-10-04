import assert from "node:assert/strict";
import crypto, { X509Certificate } from "node:crypto";
import { test } from "node:test";
import { buildCertDer, fingerprint, isPin, mintLanIdentity, PAIRING_MAX, PAIRING_PREFIX, pairingCode, parsePairingCode, samePin, spkiPin } from "./lan-cert";

test("mintLanIdentity: a self-signed P-256 v3 cert with the fixed generic profile", () => {
  const id = mintLanIdentity();
  const x = new X509Certificate(id.certPem);
  assert.match(x.subject, /^CN=sova-[0-9a-f]{16}$/);
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

test("fingerprint: four groups of upper-case hex from the pin's first 8 bytes", () => {
  const pin = Buffer.alloc(32, 0xab).toString("base64url");
  assert.equal(fingerprint(pin), "ABAB-ABAB-ABAB-ABAB");
  assert.match(fingerprint(mintLanIdentity().pin), /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);
  assert.throws(() => fingerprint("nope"));
});

test("samePin: equal pins only, never a malformed one", () => {
  const { pin } = mintLanIdentity();
  assert.equal(samePin(pin, pin), true);
  assert.equal(samePin(pin, mintLanIdentity().pin), false);
  assert.equal(samePin("x", "x"), false);
});

test("pairing code: round-trips the certificate and its pin", () => {
  const id = mintLanIdentity();
  const code = pairingCode(id.certPem);
  assert.ok(code.startsWith(PAIRING_PREFIX));
  assert.ok(code.length <= PAIRING_MAX, `code is ${code.length} chars`);
  const got = parsePairingCode(`  ${code}\n`);
  assert.ok(got);
  assert.equal(got.pin, id.pin);
  assert.equal(new X509Certificate(got.certPem).fingerprint256, new X509Certificate(id.certPem).fingerprint256);
});

test("pairing code: anything malformed is refused as a whole", () => {
  const id = mintLanIdentity();
  const code = pairingCode(id.certPem);
  const body = code.slice(PAIRING_PREFIX.length);
  const der = Buffer.from(body, "base64url");
  const flipped = Buffer.from(der);
  flipped.writeUInt8(flipped.readUInt8(flipped.length - 5) ^ 0x01, flipped.length - 5); // inside the signature
  const bad: unknown[] = [
    undefined, null, 42, {}, "", PAIRING_PREFIX, body, `sova-lan-2.${body}`,
    `${PAIRING_PREFIX}${body}=`, `${PAIRING_PREFIX}${body}+/`, `${PAIRING_PREFIX}${body.slice(0, -10)}`,
    PAIRING_PREFIX + Buffer.concat([der, Buffer.from([0])]).toString("base64url"), // trailing byte
    PAIRING_PREFIX + flipped.toString("base64url"), // signature no longer verifies
    PAIRING_PREFIX + "A".repeat(PAIRING_MAX), // too long
    PAIRING_PREFIX + Buffer.from(id.certPem).toString("base64url"), // PEM, not DER
  ];
  for (const b of bad) assert.equal(parsePairingCode(b), null, JSON.stringify(b)?.slice(0, 40));
});

test("pairing code: a CA cert, or a key that isn't P-256, is refused", () => {
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const caDer = buildCertDer(kp.publicKey, kp.privateKey, { ca: true });
  assert.equal(new X509Certificate(caDer).ca, true);
  assert.equal(parsePairingCode(PAIRING_PREFIX + caDer.toString("base64url")), null);
  const p384 = crypto.generateKeyPairSync("ec", { namedCurve: "P-384" });
  assert.equal(parsePairingCode(PAIRING_PREFIX + buildCertDer(p384.publicKey, p384.privateKey).toString("base64url")), null);
});

test("pairing code: a cert another key signed is refused (its own signature doesn't verify)", () => {
  const a = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const b = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  assert.equal(parsePairingCode(PAIRING_PREFIX + buildCertDer(a.publicKey, b.privateKey).toString("base64url")), null);
});
