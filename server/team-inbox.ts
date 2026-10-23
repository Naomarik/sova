// A team member's inbox, read-only (§app.subagents-pane/member-inbox). The main chat's subagents
// extension is the only writer of each member's `items.jsonl`; this server only folds those files,
// with the extension's own fold (pi-config/extensions/subagents/inbox.ts, node builtins only), and
// never writes, renames or compacts them.
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { foldItemsText, isOpen, type InboxItem } from "../pi-config/extensions/subagents/inbox.ts";
import type { TeamInboxBody, TeamInboxCounts, TeamInboxItemInfo, TeamInboxView, TeamInfo } from "../shared/protocol";

/** The newest items a list answer carries; `total` still counts them all. */
export const INBOX_LIST_CAP = 500;
/** A team or worker id, or an item id, as a path segment: never a separator or a dot-dot. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const validSegment = (s: string | undefined): s is string => !!s && SEGMENT.test(s);

/** `<agentDir>/sova/teams/<session key>/mailbox`: where the main chat's extension keeps its
    members' folders. A session the extension never saved (no id) has no folder this can name. */
export function mailboxRootOf(agentDir: string, sessionId: string | null): string | null {
  if (!sessionId) return null;
  // The extension's sessionDirKey (subagents/coordination.ts), with no fallback: an unsaved
  // session's folder is named by a key only its own process knows.
  const key = sessionId.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._-]+/, "").slice(0, 128);
  return key ? join(agentDir, "sova", "teams", key, "mailbox") : null;
}
export const itemsFileOf = (root: string, teamId: string, workerId: string): string => join(root, teamId, workerId, "items.jsonl");

/** The folded files, by path, kept while their size and mtime stay the same: the pane polls every
    3 s and a busy team's file only grows. Bounded so a server that browses many sessions forgets. */
const cache = new Map<string, { size: number; mtimeMs: number; ino: number; items: InboxItem[] }>();
const CACHE_MAX = 256;

/** One member's folded items, oldest id first; null when the member has no items file. Never throws:
    an unreadable file reads as none, a torn or unknown line is skipped by the fold. */
export async function readItems(file: string): Promise<InboxItem[] | null> {
  let st;
  try {
    st = await stat(file);
  } catch {
    cache.delete(file);
    return null;
  }
  if (!st.isFile()) return null;
  const hit = cache.get(file);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs && hit.ino === st.ino) return hit.items;
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return null;
  }
  const items = [...foldItemsText(text).values()];
  cache.delete(file);
  cache.set(file, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, items });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  return items;
}

export function countsOf(items: InboxItem[]): TeamInboxCounts {
  let open = 0;
  let urgent = 0;
  for (const it of items) {
    if (!isOpen(it)) continue;
    open++;
    if (it.urgent) urgent++;
  }
  return { open, urgent, total: items.length };
}

/** `i_<base36>` ids grow with time across the whole main chat; anything else sorts after them by text. */
const idRank = (id: string): number => {
  const m = /^i_([0-9a-z]+)$/.exec(id);
  return m?.[1] ? parseInt(m[1], 36) : -1;
};
/** Newest first: by when it was sent, then by id (a later id was queued later). */
export const newestFirst = (a: InboxItem, b: InboxItem): number => b.sentAt - a.sentAt || idRank(b.id) - idRank(a.id) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** The wire form of an item: everything but its body. */
export function itemInfo(it: InboxItem): TeamInboxItemInfo {
  return {
    id: it.id,
    from: { role: it.from.role, workerId: it.from.workerId },
    kind: it.kind,
    subject: it.subject,
    urgent: !!it.urgent,
    status: it.status,
    sentAt: it.sentAt,
    ...(it.readAt !== undefined ? { readAt: it.readAt } : {}),
    ...(it.addressedAt !== undefined ? { addressedAt: it.addressedAt } : {}),
    ...(it.note ? { note: it.note } : {}),
    ...(it.replyTo ? { replyTo: it.replyTo } : {}),
    ...(it.movedFrom && it.movedFrom.length > 0 ? { movedFrom: it.movedFrom.map((m) => ({ role: m.role, workerId: m.workerId, at: m.at, why: m.why })) } : {}),
    ...(it.returned ? { returned: { at: it.returned.at, why: it.returned.why } } : {}),
  };
}

export function inboxView(teamId: string, workerId: string, items: InboxItem[]): TeamInboxView {
  const sorted = [...items].sort(newestFirst);
  return { teamId, workerId, items: sorted.slice(0, INBOX_LIST_CAP).map(itemInfo), total: items.length, counts: countsOf(items) };
}

export function inboxBody(items: InboxItem[], id: string): TeamInboxBody | null {
  const it = items.find((x) => x.id === id);
  return it ? { id: it.id, body: it.body } : null;
}

/** Each member's counts on the session's teams, in place; a member with no items file gets none. */
export async function addInboxCounts(teams: TeamInfo[], root: string | null): Promise<void> {
  if (!root) return;
  await Promise.all(
    teams.flatMap((t) =>
      validSegment(t.id)
        ? t.members.map(async (m) => {
            if (!validSegment(m.workerId)) return;
            const items = await readItems(itemsFileOf(root, t.id, m.workerId));
            if (items) m.inbox = countsOf(items);
          })
        : [],
    ),
  );
}
