// A chat's commands from shell mode (§chat.shell-mode/running, /card, /lifecycle, /who): the chat's half of
// pi's `!`. Only a `shell` frame from a chat socket starts one (never text, never a script's route); Sova's
// refusals come first and a refused command never runs, is never saved and never reaches the model. One
// runs at a time, at once even while the model replies; its output streams to every client, throttled;
// each run stays in memory, and in every hello, until its entry is saved (a run that ends mid-reply is
// saved after the reply), so every device, a reconnect and a server restart show it. A chat that closes
// stops its run and saves it as stopped by the close. Harness-neutral: the harness runs it (HarnessShell).
import { randomUUID } from "node:crypto";
import type { EntryId, HarnessShell, HEntry, ShellResult } from "../shared/harness";
import { SHELL_LIVE_MAX, type ChatServerMessage, type ShellOutcome, type ShellRefusal, type ShellRun, type TranscriptItem } from "../shared/protocol";
import { killGuardRefusal } from "./shell-guard";

/** How often a running command's output goes out, at most (ms). */
export const SHELL_OUTPUT_MS = 100;
/** How long a closing chat waits for its stopped command to end and be saved (ms). */
export const SHELL_CLOSE_WAIT_MS = 5_000;
/** The refusal of a second command while one runs (t21). */
export const SHELL_RUNNING_TEXT = "A command is already running in this chat.";
export const SHELL_EMPTY_TEXT = "Type a command to run.";

/** Who may hear a refusal: the sender alone. */
export interface ShellClient {
  send(msg: ChatServerMessage): void;
}

/** What the shell needs of the chat's agent: its shell, whether it replies, and stopping that reply. */
export interface ShellAgent {
  readonly shell: HarnessShell;
  isRunning(): boolean;
  abort(): Promise<void>;
}

export interface ChatShellDeps {
  harness(): ShellAgent;
  broadcast(msg: ChatServerMessage): void;
  /** Sova's refusal before anything runs (no shell mode in this chat, a terminal owns it, a foreign
      writer, closing), or null. */
  refusal(): { reason: ShellRefusal; message: string } | null;
  /** Just before the command can write its entry: the open-time appends go first. */
  beforeWrite(): void;
  /** A saved entry's rows, as an `append` carries them; `closed`: the chat's close stopped it. */
  rowsOf(entry: HEntry, closed: boolean): TranscriptItem[];
  /** Record that the chat's close stopped the command saved as `entryId`. */
  markClosed(entryId: EntryId): void;
  /** A run began or ended: what the chat's quiet reading depends on changed. */
  changed(): void;
  platform?: string;
}

interface Live {
  run: ShellRun;
  /** Output not yet sent. */
  pending: string;
  timer: NodeJS.Timeout | null;
  /** The chat's close stopped it. */
  closing: boolean;
  /** Settles once the run's entry is saved (or never will be). */
  saved: Promise<void> | null;
  /** Settles when the command ended. */
  ended: Promise<void>;
}

const outcomeOf = (r: ShellResult, closing: boolean): ShellOutcome => ({
  ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
  ...(r.cancelled ? { cancelled: true as const, cancelReason: closing ? ("closed" as const) : ("user" as const) } : {}),
  ...(r.truncated ? { truncated: r.truncated } : {}),
  ...(r.fullOutputPath ? { fullOutputPath: r.fullOutputPath } : {}),
});

export class ChatShell {
  /** Runs not saved yet, oldest first; the last may be running. */
  private readonly runs: Live[] = [];
  /** A command was taken and hasn't ended (its hook or sandbox may still be preparing). */
  private current: Live | null = null;
  private closed = false;

  constructor(private readonly deps: ChatShellDeps) {}

  /** A command runs, or one ran and isn't saved yet: the chat isn't quiet (§chat.shell-mode/lifecycle). */
  inFlight(): boolean {
    return this.current !== null || this.runs.length > 0;
  }

  /** The runs a hello carries (ProtocolChatServerMessage hello `shell`), or undefined with none. */
  snapshot(): ShellRun[] | undefined {
    if (!this.runs.length) return undefined;
    return this.runs.map((l) => ({ ...l.run, output: l.run.state === "running" ? (l.run.output + l.pending).slice(-SHELL_LIVE_MAX) : l.run.output }));
  }

  /** A `shell` frame from a chat socket. */
  start(client: ShellClient, msg: { command?: unknown; private?: unknown; clientId?: unknown }): void {
    const clientId = typeof msg.clientId === "string" ? msg.clientId : "";
    const refuse = (reason: ShellRefusal, message: string) => client.send({ type: "shell_refused", clientId, reason, message });
    const command = typeof msg.command === "string" ? msg.command : "";
    if (this.closed) return refuse("unavailable", "The chat was restarting; your command didn't run.");
    const sova = this.deps.refusal();
    if (sova) return refuse(sova.reason, sova.message);
    if (!command.trim()) return refuse("empty", SHELL_EMPTY_TEXT);
    if (this.current) return refuse("running", SHELL_RUNNING_TEXT);
    // q8: a mis-written kill is refused before it runs, as the agent's is (§chat.kill-guard/refusal).
    const kill = killGuardRefusal(command, this.deps.platform ?? process.platform, "user");
    if (kill) return refuse("kill-guard", kill);
    const harness = this.deps.harness();
    const run: ShellRun = { id: `sh_${randomUUID()}`, command, output: "", state: "running", startedAt: Date.now(), ...(msg.private === true ? { private: true as const } : {}), ...(clientId ? { clientId } : {}) };
    let endedNow!: () => void;
    const live: Live = { run, pending: "", timer: null, closing: false, saved: null, ended: new Promise((r) => (endedNow = r)) };
    this.current = live;
    this.deps.changed();
    try {
      this.deps.beforeWrite();
    } catch (err) {
      this.current = null;
      endedNow();
      this.deps.changed();
      return refuse("busy", err instanceof Error ? err.message : String(err));
    }
    harness.shell
      .run(command, {
        id: run.id,
        ...(run.private ? { private: true } : {}),
        onStart: () => {
          if (harness.isRunning()) run.underReply = true;
          this.runs.push(live);
          this.deps.broadcast({ type: "shell_start", run: { ...run }, ...(clientId ? { clientId } : {}) });
        },
        onOutput: (chunk) => this.output(live, chunk),
      })
      .then(
        (result) => {
          if ("refused" in result) {
            this.current = null;
            refuse(result.why, result.refused);
            return;
          }
          this.end(live, result);
        },
        (err) => {
          // The harness's own failure after it started: the card ends with what it said; nothing is saved.
          console.error("[chat] shell run failed", err);
          if (!this.runs.includes(live)) {
            this.current = null;
            refuse("failed", `The command couldn't run: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
          this.end(live, { output: `${run.output}${live.pending}\n${err instanceof Error ? err.message : String(err)}`, cancelled: false, saved: Promise.resolve(null) });
        },
      )
      .finally(() => {
        endedNow();
        this.deps.changed();
      });
  }

  /** The card's Stop Command: stops the running command `id`, if it still runs. */
  stop(id: string): void {
    if (!this.current || this.current.run.id !== id || this.current.run.state !== "running") return;
    this.deps.harness().shell.stop();
  }

  /** The chat is closing (archive, restart, a backend switch, a new or switched session, anything that
      disposes it): its command stops and is saved as stopped by the close, before the chat goes; a run
      waiting to be saved is waited for. Bounded; afterwards no command starts. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const harness = this.deps.harness();
    const cur = this.current;
    if (cur && cur.run.state === "running") {
      cur.closing = true;
      harness.shell.stop();
    }
    const unsaved = [...this.runs];
    if (!unsaved.length && !cur) return;
    const deadline = new Promise<void>((r) => setTimeout(r, SHELL_CLOSE_WAIT_MS).unref?.());
    if (cur) await Promise.race([cur.ended, deadline]);
    // A run that ended while the model replies is saved when the reply ends: the reply stops now, as
    // the close would stop it anyway, so the entry is written before the chat goes.
    if (unsaved.some((l) => l.run.state === "ended") && harness.isRunning()) await Promise.race([harness.abort().catch(() => {}), deadline]);
    await Promise.race([Promise.all(unsaved.map((l) => l.saved ?? Promise.resolve())), deadline]);
  }

  private output(live: Live, chunk: string): void {
    if (!chunk) return;
    live.pending += chunk;
    if (live.pending.length > SHELL_LIVE_MAX) live.pending = live.pending.slice(-SHELL_LIVE_MAX);
    if (live.timer) return;
    live.timer = setTimeout(() => this.flush(live), SHELL_OUTPUT_MS);
    live.timer.unref?.();
  }

  private flush(live: Live): void {
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    if (!live.pending) return;
    const delta = live.pending;
    live.pending = "";
    live.run.output = (live.run.output + delta).slice(-SHELL_LIVE_MAX);
    this.deps.broadcast({ type: "shell_output", id: live.run.id, delta });
  }

  private end(live: Live, result: ShellResult): void {
    this.flush(live);
    if (this.current === live) this.current = null;
    const run = live.run;
    const outcome = outcomeOf(result, live.closing);
    const pending = this.deps.harness().isRunning();
    Object.assign(run, outcome, { state: "ended" as const, output: result.output });
    // Saved after the reply in flight, or now (then right after whatever reply it ran beside).
    if (pending) run.underReply = true;
    else delete run.underReply;
    this.deps.broadcast({ type: "shell_end", id: run.id, output: run.output, ...(run.underReply ? { underReply: true as const } : {}), ...outcome });
    live.saved = result.saved.then(
      (entry) => this.saved(live, entry),
      (err) => {
        console.error("[chat] shell entry not found", err);
        this.saved(live, null);
      },
    );
  }

  private saved(live: Live, entry: HEntry | null): void {
    const i = this.runs.indexOf(live);
    if (i >= 0) this.runs.splice(i, 1);
    this.deps.changed();
    if (!entry || !entry.id) return;
    if (live.closing && entry.kind === "shell" && entry.cancelled === true) {
      try {
        this.deps.markClosed(entry.id);
      } catch (err) {
        console.error("[chat] shell close marker not written", err);
      }
    }
    // The row comes first, then the run goes: a client never shows neither.
    const items = this.deps.rowsOf(entry, live.closing && entry.kind === "shell" && entry.cancelled === true);
    if (items.length) this.deps.broadcast({ type: "append", items });
    this.deps.broadcast({ type: "shell_saved", id: live.run.id, entryId: entry.id });
  }
}
