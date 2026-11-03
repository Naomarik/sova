import { enterSends, type EnterKey } from "./input-mode";

/**
 * The share build's message box, its pure parts (src/share/ShareComposer.tsx): which keydown sends,
 * the placeholder's key hint, the `enterkeyhint` and where the character count starts. Imports only
 * input-mode.ts (solid-js), so the share build may use it.
 */

/** "enter": Sova's own chat's keys (§chat.composer/behavior; the owner page). "mod-enter": only
    Ctrl+Enter or ⌘+Enter sends (hand-off pages, §app.baton/outsider-view). */
export type SendKey = "enter" | "mod-enter";

/** Whether this keydown sends. */
export function composerKeySends(sendKey: SendKey, e: EnterKey, touch: boolean): boolean {
  if (sendKey === "enter") return enterSends(e, touch);
  return e.key === "Enter" && (e.ctrlKey || e.metaKey);
}

/** The placeholder: with "enter" keys, the hint only while Enter sends (touch mode off). */
export function composerPlaceholder(sendKey: SendKey, base: string, touch: boolean): string {
  return sendKey === "enter" && !touch ? `${base}. Enter sends` : base;
}

/** The on-screen keyboard's Enter label: Send only while Enter sends; hand-off pages set none. */
export function composerEnterKeyHint(sendKey: SendKey, touch: boolean): "send" | "enter" | undefined {
  if (sendKey !== "enter") return undefined;
  return touch ? "enter" : "send";
}

/** The composer shows its character count only from 80% of its limit on. */
export const countFrom = (max: number): number => Math.round(max * 0.8);

/** A composer attachment as the send flow sees it. */
export interface SendAtt {
  cid: string;
  kind: "photo" | "file";
  state: string;
  id?: string;
}
export type ComposerOutcome = "sent" | "kept" | { expired: "photo" | "file" };
/** What the send flow reads and writes on the composer: its draft, its attachments, their uploads and the page's send. */
export interface SendIO<A extends SendAtt> {
  draft(): string;
  setDraft(text: string): void;
  atts(): readonly A[];
  setAtts(list: A[]): void;
  copy(list: readonly A[]): A[];
  upload(cid: string): Promise<boolean>;
  send(text: string, photos: A[], files: A[], again: boolean): Promise<ComposerOutcome>;
  /** Instant send: the box empties at once and a refusal puts it back. */
  optimistic: boolean;
}

/**
 * One Send (§app.project-assistant/chat): an instant send empties the box now and puts a refused send back,
 * its words before anything typed since. A staged photo or file that expired is uploaded again, once, and resent.
 */
export async function composerSend<A extends SendAtt>(io: SendIO<A>): Promise<void> {
  const ready = () => io.atts().filter((a) => a.state === "ready" && a.id);
  const readyOf = (kind: A["kind"]) => ready().filter((a) => a.kind === kind);
  const text = io.draft().trim();
  const taken = io.optimistic ? { text: io.draft(), atts: io.copy(io.atts()) } : null;
  /** Put a refused send back: its words before anything typed since, its photos before any added since. */
  const restore = (t: { text: string; atts: A[] }) => {
    const now = io.draft();
    io.setDraft(now.trim() ? `${t.text}\n${now}` : t.text);
    const added = io.copy(io.atts()).filter((a) => !t.atts.some((x) => x.cid === a.cid));
    io.setAtts([...t.atts, ...added]);
  };
  const photos = io.copy(readyOf("photo"));
  const files = io.copy(readyOf("file"));
  if (taken) {
    io.setAtts([]);
    io.setDraft("");
  }
  let r = await io.send(text, photos, files, false);
  if (typeof r === "object") {
    const expired = r.expired;
    if (taken) restore(taken);
    // An instant send retries only what it took; anything added while it was in flight stays in the box.
    const mine = (a: A) => !taken || taken.atts.some((t) => t.cid === a.cid);
    const again = readyOf(expired).filter(mine);
    const ok = again.length ? await Promise.all(again.map((a) => io.upload(a.cid))) : [false];
    r = ok.every(Boolean) ? await io.send(text, io.copy(readyOf("photo").filter(mine)), io.copy(readyOf("file").filter(mine)), true) : "kept";
    if (r !== "sent") return;
    if (taken) {
      // Sent: leave only what was added since the first send, the restored words taken off the front.
      const now = io.draft();
      io.setDraft(now.startsWith(taken.text) ? now.slice(taken.text.length).replace(/^\n/, "") : now);
      io.setAtts(io.atts().filter((a) => !mine(a)));
      return;
    }
  } else if (taken) {
    if (r !== "sent") restore(taken);
    return;
  }
  if (r !== "sent") return;
  io.setAtts([]);
  io.setDraft("");
}
