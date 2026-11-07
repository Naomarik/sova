// The message box's text and shell mode as one piece of state (§chat.shell-mode/box): the draft it
// opens with and saves (its mode apart from its text), the mode coming and going with the chat's
// hello, a Run and the chat's answer to it. Solid, no DOM: Composer.tsx wires it to the textarea, and
// shell-box.browser.test.ts drives it.

import { createEffect, createSignal, on, untrack } from "solid-js";
import type { ShellDraftMode } from "../../shared/protocol";
import {
  asText,
  enterOnInput,
  leaveOnKey,
  modeAnnouncement,
  NOT_CONNECTED,
  NOT_CONNECTED_YET,
  onAnswer,
  openDraft,
  runWhileBlocked,
  savedMode,
  type ShellControl,
  type ShellMode,
} from "./shell-mode";

/** A stored draft as the box reads it: its text, and the mode it was saved with. */
export interface StoredDraft {
  text: string;
  mode?: ShellDraftMode;
}

export interface ShellBoxDeps {
  /** The chat's shell mode: present while the box offers it (lib/shell-runs shellOffered). */
  shell(): ShellControl | null | undefined;
  /** This tab's copy of the draft, read now (ui-state's drafts and draftModes). */
  stored(): StoredDraft;
  /** The draft as the server has it, for a box this tab never wrote (a reload, another device). */
  load(): Promise<StoredDraft>;
  /** Saves the draft: its text, and the mode only when it is a command. */
  write(text: string, mode?: ShellDraftMode): void;
  /** Says it in the pane's polite live region. */
  announce(text: string): void;
  /** The chat's answer cleared the box: the textarea's own value follows. */
  cleared?(): void;
}

/** What Send or Enter did to a box in shell mode; `message` = the box isn't in shell mode (send it as one). */
export type RunResult = "message" | "held" | "refused" | "sent";

export function createShellBox(deps: ShellBoxDeps) {
  const opened = openDraft(deps.stored(), !!untrack(deps.shell));
  const [text, setText] = createSignal(opened.text);
  const [mode, setMode] = createSignal<ShellMode>(opened.mode);
  const shellMode = () => mode() !== "off";
  /** The Run this tab is waiting on: the box keeps the command until the chat answers (a refusal keeps it there). */
  const [pending, setPending] = createSignal<{ clientId: string; text: string; mode: ShellMode } | null>(null);
  /** Why the last Run didn't run, under the box until the command or the mode changes. */
  const [reason, setReason] = createSignal<string | null>(null);
  /** Any local write (typing, a send's clear, a restore) makes this tab's text the authority, so a
      stored draft still on its way from the server must not replace it. */
  let touched = false;

  const setDraft = (v: string) => {
    touched = true;
    setText(v);
    deps.write(v, savedMode(mode(), v));
  };
  /** Into or out of shell mode: the stored draft follows, the reason line clears and it is said. */
  const switchMode = (next: ShellMode, say = modeAnnouncement(next)) => {
    if (next === mode()) return;
    setMode(next);
    setReason(null);
    deps.write(text(), savedMode(next, text()));
    if (say) deps.announce(say);
  };
  /** The box as a message holds it, leaving shell mode: a command keeps its "!" or "!!" in view, as text. */
  const asMessage = () => {
    const t = asText(mode(), text());
    switchMode("off");
    return t;
  };

  // Nothing in memory (a reload, or another device wrote it): seed from the stored draft.
  void deps.load().then((stored) => {
    if (!stored.text || touched || text() || shellMode()) return;
    const o = openDraft(stored, !!untrack(deps.shell));
    setMode(o.mode);
    setText(o.text);
  });
  // Shell mode can arrive after the box opened (the chat's hello says it has one): a draft nobody
  // has touched opens in its mode then. Shell mode going away turns a command back into its text.
  createEffect(
    on(
      () => !!deps.shell(),
      (has) => {
        if (has && !touched && mode() === "off") {
          const o = openDraft(deps.stored(), true);
          setMode(o.mode);
          setText(o.text);
        } else if (!has && mode() !== "off") {
          // On screen only: the stored draft keeps its mode until the box is written to.
          const shown = asText(mode(), text());
          setMode("off");
          setText(shown);
          setPending(null);
          setReason(null);
        }
      },
      { defer: true },
    ),
  );
  // The chat's answer to this tab's Run: started, and the box is a message box again (unless it
  // was changed meanwhile); refused, and the command stays with the reason under it.
  createEffect(
    on(
      () => deps.shell()?.answer() ?? null,
      (a) => {
        const next = onAnswer(untrack(pending), a, { text: untrack(text), mode: untrack(mode) });
        if (next.kind === "none") return;
        setPending(null);
        if (next.kind === "refused") {
          setReason(next.reason);
          deps.announce(next.reason);
          return;
        }
        if (!next.clear) return;
        setDraft("");
        deps.cleared?.();
        switchMode("off", `Command started. ${modeAnnouncement("off")}`);
      },
      { defer: true },
    ),
  );

  return {
    text,
    mode,
    shellMode,
    pending,
    reason,
    setReason,
    setDraft,
    switchMode,
    asMessage,
    /** A message sent: the box is empty, and this tab's (empty) text is the authority. */
    sent() {
      touched = true;
      setText("");
    },
    /** What the textarea's input does: a "!" into the empty box (or a paste starting with one) enters
        shell mode, and the text it leaves is returned for the textarea; else the input is text. */
    input(value: string, inputType: string, composing: boolean): string | null {
      const entered = deps.shell() && !composing ? enterOnInput(mode(), text(), value, inputType) : null;
      if (entered) {
        switchMode(entered.mode);
        setDraft(entered.text);
        return entered.text;
      }
      if (value !== text()) setReason(null);
      setDraft(value);
      return null;
    },
    /** Backspace or Esc in the empty box leaves shell mode (from "!!", Backspace goes back to "!"). */
    key(key: string, composing: boolean): boolean {
      const left = deps.shell() && !composing ? leaveOnKey(mode(), key, text()) : null;
      if (!left) return false;
      switchMode(left);
      return true;
    },
    /**
     * Send or Enter: in shell mode the line is a command, never a message (no steer, no prompt), even
     * in a box whose chat can't run one now. `canSend`: the box takes a send now; `blocked`: why it
     * doesn't (connecting is said only to the ear, so the box says it here).
     */
    run(o: { canSend: boolean; blocked: { quiet?: boolean } | null; readOnly: boolean }): RunResult {
      if (!shellMode()) return "message";
      const shell = deps.shell();
      if (!o.canSend) {
        const why = shell && !o.readOnly && !pending() && text().trim() ? runWhileBlocked(o.blocked) : null;
        if (why) {
          setReason(why);
          deps.announce(why);
        }
        return "held";
      }
      if (!shell) {
        setReason(NOT_CONNECTED);
        deps.announce(NOT_CONNECTED);
        return "refused";
      }
      const sent = shell.run(text().trim(), mode() === "private");
      if ("refused" in sent) {
        setReason(sent.refused);
        deps.announce(sent.refused);
        return "refused";
      }
      setReason(null);
      setPending({ clientId: sent.clientId, text: text(), mode: mode() });
      return "sent";
    },
    /** "Not connected yet" answers a Run pressed while the chat connects: once it has, it is moot. */
    connected() {
      if (untrack(reason) === NOT_CONNECTED_YET) setReason(null);
    },
  };
}

export type ShellBox = ReturnType<typeof createShellBox>;
