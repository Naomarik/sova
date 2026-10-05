// The sandbox extension's adapter (pi-config/extensions/sandbox, spec §chat/sandbox). The whole
// interface is the extension's: its `/sandbox on|subagents|off` command (presence = the runtime has it) and
// the `sandbox` custom entry it appends on every change. We import exactly its pure state.ts (node
// builtins only), like mode-state.ts imports mode/state.ts, and never learn what a policy, a level
// or a backend is beyond the status words in that entry. Without the extension nothing here runs.
import { describeActive, LEVELS, type SandboxActive, type SandboxState, STATES, stateOf } from "../pi-config/extensions/sandbox/state.ts";
import type { StateView } from "../shared/harness";
import type { ChatServerMessage, SandboxApplyResult, SandboxInfo } from "../shared/protocol";
import { stateViewOf } from "./harness/pi/state";
import { SANDBOX } from "./harness/state-kinds";

type Entry = unknown;
type Command = { handler(args: string, ctx: any): Promise<void> | void; sourceInfo?: { path?: string } };

/** A branch with no `sandbox` entry: the extension writes one whenever a session comes up on, so
    none means Subagents only (§chat.sandbox/states). */
const OFF: SandboxActive = { version: 1, on: false, level: LEVELS[0]!, backend: "none", enforcement: "none" };

/**
 * The sandbox extension's own /sandbox command in a runtime, or undefined when it isn't loaded.
 * Checked by source, like the mode command, so another extension's "sandbox" never runs.
 */
export function sandboxCommandOf(runner: { getCommand(name: string): Command | undefined }): Command | undefined {
  const cmd = runner.getCommand("sandbox");
  return cmd && /[\\/]extensions[\\/]sandbox[\\/]index\.ts$/.test(cmd.sourceInfo?.path ?? "") ? cmd : undefined;
}

/** This branch's sandbox status: the newest usable `sandbox` record (the extension's own rule). */
export const sandboxInfo = (branch: readonly Entry[]): SandboxInfo => sandboxInfoOf(stateViewOf(branch));

/** The same, from a view of the branch's state. */
export function sandboxInfoOf(state: StateView): SandboxInfo {
  const active = state.latest(SANDBOX)?.data ?? OFF;
  return { on: active.on, state: stateOf(active), enforcement: active.enforcement, status: describeActive(active) };
}

export const sandboxMessage = (branch: readonly Entry[]): ChatServerMessage => ({ type: "sandbox", ...sandboxInfo(branch) });

export const isSandboxEntry = (entry: unknown): boolean => stateViewOf([entry]).has(SANDBOX);

const BODY_SHAPE = 'Expected JSON body { state: "off" | "subagents" | "on" } or { on: boolean }';

/** Validate a POST /api/sandbox body: `{ state }`, or the older `{ on }` (true: On, false:
    Subagents only, what off meant before Off existed). Both may come together (a web client sends
    `on` for an older host); then they must agree. */
export function parseSandboxBody(body: unknown): { state: SandboxState } | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { error: BODY_SHAPE };
  const { state, on } = body as { state?: unknown; on?: unknown };
  if (on !== undefined && typeof on !== "boolean") return { error: BODY_SHAPE };
  if (state === undefined) return typeof on === "boolean" ? { state: on ? "on" : "subagents" } : { error: BODY_SHAPE };
  if (typeof state !== "string" || !(STATES as readonly string[]).includes(state)) return { error: BODY_SHAPE };
  if (typeof on === "boolean" && on !== (state === "on")) return { error: "state and on disagree" };
  return { state: state as SandboxState };
}

/** What one held chat gives the adapter (ChatSession.sandboxHost). */
export interface SandboxHost {
  command(): Command | undefined;
  /** A TUI owns the file or a foreign writer was seen: nothing may be written. */
  foreign(): boolean;
  commandContext(): unknown;
  /** Before the handler runs: flush the open-time entries so they go before the extension's. */
  beforeCommand(): void;
  /** After it ran: the entry it appended is our own write. */
  afterCommand(): void;
  branch(): readonly Entry[];
  broadcast(msg: ChatServerMessage): void;
}

/**
 * POST /api/sandbox: run the extension's `/sandbox on|subagents|off` handler directly (never through
 * prompt(), so no command text reaches the model), as ChatSession.applyMode runs /mode. It reaches
 * the next tool call; the extension appends its entry and notifies with the status line.
 * "unsupported": no sandbox command in this runtime, and nothing happened.
 */
export async function applySandbox(host: SandboxHost, state: SandboxState): Promise<SandboxApplyResult> {
  const cmd = host.command();
  if (!cmd) return { outcome: "unsupported" };
  if (host.foreign()) return { outcome: "skip", sandbox: sandboxInfo(host.branch()) };
  host.beforeCommand();
  try {
    await cmd.handler(state, host.commandContext());
  } catch (err) {
    console.error("[chat] /sandbox handler failed", err);
  }
  host.afterCommand();
  // The entry_appended broadcast already went out when the state changed; this one covers a
  // refused or unchanged flip, so the client's row always ends on the runtime's answer.
  const msg = sandboxMessage(host.branch());
  host.broadcast(msg);
  const { type: _type, ...sandbox } = msg as Extract<ChatServerMessage, { type: "sandbox" }>;
  return { outcome: "command", sandbox };
}

/** An entry the runtime appended: re-send the status when it is the extension's `sandbox` entry. */
export function onSandboxAppend(host: Pick<SandboxHost, "command" | "branch" | "broadcast">, entry: unknown): void {
  if (isSandboxEntry(entry) && host.command()) host.broadcast(sandboxMessage(host.branch()));
}
