import { isIP } from "node:net";
import { REGISTRY_LIMITS, REGISTRY_LINK_KINDS, type GatewayInfo, type RegistryLinkKind, type PublicLinksFile, type RegistryAck, type RegistrySnapshot } from "../../shared/public-links";
import { meshApi } from "../mesh";
import { entryAddresses, tailnetIp } from "../mesh/address-identity";
import type { GatewayIdentity } from "../mesh/gate";
import { getIdentity } from "../mesh/localapi";
import { type PeerEntry, peerUrl } from "../mesh/peers";
import { parsePublicUrl, readPublicLinks, recordLastKnownUrl } from "../public-links";

/**
 * A routed host's view of its `via` gateway (§mesh.public/setting, §mesh.public/gateway): its
 * public URL, whether it answers, and whether it accepts this host's links (GatewayInfo.accepting).
 * shareState() reads it for the effective address and the `unreachable` / `not-accepted`
 * warnings; the ingress reads the gateway's identity for its gate; the registry push sends
 * snapshots through it.
 *
 * The gateway is the peers.json entry with the setting's StableID, and every call goes to an
 * address bound to that StableID, never to the entry's name as DNS resolves it: with LocalAPI, a
 * tailnet IP Tailscale itself lists for that node (WireGuard delivers it only to that node); in
 * address-identity mode, the entry's pinned tailnet IP (§mesh.peers/address-identity, its
 * documented limit). No such address: the gateway is unreachable, and nothing is sent. A call is
 * bound to its target: the route generation (bumped by every setting change the share runtime
 * hears, and every change of the selected entry it notices) and the entry itself (StableID, name,
 * URL: its port and, in address mode, its pinned address). The target is checked again after the
 * address is resolved and right before the request goes out, and again before anything is learnt
 * from the answer: a target withdrawn or changed meanwhile gets nothing, and teaches nothing.
 *
 * Every answer is parsed strictly. A reply that doesn't parse changes nothing and confirms nothing.
 * The hello's advertised URL is a discovery hint: it may fill in the address before the gateway's
 * own info or ack has given one, and it never makes the gateway reachable or accepting.
 */

export interface ViaGatewayStatus {
  publicUrl: string | null;
  /** The peer's label, for {gateway} in the warnings. */
  label: string;
  reachable: boolean;
  /** null: not asked yet. */
  accepting: boolean | null;
  /** The link kinds the CURRENT target said it routes (GatewayInfo.kinds), from its own info
      since it became the target (targetKinds); null until then. An older gateway never lists
      them: it gets no `s` row. */
  kinds: RegistryLinkKind[] | null;
}

const CALL_TIMEOUT_MS = 10_000;

/** A reply as the transport got it: the HTTP status and the parsed JSON body (undefined: not JSON). */
export interface GatewayReply {
  status: number;
  body: unknown;
}

export interface GatewayDeps {
  /** The Public links setting: M1's strict reader (an invalid file reads as off). */
  readSetting: () => PublicLinksFile | null;
  peers: () => PeerEntry[];
  /** SOVA_MESH_IDENTITY=addresses: the gate pins the gateway's addresses, and so does the dial. */
  addressMode: () => boolean;
  /** The base URL bound to the peer's StableID (see above), or null: nothing is sent. */
  endpoint: (peer: PeerEntry) => Promise<string | null>;
  /** One HTTP call to `url`; null when nothing answered. */
  call: (url: string, init?: RequestInit) => Promise<GatewayReply | null>;
  /** Keep the gateway's URL as learnt (M1 writes the file). */
  recordUrl: (url: string) => void;
}

/** A tailnet IP Tailscale lists for this StableID (LocalAPI), or the entry's pinned one (address
    mode), with the peer listener's port and scheme from the entry. */
async function verifiedEndpoint(peer: PeerEntry): Promise<string | null> {
  let ips: string[];
  if (deps.addressMode()) ips = entryAddresses(peer);
  else {
    try {
      const nodes = (await getIdentity().status()).peers.filter((n) => n.nodeId === peer.nodeId);
      // Exactly one node record with that StableID; none or several: no address to trust.
      ips = nodes.length === 1 ? nodes[0]!.addresses.map((a) => tailnetIp(a)).filter((a): a is string => !!a) : [];
    } catch {
      return null;
    }
  }
  const ip = ips.find((a) => isIP(a) === 4) ?? ips[0];
  if (!ip) return null;
  let base: URL;
  try {
    base = new URL(peerUrl(peer));
  } catch {
    return null;
  }
  return `${base.protocol}//${ip.includes(":") ? `[${ip}]` : ip}${base.port ? `:${base.port}` : ""}`;
}

async function httpCall(url: string, init?: RequestInit): Promise<GatewayReply | null> {
  try {
    // redirect: "error": a gateway's answer never sends this host's snapshot anywhere else.
    const res = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

const defaults: GatewayDeps = {
  readSetting: readPublicLinks,
  peers: () => meshApi.config()?.peers ?? [],
  addressMode: () => process.env.SOVA_MESH_IDENTITY === "addresses",
  endpoint: verifiedEndpoint,
  call: httpCall,
  recordUrl: (url) => {
    recordLastKnownUrl(url);
  },
};

let deps: GatewayDeps = defaults;

/** Tests: replace some dependencies; returns the undo. */
export function setGatewayDeps(partial: Partial<GatewayDeps>): () => void {
  const before = deps;
  deps = { ...deps, ...partial };
  return () => {
    deps = before;
  };
}

// ---- strict reply parsing -----------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((k) => allowed.includes(k));
const seqOk = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A public URL as a gateway may state it: a bare https origin (M1's rule), else null. */
export function publicOrigin(v: unknown): string | null {
  try {
    return parsePublicUrl(v);
  } catch {
    return null;
  }
}

/** A registry push's reply, or null when it isn't one: an ok ack only with HTTP 200, a known
    failure only with a 2xx/4xx status, and nothing but the contract's fields. */
export function parseAck(reply: GatewayReply | null): RegistryAck | null {
  if (!reply || !isObj(reply.body)) return null;
  const b = reply.body;
  if (b.ok === true) {
    if (reply.status !== 200 || !onlyKeys(b, ["ok", "seq", "publicUrl", "collisions"]) || !seqOk(b.seq)) return null;
    const publicUrl = publicOrigin(b.publicUrl);
    if (!publicUrl) return null;
    if (b.collisions === undefined) return { ok: true, seq: b.seq, publicUrl };
    const c = b.collisions;
    if (!Array.isArray(c) || c.length > REGISTRY_LIMITS.maxLinks || !c.every((h) => typeof h === "string" && REGISTRY_LIMITS.hash.test(h))) return null;
    return { ok: true, seq: b.seq, publicUrl, collisions: [...c] as string[] };
  }
  if (b.ok === false) {
    if (reply.status >= 500 || !onlyKeys(b, ["ok", "error"])) return null;
    if (b.error === "not-gateway" || b.error === "not-accepted" || b.error === "bad-snapshot") return { ok: false, error: b.error };
  }
  return null;
}

/** GET info's reply: the gateway's answer, "not-gateway" (404 {error:"not-gateway"}), or null. */
export function parseInfo(reply: GatewayReply | null): GatewayInfo | "not-gateway" | null {
  if (!reply || !isObj(reply.body)) return null;
  const b = reply.body;
  if (reply.status === 404) return onlyKeys(b, ["error"]) && b.error === "not-gateway" ? "not-gateway" : null;
  if (reply.status !== 200 || !onlyKeys(b, ["publicUrl", "accepting", "seq", "kinds"]) || typeof b.accepting !== "boolean") return null;
  if (b.seq !== null && !seqOk(b.seq)) return null;
  // `kinds` is optional (an older gateway omits it); a kind this build doesn't know is dropped.
  if (b.kinds !== undefined && !(Array.isArray(b.kinds) && b.kinds.length <= 16 && b.kinds.every((k) => typeof k === "string" && k.length <= 16))) return null;
  const publicUrl = publicOrigin(b.publicUrl);
  if (!publicUrl) return null;
  const info: GatewayInfo = { publicUrl, accepting: b.accepting, seq: b.seq as number | null };
  if (Array.isArray(b.kinds)) info.kinds = REGISTRY_LINK_KINDS.filter((k) => (b.kinds as string[]).includes(k));
  return info;
}

/** A hello's advertised share URL (a discovery hint), or null. */
export function parseHelloUrl(reply: GatewayReply | null): string | null {
  if (!reply || reply.status !== 200 || !isObj(reply.body) || reply.body.mesh !== 1) return null;
  const sg = reply.body.shareGateway;
  return isObj(sg) ? publicOrigin(sg.publicUrl) : null;
}

// ---- the via gateway ----------------------------------------------------------------------------

/** The Public links setting as the push and the ingress read it. */
export function routeSetting(): PublicLinksFile | null {
  return deps.readSetting();
}

/** The settings route's `via` StableID, or null when this host is not routed. */
function viaNode(file = deps.readSetting()): string | null {
  const route = file?.route;
  return typeof route === "object" && route !== null && typeof route.via?.nodeId === "string" && route.via.nodeId ? route.via.nodeId : null;
}

/** The via gateway's peers.json entry, by StableID; null when not routed or not a peer (now). */
export function viaGatewayPeer(): PeerEntry | null {
  const node = viaNode();
  return node ? (deps.peers().find((p) => p.nodeId === node) ?? null) : null;
}

/** Who the ingress admits: the via gateway's StableID, and in address-identity mode its pinned
    addresses too (none: nobody). null (nobody) when not routed or the gateway is no peer. */
export function viaGatewayIdentity(): GatewayIdentity | null {
  const peer = viaGatewayPeer();
  if (!peer || !peer.nodeId) return null;
  if (!deps.addressMode()) return { nodeId: peer.nodeId };
  const addresses = entryAddresses(peer);
  return addresses.length ? { nodeId: peer.nodeId, addresses } : null;
}

// What was last learnt, for the gateway with this StableID. `stated`: the URL came from the
// gateway's own info or ack (not only its hello). `asked`: it has been called at least once.
let cache: { node: string; status: ViaGatewayStatus; stated: boolean; asked: boolean } | null = null;

function cached(peer: PeerEntry): ViaGatewayStatus {
  if (cache?.node !== peer.nodeId) cache = { node: peer.nodeId, status: { publicUrl: null, label: peer.label, reachable: false, accepting: null, kinds: null }, stated: false, asked: false };
  cache.status.label = peer.label;
  return cache.status;
}

/** The gateway's own statement of its URL: cache it, and keep it as lastKnownUrl when it changed. */
function stateUrl(peer: PeerEntry, url: string): void {
  const s = cached(peer);
  s.publicUrl = url;
  cache!.stated = true;
  if (deps.readSetting()?.lastKnownUrl === url) return;
  try {
    deps.recordUrl(url);
  } catch (err) {
    console.warn(`[share] could not keep the gateway's address: ${(err as Error).name}`);
  }
}

// ---- the target a call is bound to ----------------------------------------------------------------

let routeGeneration = 0;
let lastEntry: string | null = null;

/** What of a peers.json entry decides where a call goes, and who answers it. */
function entryKey(peer: PeerEntry | null): string | null {
  return peer ? JSON.stringify([peer.nodeId, peer.dnsName, peer.url ?? null, deps.addressMode()]) : null;
}

/** The route may have changed (the setting changed, or the selected entry): calls and answers
    bound to the previous generation are void. */
export function bumpRouteGeneration(): void {
  routeGeneration += 1;
}

/** The target now: the generation, and the selected entry. A changed entry (seen here) bumps it. */
export interface GatewayTarget {
  peer: PeerEntry;
  generation: number;
  key: string;
}

// The link kinds a gateway said it routes, bound to the exact target (generation and entry) whose
// own info said so: a new generation, a changed entry, an unreachable or restarted gateway, or a
// snapshot it refused all drop it, and until the current target states `s` again it gets no `s`
// row (§mesh.public/registry).
let kindsEvidence: { generation: number; key: string; kinds: RegistryLinkKind[] } | null = null;

/** The kinds `target` itself stated since it became the target; null when it hasn't. */
export function targetKinds(target: GatewayTarget | null): RegistryLinkKind[] | null {
  const e = kindsEvidence;
  return target && e && e.generation === target.generation && e.key === target.key ? [...e.kinds] : null;
}

/** Whether `target` stated that it routes session links (kind `s`). */
export const routesSessions = (target: GatewayTarget | null): boolean => targetKinds(target)?.includes("s") ?? false;

/** Forget what any gateway said about its kinds (a refusal, a restart, the gateway unreachable). */
export function forgetKinds(): void {
  kindsEvidence = null;
}

/** The via gateway as a call target, or null when not routed / not a peer. */
export function currentTarget(): GatewayTarget | null {
  const peer = viaGatewayPeer();
  const key = entryKey(peer);
  if (key !== lastEntry) {
    lastEntry = key;
    routeGeneration += 1;
  }
  return peer && key ? { peer, generation: routeGeneration, key } : null;
}

/** Whether `target` is still the via gateway, at the same generation and entry. */
export function stillCurrent(target: GatewayTarget): boolean {
  const now = currentTarget();
  return !!now && now.generation === target.generation && now.key === target.key;
}

/** The via gateway as last learnt; null when this host is not routed, or nothing is known yet
    (not asked since it was selected, or no peer to ask): shareState then falls back to
    lastKnownUrl and `unconfirmed`, never claiming reachable or unreachable. */
export function viaGatewayStatus(): ViaGatewayStatus | null {
  const peer = viaGatewayPeer();
  if (!peer) return null;
  const s = cached(peer);
  return cache!.asked ? { ...s, kinds: targetKinds(currentTarget()) } : null;
}

/** <gateway><path> at its verified address. "withdrawn": the target changed before the request
    went out (nothing was sent); null: no address, or nothing answered. */
async function callGateway(target: GatewayTarget, path: string, init?: RequestInit, ready: () => boolean = () => true): Promise<GatewayReply | null | "withdrawn"> {
  if (!stillCurrent(target) || !ready()) return "withdrawn";
  const base = await deps.endpoint(target.peer).catch(() => null);
  if (!stillCurrent(target) || !ready()) return "withdrawn"; // resolving the address took a while
  if (!base) return null;
  return deps.call(`${base}${path}`, init).catch(() => null);
}

/** Ask the gateway now: its hello (the URL it advertises, a hint) and its info for this host
    (whether it accepts our links, and the URL it states). */
export async function refreshGateway(): Promise<ViaGatewayStatus | null> {
  const target = currentTarget();
  if (!target) return viaGatewayStatus();
  const [hello, info] = await Promise.all([callGateway(target, "/api/peer/hello"), callGateway(target, "/api/peer/share-gateway/info?kinds=1")]);
  if (hello === "withdrawn" || info === "withdrawn" || !stillCurrent(target)) return viaGatewayStatus(); // the target changed meanwhile
  const peer = target.peer;
  const s = cached(peer);
  cache!.asked = true;
  const hint = parseHelloUrl(hello);
  if (hint && !cache!.stated) s.publicUrl = hint;
  const parsed = parseInfo(info);
  if (!info) {
    s.reachable = false;
    forgetKinds(); // a gateway that comes back renegotiates
  } else if (parsed === "not-gateway") {
    s.reachable = true;
    s.accepting = false; // not (or no longer) a gateway
    forgetKinds();
  } else if (parsed) {
    s.reachable = true;
    s.accepting = parsed.accepting;
    // An info without `kinds` (an older gateway) states none: nothing is believed.
    kindsEvidence = parsed.kinds ? { generation: target.generation, key: target.key, kinds: parsed.kinds } : null;
    stateUrl(peer, parsed.publicUrl);
  }
  // A reply that doesn't parse: nothing learnt, nothing changed.
  return { ...s };
}

/** What a registry push's parsed answer says about the gateway (`answered`: something replied;
    `ack`: it parsed). Only for the target still selected. */
export function noteAck(target: GatewayTarget, ack: RegistryAck | null, answered: boolean): void {
  if (!stillCurrent(target)) return;
  const s = cached(target.peer);
  cache!.asked = true;
  if (!answered) {
    s.reachable = false;
    return;
  }
  if (!ack) return; // an answer that isn't an ack: nothing learnt
  s.reachable = true;
  if (ack.ok) {
    s.accepting = true;
    stateUrl(target.peer, ack.publicUrl);
  } else if (ack.error === "not-accepted" || ack.error === "not-gateway") s.accepting = false;
}

/** Send a snapshot to `target` at its verified address. `withdrawn`: the target changed before
    the request went out or before its answer came (nothing learnt; send again to the new one);
    `answered`: something replied; `ack`: the reply parsed as a RegistryAck (else null). */
export async function pushSnapshot(target: GatewayTarget, snapshot: RegistrySnapshot, ready?: () => boolean): Promise<{ withdrawn: boolean; answered: boolean; ack: RegistryAck | null }> {
  // `ready`: judged again right before the request goes out (the capability evidence the snapshot
  // was built on still holds); false withdraws it, and the caller builds another.
  const reply = await callGateway(
    target,
    "/api/peer/share-gateway/links",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    },
    ready,
  );
  if (reply === "withdrawn" || !stillCurrent(target)) return { withdrawn: true, answered: false, ack: null };
  const ack = parseAck(reply);
  noteAck(target, ack, !!reply);
  return { withdrawn: false, answered: !!reply, ack };
}

/** Tests: forget what was learnt. */
export function resetGatewayClient(): void {
  cache = null;
  kindsEvidence = null;
  lastEntry = null;
  routeGeneration += 1;
}
