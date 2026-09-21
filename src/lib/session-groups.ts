// Session groups (spec/02-session-list.md §2 "Groups"): the user's own grouping of sessions, shown as a
// region above Live & web. Server-side (~/.pi/agent/pi-web/session-groups.json), so every tab and
// server sees the same groups, and purely additive: a grouped session keeps its place in Live &
// web or the Archive. A session is in at most one group.
//
// The pure part (groupSections, groupNameOf, the drag payload) runs under tsx --test; the store at
// the bottom is the tab's copy of the list, shared by the sidebar and the session pane.

import { createSignal } from "solid-js";
import type { SessionGroup, SessionSummary } from "../../shared/protocol";
import { assignSessionGroup, createSessionGroup, deleteSessionGroup, listSessionGroups, renameSessionGroup } from "./api";
import { toast } from "./ui-state";

/** One group and the sessions of it that the caller passed in (already the search hits). */
export interface GroupSection {
  group: SessionGroup;
  sessions: SessionSummary[];
}

/**
 * The pane's Groups region: one section per group, in the order of `groups` (creation order).
 * Rows keep the caller's order, so sort the list before calling (the App list is newest first).
 * A group with no sessions is kept — it is a drop target, and an empty group the user just made
 * must be visible — unless `searching`, when a section with no match is noise.
 */
export function groupSections(
  sessions: readonly SessionSummary[],
  groups: readonly SessionGroup[],
  searching: boolean,
): GroupSection[] {
  const byGroup = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    if (!s.groupId) continue;
    const list = byGroup.get(s.groupId);
    if (list) list.push(s);
    else byGroup.set(s.groupId, [s]);
  }
  return groups
    .map((group) => ({ group, sessions: byGroup.get(group.id) ?? [] }))
    .filter((section) => !searching || section.sessions.length > 0);
}

/** The name of a session's group, or null when it has none (or the group is gone). */
export function groupNameOf(groups: readonly SessionGroup[], groupId: string | undefined): string | null {
  if (!groupId) return null;
  return groups.find((g) => g.id === groupId)?.name ?? null;
}

/** "Work" — a group's name for copy, in the design system's curly quotes. */
export const quoted = (name: string) => `“${name}”`;

// ---------------------------------------------------------------------------
// Dragging a row onto a group
// ---------------------------------------------------------------------------

/** The session path is carried under this type, so the composer's image drop (which reads files)
    and this drag never mistake each other for one of their own. */
export const GROUP_DRAG_TYPE = "application/x-pi-web-session";

/** Marks a drag as "this row wants a group": the path under its own type, a readable fallback
    under text/plain (a drag out of the window, a drop on anything else). */
export function setGroupDragData(e: DragEvent, path: string): void {
  if (!e.dataTransfer) return;
  e.dataTransfer.setData(GROUP_DRAG_TYPE, path);
  e.dataTransfer.setData("text/plain", path);
  e.dataTransfer.effectAllowed = "move";
}

/** The session path a drop carries, or null when the drag is something else (files, text). */
export function groupDragPath(e: DragEvent): string | null {
  const path = e.dataTransfer?.getData(GROUP_DRAG_TYPE);
  return path ? path : null;
}

/** Whether this drag event carries one of our rows (a dragover can't read the data, only the types). */
export function dragHasRow(e: DragEvent): boolean {
  return !!e.dataTransfer?.types.includes(GROUP_DRAG_TYPE);
}

// ---------------------------------------------------------------------------
// The tab's copy of the list
// ---------------------------------------------------------------------------

const [groups, setGroups] = createSignal<SessionGroup[]>([]);
/** Every group, in creation order. Empty until `loadSessionGroups` lands (or on an older server). */
export { groups as sessionGroups };

/**
 * Fetch the list. Called at startup, when the session pane's menu opens, and by the sidebar the
 * moment a session carries a group id this tab doesn't know — that is a change made in another tab
 * or on another server. A server that predates this feature, or is unreachable, leaves the last
 * list in place.
 */
export async function loadSessionGroups(): Promise<void> {
  try {
    setGroups(await listSessionGroups());
  } catch {
    // Nothing to say: the region renders from whatever list we have.
  }
}

/** Creates a group at the end of the list; null when the server refused (a toast says why). */
export async function createGroup(name: string): Promise<SessionGroup | null> {
  try {
    const group = await createSessionGroup(name);
    setGroups((list) => [...list, group]);
    return group;
  } catch (err) {
    toast(`Couldn't create the group. ${(err as Error).message}`);
    return null;
  }
}

export async function renameGroup(id: string, name: string): Promise<boolean> {
  try {
    const group = await renameSessionGroup(id, name);
    setGroups((list) => list.map((g) => (g.id === id ? group : g)));
    return true;
  } catch (err) {
    toast(`Couldn't rename the group. ${(err as Error).message}`);
    return false;
  }
}

export async function removeGroup(id: string): Promise<boolean> {
  try {
    await deleteSessionGroup(id);
    setGroups((list) => list.filter((g) => g.id !== id));
    return true;
  } catch (err) {
    toast(`Couldn't delete the group. ${(err as Error).message}`);
    return false;
  }
}

/**
 * Puts a session in a group, or takes it out with null. The caller refreshes the session list
 * afterwards (the group a row shows comes from the list, not from here).
 */
export async function setSessionGroup(path: string, groupId: string | null): Promise<boolean> {
  try {
    await assignSessionGroup(path, groupId);
    return true;
  } catch (err) {
    toast(`Couldn't move this session. ${(err as Error).message}`);
    return false;
  }
}
