// The chat's commands from shell mode that are not saved rows yet (§chat.shell-mode/card): running,
// or ended and waiting to be saved after the reply in flight. Rebuilt from every hello, kept by the
// shell events, and dropped one by one as each run's row arrives (`shell_saved`). Pure.

import { SHELL_LIVE_MAX, type ChatClientMessage, type ChatServerMessage, type ShellRowInfo, type ShellRun, type ShellTruncation } from "../../shared/protocol";
import { thousands } from "./format";
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
  if (c.cancelled) return { word: c.cancelReason === "closed" ? "Stopped when the chat closed" : "Stopped by you", tone: "plain" };
  if (c.exitCode !== undefined) return { word: `Exit ${c.exitCode}`, tone: c.exitCode === 0 ? "plain" : "error" };
  return { word: "Ended", tone: "plain" };
}

/** What a cut output kept: "Showing the last 2,000 lines", or "Showing the last 50 KB". */
export function cutWords(t: ShellTruncation): string {
  return t.by === "lines" ? `Showing the last ${thousands(t.max)} lines` : `Showing the last ${thousands(Math.round(t.max / 1024))} KB`;
}

/** The note a command run while the model replies carries until that reply ends (not for `!!`). */
export const AFTER_REPLY = "The model gets this after its reply.";
export const NOT_SHARED = "Not shared with the model";

/** The card's notes, in order: what a cut kept (and where the whole went), `!!`, and the mid-reply note. */
export function shellNotes(c: ShellCardData & { underReply?: boolean }, replying: boolean): { cut?: string; fullOutputPath?: string; notShared: boolean; afterReply: boolean } {
  return {
    ...(c.truncated ? { cut: cutWords(c.truncated) } : {}),
    ...(c.truncated && c.fullOutputPath ? { fullOutputPath: c.fullOutputPath } : {}),
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
