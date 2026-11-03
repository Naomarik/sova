import manifest from "./wire-areas.json";

// Four areas, one version number each (§mesh/compatibility): what two hosts on different builds can
// still do together depends on these numbers alone. wire-areas.json is the manifest; its `version`s
// are what this build runs and its `shape`s what shared/wire-areas.test.ts holds the code against.
// This file stays out of protocol.ts: its hash is the fingerprint hosts that list no areas compare.
// No down-translation and no oldest supported version: two numbers match only when they are equal.

export type AreaId = "sessions" | "transcript" | "composer" | "peer";

export const AREA_IDS: readonly AreaId[] = ["sessions", "transcript", "composer", "peer"];

/** One number per area, as a hello lists them. */
export type WireAreas = Record<AreaId, number>;

/** The numbers this build runs. In a page: the numbers it was bundled with, never its server's. */
export const WIRE_AREAS: WireAreas = {
  sessions: manifest.sessions.version,
  transcript: manifest.transcript.version,
  composer: manifest.composer.version,
  peer: manifest.peer.version,
};

/** A hello from a build that lists its areas carries them, outside the fingerprint; a host on an
    earlier build omits the field (§mesh.compatibility/legacy). */
export interface AreasHello {
  areas?: WireAreas;
}

/** The writing number a REST request states (a page's bundled number; a host's own for what it runs). */
export const COMPOSER_HEADER = "X-Sova-Composer";
/** The writing number a /ws/chat socket states: browsers can't set a socket's headers. */
export const COMPOSER_PARAM = "composer";
/** The host-to-host number a host states on its own calls to a peer. */
export const PEER_AREA_HEADER = "X-Sova-Peer-Area";

/** The areas in a hello, or undefined when it lists none or lists something else: such a host is
    read as one with no list. Extra keys are ignored, so a later area doesn't blind an earlier build. */
export function readAreas(raw: unknown): WireAreas | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const out = {} as WireAreas;
  for (const id of AREA_IDS) {
    const n = r[id];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return undefined;
    out[id] = n;
  }
  return out;
}

/** What a host that answers can do from here (§mesh.compatibility/states). */
export type HostState = "works" | "read-only" | "display" | "update";

/**
 * The one reading of a host: `own` are the reader's numbers (a page's bundled ones, or a host's for
 * what it does on its own), `peer` that host's state and the areas it lists. Null for a host that
 * doesn't answer, refuses or hides: those keep that state. `skewed` is a host that lists no areas on
 * another build; one that lists none and is `up` shares this host's fingerprint.
 */
export function hostState(own: WireAreas, peer: { state: string; areas?: WireAreas }): HostState | null {
  if (peer.state === "skewed") return "update";
  if (peer.state !== "up") return null;
  const areas = peer.areas;
  if (!areas) return "works";
  if (areas.sessions !== own.sessions || areas.peer !== own.peer) return "update";
  if (areas.transcript !== own.transcript) return "display";
  if (areas.composer !== own.composer) return "read-only";
  return "works";
}

/** Which side is behind on an area, the side with the lower number; null when they match. */
export function behindOn(area: AreaId, own: WireAreas, theirs: WireAreas): "own" | "theirs" | null {
  if (own[area] === theirs[area]) return null;
  return own[area] < theirs[area] ? "own" : "theirs";
}

/** A number as a request states it: a whole number from 1, else undefined (states nothing). */
function statedNumber(stated: string | number | null | undefined): number | undefined {
  if (typeof stated === "number") return Number.isInteger(stated) && stated >= 1 ? stated : undefined;
  return stated && /^[1-9]\d{0,8}$/.test(stated) ? Number(stated) : undefined;
}

/**
 * The sentence the host holding a session refuses a writing request with
 * (§mesh.compatibility/refusal), or null when it takes it. `own` is that host's writing number and
 * `host` its name. A request stating nothing passes while writing is at its first version.
 */
export function writingRefusal(stated: string | number | null | undefined, own: number, host: string): string | null {
  const n = statedNumber(stated);
  if (n === undefined) return own > 1 ? `This page is older than ${host}. Reload the page to send here.` : null;
  if (n === own) return null;
  return n < own ? `This page is older than ${host}. Reload the page to send here.` : `${host} needs an update before it can take sends from this page.`;
}

/** The same rule for what a host sends a peer on its own (§mesh.links/delivery): a request stating
    nothing comes from a host that lists no areas, which stays as it was (§mesh.compatibility/legacy). */
export function peerRefusal(stated: string | number | null | undefined, own: number, host: string): string | null {
  const n = statedNumber(stated);
  if (n === undefined || n === own) return null;
  return n < own ? `The sending host needs an update before ${host} can take this.` : `${host} needs an update before it can take this.`;
}

/** REST: what a refused writing request answers, with status 409. On /ws/chat the same sentence is
    an `error` frame's `message`, code `refused`, with the send's `clientId` when it has one. */
export interface WritingRefused {
  error: string;
  code: "wire-version";
}
export const WIRE_VERSION_CODE = "wire-version";
