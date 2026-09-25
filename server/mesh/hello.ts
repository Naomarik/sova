import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import type { MeshHello, PeerState } from "../../shared/protocol";
import { type PeerEntry, peerUrl } from "./peers";

// Hello: who a Sova host is and which wire contract it speaks. The fingerprint and the package
// version are read once, on the first hello, never at import.

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

export function ownHello(self: { id: string; label: string }, nodeId?: string): MeshHello {
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
    now: Date.now(),
  };
}

export const ownProtocol = (): string => ownFingerprint().protocol;

export interface ProbeResult {
  state: PeerState;
  hello?: MeshHello;
  error?: string;
  /** Round trip of an answered hello, ms (this host's measure; never on the wire). */
  ms?: number;
}

/** GET <base>/api/peer/hello, classified. Never throws. */
export async function probeHello(base: string): Promise<ProbeResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/api/peer/hello`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (res.status === 403 && res.headers.get(REFUSED_HEADER) === "refused") {
      await res.body?.cancel();
      return { state: "refused", error: "this host is not in its peers.json" };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { state: "down", error: `hello answered ${res.status}` };
    }
    const hello = (await res.json()) as MeshHello;
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
    if (r.state === "up" || r.state === "skewed") lastSeen.set(peer.id, Date.now());
    return r;
  });
  probes.set(base, { at: Date.now(), result });
  return result;
}

export const peerLastSeen = (id: string): number | null => lastSeen.get(id) ?? null;

/** Tests: forget cached probes. */
export const clearProbes = (): void => probes.clear();
