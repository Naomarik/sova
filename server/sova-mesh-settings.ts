import { grantCaps, MESH_CAPS, MESH_PRESETS, presetCaps, type MeshCap, type MeshGrant, type MeshPreset } from "../shared/mesh-access";
import type { MeshAccessRow } from "../shared/project-settings";
import type { SovaSettingId } from "../shared/sova-settings-reference";
import { applyMeshAccess, applyMeshPairing, applyMeshPeers, applyMeshRelay, applyMeshSettings, meshCardState, meshGrantOf, meshPeers, meshSelf, readMeshConfig, readMeshSettings, type MeshResult } from "./mesh";
import { accessFile } from "./mesh/access";
import { meshCardPort } from "./mesh/card-port";
import { PEER_ID_RE, peersFile } from "./mesh/peers";

/**
 * Mesh by a card (§chat.create-mode/settings-cards): each setting checked and written by the code the Mesh page's
 * route runs (`dry` for the check), never a file write, so a card meets every check the screen does. A card that
 * changes who reaches this computer carries that whole access after the change.
 */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const errorOf = (r: MeshResult): string | null => (r.status === 200 ? null : (((r.body as { error?: string } | null)?.error) ?? `refused (${r.status})`));
const capsText = (caps: readonly MeshCap[]): string => caps.join(", ") || "nothing";
const capsOf = (rec: Record<MeshCap, boolean>): MeshCap[] => MESH_CAPS.filter((c) => rec[c]);
const SETTINGS_KEYS = ["hostLabel", "sync", "frontDoor", "frontDoorOrder", "frontDoorExclude", "serveUrl", "loginKinds"];

/** What a change does to each computer's access; absent: that computer's stays as it is. */
type AccessChange = (id: string) => { to: MeshCap[]; preset: string } | "removed" | undefined;

async function wholeAccess(change: AccessChange, added?: { id: string; label: string; preset: MeshPreset }): Promise<MeshAccessRow[]> {
  const now = await meshCardState();
  const rows: MeshAccessRow[] = now.peers.map((p) => {
    const before = `${p.preset ?? "default"}: ${capsText(p.caps)}`;
    const c = change(p.id);
    if (c === "removed") return { peer: p.id, label: p.label, before, after: "removed", changed: true, shell: false };
    const after = c ? `${c.preset}: ${capsText(c.to)}` : before;
    return { peer: p.id, label: p.label, before, after, changed: after !== before, shell: (c ? c.to : p.caps).includes("sessions") };
  });
  if (added) {
    const caps = capsOf(presetCaps(added.preset));
    rows.push({ peer: added.id, label: added.label, before: "none yet", after: `${added.preset}: ${capsText(caps)}`, changed: true, shell: caps.includes("sessions") });
  }
  return rows;
}

const peerRow = (p: ReturnType<typeof meshPeers>[number]) => ({ id: p.id, ...(p.label ? { label: p.label } : {}), ...(p.priority !== undefined ? { priority: p.priority } : {}), ...(p.url ? { url: p.url } : {}), ...(p.serveUrl ? { serveUrl: p.serveUrl } : {}) });
const namesOf = (peers: unknown[]): Array<Record<string, unknown>> => peers as Array<Record<string, unknown>>;

/** The list as the route takes it: each computer keeps its identity, whatever a card's row says. */
function peersBody(rows: Array<Record<string, unknown>>): { peers: Array<Record<string, unknown>> } {
  const now = meshPeers();
  return {
    peers: rows.map((r) => {
      const was = now.find((p) => p.id === r.id)!;
      return { ...r, nodeId: was.nodeId, name: was.dnsName || was.id };
    }),
  };
}

const slug = (name: string): string => name.split(".")[0]!.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32);
const addBody = (v: Record<string, unknown>) => {
  const id = typeof v.id === "string" && v.id ? v.id : slug(String(v.name));
  return { id, peers: [...peersBody(meshPeers().map(peerRow)).peers, { id, name: v.name, ...(typeof v.label === "string" ? { label: v.label } : {}) }], grants: { [id]: v.preset } };
};

const asGrant = (v: unknown): MeshGrant | null => (v as { grant: MeshGrant | null }).grant;
const defaultGrant = (id: string): MeshGrant => ({ preset: meshPeers().find((p) => p.id === id)?.lan ? "presence" : "full" });

export const MESH_ADAPTERS: Pick<Record<SovaSettingId, MeshAdapter>, Extract<SovaSettingId, `mesh.${string}`>> = {
  "mesh.settings": {
    files: () => [peersFile()],
    read(value) {
      const now = readMeshSettings() as unknown as Record<string, unknown>;
      const asked = isObj(value) ? value : {};
      return Object.fromEntries(Object.keys(asked).map((k) => [k, k === "sync" && isObj(asked.sync) ? Object.fromEntries(Object.keys(asked.sync).map((c) => [c, (now.sync as Record<string, unknown>)[c]])) : (now[k] ?? null)]));
    },
    check(v) {
      if (!isObj(v)) return `Expected any of {${SETTINGS_KEYS.join(", ")}}.`;
      for (const k of Object.keys(v)) if (!SETTINGS_KEYS.includes(k)) return `"${k}" can't go on a card: ${SETTINGS_KEYS.join(", ")} can.`;
      return errorOf(applyMeshSettings(v, { dry: true }));
    },
    write: async (v) => errorOf(applyMeshSettings(v as Record<string, never>)),
    widens(before, value) {
      const was = (isObj(before) && isObj(before.sync) ? before.sync : {}) as Record<string, boolean>;
      const to = (isObj(value) && isObj(value.sync) ? value.sync : {}) as Record<string, boolean>;
      return Object.keys(to).some((k) => to[k] === true && was[k] !== true) || (isObj(value) && "loginKinds" in value && value.loginKinds !== "api-keys");
    },
  },
  "mesh.peers": {
    files: () => [peersFile()],
    read: () => meshPeers().map(peerRow),
    async check(v) {
      if (!Array.isArray(v)) return "Expected the whole list of linked computers.";
      for (const r of namesOf(v)) {
        if (!isObj(r) || typeof r.id !== "string") return "Each row names its id.";
        for (const k of Object.keys(r)) if (!["id", "label", "priority", "url", "serveUrl"].includes(k)) return `"${k}" can't change here: a computer keeps its identity. Remove it and link it again.`;
        if (!meshPeers().some((p) => p.id === r.id)) return `${r.id} isn't linked: mesh.peer-add links a computer.`;
      }
      return errorOf(await applyMeshPeers(peersBody(namesOf(v)), { dry: true }));
    },
    write: async (v) => errorOf(await applyMeshPeers(peersBody(namesOf(v as unknown[])))),
    access: (v) => wholeAccess((id) => (namesOf(v as unknown[]).some((r) => r.id === id) ? undefined : "removed")),
  },
  "mesh.peer-add": {
    files: () => [peersFile(), accessFile()],
    read: () => null,
    async check(v) {
      if (!isObj(v) || typeof v.name !== "string" || !v.name.trim()) return "Name the computer as this tailnet knows it.";
      if (!(MESH_PRESETS as readonly unknown[]).includes(v.preset)) return `Name its access, one of ${MESH_PRESETS.join(", ")}: nothing is assumed.`;
      for (const k of Object.keys(v)) if (!["name", "id", "label", "preset"].includes(k)) return `"${k}" can't go on a card: name, id, label and preset can.`;
      const body = addBody(v);
      if (meshPeers().some((p) => p.id === body.id)) return `${body.id} is already linked.`;
      return errorOf(await applyMeshPeers(body, { dry: true }));
    },
    write: async (v) => errorOf(await applyMeshPeers(addBody(v as Record<string, unknown>))),
    access(v) {
      const r = v as Record<string, unknown>;
      return wholeAccess(() => undefined, { id: addBody(r).id, label: typeof r.label === "string" ? r.label : String(r.name), preset: r.preset as MeshPreset });
    },
  },
  "mesh.access": {
    files: () => [accessFile()],
    read(value) {
      const id = isObj(value) ? value.peer : undefined;
      return { peer: id, grant: typeof id === "string" ? meshGrantOf(id) : null };
    },
    check(v) {
      if (!isObj(v) || !("grant" in v)) return "Expected {peer, grant}.";
      return errorOf(applyMeshAccess(v, { dry: true }));
    },
    write: async (v) => errorOf(applyMeshAccess(v as Record<string, never>)),
    widens(before, value) {
      const id = (value as { peer: string }).peer;
      const was = grantCaps((before as { grant: MeshGrant | null }).grant ?? defaultGrant(id));
      const to = grantCaps(asGrant(value) ?? defaultGrant(id));
      return MESH_CAPS.some((c) => to[c] && !was[c]);
    },
    access(v) {
      const id = (v as { peer: string }).peer;
      const g = asGrant(v) ?? defaultGrant(id);
      return wholeAccess((p) => (p === id ? { to: capsOf(grantCaps(g)), preset: g.preset } : undefined));
    },
  },
  "mesh.browser-access": {
    files: () => [peersFile()],
    read(value) {
      const host = isObj(value) ? value.host : undefined;
      const on = host === meshSelf().id ? readMeshConfig()?.self.browserAccess !== false : meshPeers().find((p) => p.id === host)?.browserAccess !== false;
      return { host, on };
    },
    check(v) {
      if (!isObj(v) || typeof v.on !== "boolean" || typeof v.host !== "string") return "Expected {host, on}.";
      if (v.host !== meshSelf().id && !meshPeers().some((p) => p.id === v.host)) return `${v.host} isn't linked: a chat can't act on a computer that isn't.`;
      return readMeshConfig() ? null : "The mesh is off: link a computer first.";
    },
    async write(v) {
      const r = v as { host: string; on: boolean };
      const run = meshCardPort().browserAccess;
      return run ? errorOf(await run({ id: r.host, browserAccess: r.on })) : "Browser access isn't available here.";
    },
    widens: (_b, v) => (v as { on: boolean }).on,
  },
  "mesh.resync": {
    files: () => [],
    read: () => ({ peer: null }),
    async check(v) {
      if (!isObj(v) || typeof v.peer !== "string") return "Expected {peer}.";
      return (await meshCardPort().resyncProblem?.(v.peer)) ?? null;
    },
    async write(v) {
      const run = meshCardPort().resync;
      return run ? errorOf(await run((v as { peer: string }).peer)) : "Resync isn't available here.";
    },
  },
  "mesh.pairing": {
    files: () => [peersFile(), accessFile()],
    read: () => null,
    input: { field: "pin", label: "The other computer's fingerprint, from its Mesh page" },
    check(v) {
      if (!isObj(v)) return "Expected {id, role, preset, host?, port?, label?}.";
      for (const k of Object.keys(v)) if (!["id", "label", "role", "host", "port", "preset"].includes(k)) return `"${k}" can't go on a card: id, label, role, host, port and preset can. The fingerprint goes in the card's own field, typed by the person, and an internet relay stays on Settings → Mesh, Pairings.`;
      if (typeof v.id !== "string" || !PEER_ID_RE.test(v.id)) return `id must match ${PEER_ID_RE}.`;
      if (v.role !== "dial" && v.role !== "accept") return 'role is "dial" or "accept".';
      if (v.role === "dial" && (typeof v.host !== "string" || typeof v.port !== "number")) return "A computer this one dials needs its relay's host and port.";
      if (!(MESH_PRESETS as readonly unknown[]).includes(v.preset)) return `Name its access, one of ${MESH_PRESETS.join(", ")}: nothing is assumed.`;
      if (meshPeers().some((p) => p.id === v.id)) return `${v.id} is already linked.`;
      return null;
    },
    async write(v, input) {
      const { preset, ...rest } = v as Record<string, unknown>;
      return errorOf(await applyMeshPairing({ ...rest, grant: preset as string, pin: input }));
    },
    access(v) {
      const r = v as Record<string, unknown>;
      return wholeAccess(() => undefined, { id: String(r.id), label: typeof r.label === "string" ? r.label : String(r.id), preset: r.preset as MeshPreset });
    },
  },
  "mesh.relay": {
    files: () => [peersFile()],
    read: () => readMeshConfig()?.self.relay ?? null,
    check(v) {
      if (v !== null && (!isObj(v) || typeof v.host !== "string" || typeof v.port !== "number")) return "Expected {host, port} or null.";
      if (isObj(v) && Object.keys(v).some((k) => k !== "host" && k !== "port")) return "A card holds host and port: an internet relay stays on Settings → Mesh, Pairings.";
      return errorOf(applyMeshRelay(v as never, { dry: true }));
    },
    write: async (v) => errorOf(applyMeshRelay(v as never)),
    widens: (_b, v) => v !== null,
  },
};
interface MeshAdapter {
  files(): string[];
  read(value?: unknown): unknown;
  check(value: unknown): string | null | Promise<string | null>;
  write(value: unknown, input?: string): Promise<string | null>;
  /** A value the person types into the card's own field at Apply: it never reaches a chat. */
  input?: { field: string; label: string };
  widens?(before: unknown, value: unknown): boolean;
  access?(value: unknown): Promise<MeshAccessRow[]>;
}

