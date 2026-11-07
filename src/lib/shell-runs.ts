// The chat's commands from shell mode that are not saved rows yet (§chat.shell-mode/card): running,
// or ended and waiting to be saved after the reply in flight. Rebuilt from every hello, kept by the
// shell events, and dropped one by one as each run's row arrives (`shell_saved`). Pure.

import { SHELL_LIVE_MAX, SHELL_OUTPUT_MAX_BYTES, type ChatClientMessage, type ChatServerMessage, type ShellRowInfo, type ShellRun } from "../../shared/protocol";
import { NOT_CONNECTED, type ShellAnswer } from "./shell-mode";

/** The frame a Run sends: the command without its "!" or "!!", `private` only for "!!". */
export function shellFrame(command: string, priv: boolean, clientId: string): Extract<ChatClientMessage, { type: "shell" }> {
  return { type: "shell", command, ...(priv ? { private: true } : {}), clientId };
}

/**
 * A Run from the box (§chat.shell-mode/who): its frame goes over the live socket and nowhere else
 * (never into the outbox a waking chat takes); several may run at once. The id it went with, or why it
 * didn't go: the command stays in the box and the reason shows under it.
 */
export function runShell(
  o: { open: boolean; send(frame: Extract<ChatClientMessage, { type: "shell" }>): boolean; newId(): string },
  command: string,
  priv: boolean,
): { clientId: string } | { refused: string } {
  if (!o.open) return { refused: NOT_CONNECTED };
  const clientId = o.newId();
  return o.send(shellFrame(command, priv, clientId)) ? { clientId } : { refused: NOT_CONNECTED };
}

type ShellMessage = Extract<ChatServerMessage, { type: "hello" | "shell_start" | "shell_output" | "shell_end" | "shell_saved" }>;

/** The live runs after `msg`, or null when `msg` doesn't touch them. */
export function nextShellRuns(runs: readonly ShellRun[], msg: ChatServerMessage): ShellRun[] | null {
  const m = msg as ShellMessage;
  switch (m.type) {
    case "hello":
      return [...(m.shell ?? [])];
    case "shell_start":
      return [...runs.filter((r) => r.id !== m.run.id), m.run];
    case "shell_output":
      return runs.map((r) => (r.id === m.id && r.state === "running" ? { ...r, output: (r.output + m.delta).slice(-SHELL_LIVE_MAX) } : r));
    case "shell_end": {
      const { type: _type, id, ...ended } = m;
      return runs.map((r) => (r.id === id ? { ...r, ...ended, state: "ended" } : r));
    }
    case "shell_saved":
      return runs.filter((r) => r.id !== m.id);
    default:
      return null;
  }
}

/**
 * Stop Command on a running command's card or window (§chat.shell-mode/card): its `shell_stop` goes
 * over the chat socket, once; the card then waits for the end, Stop Command held, and a press while
 * it waits sends nothing. The stopping set after the press.
 */
export function stopRun(stopping: ReadonlySet<string>, id: string, send: (frame: Extract<ChatClientMessage, { type: "shell_stop" }>) => boolean): ReadonlySet<string> {
  if (stopping.has(id)) return stopping;
  return send({ type: "shell_stop", id }) ? new Set([...stopping, id]) : stopping;
}

/** Stop All on the running list: each running command's own stop, as Stop Command sends it (no route
    of its own). The stopping set after. */
export function stopAll(stopping: ReadonlySet<string>, runs: readonly ShellRun[], send: (frame: Extract<ChatClientMessage, { type: "shell_stop" }>) => boolean): ReadonlySet<string> {
  return runs.filter((r) => r.state === "running").reduce((s, r) => stopRun(s, r.id, send), stopping);
}

/** What the running bar offers: with exactly 1 command running, Show Output (its window) and Stop
    Command, and no list; with more, Show All / Hide for the list, and Stop All while the list is open. */
export interface BarButtons {
  showOutput: boolean;
  stop: boolean;
  showAll: boolean;
  stopAll: boolean;
}

export function barButtons(running: number, open: boolean): BarButtons {
  if (running === 1) return { showOutput: true, stop: true, showAll: false, stopAll: false };
  if (running > 1) return { showOutput: false, stop: false, showAll: true, stopAll: open };
  return { showOutput: false, stop: false, showAll: false, stopAll: false };
}

/** A duration as a clock: "0:07", "12:30", "1:02:05". */
export function clock(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A finished card's output: its last `n` lines (a trailing newline ends the last, it starts none). */
export function lastLines(output: string, n = 3): string {
  const lines = output.replace(/\n$/, "").split("\n");
  return lines.slice(-n).join("\n");
}

/** The runs still stopping after the live runs changed: only those still running wait. */
export function stillStopping(stopping: ReadonlySet<string>, runs: readonly ShellRun[]): ReadonlySet<string> {
  const running = new Set(runs.filter((r) => r.state === "running").map((r) => r.id));
  return [...stopping].every((id) => running.has(id)) ? stopping : new Set([...stopping].filter((id) => running.has(id)));
}

/** The chat closed (archived, restarted, switched): its running commands were stopped with it, and
    their cards say so at once, before the saved rows come with the next hello. */
export function stopOnClose(runs: readonly ShellRun[]): ShellRun[] {
  return runs.map((r) => (r.state === "running" ? { ...r, state: "ended", cancelled: true, cancelReason: "closed" } : r));
}

/** The answer a composer waits on: its own Run started (the start carries its id) or was refused. */
export function shellAnswerOf(msg: ChatServerMessage): ShellAnswer | null {
  if (msg.type === "shell_start" && msg.clientId) return { clientId: msg.clientId };
  if (msg.type === "shell_refused") return { clientId: msg.clientId, refused: msg.message };
  return null;
}

/** The connection went before the chat answered a Run: the command may or may not have started. */
export const SHELL_DROPPED = "The connection dropped before the chat answered. Check the chat before you run it again.";

/**
 * The Runs this tab still waits on when a hello comes (its connection dropped in between): one the
 * hello's runs carry by its id started; any other is answered with SHELL_DROPPED, since it may have
 * run and ended meanwhile, and the command stays in the box.
 */
export function answersAtHello(waiting: Iterable<string>, runs: readonly ShellRun[]): ShellAnswer[] {
  const started = new Set(runs.flatMap((r) => (r.clientId ? [r.clientId] : [])));
  return [...waiting].map((clientId) => (started.has(clientId) ? { clientId } : { clientId, refused: SHELL_DROPPED }));
}

/** A running command's newest output line, as a terminal shows it: the last line with text, and of a
    line a progress bar redraws (carriage returns), only what was drawn last. Empty: nothing yet. */
export function lastLine(output: string): string {
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const drawn = lines[i]!.split("\r").filter((p) => p.trim() !== "").pop();
    if (drawn) return drawn.trimEnd();
  }
  return "";
}

/** What a card draws, from a live run or a saved row. */
export interface ShellCardData extends ShellRowInfo {
  running: boolean;
}

export const cardOfRun = (r: ShellRun): ShellCardData => ({ ...r, running: r.state === "running" });
export const cardOfRow = (row: ShellRowInfo): ShellCardData => ({ ...row, running: false });

/** The card's status: while it runs, `Running` with the live dot; then how it ended (§chat.shell-mode/card). */
export function shellStatus(c: ShellCardData): { word: string; tone: "live" | "error" | "plain" } {
  if (c.running) return { word: "Running", tone: "live" };
  if (c.cancelled && c.cancelReason === "limit") return { word: LIMIT_WORD, tone: "error" };
  if (c.cancelled && c.cancelReason === "closed") return { word: "Stopped when the chat closed", tone: "plain" };
  // Stopped from outside this page (a script, a chat, the Overseer through Stop Command): no "by you".
  if (c.cancelled && c.cancelReason === "other") return { word: "Stopped", tone: "plain" };
  if (c.cancelled) return { word: "Stopped by you", tone: "plain" };
  if (c.exitCode !== undefined) return { word: `Exit ${c.exitCode}`, tone: c.exitCode === 0 ? "plain" : "error" };
  return { word: "Ended", tone: "plain" };
}

/** A command stopped for printing more than SHELL_OUTPUT_MAX_BYTES: Sova stopped it, not you. */
export const LIMIT_WORD = `Stopped at the ${Math.round(SHELL_OUTPUT_MAX_BYTES / 1e9)} GB output limit`;

/** The note a command run while the model replies carries until that reply ends (not for `!!`). */
export const AFTER_REPLY = "The model gets this after its reply.";
export const NOT_SHARED = "Not shared with the model";

/** The card's notes, in order: `!!`, and the mid-reply note. */
export function shellNotes(c: ShellCardData & { underReply?: boolean }, replying: boolean): { notShared: boolean; afterReply: boolean } {
  return {
    notShared: !!c.private,
    afterReply: !!c.underReply && replying && !c.private,
  };
}

/** Whether a chat's box offers shell mode (§chat.shell-mode/box). The chat's hello decides (`shellMode`):
    false once a hello lacks it, as a project assistant's, the Overseer's or a gathering session's does, and an
    older server's. Before this view's first hello, what the view knows of the chat: no Overseer, project
    overseer or gathering session, and no baton holding the composer. */
export function shellOffered(o: { helloShellMode: boolean | null; overseer?: boolean; projectOverseer?: boolean; baton?: boolean; batonHeld?: boolean }): boolean {
  return (o.helloShellMode ?? true) && !o.overseer && !o.projectOverseer && !o.baton && !o.batonHeld;
}
