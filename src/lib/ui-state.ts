// App-wide UI signals that don't belong to any one view: toasts, the polite status region,
// $HOME for path display, and per-session composer drafts.

import { createSignal } from "solid-js";
import { fetchDraft, putDraft } from "./api";
import type { UploadResult } from "../../shared/protocol";
import type { ContextState } from "./context";
import { draftCounts } from "./draft-mark";
import { createDraftSaver, type DraftPayload } from "./draft-save";
import { readKey, writeKey } from "./storage-keys";
import { makeToast, placeToast, type Toast, type ToastOptions } from "./toast";

export type { Toast, ToastOptions };

const [toasts, setToasts] = createSignal<Toast[]>([]);
let toastId = 0;

export { toasts };

/** Transient confirmation ("Copied path."). Never the only record of a fact. Its clock is the
    renderer's (ui.tsx), which pauses it under the pointer or focus; `key` replaces the toast with
    the same key (lib/toast). */
export function toast(text: string, options?: ToastOptions) {
  setToasts((list) => placeToast(list, makeToast(++toastId, text, options)));
}

export function dismissToast(id: number) {
  setToasts((list) => list.filter((x) => x.id !== id));
}

const [announcement, setAnnouncement] = createSignal("");
export { announcement };

/** Speaks through the single visually-hidden role=status region. */
export function announce(text: string) {
  // Clear first so repeating the same sentence is still announced.
  setAnnouncement("");
  queueMicrotask(() => setAnnouncement(text));
}

export const [home, setHome] = createSignal<string | null>(null);

/**
 * True while a workspace's group composer is focused or holds text. A pane composer that is
 * neither focused nor holding its own draft collapses under it: the caret is somewhere else, and N full
 * composers below one that is about to write to all of them is noise.
 *
 * App-wide rather than passed down, because the two ends are four components apart — the group
 * composer at the foot of the workspace and each pane's own composer — and threading a boolean
 * through SessionView, ChatView and WatchView would put a workspace concept in all three.
 */
export const [groupComposerActive, setGroupComposerActive] = createSignal(false);

/**
 * Running state of sessions this tab is chatting in, by path. The sidebar overlays it on the
 * server's `busy` so the open session's row changes immediately, not at the next list refetch.
 */
export const [localRunning, setLocalRunning] = createSignal<Record<string, boolean>>({});

/**
 * Context-window fill per session path, kept current by the open chat/watch view and read by the
 * session head's meter. Missing key: not known yet; null: nothing to show; "compacted": the fill
 * is stale after a compaction until the next reply.
 */
export const [sessionContext, setSessionContextMap] = createSignal<Record<string, ContextState>>({});
export const setSessionContext = (path: string, ctx: ContextState) =>
  setSessionContextMap((m) => (m[path] === ctx ? m : { ...m, [path]: ctx }));

/** Composer drafts by session path. Kept in memory so switching sessions never loses one, and the
    authority within this tab: the server copy only seeds a path this tab hasn't touched yet. */
export const drafts = new Map<string, string>();

/** The draft's uploaded attachments by session path, stored with the text. A signal, because an
    upload can land after its composer unmounted (or remounted) and the strip must still show it. */
const [attachmentsByPath, setAttachmentsByPath] = createSignal<Record<string, UploadResult[]>>({});
const NO_ATTACHMENTS: UploadResult[] = [];
export const draftAttachments = (path: string): UploadResult[] => attachmentsByPath()[path] ?? NO_ATTACHMENTS;

const storeAttachments = (path: string, list: UploadResult[]) =>
  setAttachmentsByPath((m) => {
    if (list.length === 0 && !(path in m)) return m;
    const next = { ...m };
    if (list.length) next[path] = list;
    else delete next[path];
    return next;
  });

/** Whether each session this tab knows the draft of holds one (lib/draft-mark), by path. A signal,
    unlike `drafts`, so the sidebar's pencil follows every write; a path absent here is unknown
    to this tab, and the row falls back to the listing's `hasDraft`. */
const [draftPresence, setDraftPresence] = createSignal<Record<string, boolean>>({});
export const hasLocalDraft = (path: string): boolean | undefined => draftPresence()[path];

/** Re-derives `path`'s presence from the in-memory draft. Called by every writer after it writes;
    changes the signal only when the answer does, so a keystroke doesn't re-render the list. */
const syncPresence = (path: string) => {
  const has = draftCounts(drafts.get(path) ?? "", draftAttachments(path));
  setDraftPresence((m) => (m[path] === has ? m : { ...m, [path]: has }));
};

/** Paths whose draft this tab already knows: loaded from the server, or written here. A known path
    never asks the server again, and a load that lands after a local write never overwrites it. */
const draftKnown = new Set<string>();
/** Set only while the page is being hidden, so that flush's writes can outlive the page. */
let unloading = false;
const draftSaver = createDraftSaver((path, d) => putDraft(path, d.text, d.attachments, { keepalive: unloading }).then(() => {}));

/** The whole draft goes out on every save, so a text save never drops the attachments. */
const scheduleSave = (path: string) =>
  draftSaver.schedule(path, { text: drafts.get(path) ?? "", attachments: draftAttachments(path) });

/** Writes the in-memory draft and schedules the server copy (debounced). */
export function setDraftText(path: string, text: string): void {
  draftKnown.add(path);
  if (text) drafts.set(path, text);
  else drafts.delete(path);
  syncPresence(path);
  scheduleSave(path);
}

/** Replaces the draft's attachments and schedules the server copy through the same debounce. */
export function setDraftAttachments(path: string, list: UploadResult[]): void {
  draftKnown.add(path);
  storeAttachments(path, list);
  syncPresence(path);
  scheduleSave(path);
}

/** After a send: blank text and no attachments, which deletes the stored draft. The files stay,
    since the sent prompt names them. */
export function clearDraft(path: string): void {
  draftKnown.add(path);
  drafts.delete(path);
  storeAttachments(path, []);
  syncPresence(path);
  scheduleSave(path);
}

/** This tab's list first, then anything the server has that it doesn't — by path, no duplicates. */
function mergeAttachments(local: UploadResult[], stored: UploadResult[]): UploadResult[] {
  if (stored.length === 0) return local;
  const seen = new Set(local.map((a) => a.path));
  return [...local, ...stored.filter((a) => !seen.has(a.path))];
}

/** The draft for `path`: this tab's copy when it has one, else the stored one. Never rejects. */
export async function loadDraft(path: string): Promise<DraftPayload> {
  const local = (): DraftPayload => ({ text: drafts.get(path) ?? "", attachments: draftAttachments(path) });
  if (draftKnown.has(path)) return local();
  let stored: DraftPayload = { text: "", attachments: [] };
  try {
    const r = await fetchDraft(path);
    stored = { text: r.text ?? "", attachments: r.attachments };
  } catch {
    // Unreachable server or a missing file: start empty; typing still saves.
  }
  if (draftKnown.has(path)) {
    // Typed (or sent, or restored) while the request was out: the local text wins. Stored
    // attachments still come back if this tab attached nothing, so a keystroke during the load
    // can't cost the screenshot — the save it scheduled would otherwise store an empty list.
    if (stored.attachments.length && draftAttachments(path).length === 0) setDraftAttachments(path, stored.attachments);
    return local();
  }
  draftKnown.add(path);
  if (stored.text) drafts.set(path, stored.text);
  // A load may ADD an attachment, never drop one: the server copy can be behind a save still in
  // flight, and losing a row the user can see leaves its file orphaned on disk — the worse bug.
  // (Deleting a file goes through Remove: setDraftAttachments, or clearDraft after a send.)
  storeAttachments(path, mergeAttachments(draftAttachments(path), stored.attachments));
  syncPresence(path);
  return local();
}

/** Sends every pending draft save now. */
export function flushDrafts(): void {
  draftSaver.flush();
}

// A PWA that's backgrounded or closed may never run its debounce timer again: send what's pending
// while the page is still allowed to, with keepalive so the request survives the unload.
if (typeof window !== "undefined") {
  const flushForUnload = () => {
    unloading = true;
    try {
      draftSaver.flush();
    } finally {
      unloading = false;
    }
  };
  window.addEventListener("pagehide", flushForUnload);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushForUnload();
  });
}

export async function copyText(text: string, done: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
    return true;
  } catch {
    toast("Couldn't reach the clipboard. Nothing was copied.");
    return false;
  }
}

export interface LightboxState {
  /** One row's images; the caption is each image's alt. */
  images: { src: string; alt: string }[];
  index: number;
  /** The thumbnail that opened it, focused again on close. */
  opener: HTMLElement | null;
}

/** The one image viewer; null when closed. */
export const [lightbox, setLightbox] = createSignal<LightboxState | null>(null);

export const openLightbox = (images: LightboxState["images"], index: number, opener: HTMLElement | null) =>
  setLightbox({ images, index, opener });

// ---------------------------------------------------------------------------
// Per-session view preferences
//
// Persisted so a reload keeps them: the key convention follows the sessionStorage users
// (Sidebar's ARCHIVE_KEY, the group-layout keys) — `sova:<name>-<path>`. Storage access
// is wrapped: a blocked or full localStorage must never break a render, and the in-memory map
// below is the authority within a session either way.

const PREF_PREFIX = "sova:";

function readPref(name: string, path: string): string | null {
  try {
    return readKey(localStorage, `${PREF_PREFIX}${name}-${path}`);
  } catch {
    return null;
  }
}

function writePref(name: string, path: string, value: string): void {
  try {
    writeKey(localStorage, `${PREF_PREFIX}${name}-${path}`, value);
  } catch {
    // Persistence is a convenience; the choice still holds for this session.
  }
}

/** Whether the session's transcript hides tool rows. The in-memory map wins over the stored
    value, so a toggle shows immediately and still survives a reload. No path: never hidden. */
const [hideToolsByPath, setHideToolsByPath] = createSignal<Record<string, boolean>>({});

export const hideTools = (path: string | null | undefined): boolean =>
  path ? (hideToolsByPath()[path] ?? readPref("hide-tools", path) === "1") : false;

/** Says so through the status region: rows disappearing is otherwise a silent, confusing event. */
export function setHideTools(path: string, hide: boolean): void {
  setHideToolsByPath((m) => (m[path] === hide ? m : { ...m, [path]: hide }));
  writePref("hide-tools", path, hide ? "1" : "0");
  announce(hide ? "Tool calls hidden in this session." : "Tool calls shown again.");
}

/** Whether the session's transcript hides thinking rows. Its own preference: thinking is often still
    wanted while tool cards are not. Same storage and same in-memory authority as the tool rows. */
const [hideThinkingByPath, setHideThinkingByPath] = createSignal<Record<string, boolean>>({});

export const hideThinking = (path: string | null | undefined): boolean =>
  path ? (hideThinkingByPath()[path] ?? readPref("hide-thinking", path) === "1") : false;

export function setHideThinking(path: string, hide: boolean): void {
  setHideThinkingByPath((m) => (m[path] === hide ? m : { ...m, [path]: hide }));
  writePref("hide-thinking", path, hide ? "1" : "0");
  announce(hide ? "Thinking hidden in this session." : "Thinking shown again.");
}

/** The session pane's active tab per path. A plain string, so this module knows no tab list: the
    pane narrows it to its own union. In memory only, and deliberately so — each opener sets the tab
    as it opens the pane (`openPane`), so a stored value would be overwritten before anything read
    it. The pane is never open across a reload either. */
const [activeTabByPath, setActiveTabByPath] = createSignal<Record<string, string>>({});

export const activeTab = (path: string | null | undefined): string | null => (path ? (activeTabByPath()[path] ?? null) : null);

export function setActiveTab(path: string, id: string): void {
  setActiveTabByPath((m) => (m[path] === id ? m : { ...m, [path]: id }));
}

/**
 * The ids of messages THIS TAB sent, per session — `sessionStorage`, because that is exactly the
 * scope wanted: per tab (another window must never restore a message it didn't write) and across a
 * reload (the same tab, after F5 or an HMR reload, is still the author).
 *
 * It decides who gets a failed or dropped message's text back. Held only in memory, a reload
 * between the send and the failure left NO tab willing to restore it, and the user's typed words
 * were lost with nothing said — rare, but silent, and the text exists nowhere else by then.
 * Capped, because a long session shouldn't grow an unbounded list of ids nobody will ask about:
 * the ones that matter are the recent ones, since a message is only ever in flight briefly.
 */
const SENDS_CAP = 50;
const sendsKey = (path: string) => `${PREF_PREFIX}sends-${path}`;

const readSends = (path: string): string[] => {
  try {
    const raw = readKey(sessionStorage, sendsKey(path));
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : [];
  } catch {
    // No sessionStorage (a hardened browser), or unparseable: authorship simply isn't remembered.
    return [];
  }
};

/** Records that this tab sent `id` in `path`. */
export function rememberSend(path: string, id: string): void {
  if (!id) return;
  const list = readSends(path).filter((v) => v !== id);
  list.push(id);
  try {
    writeKey(sessionStorage, sendsKey(path), JSON.stringify(list.slice(-SENDS_CAP)));
  } catch {
    // Storage full or blocked: the in-flight restore is the only thing that degrades.
  }
}

/** Whether this tab sent that message — the gate on handing its text back. */
export const sentHere = (path: string, id: string): boolean => !!id && readSends(path).includes(id);
