// Run: node scripts/run-tests.mjs server/share-contract.test.ts. The share protocol's ratchet
// (§mesh.public/share-protocol): a fingerprint of everything a gateway and a routed host must agree
// on, checked against the value recorded for SHARE_PROTOCOL. A throwaway PI_CODING_AGENT_DIR; ~/.pi
// untouched.
//
// When this fails, the share contract changed. Decide which it is:
// - a change an older gateway or host can't follow: raise SHARE_PROTOCOL in shared/public-links.ts
//   and record the new fingerprint under the new number;
// - a compatible one: record the new fingerprint under the same number, with the reason.
// Never record a fingerprint without one of those two.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-share-contract-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
mkdirSync(join(root, "agent", "sessions"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const pub = await import("../shared/public-links");
const { SNAPSHOT_KEYS, LINK_KEYS } = await import("./share/registry-validation");
const { ACK_ERROR_KEYS, ACK_OK_KEYS, INFO_KEYS, INFO_QUERY } = await import("./share/gateway-client");
const { DROPPED_RESPONSE, SHARE_RESPONSE_HEADERS, UNKNOWN_LINK, redirectPasses, ASSET_CSP } = await import("./share/router");
const { FORWARD_BODY_MAX, FORWARD_METHODS, FORWARD_SHAPE, FORWARD_SOCKET, FORWARD_TIMEOUT_MS, SHARE_WS_MAX_PAYLOAD } = await import("./share/edge");
const { ORIGIN_CLOSES, WS_HOP_UPSTREAM_MAX_PAYLOAD, WS_HOPS_PER_KEY } = await import("./share/ws-hop");
const { OFFLINE_BODY } = await import("./share/offline");
const { TOKEN_RE } = await import("./baton-links");

/** Every share protocol number, with each fingerprint recorded under it and why it is compatible
    with the number's first one (the first needs no reason). */
const RECORDED: Record<number, { fingerprint: string; compatible?: string }[]> = {
  2: [{ fingerprint: "ec25563b5d6c25f2" }],
};

/** The share contract, canonical: only what both sides read (§mesh.public/share-protocol). */
function contract(): unknown {
  return {
    registry: {
      snapshotKeys: [...SNAPSHOT_KEYS].sort(),
      linkKeys: [...LINK_KEYS].sort(),
      kinds: [...pub.REGISTRY_LINK_KINDS],
      limits: { ...pub.REGISTRY_LIMITS, hash: pub.REGISTRY_LIMITS.hash.source, asset: pub.REGISTRY_LIMITS.asset.source },
      snapshotMaxBytes: pub.SNAPSHOT_MAX_BYTES,
      ackOk: [...ACK_OK_KEYS],
      ackError: [...ACK_ERROR_KEYS],
      info: [...INFO_KEYS],
      infoQuery: INFO_QUERY,
    },
    hop: {
      set: [...pub.INGRESS_SET_HEADERS],
      strip: [...pub.INGRESS_STRIP_HEADERS],
      previewHeader: pub.PREVIEW_HEADER,
      previewLabel: pub.PREVIEW_LABEL_RE.source,
    },
    passBack: {
      dropped: DROPPED_RESPONSE.source,
      stamped: SHARE_RESPONSE_HEADERS,
      assetCsp: ASSET_CSP,
      redirect: redirectPasses.toString(),
      assetTypes: pub.ASSET_TYPES,
      assetNameTypes: pub.ASSET_NAME_TYPES,
      assetMaxBytes: pub.ASSET_MAX_BYTES,
    },
    sockets: {
      shape: FORWARD_SOCKET.source,
      originCloses: [...ORIGIN_CLOSES].sort((a, b) => a - b),
      pageMaxPayload: SHARE_WS_MAX_PAYLOAD,
      hostMaxPayload: WS_HOP_UPSTREAM_MAX_PAYLOAD,
      perLink: WS_HOPS_PER_KEY,
    },
    offline: { body: OFFLINE_BODY, hopLost: pub.HOP_LOST_CLOSE, backoff: pub.RECONNECT_BACKOFF_MS, retryAfter: pub.OFFLINE_RETRY_AFTER_S },
    routes: {
      forwardShape: FORWARD_SHAPE.source,
      forwardMethods: [...FORWARD_METHODS],
      forwardBodyMax: FORWARD_BODY_MAX,
      forwardTimeoutMs: FORWARD_TIMEOUT_MS,
      unknownLink: UNKNOWN_LINK,
      token: TOKEN_RE.source,
    },
  };
}

const fingerprint = (): string => createHash("sha256").update(JSON.stringify(contract())).digest("hex").slice(0, 16);

test("the share contract's fingerprint is recorded under SHARE_PROTOCOL", () => {
  const now = fingerprint();
  const recorded = RECORDED[pub.SHARE_PROTOCOL] ?? [];
  assert.ok(
    recorded.some((r) => r.fingerprint === now),
    `The share contract changed (fingerprint ${now}, SHARE_PROTOCOL ${pub.SHARE_PROTOCOL}). Raise SHARE_PROTOCOL for a change an older side can't follow, or record ${now} under ${pub.SHARE_PROTOCOL} with why it is compatible (see this file's header).`,
  );
  recorded.slice(1).forEach((r) => assert.ok(r.compatible && r.compatible.length > 10, `${r.fingerprint} under ${pub.SHARE_PROTOCOL} needs its reason`));
});

test("SHARE_PROTOCOL is the highest number recorded and a small whole number", () => {
  const numbers = Object.keys(RECORDED).map(Number);
  assert.equal(pub.SHARE_PROTOCOL, Math.max(...numbers));
  assert.ok(Number.isSafeInteger(pub.SHARE_PROTOCOL) && pub.SHARE_PROTOCOL >= 2);
});

test("the fingerprint moves with the contract (it can tell a changed contract from an unchanged one)", () => {
  const before = fingerprint();
  const strip = pub.INGRESS_STRIP_HEADERS as unknown as string[];
  strip.push("x-test-added");
  try {
    assert.notEqual(fingerprint(), before);
  } finally {
    strip.pop();
  }
  assert.equal(fingerprint(), before);
});
