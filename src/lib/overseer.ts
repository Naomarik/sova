import { type AttentionDigest, OVERSEER_BRIEF_PREFIX, type SovaConfirmDetails, type SovaConfirmItem, type SovaNavigateDetails, type TranscriptItem } from "../../shared/protocol";
import { isObj, str } from "./message";
import { openSettings, SETTINGS_TABS, type SettingsSection, type SettingsTab } from "./settings-nav";

/** The route the Overseer lives at. Its identity is this route, never a session id. */
export const OVERSEER_HASH = "#/overseer";
export const isOverseerHash = (hash: string): boolean => hash === OVERSEER_HASH || hash.startsWith(`${OVERSEER_HASH}/`);
/** `#/overseer/h/<id>`: an old Overseer file, read-only. */
export function overseerHistoryId(hash: string): string | null {
  const m = /^#\/overseer\/h\/(.+)$/.exec(hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
}
export const overseerHistoryHref = (id: string) => `${OVERSEER_HASH}/h/${encodeURIComponent(id)}`;

/** A proactive "Brief me" prompt: a machine row, never "You", and never a turn any tab navigates on. */
export const isBriefText = (text: string | undefined): boolean => !!text && text.trimStart().startsWith(OVERSEER_BRIEF_PREFIX);
/** The brief's own words, without the prefix. */
export const briefBody = (text: string): string => text.trimStart().slice(OVERSEER_BRIEF_PREFIX.length).trim();

// ---- Tool details -------------------------------------------------------------------------

/** The `details` of a tool result: a live `tool_execution_end` result, or a persisted row's raw message. */
export function detailsOf(resultOrRaw: unknown): unknown {
  if (!isObj(resultOrRaw)) return undefined;
  if ("details" in resultOrRaw) return resultOrRaw.details;
  return isObj(resultOrRaw.message) ? resultOrRaw.message.details : undefined;
}

export function navigateDetails(details: unknown): SovaNavigateDetails | null {
  if (!isObj(details)) return null;
  const href = str(details.href);
  if (!href || !(href.startsWith("#/") || href.startsWith("settings:"))) return null;
  return { href, label: str(details.label) ?? href };
}

export function confirmDetails(details: unknown): SovaConfirmDetails | null {
  if (!isObj(details)) return null;
  const title = str(details.title);
  if (!title || !Array.isArray(details.options)) return null;
  const options = details.options.flatMap((o) => {
    if (typeof o === "string") return o.trim() ? [{ label: o }] : [];
    if (!isObj(o) || !str(o.label)?.trim()) return [];
    return [{ label: str(o.label)!, reply: str(o.reply), tone: o.tone === "danger" ? ("danger" as const) : undefined }];
  });
  if (options.length === 0) return null;
  const items = Array.isArray(details.items) ? details.items.flatMap(confirmItem) : [];
  return { title, detail: str(details.detail), options, ...(items.length ? { items } : {}), ...(details.clickOnly === true ? { clickOnly: true as const } : {}) };
}

/** One card item, tolerant: a row without its kind's id and name is dropped, bad optional fields go. */
function confirmItem(v: unknown): SovaConfirmItem[] {
  if (!isObj(v)) return [];
  const id = str(v.id)?.trim();
  if (!id) return [];
  const text = str(v.note)?.replace(/\s+/g, " ").trim();
  const note = text ? { note: text } : {};
  if (v.kind === "session") {
    const workers = typeof v.workers === "number" && Number.isFinite(v.workers) && v.workers > 0 ? Math.floor(v.workers) : undefined;
    const at = str(v.lastActiveAt);
    return [
      {
        kind: "session",
        id,
        title: str(v.title)?.trim() || id,
        ...(str(v.project)?.trim() ? { project: str(v.project)!.trim() } : {}),
        ...(at && Number.isFinite(Date.parse(at)) ? { lastActiveAt: at } : {}),
        ...(str(v.summary)?.trim() ? { summary: str(v.summary)!.trim() } : {}),
        ...(workers ? { workers } : {}),
        ...note,
      },
    ];
  }
  if (v.kind === "idea") return [{ kind: "idea", id, title: str(v.title)?.trim() ?? "", ...note }];
  if (v.kind === "todo") {
    const text = str(v.text)?.trim();
    return text ? [{ kind: "todo", id, text, ...note }] : [];
  }
  // An org's project or roster person (§app.overseer/confirm): its org is part of what it is.
  if (v.kind === "project" || v.kind === "person") {
    const orgId = str(v.orgId)?.trim();
    const name = str(v.name)?.trim();
    if (!orgId || !name) return [];
    const orgName = str(v.orgName)?.trim() || orgId;
    if (v.kind === "project") return [{ kind: "project", id, orgId, name, orgName, ...note }];
    const status = v.status === "proposed" || v.status === "left" ? v.status : "active";
    return [{ kind: "person", id, orgId, name, orgName, status, ...note }];
  }
  return [];
}

/** How many session rows a confirm card shows before "Show all". */
export const CONFIRM_SESSIONS_SHOWN = 8;

/**
 * A confirm card's rows in display order: ideas and todos first and always shown (a card's
 * effects on them, such as ticking a todo, are never behind a toggle), then the sessions, the
 * first `CONFIRM_SESSIONS_SHOWN` of them unless `all`. `collapsible`: there is a toggle (it would
 * hide 2 or more sessions; hiding 1 saves nothing). `hidden`: sessions not shown now.
 */
export function confirmRows(items: readonly SovaConfirmItem[], all: boolean): { rows: SovaConfirmItem[]; sessions: number; collapsible: boolean; hidden: number } {
  const pinned = items.filter((i) => i.kind !== "session");
  const sessions = items.filter((i) => i.kind === "session");
  const collapsible = sessions.length - CONFIRM_SESSIONS_SHOWN > 1;
  const shown = collapsible && !all ? sessions.slice(0, CONFIRM_SESSIONS_SHOWN) : sessions;
  return { rows: [...pinned, ...shown], sessions: sessions.length, collapsible, hidden: sessions.length - shown.length };
}

/** The text a confirm option sends. */
export const confirmReply = (o: SovaConfirmDetails["options"][number]): string => o.reply?.trim() || o.label;

/**
 * Whether a confirm card at `index` has been answered: any later user message on the branch
 * answers it (the model ended its turn, so the next thing the user says is the answer, clicked or
 * typed). A wake nudge or a proactive brief is not the user's answer. `choice` is the option that
 * message picked, when it is one of them.
 */
export function confirmAnswer(
  items: readonly TranscriptItem[],
  index: number,
  details: SovaConfirmDetails | null,
): { answered: boolean; choice: string | null } {
  for (let i = index + 1; i < items.length; i++) {
    const it = items[i]!;
    if (it.kind !== "user" || isBriefText(it.text)) continue;
    const text = (it.text ?? "").trim();
    const hit = details?.options.find((o) => confirmReply(o) === text || o.label === text);
    return { answered: true, choice: hit ? hit.label : null };
  }
  return { answered: false, choice: null };
}

// ---- Navigation -----------------------------------------------------------------------------

/** `settings:<tab>[/<section>]` → the Settings dialog's own arguments; null for anything else. */
export function settingsTarget(href: string): { tab: SettingsTab; section: SettingsSection | null } | null {
  const m = /^settings:([a-z]+)(?:\/([a-z-]+))?$/.exec(href);
  if (!m) return null;
  const tab = SETTINGS_TABS.find((t) => t === m[1]);
  if (!tab) return null;
  return { tab, section: m[2] === "spec" ? "spec" : null };
}

/** Follows a navigate target in this tab: Settings opens as the dialog, anything else is a route. */
export function goTo(href: string): void {
  const settings = settingsTarget(href);
  if (settings) openSettings(settings.tab, settings.section);
  else if (href.startsWith("#/")) location.hash = href;
}

/**
 * Which turn is this tab's. A navigate result moves the screen only in the tab that started the
 * running turn: this tab sent a message and the server started a turn with it (`send_ack`
 * queued:false), or took it from the queue (`queue_item_gone` delivered). Every other turn — another
 * tab's, another device's, a proactive brief, a wake nudge — never moves this tab. It also answers
 * for one turn only: the next turn starts unowned.
 */
export function createTurnOwner(sentHere: (id: string) => boolean) {
  let mine = false;
  return {
    /** The server's `send_ack` for a message. */
    ack(clientId: string, queued: boolean) {
      if (!queued && sentHere(clientId)) mine = true;
    },
    /** A `queue_item_gone`. */
    gone(itemId: string, reason: string) {
      if (reason === "delivered" && sentHere(itemId)) mine = true;
    },
    /** `agent_settled`: the turn is over, and so is this tab's claim on it. */
    settled() {
      mine = false;
    },
    /** A reconnect: nothing this tab knew about the running turn survives it. */
    reset() {
      mine = false;
    },
    mine: () => mine,
  };
}

// ---- Entry button ---------------------------------------------------------------------------

/** The entry button's words, for its title and accessible name: its own unread messages, nothing else.
    Who needs you is the sidebar's Needs you region (lib/needs-you), not the eye. */
export function overseerButtonLabel(unread: number): string {
  return unread > 0 ? `Overseer · ${unread} new ${unread === 1 ? "message" : "messages"}` : "Overseer";
}

// ---- The head's drafts list ------------------------------------------------------------------

/** How often the Overseer's counts are re-read: the entry button's poll, and the attention digest's (App). */
export const OVERSEER_POLL_MS = 10_000;

/** One session in the head's "N drafts" menu. */
export interface HeadRow {
  id: string;
  title: string;
  where: string;
  href: string;
  /** ms epoch of its newest item of the menu's kind; 0 unknown. */
  since: number;
}

/** The head's menu: its rows (their count is the menu's number) and whether the digest's cap may have dropped some. */
export interface HeadList {
  rows: HeadRow[];
  cut: boolean;
}

/**
 * The head's drafts menu, from the attention digest's decide items of kind "draft" or "queued" (an
 * unsent draft or queued input), minus any session that also has an act item (that one is counted
 * as "needs you"). One row per session, newest first. `cut` is true when the digest's 30-item cap
 * dropped act or decide items, so the menu may be short.
 */
export function headDrafts(digest: Pick<AttentionDigest, "items" | "counts">): HeadList {
  const needsYou = new Set(digest.items.filter((i) => i.tier === "act").map((i) => i.id));
  const drafts = new Map<string, HeadRow>();
  for (const it of digest.items) {
    if (it.tier !== "decide" || needsYou.has(it.id) || (it.kind !== "draft" && it.kind !== "queued")) continue;
    const row = drafts.get(it.id);
    if (row) row.since = Math.max(row.since, it.since);
    else drafts.set(it.id, { id: it.id, title: it.title, where: it.where, href: it.href, since: it.since });
  }
  const cut = digest.counts.act + digest.counts.decide > digest.items.length;
  return { rows: [...drafts.values()].sort((a, b) => b.since - a.since), cut };
}

/** Alt+O opens the Overseer. `code`, not `key`: on a Mac, Option+O types "ø". */
export const isOverseerShortcut = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string }) =>
  e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyO";

/** The proactivity cycle: Off → List Only → Brief Me → Off. */
export const PROACTIVITY = ["off", "badge", "brief"] as const;
export const PROACTIVITY_LABEL = { off: "Off", badge: "List Only", brief: "Brief Me" } as const;
export const PROACTIVITY_HINT = {
  off: "No Needs you list. The Overseer chat still works.",
  badge: "Lists the sessions that need you in the sidebar. No messages from the Overseer.",
  brief: "The list, plus an Overseer message when something new needs you, at most once every 10 minutes.",
} as const;
export const nextProactivity = (p: (typeof PROACTIVITY)[number]) => PROACTIVITY[(PROACTIVITY.indexOf(p) + 1) % PROACTIVITY.length]!;
