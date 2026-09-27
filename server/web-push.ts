import { createECDH, createPrivateKey, createCipheriv, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";

// Web Push on node:crypto alone (builtins only, no dependency):
// - RFC 8291 message encryption, in the RFC 8188 `aes128gcm` content coding (one record);
// - RFC 8292 VAPID: an ES256 JWT for the push service's origin, plus the server's public key.
// The payload is end-to-end encrypted for one device: the push service sees only ciphertext.

export const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString("base64url");
export const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

/** The server's P-256 key pair, base64url: `publicKey` is the 65-byte uncompressed point (what a
    browser's `applicationServerKey` takes), `privateKey` the 32-byte scalar. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** A browser's PushSubscription, as `toJSON()` gives it. */
export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(padScalar(ecdh.getPrivateKey())) };
}

/** OpenSSL may drop a leading zero byte of the scalar; JWK wants exactly 32. */
const padScalar = (d: Buffer): Buffer => (d.length >= 32 ? d : Buffer.concat([Buffer.alloc(32 - d.length), d]));

/** A pair that is not a P-256 point and its scalar is refused: a hand-edited file never signs garbage. */
export function validVapidKeys(k: unknown): k is VapidKeys {
  if (!k || typeof k !== "object") return false;
  const { publicKey, privateKey } = k as Record<string, unknown>;
  if (typeof publicKey !== "string" || typeof privateKey !== "string") return false;
  try {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(fromB64url(privateKey));
    return ecdh.getPublicKey().equals(fromB64url(publicKey));
  } catch {
    return false;
  }
}

function vapidPrivateKey(keys: VapidKeys): KeyObject {
  const pub = fromB64url(keys.publicKey);
  return createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: keys.privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)) },
    format: "jwk",
  });
}

/** RFC 8292 §2: the JWT's `aud` is the push resource's origin; `exp` at most 24 h ahead (12 h here). */
export function vapidJwt(endpoint: string, subject: string, keys: VapidKeys, now = Date.now()): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  // ES256 = ECDSA P-256 over SHA-256, the signature as r‖s (64 bytes), not DER.
  const sig = sign("sha256", Buffer.from(`${header}.${body}`), { key: vapidPrivateKey(keys), dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${b64url(sig)}`;
}

/** RFC 8292 §3: `Authorization: vapid t=<jwt>, k=<public key>`. */
export const vapidAuthorization = (endpoint: string, subject: string, keys: VapidKeys, now?: number): string =>
  `vapid t=${vapidJwt(endpoint, subject, keys, now)}, k=${keys.publicKey}`;

/** RFC 8188 record size: the whole payload fits one record (a push message is ≤ 4096 bytes). */
const RECORD_SIZE = 4096;
/** The largest plaintext one record carries: 4096 − 16 (tag) − 1 (delimiter) − 86 (header). */
export const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1 - 86;

/** Fixed inputs, for the RFC 8291 Appendix A vector only; real sends take fresh ones. */
export interface EncryptFixture {
  salt: Buffer;
  /** The application server's ephemeral private key (32 bytes). */
  asPrivate: Buffer;
}

/**
 * RFC 8291 §3.4 + RFC 8188 §2: the `aes128gcm` body for one device — header (salt, record size,
 * the ephemeral public key) then one record: AES-128-GCM of plaintext ‖ 0x02 (last-record padding
 * delimiter), with its 16-byte tag.
 */
export function encryptPayload(plaintext: Buffer, target: PushTarget["keys"], fixture?: EncryptFixture): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`push payload is ${plaintext.length} bytes; at most ${MAX_PLAINTEXT} fit`);
  const uaPublic = fromB64url(target.p256dh);
  const authSecret = fromB64url(target.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("p256dh must be a 65-byte uncompressed P-256 point");
  if (authSecret.length !== 16) throw new Error("auth must be 16 bytes");
  const ecdh = createECDH("prime256v1");
  if (fixture) ecdh.setPrivateKey(fixture.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = fixture?.salt ?? randomBytes(16);
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const { cek, nonce } = deriveKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, record]);
}

/** RFC 8291 §3.3–3.4 and RFC 8188 §2.2–2.3: IKM from the ECDH secret and auth secret, then CEK and NONCE from the salt. */
export function deriveKeys(ecdhSecret: Buffer, authSecret: Buffer, uaPublic: Buffer, asPublic: Buffer, salt: Buffer): { ikm: Buffer; cek: Buffer; nonce: Buffer } {
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  return { ikm, cek, nonce };
}

/** One delivery: delivered, gone (404/410: the subscription is dead, drop it), or failed. */
export type PushOutcome = { status: "ok"; code: number } | { status: "gone"; code: number } | { status: "error"; code?: number; message: string };

export interface SendOptions {
  keys: VapidKeys;
  /** The VAPID `sub`: a `mailto:` or `https:` contact for whoever runs this server. */
  subject: string;
  /** Seconds the push service keeps an undelivered message. */
  ttl: number;
  urgency?: "very-low" | "low" | "normal" | "high";
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function sendPush(target: PushTarget, payload: Buffer | string, opts: SendOptions): Promise<PushOutcome> {
  let body: Buffer;
  let authorization: string;
  try {
    body = encryptPayload(Buffer.isBuffer(payload) ? payload : Buffer.from(payload), target.keys);
    authorization = vapidAuthorization(target.endpoint, opts.subject, opts.keys);
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(opts.ttl),
        Urgency: opts.urgency ?? "high",
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
    if (res.status >= 200 && res.status < 300) return { status: "ok", code: res.status };
    if (res.status === 404 || res.status === 410) return { status: "gone", code: res.status };
    const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 160);
    return { status: "error", code: res.status, message: `${res.status}${res.statusText ? ` ${res.statusText}` : ""}${text ? `: ${text}` : ""}` };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
