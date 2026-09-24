// The sandbox extension's adapter (pi-config/extensions/sandbox, spec §chat/sandbox). The whole
// interface is the extension's: its `/sandbox on|off` command (presence = the runtime has it) and
// the `sandbox` custom entry it appends on every change. We import exactly its pure state.ts (node
// builtins only), like mode-state.ts imports mode/state.ts, and never learn what a policy, a level
// or a backend is beyond the status words in that entry. Without the extension nothing here runs.
import { describeActive, LEVELS, restoreActive, SANDBOX_ENTRY_TYPE, type SandboxActive } from "../pi-config/extensions/sandbox/state.ts";
import type { ChatServerMessage, SandboxApplyResult, SandboxInfo } from "../shared/protocol";

type Entry = { type: string; customType?: string; data?: unknown };
type Command = { handler(args: string, ctx: any): Promise<void> | void; sourceInfo?: { path?: string } };

/** A branch with no `sandbox` entry: the extension writes one whenever a session comes up on. */
const OFF: SandboxActive = { version: 1, on: false, level: LEVELS[0]!, backend: "none", enforcement: "none" };

/**
 * The sandbox extension's own /sandbox command in a runtime, or undefined when it isn't loaded.
 * Checked by source, like the mode command, so another extension's "sandbox" never runs.
 */
export function sandboxCommandOf(runner: { getCommand(name: string): Command | undefined }): Command | undefined {
  const cmd = runner.getCommand("sandbox");
  return cmd && /[\\/]extensions[\\/]sandbox[\\/]index\.ts$/.test(cmd.sourceInfo?.path ?? "") ? cmd : undefined;
}

/** This branch's sandbox status: the newest `sandbox` entry, restored by the extension's own rule. */
export function sandboxInfo(branch: readonly Entry[]): SandboxInfo {
  const active = restoreActive(branch) ?? OFF;
  return { on: active.on, enforcement: active.enforcement, status: describeActive(active) };
}

export const sandboxMessage = (branch: readonly Entry[]): ChatServerMessage => ({ type: "sandbox", ...sandboxInfo(branch) });

export const isSandboxEntry = (entry: unknown): boolean =>
  !!entry && typeof entry === "object" && (entry as Entry).type === "custom" && (entry as Entry).customType === SANDBOX_ENTRY_TYPE;

/** Validate a POST /api/sandbox body: `{ on: boolean }`, nothing else. */
export function parseSandboxBody(body: unknown): { on: boolean } | { error: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body) || typeof (body as { on?: unknown }).on !== "boolean")
    return { error: "Expected JSON body { on: boolean }" };
  return { on: (body as { on: boolean }).on };
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
 * POST /api/sandbox: run the extension's `/sandbox on|off` handler directly (never through
 * prompt(), so no command text reaches the model), as ChatSession.applyMode runs /mode. It reaches
 * the next tool call; the extension appends its entry and notifies with the status line.
 * "unsupported": no sandbox command in this runtime, and nothing happened.
 */
export async function applySandbox(host: SandboxHost, on: boolean): Promise<SandboxApplyResult> {
  const cmd = host.command();
  if (!cmd) return { outcome: "unsupported" };
  if (host.foreign()) return { outcome: "skip", sandbox: sandboxInfo(host.branch()) };
  host.beforeCommand();
  try {
    await cmd.handler(on ? "on" : "off", host.commandContext());
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
