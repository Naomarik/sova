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
