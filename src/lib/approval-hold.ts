import { createRoot, createSignal } from "solid-js";
import { setFolderApprovals } from "./api";
import { decideAll, type ItemKind } from "./approvals";
import { inOrder } from "./approval-overlay";

/**
 * A new chat's setup card and its composer, per session file, in this tab:
 * - "Saving…": a flip made on the card isn't saved and read back yet, so Send waits for it (a first
 *   message never goes out on the list before the flip). Nothing else holds Send: an item that is off
 *   simply stays off.
 * - the New rows its open list showed: once its first message goes in, each still New counts as left
 *   off, and is saved so (settleSeenNew).
 */

export interface Hold {
  /** A flip made here is still being saved: Send waits for it. */
  saving: true;
}

const store = createRoot(() => {
  const [holds, setHolds] = createSignal<Record<string, Hold>>({});
  const [reread, setReread] = createSignal<{ path: string; n: number } | null>(null);
  return { holds, setHolds, reread, setReread };
});

/** Whether Send waits for a save in this chat, or null. */
export const holdOf = (path: string): Hold | null => store.holds()[path] ?? null;

/** The setup card's word: null (or a hold that isn't saving) clears it. */
export function setHold(path: string, hold: { saving?: true } | null): void {
  const cur = store.holds()[path];
  const on = !!hold?.saving;
  if (on === !!cur) return;
  store.setHolds((all) => {
    const next = { ...all };
    if (on) next[path] = { saving: true };
    else delete next[path];
    return next;
  });
}

let asks = 0;
/** The chat's setup should be read again (a decision made elsewhere, the chat rebuilt). */
export const askReread = (path: string): void => void store.setReread({ path, n: ++asks });
export const rereadAsked = () => store.reread();

/** What a chat's open list showed as New, by session file: its folder (to save into) and the keys. */
interface Seen {
  cwd: string;
  queue: string;
  keys: Map<string, ItemKind>;
}
const seen = new Map<string, Seen>();

/**
 * The card's word on its New rows as they stand: `fresh` is every row New now. While its list is
 * `open`, each is noted as seen; a noted key that is no longer New (flipped, decided elsewhere) drops.
 */
export function noteSeenNew(path: string, now: { cwd: string; queue: string; fresh: { kind: ItemKind; key: string }[]; open: boolean }): void {
  const had = seen.get(path);
  const fresh = new Map(now.fresh.map((r) => [r.key, r.kind] as const));
  const keys = new Map([...(had?.keys ?? [])].filter(([k]) => fresh.has(k)));
  if (now.open) for (const [k, kind] of fresh) keys.set(k, kind);
  if (keys.size) seen.set(path, { cwd: now.cwd, queue: now.queue, keys });
  else seen.delete(path);
}

/**
 * The chat's first message went in: the New rows its list showed count as left off, saved as off for
 * the folder (turning off is open to every caller), so they stop being marked. Once per chat; a
 * failure leaves the marks.
 */
export function settleSeenNew(path: string): void {
  const s = seen.get(path);
  seen.delete(path);
  if (!s?.keys.size) return;
  const of = (kind: ItemKind) => decideAll([...s.keys].filter(([, k]) => k === kind).map(([key]) => ({ key })), "disallowed");
  void inOrder(s.queue, () => setFolderApprovals(s.cwd, { files: of("context"), skills: of("skill") })).catch(() => undefined);
}
