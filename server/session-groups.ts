import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { GROUP_LABEL_MAX, GROUP_NAME_MAX, type GroupMember, type GroupSeed, type SessionGroup } from "../shared/protocol";

/** The user's sidebar groups, and which session belongs to which (spec/02-session-list.md §2 "Groups").
    pi-web's own data, beside the archive and web-session id lists: the session files are never touched. */
const FILE = join(getAgentDir(), "pi-web", "session-groups.json");

/** Re-exported for the tests and the routes; defined once in the wire contract (shared/protocol.ts). */
export { GROUP_LABEL_MAX, GROUP_NAME_MAX };

/** A group as this module keeps it: `members` is always there (load reconciles it), while the
    wire type leaves it optional for older servers and hand-written store files. */
type StoredGroup = SessionGroup & { members: GroupMember[] };

/** The version this build writes into a store it created. */
const STORE_VERSION = 1;

/** On disk: `{ version: 1, groups: [...], assignments: { <session id>: <group id> } }`. */
interface Store {
  groups: StoredGroup[];
  assignments: Record<string, string>;
  /** Top-level keys this build doesn't know, kept so another version's write survives ours. */
  extra: Record<string, unknown>;
  /** The version found in the file (ours for a new one), written back unchanged. */
  version: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A trimmed, usable name, or null when it is empty or too long. Pure, so the routes and the tests
    read the rule from one place. */
export function cleanGroupName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > GROUP_NAME_MAX) return null;
  return name;
}

/** A trimmed label, or `null` to clear it (null and the empty string both clear). `ok: false` for
    anything that is not a string, or longer than the limit — the one place the rule is written. */
export function cleanGroupLabel(raw: unknown): { ok: true; label: string | null } | { ok: false } {
  if (raw === null) return { ok: true, label: null };
  if (typeof raw !== "string") return { ok: false };
  const label = raw.trim();
  if (label.length === 0) return { ok: true, label: null };
  return label.length > GROUP_LABEL_MAX ? { ok: false } : { ok: true, label };
}

/** A stored seed, read leniently: both fields must be non-empty strings or the group is simply
    not a fanout group (and so is never auto-dissolved). */
function readSeed(raw: unknown): GroupSeed | null {
  if (!isObj(raw)) return null;
  const { parentSessionPath, leafId } = raw as { parentSessionPath?: unknown; leafId?: unknown };
  if (typeof parentSessionPath !== "string" || !parentSessionPath || typeof leafId !== "string" || !leafId) return null;
  return { parentSessionPath, leafId };
}

/** One stored member entry, read leniently: anything that isn't `{ id: string }` is dropped, and a
    label that is missing, not a string, blank or too long simply isn't there. Keys we don't know
    ride along — see `passThrough`. */
function readMember(raw: unknown): GroupMember | null {
  if (!isObj(raw) || typeof raw.id !== "string") return null;
  const label = cleanGroupLabel(raw.label);
  return { ...passThrough(raw, MEMBER_KEYS), id: raw.id, ...(label.ok && label.label ? { label: label.label } : {}) };
}

/**
 * Whatever this version doesn't know about, kept verbatim. The store is written by whichever
 * pi-web is running, and they need not be the same build: a rebuild-on-load that keeps only the
 * fields it recognises DELETES a newer (or older) server's data on the next unrelated write.
 * So every object we rebuild carries its strangers with it, and the fields we do know are
 * written last, over the top.
 *
 * The consequence, which is why this is worth keeping when someone is tempted to simplify it
 * away: a fanout group's `seed` written by a newer build would be erased by an older build
 * RENAMING the group, and with it that group's fork markers and Align to Fork — silently, with
 * nothing erroring, and nobody would trace the loss back to a rename (spec §14 "Data").
 */
function passThrough(raw: Record<string, unknown>, known: readonly string[]): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!known.includes(k)) rest[k] = v;
  return rest;
}

const STORE_KEYS = ["version", "groups", "assignments"] as const;
const GROUP_KEYS = ["id", "name", "createdAt", "members", "seed", "autoDissolve"] as const;
const MEMBER_KEYS = ["id", "label"] as const;

/**
 * Members are presentation only, so they are never the truth about membership: after reading them
 * we intersect with the assignments — entries whose session left the group (or was never in it,
 * or repeats) drop out, and sessions the assignments put in the group but the metadata doesn't
 * know about are appended, in id order so two servers agree. A store written before this field
 * existed therefore reads back as a fully ordered group, not an empty one.
 */
function reconcile(groups: StoredGroup[], assignments: Record<string, string>): void {
  const wanted = new Map<string, Set<string>>(groups.map((g) => [g.id, new Set<string>()]));
  for (const [sessionId, groupId] of Object.entries(assignments)) wanted.get(groupId)?.add(sessionId);
  for (const group of groups) {
    const ids = wanted.get(group.id) ?? new Set<string>();
    const seen = new Set<string>();
    const members: GroupMember[] = [];
    for (const m of group.members) {
      if (!ids.has(m.id) || seen.has(m.id)) continue;
      seen.add(m.id);
      members.push(m);
    }
    for (const id of [...ids].filter((id) => !seen.has(id)).sort()) members.push({ id });
    group.members = members;
  }
}

/** The file, read leniently: a missing or corrupt store is empty, and anything malformed inside it
    is dropped rather than failing a render. Assignments whose group is gone are dropped too. */
function load(): Store {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return { groups: [], assignments: {}, extra: {}, version: STORE_VERSION }; // missing or corrupt: start empty
  }
  const v = isObj(raw) ? raw : {};
  const groups: StoredGroup[] = [];
  const seen = new Set<string>();
  for (const g of Array.isArray(v.groups) ? v.groups : []) {
    if (!isObj(g)) continue;
    const id = typeof g.id === "string" ? g.id : null;
    const name = cleanGroupName(g.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    const members = (Array.isArray(g.members) ? g.members : []).map(readMember).filter((m): m is GroupMember => m !== null);
    const seed = readSeed(g.seed);
    groups.push({
      ...passThrough(g, GROUP_KEYS),
      ...(seed ? { seed } : {}),
      ...(typeof g.autoDissolve === "boolean" ? { autoDissolve: g.autoDissolve } : {}),
      id,
      name,
      createdAt: typeof g.createdAt === "string" ? g.createdAt : new Date(0).toISOString(),
      members,
    });
  }
  const assignments: Record<string, string> = {};
  if (isObj(v.assignments)) {
    for (const [sessionId, groupId] of Object.entries(v.assignments)) {
      if (typeof groupId === "string" && seen.has(groupId)) assignments[sessionId] = groupId;
    }
  }
  reconcile(groups, assignments);
  // A newer writer's version number is kept as we found it: we preserve its fields, so quietly
  // stamping the file back down to ours would be a lie about what is in it.
  return { groups, assignments, extra: passThrough(v, STORE_KEYS), version: typeof v.version === "number" ? v.version : STORE_VERSION };
}

/** Atomic (tmp + rename), same as the archive and web-session lists: a crash never leaves a half file. */
function save({ groups, assignments, extra, version }: Store): void {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...extra, version, groups, assignments }));
  renameSync(tmp, FILE);
}

/**
 * Read fresh, change one thing, write — the archive's rule (`archived-sessions.ts`): another
 * server instance's writes survive ours, because we never write back a snapshot we loaded earlier.
 */
function edit<T>(change: (store: Store) => T): T {
  const store = load();
  const result = change(store);
  save(store);
  return result;
}

/** Every group, in creation order (the order the sidebar shows them in), each with its members in
    display order. */
export function readGroups(): SessionGroup[] {
  return load().groups;
}

/** Session id → group id, for the whole list at once (listSessions fills `groupId` from it). */
export function readAssignments(): Record<string, string> {
  return load().assignments;
}

export type GroupResult = { ok: true; group: SessionGroup } | { ok: false; status: 400 | 404; error: string };

/**
 * POST /api/session-groups: a new, empty group at the end of the list. `seed` is written only by
 * pi-web's own fanout (fork mode) and carries lineage; `autoDissolve` is what decides whether the
 * group is removed once emptied, and the fanout sets it only when it also chose the NAME. A group
 * the user named survives being emptied whether or not it has lineage.
 */
export function createGroup(rawName: unknown, seed?: GroupSeed, autoDissolve?: boolean): GroupResult {
  const name = cleanGroupName(rawName);
  if (!name) return { ok: false, status: 400, error: `name must be 1–${GROUP_NAME_MAX} characters` };
  const group: StoredGroup = {
    id: randomUUID(),
    name,
    createdAt: new Date().toISOString(),
    members: [],
    ...(seed ? { seed } : {}),
    ...(autoDissolve !== undefined ? { autoDissolve } : {}),
  };
  return edit((store) => {
    store.groups.push(group);
    return { ok: true, group };
  });
}

/** PATCH /api/session-groups/:id: rename in place; the order and the assignments don't move. */
export function renameGroup(id: string, rawName: unknown): GroupResult {
  return updateGroup(id, { name: rawName });
}

/** The PATCH body, still unvalidated: every field is optional, but a patch with none of them is a
    400 rather than a silent no-op. `labels` sets one label per session id (`null` clears it). */
export interface GroupPatch {
  name?: unknown;
  order?: unknown;
  labels?: unknown;
}

/**
 * PATCH /api/session-groups/:id: name, member ORDER and member LABELS, in one read-fresh-edit-write.
 * Order and labels are presentation only, so they are lenient about membership — an id that isn't
 * in the group is ignored, because a list the client drew a moment ago races with every assign and
 * every cleanup. The name rule and the label rule are the strict ones (400).
 */
export function updateGroup(id: string, patch: GroupPatch): GroupResult {
  const hasName = patch.name !== undefined;
  const hasOrder = patch.order !== undefined;
  const hasLabels = patch.labels !== undefined;
  if (!hasName && !hasOrder && !hasLabels) return { ok: false, status: 400, error: "Expected at least one of name, order, labels" };

  const name = hasName ? cleanGroupName(patch.name) : null;
  if (hasName && !name) return { ok: false, status: 400, error: `name must be 1–${GROUP_NAME_MAX} characters` };

  let order: string[] | null = null;
  if (hasOrder) {
    if (!Array.isArray(patch.order) || patch.order.some((x) => typeof x !== "string")) return { ok: false, status: 400, error: "order must be an array of session ids" };
    order = patch.order as string[];
  }

  const labels: { id: string; label: string | null }[] = [];
  if (hasLabels) {
    if (!Array.isArray(patch.labels)) return { ok: false, status: 400, error: "labels must be an array of { id, label }" };
    for (const entry of patch.labels) {
      if (!isObj(entry) || typeof entry.id !== "string") return { ok: false, status: 400, error: "labels must be an array of { id, label }" };
      const label = cleanGroupLabel(entry.label);
      if (!label.ok) return { ok: false, status: 400, error: `label must be at most ${GROUP_LABEL_MAX} characters` };
      labels.push({ id: entry.id, label: label.label });
    }
  }

  return edit((store) => {
    const group = store.groups.find((g) => g.id === id);
    if (!group) return { ok: false, status: 404, error: "Group not found" };
    if (name) group.name = name;
    if (order) {
      const byId = new Map(group.members.map((m) => [m.id, m]));
      const moved: GroupMember[] = [];
      for (const memberId of order) {
        const member = byId.get(memberId);
        if (!member) continue; // not in this group (any more): ignored, never an error
        byId.delete(memberId);
        moved.push(member);
      }
      group.members = [...moved, ...group.members.filter((m) => byId.has(m.id))]; // the rest keep their order, after
    }
    for (const { id: memberId, label } of labels) {
      const member = group.members.find((m) => m.id === memberId);
      if (!member) continue;
      if (label === null) delete member.label;
      else member.label = label;
    }
    return { ok: true, group: { ...group, members: group.members.map((m) => ({ ...m })) } };
  });
}

/** DELETE /api/session-groups/:id: the group and its assignments go; no session file is touched. */
export function deleteGroup(id: string): boolean {
  return edit((store) => {
    const at = store.groups.findIndex((g) => g.id === id);
    if (at < 0) return false;
    store.groups.splice(at, 1);
    for (const [sessionId, groupId] of Object.entries(store.assignments)) {
      if (groupId === id) delete store.assignments[sessionId];
    }
    return true;
  });
}

/** One group by id, or null. Read-only; the same reconciled shape readGroups returns. */
export function readGroup(id: string): SessionGroup | null {
  return load().groups.find((g) => g.id === id) ?? null;
}

/**
 * Give a group the seed of the fanout landing in it. Only ever called for a group that has none
 * (the caller checks, because a DIFFERING seed is a refusal rather than an overwrite): one group
 * carries one seed, since the fork marker reads it.
 *
 * Adoption also RECORDS `autoDissolve: false`, and that is not belt-and-braces. The legacy rule
 * reads an absent flag plus a seed as "a fanout group written before the flag existed", and an
 * adopted group looks exactly like that from disk — seed present, flag absent. Leaving it
 * implicit would delete a group the user named the moment its last member left, which is the
 * whole thing the flag was split out to prevent. Only ever written when absent, so an explicit
 * value already there still wins.
 */
export function adoptGroupSeed(id: string, seed: GroupSeed): SessionGroup | null {
  return edit((store) => {
    const group = store.groups.find((g) => g.id === id);
    if (!group) return null;
    group.seed ??= seed; // never overwrite: the caller has already refused a mismatch
    group.autoDissolve ??= false; // the user named this group; lineage doesn't change that
    return { ...group, members: group.members.map((m) => ({ ...m })) };
  });
}

export type AssignResult = { ok: true; dissolved?: true } | { ok: false; status: 400 | 404; error: string };

/**
 * Whether this group deletes itself when its last member leaves. `autoDissolve` is the ONE truth
 * of that, and it is set only when pi-web both created AND named the group (fanout without a
 * groupId). It used to be inferred from `seed` — but seed is lineage, and a hand-made group can
 * now adopt one, so the inference would have deleted a group the USER named. Absent means the
 * record predates the flag, and only then does `seed` imply it: those are pi-web's own fanouts.
 */
function dissolvesWhenEmpty(group: StoredGroup): boolean {
  return group.autoDissolve ?? group.seed !== undefined;
}

/**
 * Spec §14 "Emptying a group": a group pi-web fanned out exists to hold that fanout, so the write
 * that removes its last member removes the group too — in the SAME atomic write, so the store is
 * never briefly a fanout group with nothing in it. A hand-made group is left standing: its name is
 * the user's work, and §2 already specs an empty one as a real state.
 *
 * Deliberately only here, on the assign GESTURE — never on "the group happens to be empty now".
 * dropGroupAssignments prunes assignments whose session file has gone, and it runs on EVERY
 * listing pass (sessions-index.ts, listSessions), not just archive cleanup. A rule keyed on
 * emptiness rather than on the gesture would therefore let a background list refresh silently
 * delete a group the user made — with nobody listening to that call to even report it. An empty
 * fanout group is a real state instead, and the workspace offers Dissolve by hand (spec §14).
 *
 * Returns whether it dissolved, so the caller can tell the client the group it was viewing is gone.
 */
function dissolveIfEmptied(store: Store, groupId: string | null): boolean {
  if (!groupId) return false;
  const at = store.groups.findIndex((g) => g.id === groupId);
  if (at < 0) return false;
  const group = store.groups[at]!;
  if (!dissolvesWhenEmpty(group)) return false;
  if (Object.values(store.assignments).includes(groupId)) return false; // still has members
  store.groups.splice(at, 1);
  return true;
}

/**
 * POST /api/session-groups/assign: one session, at most one group (`null` takes it out of the one
 * it's in). The group id must name an existing group; the caller has already checked the session.
 * The member entry travels with the session: a move carries its label to the end of the new group
 * unless `label` says otherwise (a string sets it, `null` clears it, `undefined` keeps it). Being
 * taken out of every group drops the entry, label and all — there is nowhere to keep it.
 *
 * `index` lands the member at a position instead of the end, so Add Back (the undo for Promote)
 * restores label AND place in one write and cannot half-succeed (spec §14 "One write, not two").
 * Past the end, or omitted, means the end.
 */
export function assignSession(sessionId: string, groupId: string | null, label?: string | null, index?: number): AssignResult {
  return edit((store) => {
    // The target is checked BEFORE anything moves: a refusal still writes the store back, and it
    // must write it back unchanged.
    const group = groupId === null ? null : store.groups.find((g) => g.id === groupId);
    if (groupId !== null && !group) return { ok: false, status: 404, error: "Group not found" };
    const from = store.assignments[sessionId] ?? null; // the group this session is leaving, if any
    // Already in the target group: a re-assign must not silently reorder it. Drag-and-drop can
    // drop a grouped row back onto its own section, and a double-fire sends the same assign twice;
    // either one moving the member to the end would rewrite an order the user arranged by hand.
    // Only the label changes (when the body carried one).
    if (group && from === group.id) {
      const member = group.members.find((m) => m.id === sessionId);
      if (!member) group.members.push({ id: sessionId, ...(label ? { label } : {}) }); // reconcile normally prevents this
      else if (label === null) delete member.label;
      else if (label !== undefined) member.label = label;
      return { ok: true };
    }
    // The whole member entry travels, not just its label: anything a newer build wrote on it
    // (see passThrough) would otherwise be dropped by a move, which is the very case that work
    // exists to cover.
    let carried: GroupMember | undefined;
    for (const g of store.groups) {
      const at = g.members.findIndex((m) => m.id === sessionId);
      if (at < 0) continue;
      carried ??= g.members[at]!;
      g.members.splice(at, 1);
    }
    if (!group) {
      delete store.assignments[sessionId];
      return { ok: true, ...(dissolveIfEmptied(store, from) ? { dissolved: true as const } : {}) };
    }
    const member: GroupMember = { ...carried, id: sessionId };
    if (label === null) delete member.label; // an explicit clear
    else if (label !== undefined) member.label = label; // an explicit set; undefined keeps the carried one
    const at = index === undefined ? group.members.length : Math.min(index, group.members.length);
    group.members.splice(at, 0, member);
    store.assignments[sessionId] = group.id;
    // A move out of a fanout group empties it just as surely as an unassign does (never the
    // same-group case: that returned above).
    return { ok: true, ...(dissolveIfEmptied(store, from) ? { dissolved: true as const } : {}) };
  });
}

/** Forget the assignments of sessions whose files are gone (Archive cleanup). One write, not one each. */
export function dropGroupAssignments(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return;
  const gone = new Set(sessionIds);
  edit((store) => {
    for (const id of gone) delete store.assignments[id];
    for (const group of store.groups) group.members = group.members.filter((m) => !gone.has(m.id));
  });
}
