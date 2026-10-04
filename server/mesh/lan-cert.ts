// A host's TLS identity for dial-out pairings (§mesh.lan/identity): one ECDSA P-256 key and a
// self-signed X.509 v3 certificate built here in DER (Node and Bun parse certificates but can't mint
// them, and Sova adds no dependency). The certificate only carries the key: the TLS handshake's
// CertificateVerify proves possession, and the SPKI pin decides trust (§mesh.lan/handshake). No
// library ever verifies the certificate itself.
//
// Builtins only. Nothing here logs; callers must never log a key.

import crypto, { type KeyObject, X509Certificate } from "node:crypto";

export interface LanIdentity {
  /** PKCS#8 PEM. Secret: never logged, synced or shown. */
  keyPem: string;
  certPem: string;
  /** The certificate key's pin (see spkiPin). */
  pin: string;
}

// ─── Minimal DER ────────────────────────────────────────────────────────────────────────────────

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...p: Buffer[]) => tlv(0x30, ...p);
const set = (...p: Buffer[]) => tlv(0x31, ...p);

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const out = [40 * first + second];
  for (const arc of rest) {
    const b = [arc & 0x7f];
    for (let x = arc >> 7; x > 0; x >>= 7) b.unshift(0x80 | (x & 0x7f));
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}

const ECDSA_WITH_SHA256 = seq(oid("1.2.840.10045.4.3.2"));
const name = (cn: string) => seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn)))));
// Each identity has its own random subject (= issuer). With one shared subject, both TLS stacks
// look a pinned cert up by name and find only the first of several a relay pins. Random hex only:
// nothing in it names Sova to a scanner reading the certificate.
const randomCn = () => crypto.randomBytes(8).toString("hex");
// notBefore 2000-01-01 (UTCTime), notAfter 9999-12-31 (GeneralizedTime, RFC 5280's "no expiry").
const VALIDITY = seq(tlv(0x17, Buffer.from("000101000000Z")), tlv(0x18, Buffer.from("99991231235959Z")));
// One critical extension: basicConstraints CA:FALSE (an empty SEQUENCE; DER omits the default).
// The strictest profile both runtimes accept as a pinned anchor: Bun refuses a pinned self-signed
// cert that also has keyUsage without keyCertSign.
const basicConstraints = (ca: boolean) => tlv(0xa3, seq(seq(oid("2.5.29.19"), tlv(0x01, Buffer.from([0xff])), tlv(0x04, ca ? seq(tlv(0x01, Buffer.from([0xff]))) : seq()))));
const VERSION_3 = tlv(0xa0, tlv(0x02, Buffer.from([2])));

function serial(): Buffer {
  const s = crypto.randomBytes(16);
  s[0] = ((s[0] ?? 0) & 0x7f) | 0x01; // positive, no leading zero byte needed, never zero
  return tlv(0x02, s);
}

export function pem(der: Buffer): string {
  const b64 = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${b64.join("\n")}\n-----END CERTIFICATE-----\n`;
}

/**
 * The DER certificate for `publicKey`, signed by `signer` (its own private key for a real
 * identity), self-issued under a fresh random name. `ca`, `subjectCn` and `issuerCn` exist for tests
 * (a CA cert to refuse, a child cert for the chain trick); Sova's identities never set them.
 */
export function buildCertDer(publicKey: KeyObject, signer: KeyObject, test: { ca?: boolean; subjectCn?: string; issuerCn?: string } = {}): Buffer {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const subject = test.subjectCn ?? randomCn();
  const issuer = test.issuerCn ?? subject;
  const tbs = seq(VERSION_3, serial(), ECDSA_WITH_SHA256, name(issuer), VALIDITY, name(subject), spki, basicConstraints(test.ca === true));
  const sig = crypto.sign("sha256", tbs, { key: signer, dsaEncoding: "der" });
  return seq(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.from([0]), sig));
}

/** A fresh identity: a new P-256 key and its self-signed certificate. */
export function mintLanIdentity(): LanIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = buildCertDer(publicKey, privateKey);
  return { keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), certPem: pem(der), pin: spkiPin(publicKey) };
}

// ─── Pins and fingerprints ──────────────────────────────────────────────────────────────────────
// A pin is the first 128 bits of SHA-256(SubjectPublicKeyInfo), as 32 upper-case hex digits: short
// enough to read out or paste, and far past what a second-preimage search could match (64 bits
// would be within reach of a large GPU budget). People see it as 8 groups of 4 (`fingerprint`).

const PIN_RE = /^[0-9A-F]{32}$/;

/** The pin of a key or certificate. */
export function spkiPin(of: KeyObject | X509Certificate): string {
  const key = of instanceof X509Certificate ? of.publicKey : of.type === "private" ? crypto.createPublicKey(of) : of;
  return crypto.createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest().subarray(0, 16).toString("hex").toUpperCase();
}

export const isPin = (s: unknown): s is string => typeof s === "string" && PIN_RE.test(s);

/** A pin as people type or paste it (any case, spaces or dashes between digits), or null. */
export function parsePin(input: unknown): string | null {
  if (typeof input !== "string" || input.length > 80) return null;
  const hex = input.replace(/[\s-]/g, "").toUpperCase();
  return PIN_RE.test(hex) ? hex : null;
}

/** `ABCD-EF01-…` (8 groups of 4), the form pages show and people compare. */
export function fingerprint(pin: string): string {
  if (!isPin(pin)) throw new Error("not a pin");
  return pin.match(/.{4}/g)!.join("-");
}

/** Constant-time pin equality (pins aren't secret; this just never short-circuits). */
export function samePin(a: string, b: string): boolean {
  if (!isPin(a) || !isPin(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The node id a dial-out pairing goes by in peers.json and the grants file: `lan:<pin, lower case>`. */
export const LAN_NODE_PREFIX = "lan:";
export const lanNodeId = (pin: string): string => `${LAN_NODE_PREFIX}${pin.toLowerCase()}`;
export const isLanNodeId = (nodeId: string): boolean => nodeId.toLowerCase().startsWith(LAN_NODE_PREFIX);
