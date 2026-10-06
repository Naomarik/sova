import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { grantCaps, MESH_CAPS, MESH_PRESETS, type MeshAccessFile, type MeshCap, type MeshGrant } from "../../shared/mesh-access";
import { stateRoot } from "../state-root";
import { isLanNodeId } from "./lan-cert";
import { judgedPath } from "./paths";

// Per-peer grants (§mesh.peers/grants): `<state root>/mesh-access.json`, what each peer may see and
// do on THIS host. The peer listener asks `allows` after the identity check, and this host's own
// pushes ask `mayShareWith` before calling a peer. Only a MISSING file is today's behaviour (every
// peer `full`); a file that exists but can't be read or parsed fails CLOSED (hello only), unlike
// peers.json, which turns the mesh off. Keyed by node identity, so a peer's id can be renamed
// without losing its grant.

/** What a request needs: a capability, `hello` (presence, or a broken file), or `full` (every cap). */
export type Need = MeshCap | "hello" | "full" | "sync.docs";

export type AccessRead = { kind: "missing" } | { kind: "ok"; file: MeshAccessFile } | { kind: "error"; error: string };

export const accessFile = (): string => join(stateRoot(), "mesh-access.json");

const LOGIN_KEY_RE = /^(?:pi|claude):[A-Za-z0-9._@:-]{1,128}$/;

/** Validate a whole access document. Every error is fatal (the caller fails closed on it). */
export function validateAccess(raw: unknown): { file: MeshAccessFile } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "expected an object" };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) return { error: `unsupported version ${JSON.stringify(r.version)}` };
  const peersRaw = r.peers ?? {};
  if (typeof peersRaw !== "object" || peersRaw === null || Array.isArray(peersRaw)) return { error: "peers must be an object" };
  const peers: Record<string, MeshGrant> = {};
  for (const [node, g] of Object.entries(peersRaw)) {
    if (!node || node.length > 128) return { error: `peers: bad node id ${JSON.stringify(node)}` };
    const v = validateGrant(g);
    if ("error" in v) return { error: `peers[${JSON.stringify(node)}]: ${v.error}` };
    peers[node] = v.grant;
  }
  return { file: { version: 1, peers } };
}

/** One grant, strictly. */
export function validateGrant(raw: unknown): { grant: MeshGrant } | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "a grant is an object" };
  const g = raw as Record<string, unknown>;
  if (!(MESH_PRESETS as readonly unknown[]).includes(g.preset)) return { error: `preset must be one of ${MESH_PRESETS.join(", ")}` };
  const grant: MeshGrant = { preset: g.preset as MeshGrant["preset"] };
  if (g.caps !== undefined) {
    if (typeof g.caps !== "object" || g.caps === null || Array.isArray(g.caps)) return { error: "caps must be an object" };
    const caps: Partial<Record<MeshCap, boolean>> = {};
    for (const [k, v] of Object.entries(g.caps)) {
      if (!(MESH_CAPS as readonly string[]).includes(k)) return { error: `caps.${k} is not a capability` };
      if (typeof v !== "boolean") return { error: `caps.${k} must be true or false` };
      caps[k as MeshCap] = v;
    }
    if (Object.keys(caps).length) grant.caps = caps;
  }
  if (g.logins !== undefined) {
    if (!Array.isArray(g.logins) || g.logins.some((k) => typeof k !== "string" || !LOGIN_KEY_RE.test(k))) return { error: "logins must be a list of login keys" };
    if (new Set(g.logins).size !== g.logins.length) return { error: "logins lists a login twice" };
    grant.logins = [...(g.logins as string[])].sort();
  }
  return { grant };
}

/** The file, parsed and validated. */
export function readAccess(file = accessFile()): AccessRead {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "error", error: `mesh-access.json: ${(err as Error).message}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { kind: "error", error: `mesh-access.json: not JSON (${(err as Error).message})` };
  }
  const v = validateAccess(json);
  return "error" in v ? { kind: "error", error: `mesh-access.json: ${v.error}` } : { kind: "ok", file: v.file };
}

/** Write the file atomically at 0600 (tmp + rename). */
export function writeAccess(doc: MeshAccessFile, file = accessFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, peers: doc.peers }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

// ---- the current state, re-read with one stat per question (the peers.json pattern) -------------

let stamp = "";
let current: AccessRead = { kind: "missing" };
const changeHooks: Array<() => void> = [];

function stampOf(file: string): string {
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : `error:${(err as Error).message}`;
  }
}

/** The grants as the file has them now (a hand edit is picked up with one stat). */
export function access(): AccessRead {
  const file = accessFile();
  const now = stampOf(file);
  if (now !== stamp) {
    const before = JSON.stringify(current);
    stamp = now;
    current = now === "missing" ? { kind: "missing" } : readAccess(file);
    if (current.kind === "error" && JSON.stringify(current) !== before) console.warn(`[mesh] ${current.error}; every peer gets hello only until it is fixed`);
    if (JSON.stringify(current) !== before) for (const h of changeHooks) h();
  }
  return current;
}

/** Fires after the grants changed (a write here, or a hand edit noticed by the next question). */
export function onAccessChange(fn: () => void): void {
  changeHooks.push(fn);
}

/** Tests: forget the cached read. */
export function resetAccessCache(): void {
  stamp = "";
  current = { kind: "missing" };
}

/** Change the file: `change` gets it as it is now (missing = empty) and returns the next one. A
    file that is there but unusable is never overwritten. */
export function updateAccess(change: (doc: MeshAccessFile) => MeshAccessFile): { ok: true } | { error: string } {
  const now = access();
  if (now.kind === "error") return { error: `${now.error}; fix or remove it first` };
  const base: MeshAccessFile = now.kind === "ok" ? now.file : { version: 1, peers: {} };
  const next = change(structuredClone(base));
  const v = validateAccess(next);
  if ("error" in v) return { error: v.error };
  writeAccess(v.file);
  access();
  return { ok: true };
}

// ---- decisions --------------------------------------------------------------------------------

/** What a node has with no file or no entry: `full` for a tailnet peer (as before grants), but only
    `presence` for a dial-out pairing (`lan:` node), which fails closed (§mesh.lan/pairing). */
export const defaultPreset = (nodeId: string): "full" | "presence" => (isLanNodeId(nodeId) ? "presence" : "full");

/** The caps a node has now: its grant's; with no file or no entry, its default preset's; none
    (hello only) on a broken file. */
export function capsOf(nodeId: string): Record<MeshCap, boolean> | "hello-only" {
  const a = access();
  if (a.kind === "error") return "hello-only";
  const grant = a.kind === "ok" ? a.file.peers[nodeId] : undefined;
  return grantCaps(grant ?? { preset: defaultPreset(nodeId) });
}

/** Whether `nodeId` may have what a request needs. */
export function allows(nodeId: string, need: Need): boolean {
  const caps = capsOf(nodeId);
  if (caps === "hello-only") return need === "hello";
  if (need === "hello") return caps.presence;
  if (need === "full") return MESH_CAPS.every((c) => caps[c]);
  if (need === "sync.docs") return caps["sync.settings"] || caps["sync.themes"];
  return caps[need];
}

/** Whether this host's grant to `nodeId` is anything but `full` (a broken file counts as restricted). */
export function restricted(nodeId: string): boolean {
  const a = access();
  if (a.kind === "missing") return defaultPreset(nodeId) !== "full";
  return !allows(nodeId, "full");
}

/** The logins `nodeId` receives now: "all", or the chosen keys ([] without sync.logins). */
export function loginsOf(nodeId: string): "all" | string[] {
  if (!allows(nodeId, "sync.logins")) return [];
  const a = access();
  const grant = a.kind === "ok" ? a.file.peers[nodeId] : undefined;
  return grant?.logins ?? "all";
}

/** Whether login `key` is exchanged with `nodeId` (both directions, logouts included). */
export function mayShareLoginNode(nodeId: string, key: string): boolean {
  const l = loginsOf(nodeId);
  return l === "all" || l.includes(key);
}

// ---- the route classifier ---------------------------------------------------------------------

export interface Classified {
  need: Need;
  /** Which rule matched; "default" = no rule (the route needs `full`). The completeness test
      fails on any registered route that falls to it. */
  rule: string;
}

// Peer-only routes, by their judged path.
const PEER_RULES: Array<[RegExp, Need]> = [
  [/^\/api\/peer\/hello$/, "hello"],
  [/^\/api\/peer\/details$/, "presence"],
  [/^\/api\/peer\/(?:label|browser-access)$/, "presence"],
  [/^\/api\/peer\/(?:rename|set-browser-access)$/, "admin"],
  [/^\/api\/peer\/sync\/(?:manifest|doc|push)$/, "sync.docs"],
  [/^\/api\/peer\/sync\/extensions$/, "sync.extensions"],
  [/^\/api\/peer\/credentials\/[^/]+$/, "sync.logins"],
  // The Claude login pool goes with the logins grant (§mesh.peers/grants).
  [/^\/api\/peer\/claude-pool\/[^/]+$/, "sync.logins"],
  // A session's transcript, read by id: it belongs to sessions, not links (§mesh.peers/grants).
  [/^\/api\/peer\/links\/read$/, "sessions"],
  [/^\/api\/peer\/links(?:\/.*)?$/, "links"],
  [/^\/api\/peer\/outreach\/[^/]+$/, "outreach"],
  [/^\/api\/peer\/share-gateway\/[^/]+$/, "share"],
];

// Driving sessions: every method. A browser relayed by the peer drives a session here through these.
const SESSION_PREFIXES = [
  "sessions",
  "session-groups",
  "transcript",
  "attachment",
  "upload",
  "files",
  "folders",
  "cwds",
  "targets",
  "models",
  "mode",
  "subagents",
  "workers",
  "worktrees",
  "sandbox",
  "diff",
  "spec-turn",
  "explanations",
  "insights",
  "links",
  "baton",
  "health",
];
// Read with `sessions` (GET/HEAD: the remote session pane and an org page on a peer read them);
// every write needs `admin`.
const READ_PREFIXES = [
  "settings",
  "themes",
  "extensions",
  "claude",
  "orgs",
  "projects",
  "project-services",
  "overseer",
  "schedules",
  "previews",
  "monitor",
  "push",
  "services",
  "outreach",
  "public-links",
  "shares-overview",
  "session-shares",
  "visitor-logging",
  "voice",
  "profiles",
  "playbooks",
  "provider-limits",
  "usage",
];
// Never below `full`: the operator's credentials and the share pages' own routes.
const FULL_PREFIXES = ["auth", "h", "i", "s"];

const prefixRe = (list: string[]) => new RegExp(`^/api/(${list.map((p) => p.replace(/[-]/g, "\\-")).join("|")})(?:/|$)`);
const SESSION_RE = prefixRe(SESSION_PREFIXES);
const READ_RE = prefixRe(READ_PREFIXES);
const FULL_RE = prefixRe(FULL_PREFIXES);

/** The one capability a peer-listener request needs, from its method and path (judged as the router
    will route it). An unjudgeable path needs `full`. */
export function classifyRequest(method: string, pathname: string): Classified {
  const path = judgedPath(pathname);
  if (!path) return { need: "full", rule: "unjudgeable" };
  if (path.startsWith("/api/peer/") || path === "/api/peer") {
    for (const [re, need] of PEER_RULES) if (re.test(path)) return { need, rule: re.source };
    return { need: "full", rule: "default" };
  }
  const read = method === "GET" || method === "HEAD";
  let m = SESSION_RE.exec(path);
  if (m) return { need: "sessions", rule: `sessions:${m[1]}` };
  m = READ_RE.exec(path);
  if (m) return read ? { need: "sessions", rule: `read:${m[1]}` } : { need: "admin", rule: `write:${m[1]}` };
  m = FULL_RE.exec(path);
  if (m) return { need: "full", rule: `full:${m[1]}` };
  return { need: "full", rule: "default" };
}

/** What a peer-listener WebSocket needs: the LLM count feed is `llm`, every other socket `sessions`. */
export function classifyUpgrade(pathname: string, search: URLSearchParams): Classified {
  if (pathname === "/ws/watch" && search.get("feed") === "llm") return { need: "llm", rule: "ws:llm" };
  if (pathname === "/ws/chat" || pathname === "/ws/watch") return { need: "sessions", rule: `ws:${pathname}` };
  return { need: "full", rule: "default" };
}

// ---- what peers deny THIS host (learnt from their answers, never from their claims) ------------

const theirs = new Map<string, { denied: Set<MeshCap>; at: number }>();

/** A peer answered `denied` to a call needing `cap`. */
export function noteDenied(peerId: string, cap: MeshCap): void {
  const t = theirs.get(peerId) ?? { denied: new Set<MeshCap>(), at: 0 };
  t.denied.add(cap);
  t.at = Date.now();
  theirs.set(peerId, t);
}

/** A peer answered a call needing `cap`: it grants it (again). */
export function noteGranted(peerId: string, cap: MeshCap): void {
  const t = theirs.get(peerId);
  if (t?.denied.delete(cap) && !t.denied.size) theirs.delete(peerId);
}

/** What `peerId` has denied this host since this server started. */
export function deniedBy(peerId: string): { denied: MeshCap[]; at: number } | null {
  const t = theirs.get(peerId);
  return t ? { denied: MESH_CAPS.filter((c) => t.denied.has(c)), at: t.at } : null;
}

/** Tests: forget what peers denied. */
export const clearDenied = (): void => theirs.clear();

/** peerFetch's rejection of a call this host's own grant withholds from the peer: never sent, so
    the peer is not down (§mesh.peers/grants). */
export class NotShared extends Error {
  constructor(readonly peerId: string) {
    super(`not shared with ${peerId}`);
    this.name = "NotShared";
  }
}

// ---- the grant API as server/sync, the pool and the details call it ----------------------------
// Through these, a mesh surface without the grant methods (an older stub) shares everything, which
// is exactly today's behaviour.

interface GrantApi {
  mayShareWith?: (peerId: string, cap: MeshCap) => boolean;
  mayShareLogin?: (peerId: string, key: string) => boolean;
  noteAnswer?: (peerId: string, cap: MeshCap, res: Response) => boolean;
}

/** Whether this host shares `cap` with `peerId` (§mesh.peers/grants). */
export const sharesWith = (mesh: GrantApi, peerId: string, cap: MeshCap): boolean => mesh.mayShareWith?.(peerId, cap) ?? true;

/** Whether login `key` is exchanged with `peerId`. */
export const sharesLogin = (mesh: GrantApi, peerId: string, key: string): boolean => mesh.mayShareLogin?.(peerId, key) ?? true;

/** Record a peer's answer to a call needing `cap`; true when it was `denied`. */
export const answerDenied = (mesh: GrantApi, peerId: string, cap: MeshCap, res: Response): boolean => mesh.noteAnswer?.(peerId, cap, res) ?? false;
