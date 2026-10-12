import { createHash } from "node:crypto";
import { isProfileId, nameError, type SubagentProfile } from "../../pi-config/extensions/subagents/subagent-profiles.ts";

/**
 * The subagent profile library's per-profile merge (§mesh.sync/profile-library). The library file
 * keeps the shape every reader parses (`{version: 1, profiles}`); what the merge needs beside it —
 * one stamp per profile id, and a stamped deletion for a profile that left — lives in the doc
 * sync's own state as `items`, and travels with the document's manifest entry. An older build
 * ignores `items` and exchanges the whole file; what it sends is merged by union.
 */

/** One profile's stamp: its content's hash (null = deleted), when this host first saw it, and where it was made. */
export interface ItemMeta {
  hash: string | null;
  modifiedAt: number;
  origin: string;
}
export type Items = Record<string, ItemMeta>;

export interface ProfileChanges {
  added: string[];
  changed: string[];
  removed: string[];
}

/** Newer edit wins; > 0 when `a` does. The same order as whole documents (compareDocs). */
export function compareItems(a: ItemMeta, b: ItemMeta): number {
  const c = (x: number | string, y: number | string) => (x < y ? -1 : x > y ? 1 : 0);
  return c(a.modifiedAt, b.modifiedAt) || c(a.origin, b.origin) || c(a.hash ?? "", b.hash ?? "");
}

const isItem = (v: unknown): v is ItemMeta => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Partial<ItemMeta>;
  return (
    (m.hash === null || (typeof m.hash === "string" && /^[0-9a-f]{64}$/.test(m.hash))) &&
    typeof m.modifiedAt === "number" &&
    Number.isFinite(m.modifiedAt) &&
    typeof m.origin === "string" &&
    m.origin.length > 0
  );
};

/** A peer's `items`, checked: every key a profile id, every value a stamp. */
export function isItems(v: unknown): v is Items {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.entries(v).every(([id, m]) => isProfileId(id) && isItem(m));
}

/** Stable JSON: object keys sorted, so a profile hashes the same whatever order a writer used. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

export const profileHash = (p: SubagentProfile): string => createHash("sha256").update(canonical(p)).digest("hex");

/** The library's text exactly as its own writer writes it. */
export const libraryText = (profiles: SubagentProfile[]): string => `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`;

const live = (items: Items): [string, ItemMeta][] => Object.entries(items).filter(([, m]) => m.hash !== null);

/**
 * Still only an untouched starter: every profile it has is dated 0 (a seed, never edited since:
 * the seed's file is dated at the epoch, and the first look at a file dates it by its mtime).
 */
export const seedOnly = (items: Items): boolean => {
  const l = live(items);
  return l.length > 0 && l.every(([, m]) => m.modifiedAt === 0);
};
const hasEdits = (items: Items): boolean => live(items).some(([, m]) => m.modifiedAt > 0);

/**
 * Fold the library as it is on disk into its stamps. A profile whose content is new or changed is
 * stamped `stamp`; one that left becomes a deletion stamped `stamp` only when `tombstones` (an
 * edit of a library that existed), else it is forgotten (the file appeared, or vanished: neither
 * deletes anything). `profiles` null: the file is absent.
 */
export function observeItems(prev: Items | undefined, profiles: SubagentProfile[] | null, stamp: { modifiedAt: number; origin: string }, tombstones: boolean): Items {
  const out: Items = {};
  const present = new Set<string>();
  for (const p of profiles ?? []) {
    present.add(p.id);
    const hash = profileHash(p);
    const was = prev?.[p.id];
    out[p.id] = was && was.hash === hash ? was : { hash, modifiedAt: stamp.modifiedAt, origin: stamp.origin };
  }
  for (const [id, m] of Object.entries(prev ?? {})) {
    if (present.has(id)) continue;
    if (m.hash === null) out[id] = m;
    else if (tombstones && profiles) out[id] = { hash: null, modifiedAt: stamp.modifiedAt, origin: stamp.origin };
  }
  return out;
}

/**
 * The stamps a peer's library comes with: its own `items` when it sent them (they must describe
 * exactly the profiles it sent), else — an older build, which sends the whole file — each profile
 * dated by the whole document's stamp, with no deletions. null: the items contradict the file.
 */
export function remoteItems(meta: { modifiedAt: number; origin: string; items?: unknown }, profiles: SubagentProfile[]): Items | null {
  if (meta.items === undefined) {
    const out: Items = {};
    for (const p of profiles) out[p.id] = { hash: profileHash(p), modifiedAt: meta.modifiedAt, origin: meta.origin };
    return out;
  }
  if (!isItems(meta.items)) return null;
  const items = meta.items;
  const ids = new Set(profiles.map((p) => p.id));
  for (const p of profiles) if (items[p.id]?.hash !== profileHash(p)) return null;
  for (const [id] of live(items)) if (!ids.has(id)) return null;
  return items;
}

/** Whether `a` holds a profile stamp (or deletion) newer than `b`'s, i.e. `b`'s side would take something from it. */
export function itemsAhead(a: Items | undefined, b: Items | undefined): boolean {
  for (const [id, m] of Object.entries(a ?? {})) {
    const o = b?.[id];
    if (!o) {
      if (m.hash !== null) return true;
      continue; // a deletion of something `b` never had changes nothing there
    }
    if (compareItems(m, o) > 0) return true;
  }
  return false;
}

export interface Side {
  /** null: no library file. */
  profiles: SubagentProfile[] | null;
  items: Items;
}
export interface MergeResult {
  profiles: SubagentProfile[];
  items: Items;
  /** Relative to `local`, by profile name. */
  changes: ProfileChanges;
  /** The newest remote stamp that changed something here, if any. */
  cause: ItemMeta | null;
}

const MAX_NAME = 48;

/**
 * Merge a peer's library into ours, profile by profile: the newer stamp wins per id, a profile
 * only one side has is kept, a newer deletion removes, and nothing is erased because the other
 * side lacks it. Profiles keep the newer file's order. A library that is still only its starter yields to one with any edited profile
 * (its profiles are dropped, not deleted). Names left colliding are made unique (the newer keeps
 * the name; the other is renamed " (2)", … as a new edit by `self` at `now`).
 */
export function mergeLibraries(local: Side, remote: Side, self: string, now: number, remoteFirst = false): MergeResult {
  let mine = local.items;
  let theirs = remote.items;
  const drop = (items: Items): Items => Object.fromEntries(Object.entries(items).filter(([, m]) => m.hash === null));
  if (seedOnly(mine) && hasEdits(theirs)) mine = drop(mine);
  else if (seedOnly(theirs) && hasEdits(mine)) theirs = drop(theirs);

  const byId = (list: SubagentProfile[] | null) => new Map((list ?? []).map((p) => [p.id, p]));
  const localById = byId(local.profiles);
  const remoteById = byId(remote.profiles);
  const items: Items = {};
  const content = new Map<string, SubagentProfile>();
  let cause: ItemMeta | null = null;
  for (const id of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    const l = mine[id];
    const r = theirs[id];
    const win = !l ? r! : !r ? l : compareItems(r, l) > 0 ? r : l;
    items[id] = win;
    if (win.hash === null) continue;
    // The winner's content, from whichever side holds it (ours first: equal stamps, equal content).
    const fromLocal = l && l.hash === win.hash ? localById.get(id) : undefined;
    const p = fromLocal ?? (r && r.hash === win.hash ? remoteById.get(id) : undefined);
    if (p) content.set(id, p);
    else delete items[id]; // a stamp with no content on either side: nothing to keep
  }

  // The newer file's order first (ours unless `remoteFirst`), then what only the other had, in its
  // order: both sides of a merge arrive at one order.
  const order: string[] = [];
  const [first, second] = remoteFirst ? [remote, local] : [local, remote];
  for (const p of first.profiles ?? []) if (content.has(p.id)) order.push(p.id);
  for (const p of second.profiles ?? []) if (content.has(p.id) && !order.includes(p.id)) order.push(p.id);
  let profiles = order.map((id) => content.get(id)!);

  // Names unique ignoring case: the newer edit keeps a name, the rest get " (n)".
  const taken = new Set<string>();
  const ranked = [...profiles].sort((a, b) => compareItems(items[b.id]!, items[a.id]!));
  const renamed = new Map<string, SubagentProfile>();
  for (const p of ranked) {
    if (!taken.has(p.name.toLowerCase())) {
      taken.add(p.name.toLowerCase());
      continue;
    }
    let n = 2;
    let name = p.name;
    do {
      const suffix = ` (${n++})`;
      name = `${p.name.slice(0, MAX_NAME - suffix.length).trimEnd()}${suffix}`;
    } while (taken.has(name.toLowerCase()) || nameError(name));
    taken.add(name.toLowerCase());
    const next = { ...p, name };
    renamed.set(p.id, next);
    items[p.id] = { hash: profileHash(next), modifiedAt: Math.max(now, items[p.id]!.modifiedAt + 1), origin: self };
  }
  if (renamed.size) profiles = profiles.map((p) => renamed.get(p.id) ?? p);

  const changes: ProfileChanges = { added: [], changed: [], removed: [] };
  const resultById = new Map(profiles.map((p) => [p.id, p]));
  for (const p of profiles) {
    const was = localById.get(p.id);
    if (!was) changes.added.push(p.name);
    else if (profileHash(was) !== items[p.id]!.hash) changes.changed.push(p.name);
  }
  for (const p of local.profiles ?? []) if (!resultById.has(p.id)) changes.removed.push(p.name);
  // What brought the change: the newest of the peer's stamps that won over ours.
  for (const [id, m] of Object.entries(items)) {
    const l = local.items[id];
    if (theirs[id] === m && (!l || compareItems(m, l) > 0) && (!cause || compareItems(m, cause) > 0)) cause = m;
  }
  return { profiles, items, changes, cause };
}
