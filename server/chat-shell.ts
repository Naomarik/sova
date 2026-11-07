// A chat's commands from shell mode (§chat.shell-mode/running, /card, /lifecycle, /who): the chat's half of
// pi's `!`. Only a `shell` frame from a chat socket starts one (never text, never a script's route); Sova's
// refusals come first and a refused command never runs, is never saved and never reaches the model. Any
// number run at once, each at once even while the model replies and each stopped on its own; output streams
// to every client, throttled, and a run whose output passes SHELL_OUTPUT_MAX_BYTES is stopped;
// each run stays in memory, and in every hello, until its entry is saved (a run that ends mid-reply is
// saved after the reply), so every device, a reconnect and a server restart show it. A chat that closes
// stops its runs (one still being prepared never starts) and saves each as stopped by the close. Harness-neutral: the harness runs it (HarnessShell).
import { randomUUID } from "node:crypto";
import type { EntryId, HarnessShell, HEntry, ShellResult } from "../shared/harness";
import { SHELL_CLOSING_TEXT } from "../shared/chat-runtime";
import { SHELL_LIVE_MAX, SHELL_OUTPUT_MAX_BYTES, type ChatServerMessage, type ShellOutcome, type ShellRefusal, type ShellRun, type TranscriptItem } from "../shared/protocol";
import { killGuardRefusal } from "./shell-guard";

/** How often a running command's output goes out, at most (ms). */
export const SHELL_OUTPUT_MS = 100;
/** How long a closing chat waits for its stopped command to end and be saved (ms). */
export const SHELL_CLOSE_WAIT_MS = 5_000;
export const SHELL_EMPTY_TEXT = "Type a command to run.";
/** A `shell` frame from a socket that is neither the page nor a peer (server/ws.ts, §chat.shell-mode/who). */
export const SHELL_NOT_PAGE_TEXT = "Only the message box can run a command. Ask the user to type it in shell mode in this chat's message box. Nothing ran.";

/** The output limit: SHELL_OUTPUT_MAX_BYTES, or SOVA_SHELL_OUTPUT_MAX_BYTES (a test's smaller one) when set. */
export function shellOutputMaxBytes(): number {
  const n = Number(process.env.SOVA_SHELL_OUTPUT_MAX_BYTES);
  return Number.isSafeInteger(n) && n > 0 ? n : SHELL_OUTPUT_MAX_BYTES;
}

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
  /** A saved entry's rows, as an `append` carries them; `stopped`: why it was stopped, when not by its page's
      Stop; `durationMs`: how long it ran. */
  rowsOf(entry: HEntry, stopped: StopReason | null, durationMs: number | undefined): TranscriptItem[];
  /** Record what pi's record doesn't say of the command saved as `entryId`: how long it ran, and why it was
      stopped when not by its page's Stop (the chat's close, the output limit, the Stop Command entry). */
  markRun(entryId: EntryId, facts: { durationMs?: number; stopped?: StopReason }): void;
  platform?: string;
  /** The output limit (SHELL_OUTPUT_MAX_BYTES); a test's is smaller. */
  maxBytes?: number;
}

/** Why a command was stopped when its own page's Stop Command didn't stop it. */
export type StopReason = "closed" | "limit" | "other";

interface Live {
  run: ShellRun;
  /** Output not yet sent. */
  pending: string;
  timer: NodeJS.Timeout | null;
  /** Stops this run alone (its Stop Command, the chat's close). */
  stop: AbortController;
  /** The chat's close stopped it. */
  closing: boolean;
  /** Its output passed the limit and Sova stopped it. */
  limited: boolean;
  /** The Stop Command entry stopped it, from outside the chat's pages. */
  byOther: boolean;
  /** Settles once the run's entry is saved (or never will be). */
  saved: Promise<void> | null;
  /** Settles when the command ended. */
  ended: Promise<void>;
}

const stopReasonOf = (live: Live): StopReason | null => (live.closing ? "closed" : live.limited ? "limit" : live.byOther ? "other" : null);

const outcomeOf = (r: ShellResult, live: Live): ShellOutcome => ({
  ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
  ...(r.cancelled ? { cancelled: true as const, cancelReason: stopReasonOf(live) ?? ("user" as const) } : {}),
  ...(r.truncated ? { truncated: r.truncated } : {}),
  ...(r.fullOutputPath ? { fullOutputPath: r.fullOutputPath } : {}),
  durationMs: Math.max(0, Date.now() - live.run.startedAt),
});

export class ChatShell {
  /** Runs not saved yet, oldest first, running or ended. */
  private readonly runs: Live[] = [];
  /** Commands taken that haven't ended (a hook or the sandbox may still be preparing one), by run id. */
  private readonly active = new Map<string, Live>();
  private closing: Promise<void> | null = null;

  constructor(private readonly deps: ChatShellDeps) {}

  /** A command runs, or one ran and isn't saved yet: the chat isn't quiet (§chat.shell-mode/lifecycle). */
  inFlight(): boolean {
    return this.active.size > 0 || this.runs.length > 0;
  }

  /** A command runs, or is being prepared: what keeps a chat whose server is gone alive (§chat.shell-mode/lifecycle). */
  running(): boolean {
    return this.active.size > 0;
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
    if (this.closing) return refuse("unavailable", SHELL_CLOSING_TEXT);
    const sova = this.deps.refusal();
    if (sova) return refuse(sova.reason, sova.message);
    if (!command.trim()) return refuse("empty", SHELL_EMPTY_TEXT);
    // q8: a mis-written kill is refused before it runs, as the agent's is (§chat.kill-guard/refusal).
    const kill = killGuardRefusal(command, this.deps.platform ?? process.platform, "user");
    if (kill) return refuse("kill-guard", kill);
    const harness = this.deps.harness();
    const run: ShellRun = { id: `sh_${randomUUID()}`, command, output: "", state: "running", startedAt: Date.now(), ...(msg.private === true ? { private: true as const } : {}), ...(clientId ? { clientId } : {}) };
    let endedNow!: () => void;
    const live: Live = { run, pending: "", timer: null, stop: new AbortController(), closing: false, limited: false, byOther: false, saved: null, ended: new Promise((r) => (endedNow = r)) };
    try {
      this.deps.beforeWrite();
    } catch (err) {
      return refuse("busy", err instanceof Error ? err.message : String(err));
    }
    this.active.set(run.id, live);
    const settle = () => {
      this.active.delete(run.id);
      endedNow();
    };
    harness.shell
      .run(command, {
        id: run.id,
        ...(run.private ? { private: true } : {}),
        signal: live.stop.signal,
        maxBytes: this.deps.maxBytes ?? shellOutputMaxBytes(),
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
            settle();
            // Stopped before it started: by the close (its socket may be gone), or by a Stop.
            refuse(result.why === "stopped" ? "unavailable" : result.why, result.why === "stopped" && live.closing ? SHELL_CLOSING_TEXT : result.refused);
            return;
          }
          if (result.limited) live.limited = true;
          settle();
          this.end(live, result);
        },
        (err) => {
          // The harness's own failure after it started: the card ends with what it said; nothing is saved.
          console.error("[chat] shell run failed", err);
          settle();
          if (!this.runs.includes(live)) {
            refuse("failed", `The command couldn't run: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }
          this.end(live, { output: `${run.output}${live.pending}\n${err instanceof Error ? err.message : String(err)}`, cancelled: false, saved: Promise.resolve(null) });
        },
      )
      .finally(settle);
  }

  /** The card's Stop Command: stops the command `id` alone, if it still runs (one still being prepared never
      starts). `byOther`: the Stop Command entry asked, not one of the chat's pages. Returns whether there was
      one to stop. */
  stop(id: string, byOther = false): boolean {
    const live = this.active.get(id);
    if (!live) return false;
    if (byOther && !live.stop.signal.aborted) live.byOther = true;
    live.stop.abort();
    return true;
  }

  /** The commands taken and not ended, oldest first: what the Stop Command entry lists (§chat.shell-mode/running). */
  list(): { id: string; command: string; private?: true; startedAt: number }[] {
    return [...this.active.values()].map(({ run }) => ({ id: run.id, command: run.private ? "" : run.command, ...(run.private ? { private: true as const } : {}), startedAt: run.startedAt }));
  }

  /** The chat is closing (archive, restart, a backend switch, a new or switched session, anything that
      disposes it): its command stops and is saved as stopped by the close, before the chat goes; a run
      waiting to be saved is waited for. Bounded; afterwards no command starts. Every call waits for the same
      close. */
  close(): Promise<void> {
    this.closing ??= this.closeNow();
    return this.closing;
  }

  private async closeNow(): Promise<void> {
    const harness = this.deps.harness();
    const stopping = [...this.active.values()];
    for (const live of stopping) {
      live.closing = true;
      live.stop.abort();
    }
    const unsaved = [...this.runs];
    if (!unsaved.length && !stopping.length) return;
    const deadline = new Promise<void>((r) => setTimeout(r, SHELL_CLOSE_WAIT_MS).unref?.());
    await Promise.race([Promise.all(stopping.map((l) => l.ended)), deadline]);
    // A run whose harness started it after all while the close waited is waited for too.
    for (const l of this.runs) if (!unsaved.includes(l)) unsaved.push(l);
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
    const run = live.run;
    const outcome = outcomeOf(result, live);
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
    if (!entry || !entry.id) return;
    const why = entry.kind === "shell" && entry.cancelled === true ? stopReasonOf(live) : null;
    const durationMs = live.run.durationMs;
    try {
      this.deps.markRun(entry.id, { ...(durationMs !== undefined ? { durationMs } : {}), ...(why ? { stopped: why } : {}) });
    } catch (err) {
      console.error("[chat] shell run marker not written", err);
    }
    // The row comes first, then the run goes: a client never shows neither.
    const items = this.deps.rowsOf(entry, why, durationMs);
    if (items.length) this.deps.broadcast({ type: "append", items });
    this.deps.broadcast({ type: "shell_saved", id: live.run.id, entryId: entry.id });
  }
}
