// A team member's inbox on the Session detail pane (§app.subagents-pane/member-inbox): the words its
// rows say, and the reader behind the Inbox tab. Read-only: nothing here marks, sends or deletes,
// and opening an item only reads its body.
import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js";
import type { TeamInboxBody, TeamInboxCounts, TeamInboxItemInfo, TeamInboxKind, TeamInboxView } from "../../shared/protocol";

export const INBOX_POLL_MS = 3000;

const KIND_WORDS: Record<TeamInboxKind, string> = {
  message: "Message",
  question: "Question",
  report: "Report",
  handover: "Handover",
  notice: "Notice",
  instruction: "Instruction",
};
export const kindWord = (k: TeamInboxKind | string): string => KIND_WORDS[k as TeamInboxKind] ?? "Message";

/** "from builder", "from main thread", "from Sova". */
export const fromWord = (it: Pick<TeamInboxItemInfo, "from">): string => `from ${it.from.role || it.from.workerId}`;

export type InboxTone = "info" | "plain" | "success";
/** The status chip: its word and tone. A returned item left this inbox for its sender; an item
    Sova's safety net closed (§app.teams/inbox-zero) reads "Closed automatically", plain. */
export function statusChip(it: Pick<TeamInboxItemInfo, "status" | "returned" | "closedBy">): { word: string; tone: InboxTone } {
  if (it.returned) return { word: "Returned to sender", tone: "plain" };
  if (it.status === "addressed") return it.closedBy === "auto" ? { word: "Closed automatically", tone: "plain" } : { word: "Addressed", tone: "success" };
  if (it.status === "read") return { word: "Read", tone: "plain" };
  return { word: "New", tone: "info" };
}

/** Whom a moved item was first sent to: "Moved from writer"; null for one sent here. */
export const movedWord = (it: Pick<TeamInboxItemInfo, "movedFrom">): string | null => {
  const first = it.movedFrom?.[0];
  return first ? `Moved from ${first.role || first.workerId}` : null;
};

/** The worker row's chip: "3 open", none at 0 or without counts. */
export const openChip = (c: TeamInboxCounts | undefined): string | null => (c && c.open > 0 ? `${c.open} open` : null);
export const openChipTitle = (n: number): string => `${n} open ${n === 1 ? "item" : "items"} in its inbox`;
/** The tab's label: "Inbox · 3 open", or "Inbox". */
export const inboxTabLabel = (c: TeamInboxCounts | undefined): string => (c && c.open > 0 ? `Inbox · ${c.open} open` : "Inbox");
export const emptyInboxText = (role: string): string => `0 items in ${role}'s inbox.`;
/** The line above the list: "2 open · 5 closed by builder · 3 closed automatically", a part at 0
    left out; null when the server sent no split (an older server) or every part is 0. */
export function inboxSummary(c: TeamInboxCounts | undefined, role: string): string | null {
  if (!c || c.closedByMember === undefined || c.closedAutomatically === undefined) return null;
  const parts = [
    c.open > 0 ? `${c.open} open` : null,
    c.closedByMember > 0 ? `${c.closedByMember} closed by ${role}` : null,
    c.closedAutomatically > 0 ? `${c.closedAutomatically} closed automatically` : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(" · ") : null;
}

export interface InboxKey {
  path: string;
  teamId: string;
  workerId: string;
}
const keyText = (k: InboxKey | null) => (k ? `${k.path}\n${k.teamId}\n${k.workerId}` : "");

export interface BodyState {
  loading: boolean;
  text?: string;
  error?: string;
}

/**
 * The Inbox tab's reader. While `active` and a key is set, the list is read at once and every
 * `pollMs`; a new key starts over (nothing of the previous member's shows). An item's body is read
 * the first time it is opened and kept; a failed body read is tried again on the next open.
 */
export function createInboxReader(opts: {
  key: () => InboxKey | null;
  active: () => boolean;
  list: (k: InboxKey) => Promise<TeamInboxView>;
  body: (k: InboxKey, id: string) => Promise<TeamInboxBody>;
  pollMs?: number;
}) {
  const [view, setView] = createSignal<TeamInboxView | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [opened, setOpened] = createSignal<ReadonlySet<string>>(new Set());
  const [bodies, setBodies] = createSignal<ReadonlyMap<string, BodyState>>(new Map());
  // A memo, so a fresh key object with the same value never starts over (agents/frontend: `on`
  // re-fires on every read signal, not on a changed value).
  const key = createMemo(() => keyText(opts.key()));
  let gen = 0;
  let inFlight = false;

  const load = async () => {
    // Untracked: the poll's effect calls this, and must follow the key's value (the memo), never
    // a fresh key object with the same value.
    const k = untrack(opts.key);
    if (!k || inFlight) return;
    const mine = gen;
    inFlight = true;
    setLoading(true);
    try {
      const v = await opts.list(k);
      if (mine !== gen) return;
      setView(v);
      setError(null);
    } catch (e) {
      if (mine === gen) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === gen) {
        setLoading(false);
        inFlight = false;
      }
    }
  };

  createEffect(() => {
    key();
    gen++;
    inFlight = false;
    setView(null);
    setError(null);
    setLoading(false);
    setOpened(new Set<string>());
    setBodies(new Map());
  });

  createEffect(() => {
    if (!key() || !opts.active()) return;
    untrack(() => void load());
    const t = setInterval(() => void load(), opts.pollMs ?? INBOX_POLL_MS);
    onCleanup(() => clearInterval(t));
  });

  const readBody = async (id: string) => {
    const k = opts.key();
    if (!k) return;
    const mine = gen;
    setBodies((m) => new Map(m).set(id, { loading: true }));
    try {
      const b = await opts.body(k, id);
      if (mine === gen) setBodies((m) => new Map(m).set(id, { loading: false, text: b.body }));
    } catch (e) {
      if (mine === gen) setBodies((m) => new Map(m).set(id, { loading: false, error: e instanceof Error ? e.message : String(e) }));
    }
  };

  const toggle = (id: string) => {
    const now = new Set(opened());
    if (now.has(id)) {
      now.delete(id);
      setOpened(now);
      return;
    }
    now.add(id);
    setOpened(now);
    const b = bodies().get(id);
    if (!b || b.error) void readBody(id);
  };

  return {
    view,
    error,
    loading,
    retry: () => void load(),
    isOpen: (id: string) => opened().has(id),
    toggle,
    body: (id: string): BodyState | undefined => bodies().get(id),
  };
}
