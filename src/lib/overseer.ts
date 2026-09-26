import { type AttentionDigest, OVERSEER_BRIEF_PREFIX, type SovaConfirmDetails, type SovaNavigateDetails, type TranscriptItem } from "../../shared/protocol";
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
  return { title, detail: str(details.detail), options };
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

// ---- The head's finished and drafts lists ----------------------------------------------------

/** How often the Overseer's counts are re-read: the entry button's poll, and the attention digest's (App). */
export const OVERSEER_POLL_MS = 10_000;

/** One session in the head's "N finished" or "N drafts" menu. */
export interface HeadRow {
  id: string;
  title: string;
  where: string;
  href: string;
  /** ms epoch of its newest item of the menu's kind; 0 unknown. */
  since: number;
}

/** One head menu: its rows (their count is the menu's number) and whether the digest's cap may have dropped some. */
export interface HeadList {
  rows: HeadRow[];
  cut: boolean;
}

/**
 * The head's two menus, from the attention digest's decide items, minus any session that also has
 * an act item (that one is counted as "needs you"). `finished`: a reply since last seen (kind
 * "finished"). `drafts`: an unsent draft or queued input. A session with both is in both; each
 * menu has one row per session, newest first. `cut` is true when the digest's 30-item cap dropped
 * act or decide items, so either menu may be short.
 */
export function headLists(digest: Pick<AttentionDigest, "items" | "counts">): { finished: HeadList; drafts: HeadList } {
  const needsYou = new Set(digest.items.filter((i) => i.tier === "act").map((i) => i.id));
  const finished = new Map<string, HeadRow>();
  const drafts = new Map<string, HeadRow>();
  for (const it of digest.items) {
    if (it.tier !== "decide" || needsYou.has(it.id)) continue;
    const into = it.kind === "finished" ? finished : it.kind === "draft" || it.kind === "queued" ? drafts : null;
    if (!into) continue;
    const row = into.get(it.id);
    if (row) row.since = Math.max(row.since, it.since);
    else into.set(it.id, { id: it.id, title: it.title, where: it.where, href: it.href, since: it.since });
  }
  const cut = digest.counts.act + digest.counts.decide > digest.items.length;
  const list = (m: Map<string, HeadRow>): HeadList => ({ rows: [...m.values()].sort((a, b) => b.since - a.since), cut });
  return { finished: list(finished), drafts: list(drafts) };
}

/** Alt+O opens the Overseer. `code`, not `key`: on a Mac, Option+O types "ø". */
export const isOverseerShortcut = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; code: string }) =>
  e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.code === "KeyO";

/** The proactivity cycle: Off → Badge → Brief me → Off. */
export const PROACTIVITY = ["off", "badge", "brief"] as const;
export const PROACTIVITY_LABEL = { off: "Off", badge: "Badge", brief: "Brief Me" } as const;
export const PROACTIVITY_HINT = {
  off: "No sidebar list, no briefs.",
  badge: "Lists the sessions that need you at the top of the sidebar.",
  brief: "Also starts a short brief when a session gets blocked, at most once every 10 minutes.",
} as const;
export const nextProactivity = (p: (typeof PROACTIVITY)[number]) => PROACTIVITY[(PROACTIVITY.indexOf(p) + 1) % PROACTIVITY.length]!;
