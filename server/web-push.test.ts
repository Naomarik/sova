// Run: npx tsx --test server/web-push.test.ts
// Pure crypto and a stubbed fetch: no network, no state dir.
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, verify } from "node:crypto";
import { test } from "node:test";
import { b64url, deriveKeys, encryptPayload, fromB64url, generateVapidKeys, sendPush, validVapidKeys, vapidAuthorization, vapidJwt } from "./web-push";

// RFC 8291 Appendix A, every value as the RFC prints it (base64url).
const A = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  ecdhSecret: "kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs",
  ikm: "S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg",
  cek: "oIhVW04MRdy2XN9CiKLxTg",
  nonce: "4h_95klXJ5E_qnoN",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

test("RFC 8291 Appendix A: the intermediate keys, byte for byte", () => {
  const as = createECDH("prime256v1");
  as.setPrivateKey(fromB64url(A.asPrivate));
  assert.equal(b64url(as.getPublicKey()), A.asPublic);
  const secret = as.computeSecret(fromB64url(A.uaPublic));
  assert.equal(b64url(secret), A.ecdhSecret);
  const k = deriveKeys(secret, fromB64url(A.auth), fromB64url(A.uaPublic), as.getPublicKey(), fromB64url(A.salt));
  assert.equal(b64url(k.ikm), A.ikm);
  assert.equal(b64url(k.cek), A.cek);
  assert.equal(b64url(k.nonce), A.nonce);
});

test("RFC 8291 Appendix A: the whole aes128gcm body, byte for byte", () => {
  const body = encryptPayload(fromB64url(A.plaintext), { p256dh: A.uaPublic, auth: A.auth }, { salt: fromB64url(A.salt), asPrivate: fromB64url(A.asPrivate) });
  assert.equal(b64url(body), A.body);
});

/** The user agent's side: what a browser does with a body, from its own private key. */
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ua = createECDH("prime256v1");
  ua.setPrivateKey(uaPrivate);
  const { cek, nonce } = deriveKeys(ua.computeSecret(asPublic), auth, ua.getPublicKey(), asPublic, salt);
  const record = body.subarray(21 + idlen);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 0x02, "last-record delimiter");
  return plain.subarray(0, -1).toString("utf8");
}

test("a fresh encryption round-trips for the device, with a new salt and key each time", () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const auth = Buffer.alloc(16, 7);
  const keys = { p256dh: b64url(ua.getPublicKey()), auth: b64url(auth) };
  const a = encryptPayload(Buffer.from('{"title":"Needs input · x"}'), keys);
  const b = encryptPayload(Buffer.from('{"title":"Needs input · x"}'), keys);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16));
  assert.equal(decrypt(a, ua.getPrivateKey(), auth), '{"title":"Needs input · x"}');
  assert.equal(decrypt(b, ua.getPrivateKey(), auth), '{"title":"Needs input · x"}');
  assert.throws(() => encryptPayload(Buffer.alloc(5000), keys), /at most/);
  assert.throws(() => encryptPayload(Buffer.from("x"), { p256dh: b64url(Buffer.alloc(65)), auth: b64url(auth) }));
});

test("VAPID: an ES256 JWT for the endpoint's origin that verifies with the public key", () => {
  const keys = generateVapidKeys();
  assert.ok(validVapidKeys(keys));
  assert.equal(fromB64url(keys.publicKey).length, 65);
  const now = Date.UTC(2026, 0, 1);
  const jwt = vapidJwt("https://push.example.test/send/abc?x=1", "mailto:ops@example.test", keys, now);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(fromB64url(h!).toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(fromB64url(p!).toString());
  assert.equal(claims.aud, "https://push.example.test");
  assert.equal(claims.sub, "mailto:ops@example.test");
  assert.ok(claims.exp > now / 1000 && claims.exp <= now / 1000 + 24 * 3600);
  const pub = fromB64url(keys.publicKey);
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) }, format: "jwk" });
  const sig = fromB64url(s!);
  assert.equal(sig.length, 64);
  assert.ok(verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, sig));
  // Another key does not verify it: the check can fail.
  const other = fromB64url(generateVapidKeys().publicKey);
  const otherKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64url(other.subarray(1, 33)), y: b64url(other.subarray(33)) }, format: "jwk" });
  assert.equal(verify("sha256", Buffer.from(`${h}.${p}`), { key: otherKey, dsaEncoding: "ieee-p1363" }, sig), false);
  assert.match(vapidAuthorization("https://push.example.test/x", "mailto:ops@example.test", keys), new RegExp(`^vapid t=[^,]+, k=${keys.publicKey}$`));
});

test("validVapidKeys refuses a pair whose halves don't belong together", () => {
  const a = generateVapidKeys();
  const b = generateVapidKeys();
  assert.equal(validVapidKeys({ publicKey: a.publicKey, privateKey: b.privateKey }), false);
  assert.equal(validVapidKeys({ publicKey: a.publicKey }), false);
  assert.equal(validVapidKeys(null), false);
});

test("sendPush: headers, and 201 ok / 404 and 410 gone / other codes an error", async () => {
  const ua = createECDH("prime256v1");
  ua.generateKeys();
  const target = { endpoint: "https://push.example.test/send/1", keys: { p256dh: b64url(ua.getPublicKey()), auth: b64url(Buffer.alloc(16, 1)) } };
  const keys = generateVapidKeys();
  const seen: { url: string; init: RequestInit }[] = [];
  const answer = (status: number, text = "") => (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init! });
    return new Response(text || null, { status });
  }) as typeof fetch;
  const opts = (status: number, text?: string) => ({ keys, subject: "mailto:ops@example.test", ttl: 60, fetchImpl: answer(status, text) });
  assert.deepEqual(await sendPush(target, "hi", opts(201)), { status: "ok", code: 201 });
  const h = seen[0]!.init.headers as Record<string, string>;
  assert.equal(seen[0]!.url, target.endpoint);
  assert.equal(h["Content-Encoding"], "aes128gcm");
  assert.equal(h.TTL, "60");
  assert.equal(h.Urgency, "high");
  assert.match(h.Authorization!, /^vapid t=/);
  assert.equal(decrypt(Buffer.from(seen[0]!.init.body as Uint8Array), ua.getPrivateKey(), Buffer.alloc(16, 1)), "hi");
  assert.deepEqual(await sendPush(target, "hi", opts(404)), { status: "gone", code: 404 });
  assert.deepEqual(await sendPush(target, "hi", opts(410)), { status: "gone", code: 410 });
  const e = await sendPush(target, "hi", opts(403, '{"reason":"BadJwtToken"}'));
  assert.equal(e.status, "error");
  assert.match((e as { message: string }).message, /^403.*BadJwtToken/);
  const thrown = await sendPush(target, "hi", { keys, subject: "mailto:a@b.test", ttl: 1, fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch });
  assert.deepEqual(thrown, { status: "error", message: "offline" });
});
