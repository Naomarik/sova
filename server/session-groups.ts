import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { GROUP_NAME_MAX, type SessionGroup } from "../shared/protocol";

/** The user's sidebar groups, and which session belongs to which (spec/02-session-list.md §2 "Groups").
    pi-web's own data, beside the archive and web-session id lists: the session files are never touched. */
const FILE = join(getAgentDir(), "pi-web", "session-groups.json");

/** Re-exported for the tests and the routes; defined once in the wire contract (shared/protocol.ts). */
export { GROUP_NAME_MAX };

/** On disk: `{ version: 1, groups: [...], assignments: { <session id>: <group id> } }`. */
interface Store {
  groups: SessionGroup[];
  assignments: Record<string, string>;
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

/** The file, read leniently: a missing or corrupt store is empty, and anything malformed inside it
    is dropped rather than failing a render. Assignments whose group is gone are dropped too. */
function load(): Store {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return { groups: [], assignments: {} }; // missing or corrupt: start empty
  }
  const v = isObj(raw) ? raw : {};
  const groups: SessionGroup[] = [];
  const seen = new Set<string>();
  for (const g of Array.isArray(v.groups) ? v.groups : []) {
    if (!isObj(g)) continue;
    const id = typeof g.id === "string" ? g.id : null;
    const name = cleanGroupName(g.name);
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    groups.push({ id, name, createdAt: typeof g.createdAt === "string" ? g.createdAt : new Date(0).toISOString() });
  }
  const assignments: Record<string, string> = {};
  if (isObj(v.assignments)) {
    for (const [sessionId, groupId] of Object.entries(v.assignments)) {
      if (typeof groupId === "string" && seen.has(groupId)) assignments[sessionId] = groupId;
    }
  }
  return { groups, assignments };
}

/** Atomic (tmp + rename), same as the archive and web-session lists: a crash never leaves a half file. */
function save({ groups, assignments }: Store): void {
  mkdirSync(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, groups, assignments }));
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

/** Every group, in creation order (the order the sidebar shows them in). */
export function readGroups(): SessionGroup[] {
  return load().groups;
}

/** Session id → group id, for the whole list at once (listSessions fills `groupId` from it). */
export function readAssignments(): Record<string, string> {
  return load().assignments;
}

export type GroupResult = { ok: true; group: SessionGroup } | { ok: false; status: 400 | 404; error: string };

/** POST /api/session-groups: a new, empty group at the end of the list. */
export function createGroup(rawName: unknown): GroupResult {
  const name = cleanGroupName(rawName);
  if (!name) return { ok: false, status: 400, error: `name must be 1–${GROUP_NAME_MAX} characters` };
  const group: SessionGroup = { id: randomUUID(), name, createdAt: new Date().toISOString() };
  return edit((store) => {
    store.groups.push(group);
    return { ok: true, group };
  });
}

/** PATCH /api/session-groups/:id: rename in place; the order and the assignments don't move. */
export function renameGroup(id: string, rawName: unknown): GroupResult {
  const name = cleanGroupName(rawName);
  if (!name) return { ok: false, status: 400, error: `name must be 1–${GROUP_NAME_MAX} characters` };
  return edit((store) => {
    const group = store.groups.find((g) => g.id === id);
    if (!group) return { ok: false, status: 404, error: "Group not found" };
    group.name = name;
    return { ok: true, group: { ...group } };
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

export type AssignResult = { ok: true } | { ok: false; status: 400 | 404; error: string };

/**
 * POST /api/session-groups/assign: one session, at most one group (`null` takes it out of the one
 * it's in). The group id must name an existing group; the caller has already checked the session.
 */
export function assignSession(sessionId: string, groupId: string | null): AssignResult {
  return edit((store) => {
    if (groupId === null) {
      delete store.assignments[sessionId];
      return { ok: true };
    }
    if (!store.groups.some((g) => g.id === groupId)) return { ok: false, status: 404, error: "Group not found" };
    store.assignments[sessionId] = groupId;
    return { ok: true };
  });
}

/** Forget the assignments of sessions whose files are gone (Archive cleanup). One write, not one each. */
export function dropGroupAssignments(sessionIds: readonly string[]): void {
  if (sessionIds.length === 0) return;
  edit((store) => {
    for (const id of sessionIds) delete store.assignments[id];
  });
}
