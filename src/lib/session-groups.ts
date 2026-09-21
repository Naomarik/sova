// Session groups (spec/02-session-list.md §2 "Groups"): the user's own grouping of sessions, shown as a
// region above Live & web. Server-side (~/.pi/agent/pi-web/session-groups.json), so every tab and
// server sees the same groups, and purely additive: a grouped session keeps its place in Live &
// web or the Archive. A session is in at most one group.
//
// The pure part (groupSections, groupNameOf, the drag payload) runs under tsx --test; the store at
// the bottom is the tab's copy of the list, shared by the sidebar and the session pane.

import { createSignal } from "solid-js";
import type { AssignGroupResult, SessionGroup, SessionSummary } from "../../shared/protocol";
import { assignSessionGroup, createSessionGroup, deleteSessionGroup, listSessionGroups, patchSessionGroup, renameSessionGroup } from "./api";
import { shortModel } from "./format";
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

/**
 * The group's sessions in DISPLAY order: `members` (the server's order) first, then anything the
 * server's list doesn't mention, in the order the caller passed. Membership is the caller's list —
 * a member id the sessions don't carry is dropped, exactly as the server reconciles its own copy.
 * An older server sends no `members` at all, and then this is the caller's order unchanged.
 */
export function orderedMembers(sessions: readonly SessionSummary[], group: SessionGroup | null | undefined): SessionSummary[] {
  const members = group?.members;
  if (!members || members.length === 0) return [...sessions];
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const out: SessionSummary[] = [];
  const seen = new Set<string>();
  for (const m of members) {
    const s = byId.get(m.id);
    if (s && !seen.has(s.id)) {
      seen.add(s.id);
      out.push(s);
    }
  }
  for (const s of sessions) if (!seen.has(s.id)) out.push(s);
  return out;
}

/**
 * What each tab SHOWS (spec/14-workspaces.md "A pane"). A tab's job is to tell one member from
 * another inside this group, and a title often can't: every member of a fork shares the source's
 * title, so a strip of five tabs reading "Retry with jitter" names nothing. The rule is the first
 * thing that distinguishes it — the label if the user set one, else the model (with a repeat
 * suffix when that model is in the group more than once) whenever members share a title, else the
 * title. Returned in the members' own order, one per member.
 */
export function tabLabels(members: readonly { title: string; model?: string | null; label?: string | null }[]): string[] {
  const titles = new Map<string, number>();
  const models = new Map<string, number>();
  for (const m of members) {
    titles.set(m.title, (titles.get(m.title) ?? 0) + 1);
    const model = shortModel(m.model);
    if (model) models.set(model, (models.get(model) ?? 0) + 1);
  }
  // Numbered over the whole group, not over the title-sharers, so a member's suffix doesn't move
  // when an unrelated member joins or leaves.
  const seen = new Map<string, number>();
  return members.map((m) => {
    const model = shortModel(m.model);
    const nth = model ? (seen.set(model, (seen.get(model) ?? 0) + 1), seen.get(model)!) : 0;
    if (m.label) return m.label;
    if ((titles.get(m.title) ?? 0) > 1 && model) return (models.get(model) ?? 0) > 1 ? `${model} #${nth}` : model;
    return m.title;
  });
}

/** The user's own word for a session inside its group ("control"), or null when it has none. */
export function memberLabel(group: SessionGroup | null | undefined, sessionId: string): string | null {
  return group?.members?.find((m) => m.id === sessionId)?.label ?? null;
}

/**
 * Writes a group's whole member order. Always the full array: the server reads `order` as "these
 * first, in this order", so a partial list moves those members to the front.
 */
export async function setGroupOrder(id: string, order: string[]): Promise<boolean> {
  try {
    const group = await patchSessionGroup(id, { order });
    setGroups((list) => list.map((g) => (g.id === id ? group : g)));
    return true;
  } catch (err) {
    toast(`Couldn't reorder this group. ${(err as Error).message}`);
    return false;
  }
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

/** Whether a load has ever finished. Until it has, "this group doesn't exist" is not yet a fact —
    the workspace route must not bounce a group it simply hasn't heard of yet. */
const [loaded, setLoaded] = createSignal(false);
export { loaded as sessionGroupsLoaded };

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
  setLoaded(true);
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
 *
 * Returns the server's answer, not just success, because one thing in it cannot be inferred from
 * the list: `dissolved` says this write emptied a fanout group and the server deleted it in the
 * same breath. Null means the write failed and a toast has already said why.
 */
export async function setSessionGroup(
  path: string,
  groupId: string | null,
  opts?: { label?: string | null; index?: number },
): Promise<AssignGroupResult | null> {
  try {
    return await assignSessionGroup(path, groupId, opts);
  } catch (err) {
    toast(`Couldn't move this session. ${(err as Error).message}`);
    return null;
  }
}
