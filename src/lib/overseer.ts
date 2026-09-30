import { OVERSEER_BRIEF_PREFIX, type SovaConfirmDetails, type SovaConfirmItem, type SovaNavigateDetails, type TranscriptItem } from "../../shared/protocol";
import { CARD_TOOL, normalizeCardDetails, openCardsOf, type CardDetails, type OverseerCard } from "../../shared/overseer-card";
import { isObj, str, toolResultView } from "./message";
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
 * A legacy `sova_confirm` card (§app.overseer/confirm, cards from before ids), read-only: whether it
 * was answered by the rule it had then. Any later user message on the branch
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

// ---- Cards (sova_card, §app.overseer/confirm) ------------------------------------------------

/** The thread's cards: each sova_card row's checked details (by the call's item id), each card's
    newest snapshot, and the row that last touched it itself (that row renders the full card). */
export interface CardFold {
  rows: Map<string, CardDetails>;
  cards: Map<string, OverseerCard>;
  newest: Map<string, string>;
}

/**
 * Folds the thread's `sova_card` results in order (a clone of the align fold): an error result and
 * details that don't check out are never state, and a legacy `sova_confirm` row is never folded.
 * `live`: this run's results not in the transcript yet, in call order.
 */
export function cardFold(items: readonly TranscriptItem[], live: readonly unknown[] = []): CardFold {
  const results = new Map<string, TranscriptItem>();
  for (const it of items) if (it.kind === "tool-result" && it.toolCallId) results.set(it.toolCallId, it);
  const fold: CardFold = { rows: new Map(), cards: new Map(), newest: new Map() };
  const put = (c: OverseerCard) => {
    fold.cards.delete(c.id);
    fold.cards.set(c.id, c);
  };
  const take = (d: CardDetails | undefined, rowId?: string) => {
    if (!d) return;
    if (rowId) fold.rows.set(rowId, d);
    if (d.closed) put(d.closed);
    if (d.card) {
      put(d.card);
      if (rowId) fold.newest.set(d.card.id, rowId);
      else fold.newest.delete(d.card.id);
    }
  };
  for (const it of items) {
    if (it.kind !== "tool-call" || it.text !== CARD_TOOL || !it.toolCallId) continue;
    const r = results.get(it.toolCallId);
    if (!r || toolResultView(r.raw, r.text).isError) continue;
    take(normalizeCardDetails(detailsOf(r.raw)), it.id);
  }
  for (const d of live) take(normalizeCardDetails(d));
  return fold;
}

/** The open cards, newest touched last. */
export const openCards = (fold: CardFold): OverseerCard[] => openCardsOf([...fold.cards.values()]);

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

// ---- Polling ---------------------------------------------------------------------------------

/** How often the Overseer's counts are re-read: the entry button's poll, and the attention digest's (App). */
export const OVERSEER_POLL_MS = 10_000;

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
