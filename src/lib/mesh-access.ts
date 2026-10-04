// The Mesh page's grants editor (§mesh.peers/grants; components/MeshAccess.tsx): the words for each
// preset and capability, and how a switch changes a grant. Pure, so node tests run it without a DOM.

import { grantCaps, MESH_CAPS, presetCaps, type MeshCap, type MeshGrant, type MeshPreset } from "../../shared/mesh-access";

export type { MeshAccessPeer, MeshAccessView, MeshCap, MeshGrant, MeshPreset } from "../../shared/mesh-access";
export { MESH_CAPS, MESH_PRESETS } from "../../shared/mesh-access";

/** A peer with no stored grant has this one: everything, as before grants existed. */
export const FULL: MeshGrant = { preset: "full" };

/** The preset menu's words. */
export const PRESET_LABEL: Record<MeshPreset, string> = {
  full: "Everything",
  sessions: "Sessions",
  presence: "Presence only",
  none: "Nothing",
};

/** What each preset means, one sentence each. */
export const PRESET_HINT: Record<MeshPreset, string> = {
  full: "Sees and does everything here, as before grants.",
  sessions: "Lists this host and runs sessions here. No sync, settings or logins.",
  presence: "Lists this host and reads its details. Nothing else.",
  none: "Gets nothing from this host, not even a hello.",
};

/** Each capability's name and what granting it means, in plain words. */
export const CAP_COPY: Record<MeshCap, { label: string; means: string }> = {
  presence: { label: "Presence", means: "Lists this host, reads its details, and hears its name." },
  sessions: { label: "Sessions", means: "Can start and drive sessions here, which run commands on this machine as you." },
  links: { label: "Links", means: "Can link its sessions to sessions here and send them files." },
  llm: { label: "LLM activity", means: "Sees how many LLM calls this host has in flight." },
  "sync.settings": { label: "Sync settings", means: "Exchanges Sova and pi settings with this host." },
  "sync.themes": { label: "Sync themes", means: "Exchanges theme files with this host." },
  "sync.extensions": { label: "Sync extensions", means: "Sees this host's extensions and shares its own." },
  "sync.logins": { label: "Sync logins", means: "Exchanges the logins chosen below, and borrows and lends Claude logins with this host." },
  outreach: { label: "Outreach", means: "Can send messages through this host's sender." },
  share: { label: "Public links", means: "Can register public links with this host's gateway." },
  admin: { label: "Admin", means: "Can rename this host, change its settings and Browser access, and edit projects and orgs." },
};

/** The sync capabilities, which also reach a peer through any other host that shares them. */
export const SYNC_CAPS: readonly MeshCap[] = ["sync.settings", "sync.themes", "sync.extensions", "sync.logins"];

/** The grant a stored one (or none) stands for. */
export const grantOf = (stored: MeshGrant | undefined): MeshGrant => stored ?? FULL;

/** A new preset; the per-login choice carries over, the switches don't. */
export function withPreset(g: MeshGrant, preset: MeshPreset): MeshGrant {
  return { preset, ...(g.logins ? { logins: [...g.logins] } : {}) };
}

/** One switch flipped. A switch that lands on the preset's own value is dropped, so the grant stays
    the plainest one that says it. */
export function withCap(g: MeshGrant, cap: MeshCap, on: boolean): MeshGrant {
  const caps = { ...(g.caps ?? {}) };
  if (presetCaps(g.preset)[cap] === on) delete caps[cap];
  else caps[cap] = on;
  const { caps: _, ...rest } = g;
  return Object.keys(caps).length ? { ...rest, caps } : rest;
}

/** One login switched on or off for this peer. Until the user first chooses, every login goes (the
    grant has no list); the first switch writes the list out, from every login this host has. */
export function withLogin(g: MeshGrant, key: string, on: boolean, allKeys: readonly string[]): MeshGrant {
  const now = new Set(g.logins ?? allKeys);
  if (on) now.add(key);
  else now.delete(key);
  return { ...g, logins: [...now].sort() };
}

/** Whether a login goes to the peer under `g`. */
export const loginOn = (g: MeshGrant, key: string): boolean => grantCaps(g)["sync.logins"] && (!g.logins || g.logins.includes(key));

/** The grant's line on the collapsed row: the preset, and how many switches change it. */
export function grantSummary(g: MeshGrant): string {
  const changed = MESH_CAPS.filter((c) => typeof g.caps?.[c] === "boolean").length;
  return changed ? `${PRESET_LABEL[g.preset]}, ${changed} changed` : PRESET_LABEL[g.preset];
}

/** "What this host can see on <peer>", from that peer's own answers, never from a claim it makes. */
export function theirLine(peer: string, theirs: { denied: MeshCap[] } | undefined): string {
  if (!theirs?.denied.length) return `${peer} hasn't kept anything from this host so far.`;
  const words = theirs.denied.map((c) => CAP_COPY[c].label.toLowerCase());
  const list = words.length < 3 ? words.join(" and ") : `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;
  return `${peer} keeps ${list} from this host.`;
}

/** Under a sync category turned off: sync replicates host to host, so other hosts can still pass
    this host's copy on. "VPS and Phone can still pass it on to Laptop." */
export function transitLine(others: readonly string[], peer: string): string {
  const who = others.length < 3 ? others.join(" and ") : `${others.slice(0, -1).join(", ")}, and ${others.at(-1)}`;
  return `${who} can still pass it on to ${peer}, unless ${others.length === 1 ? "it keeps" : "they keep"} it from ${peer} too.`;
}
