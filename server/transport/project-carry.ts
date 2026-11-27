// What a transport carries of the project besides its code (§app.transport/arrival "Registered there"): this
// device's Sova settings for it, for a device where it isn't a registered project yet, and the host values its
// definition declares, which that device asks you for on the Transport card (§app.transport/agent). Device-only
// things never travel: host values beyond those names, the copy limit, running copies and their data, merge queue
// history and runs, landing state, and the project's settings change cards (proposals on this device's refs).
// Pure but for the deps; the live ones are in server/transport/routes.ts.

/** The project's own Sova settings as they travel: its name, its project overseer's settings and its context-file and
    skill decisions for new chats (by project-relative file, each with the hash it was decided on). */
export interface CarriedSettings {
  v: 1;
  name?: string;
  overseer?: Record<string, unknown>;
  approvals?: { context: Record<string, CarriedDecision>; skills: Record<string, CarriedDecision> };
}
export interface CarriedDecision {
  state: "approved" | "disallowed";
  sha256?: string;
  name?: string;
}

export interface CarryDeps {
  /** Every project known here, with its root (registered or placed). */
  projects(): { id: string; name: string; root: string }[];
  /** A folder's real path (symlinks resolved), or the path as named when it can't be read. */
  canonical(p: string): string;
  /** The project overseer's settings file of project `id`, parsed; null: none. */
  readOverseer(id: string): Record<string, unknown> | null;
  /** Its context-file and skill decisions (the folder `p:<id>` of the approval store); null: none. */
  readApprovals(id: string): { context: Record<string, unknown>; skills: Record<string, unknown> } | null;
  /** Register `root` as a project here, as adding a project does; resolves with its id. */
  register(root: string, name?: string): Promise<string>;
  writeOverseer(id: string, settings: Record<string, unknown>): void;
  writeApprovals(id: string, decisions: NonNullable<CarriedSettings["approvals"]>): void;
}

const MAX_BYTES = 64 * 1024;
const HOST_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const MAX_NAMES = 40;
const MAX_VALUE = 4096;
const SHA = /^[0-9a-f]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A project-relative POSIX path that never climbs out: an absolute one names a file of this device's only. */
const relKey = (k: string) => k.length > 0 && k.length <= 4096 && !k.startsWith("/") && !/[\0\n\r]/.test(k) && !k.split("/").some((s) => s === ".." || s === "" || s === ".");

function decisions(v: unknown): Record<string, CarriedDecision> {
  const out: Record<string, CarriedDecision> = {};
  if (!isObj(v)) return out;
  for (const [k, d] of Object.entries(v)) {
    if (!relKey(k) || !isObj(d) || (d.state !== "approved" && d.state !== "disallowed")) continue;
    out[k] = { state: d.state, ...(typeof d.sha256 === "string" && SHA.test(d.sha256) ? { sha256: d.sha256 } : {}), ...(typeof d.name === "string" && d.name.length <= 200 ? { name: d.name } : {}) };
  }
  return out;
}

/** The registered project whose root is `root` here, if any. */
export const projectAt = (root: string, deps: Pick<CarryDeps, "projects" | "canonical">) => {
  const r = deps.canonical(root);
  return deps.projects().find((p) => deps.canonical(p.root) === r) ?? null;
};

/** This device's settings for the project at `root`, as they travel; null when it isn't a project here. */
export function carriedSettingsOf(root: string, deps: Pick<CarryDeps, "projects" | "canonical" | "readOverseer" | "readApprovals">): CarriedSettings | null {
  const p = projectAt(root, deps);
  if (!p) return null;
  const overseer = deps.readOverseer(p.id);
  const a = deps.readApprovals(p.id);
  const approvals = a ? { context: decisions(a.context), skills: decisions(a.skills) } : null;
  const out: CarriedSettings = {
    v: 1,
    name: p.name,
    ...(overseer ? { overseer } : {}),
    ...(approvals && (Object.keys(approvals.context).length || Object.keys(approvals.skills).length) ? { approvals } : {}),
  };
  return parseCarried(out);
}

/** A carried settings bundle as the destination takes it: its known keys only, within its size; null: none usable. */
export function parseCarried(v: unknown): CarriedSettings | null {
  if (!isObj(v) || v.v !== 1) return null;
  const out: CarriedSettings = { v: 1 };
  if (typeof v.name === "string" && v.name.trim() && v.name.length <= 200) out.name = v.name.trim();
  if (isObj(v.overseer) && v.overseer.version === 1) out.overseer = v.overseer;
  if (isObj(v.approvals)) {
    const context = decisions(v.approvals.context);
    const skills = decisions(v.approvals.skills);
    if (Object.keys(context).length || Object.keys(skills).length) out.approvals = { context, skills };
  }
  return JSON.stringify(out).length > MAX_BYTES ? { v: 1, ...(out.name ? { name: out.name } : {}) } : out;
}

/** The host values that travel: the names the definition declares, and of this device's values only theirs. Pure. */
export function hostCarry(names: readonly string[], held: Record<string, string>): { names: string[]; values: Record<string, string> } | null {
  const n = [...new Set(names.filter((x) => HOST_NAME.test(x)))].slice(0, MAX_NAMES);
  if (!n.length) return null;
  const values: Record<string, string> = {};
  for (const k of n) if (typeof held[k] === "string" && held[k].length <= MAX_VALUE) values[k] = held[k];
  return { names: n, values };
}

/** The same, as the destination takes it from an offer; null: none, or malformed. Pure. */
export function parseHostCarry(v: unknown): { names: string[]; values: Record<string, string> } | null {
  if (!isObj(v) || !Array.isArray(v.names)) return null;
  const names = v.names.filter((x): x is string => typeof x === "string");
  const values = isObj(v.values) ? Object.fromEntries(Object.entries(v.values).filter((e): e is [string, string] => typeof e[1] === "string")) : {};
  return hostCarry(names, values);
}

/** One host value that device lacks, as the Transport card asks it: its name and the source's value to keep or change. */
export interface HostAsk {
  name: string;
  value: string;
}

/** What the card asks: each declared name this device doesn't hold, prefilled with the source's value ("" when the
    source had none). Pure. */
export const hostAsksOf = (carry: { names: string[]; values: Record<string, string> } | null, held: ReadonlySet<string>): HostAsk[] =>
  (carry?.names ?? []).filter((n) => !held.has(n)).map((n) => ({ name: n, value: carry!.values[n] ?? "" }));

/** The values your Save on the card writes: only names it asks, each a non-empty single line. Pure. */
export function pickHostValues(asked: readonly HostAsk[], given: unknown): Record<string, string> | string {
  if (!isObj(given)) return "values must be an object of NAME: value";
  const names = new Set(asked.map((a) => a.name));
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(given)) {
    if (!names.has(k)) return `${k} isn't a host value this transport asks for`;
    if (typeof v !== "string" || !v.length || v.length > MAX_VALUE || /[\0\n\r]/.test(v)) return `${k} must be one line of text`;
    out[k] = v;
  }
  return Object.keys(out).length ? out : "Nothing to save";
}

/**
 * The project has arrived at `root`: when no project here has that root, it is registered (as adding a project
 * does) with the carried settings; when one has, nothing of its settings changes. Never throws.
 */
export async function registerArrived(root: string, carried: CarriedSettings | null, deps: CarryDeps): Promise<{ registered: string } | { already: string } | { error: string }> {
  const at = projectAt(root, deps);
  if (at) return { already: at.id };
  try {
    const id = await deps.register(root, carried?.name);
    if (carried?.overseer) deps.writeOverseer(id, carried.overseer);
    if (carried?.approvals) deps.writeApprovals(id, carried.approvals);
    return { registered: id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
