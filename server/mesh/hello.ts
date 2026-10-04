import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { DENIED, type PeerStateView } from "../../shared/mesh-access";
import type { MeshBuildHello } from "../../shared/mesh-resync";
import type { AdvertisedGateway, MeshHelloPublic, ShareGatewayHello } from "../../shared/public-links";
import { gatewayPublicUrl, isPublicUrl } from "../share/registry";
import { type PeerEntry, peerUrl, readPeers } from "./peers";

// Hello: who a Sova host is and which wire contract it speaks. The fingerprint and the package
// version are read once, never at import: at boot (primeFingerprint, from server/index.ts through
// captureBootBuild), else on the first hello.

const PROTOCOL_FILE = new URL("../../shared/protocol.ts", import.meta.url);
const PACKAGE_FILE = new URL("../../package.json", import.meta.url);
/** The same index.html server/index.ts serves (checked per request there too). */
const INDEX_FILE = new URL("../../dist/index.html", import.meta.url);
export const PROBE_TIMEOUT_MS = 2500;
const PROBE_CACHE_MS = 3000;
/** Set on the gate's refusals, so a proxy tells "this host refused you" from a route's own 403. */
export const REFUSED_HEADER = "X-Sova-Mesh";

let fingerprint: { protocol: string; version: string } | null = null;
function ownFingerprint(): { protocol: string; version: string } {
  if (!fingerprint) {
    let version = "unknown";
    try {
      version = String(JSON.parse(readFileSync(PACKAGE_FILE, "utf8")).version ?? "unknown");
    } catch {
      // a stripped deploy without package.json: the protocol hash still distinguishes
    }
    fingerprint = { protocol: createHash("sha256").update(readFileSync(PROTOCOL_FILE)).digest("hex").slice(0, 16), version };
  }
  return fingerprint;
}

// The served build: re-hashed only when index.html's mtime or size changes, so a hello is a stat.
let buildCache: { key: string; build: string } | null = null;
function ownBuild(): string | undefined {
  let key: string;
  try {
    const st = statSync(INDEX_FILE);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    buildCache = null;
    return undefined; // no build served (dev server behind Vite, or not built yet)
  }
  if (buildCache?.key !== key) {
    try {
      buildCache = { key, build: createHash("sha256").update(readFileSync(INDEX_FILE)).digest("hex").slice(0, 16) };
    } catch {
      return undefined;
    }
  }
  return buildCache.build;
}

// The public-links gateway advertisement (§mesh.public/gateway): an optional field outside
// MeshHello, so the fingerprint (sha256 of shared/protocol.ts) is unchanged and an older host just
// ignores it. Discovery only: whether this gateway accepts a given host is GatewayInfo, asked by
// that host. Only a host whose route is "self" with a gateway setting advertises.
function ownShareGateway(): ShareGatewayHello {
  let publicUrl: string | null = null;
  try {
    publicUrl = gatewayPublicUrl();
  } catch {
    // an unreadable setting advertises nothing; the hello itself must never fail
  }
  return publicUrl ? { shareGateway: { publicUrl } } : {};
}

/** Read the fingerprint now: at boot, together with the commit (mesh/build-id.ts), so the two
    describe the same moment. Idempotent; returns the protocol hash. */
export const primeFingerprint = (): string => ownFingerprint().protocol;

// The boot commit (§mesh.peers/resync), advertised like the gateway: an optional field outside
// MeshHello (shared/mesh-resync.ts), so the fingerprint is unchanged and an older host ignores it.
let bootCommit: string | undefined;
/** Set once at boot by captureBootBuild; tests reset it with undefined. */
export const advertiseCommit = (commit: string | undefined): void => {
  bootCommit = commit;
};

export function ownHello(self: { id: string; label: string }, nodeId?: string): MeshHelloPublic & MeshBuildHello {
  const { protocol, version } = ownFingerprint();
  const build = ownBuild();
  return {
    mesh: 1,
    id: self.id,
    label: self.label,
    hostname: hostname(),
    version,
    protocol,
    pi: PI_VERSION,
    ...(build ? { build } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...ownShareGateway(),
    ...(bootCommit ? { commit: bootCommit } : {}),
    now: Date.now(),
  };
}

export const ownProtocol = (): string => ownFingerprint().protocol;

export interface ProbeResult {
  /** `hidden`: the peer identified this host but grants it nothing, hello included (§mesh.peers/grants). */
  state: PeerStateView;
  /** A gateway's hello also carries `shareGateway`, a newer build's its boot `commit` (both optional). */
  hello?: MeshHelloPublic & MeshBuildHello;
  error?: string;
  /** Round trip of an answered hello, ms (this host's measure; never on the wire). */
  ms?: number;
}

/** Whether a probe reached the peer: a skewed one answered too, as its session list and its own
    calls do, so it is up to the hooks (reading it as down made each poll a comeback). A hidden one
    answered as well: it is reachable, it just shows this host nothing. */
export const answered = (probe: ProbeResult): boolean => probe.state === "up" || probe.state === "skewed" || probe.state === "hidden";

/** GET <base>/api/peer/hello, classified. Never throws. */
export async function probeHello(base: string): Promise<ProbeResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/api/peer/hello`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.status === 403 && res.headers.get(REFUSED_HEADER) === "refused") {
      await res.body?.cancel();
      return { state: "refused", error: "this host is not in its peers.json" };
    }
    if (res.status === 403 && res.headers.get(REFUSED_HEADER) === DENIED) {
      await res.body?.cancel();
      return { state: "hidden", error: "it shares nothing with this host" };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { state: "down", error: `hello answered ${res.status}` };
    }
    const hello = (await res.json()) as MeshHelloPublic & MeshBuildHello;
    const ms = Math.round(performance.now() - t0);
    if (hello?.mesh !== 1 || typeof hello.protocol !== "string") return { state: "down", error: "not a Sova hello" };
    if (hello.protocol !== ownProtocol()) return { state: "skewed", hello, error: `protocol ${hello.protocol}, this host ${ownProtocol()}`, ms };
    return { state: "up", hello, ms };
  } catch (err) {
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const why = e.name === "TimeoutError" ? "no answer in time" : (e.cause?.code ?? e.cause?.message ?? e.message);
    return { state: "down", error: why };
  }
}

// Probes are cached briefly per peer URL, so the Mesh page's own polling drives them and nothing
// runs when nobody asks. `lastSeen` is the last "up"/"skewed" answer since this server started.
const probes = new Map<string, { at: number; result: Promise<ProbeResult> }>();
const lastSeen = new Map<string, number>();

export function probePeer(peer: PeerEntry): Promise<ProbeResult> {
  const base = peerUrl(peer);
  const hit = probes.get(base);
  if (hit && Date.now() - hit.at < PROBE_CACHE_MS) return hit.result;
  const result = probeHello(base).then((r) => {
    if (answered(r)) lastSeen.set(peer.id, Date.now());
    return r;
  });
  probes.set(base, { at: Date.now(), result });
  return result;
}

const peersNow = (): PeerEntry[] => {
  const read = readPeers();
  return read.ok ? read.config.peers : [];
};

/** The peers whose hello advertises a share gateway (§mesh.public/gateway; discovery only, whether
    one accepts this host is its GatewayInfo). Probes through probePeer, so answers are cached.
    Only peers answering `up`: a down or skewed one is left out, and so is a publicUrl that isn't
    exactly an https origin (isPublicUrl). `nodeId` is the peer's StableID
    from peers.json, never the hello's. Never throws. */
export async function advertisedGateways(peers: () => PeerEntry[] = peersNow): Promise<AdvertisedGateway[]> {
  let list: PeerEntry[];
  try {
    list = peers();
  } catch {
    return [];
  }
  const found = await Promise.all(
    list.map(async (peer): Promise<AdvertisedGateway | null> => {
      try {
        const r = await probePeer(peer);
        const url = r.state === "up" ? r.hello?.shareGateway?.publicUrl : undefined;
        return isPublicUrl(url) ? { nodeId: peer.nodeId, peer: peer.id, publicUrl: url } : null;
      } catch {
        return null;
      }
    }),
  );
  return found.filter((g): g is AdvertisedGateway => g !== null);
}

export const peerLastSeen = (id: string): number | null => lastSeen.get(id) ?? null;

/** Tests: forget cached probes. */
export const clearProbes = (): void => probes.clear();
