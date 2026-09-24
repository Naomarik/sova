// Resuming a restored subagent worker from Sova (§chat/subagents resume). The subagents extension
// owns resume: its `agent-resume <ag_NN>` command handler starts the worker again from its durable
// record, idle, and throws a readable Error when it can't. Sova calls that handler directly (as
// applyMode calls /mode), so no command text ever reaches the model.

/** The part of an extension command Sova calls. */
interface Command {
  handler(args: string, ctx: unknown): Promise<void> | void;
  sourceInfo?: { path?: string };
}

/** The subagents extension's own `agent-resume`, never another extension's command of that name. */
export function resumeCommandOf(runner: { getCommand(name: string): Command | undefined }): Command | undefined {
  const cmd = runner.getCommand("agent-resume");
  return cmd && /[\\/]extensions[\\/]subagents[\\/]index\.ts$/.test(cmd.sourceInfo?.path ?? "") ? cmd : undefined;
}

/** Worker ids as the subagents extension mints them. Anything else never reaches the handler. */
export const WORKER_ID_RE = /^ag_\d{1,6}$/;

export interface ResumeHost {
  command(): Command | undefined;
  /** A TUI or another writer owns the session file: nothing may be started from here. */
  foreign(): boolean;
  commandContext(): unknown;
  beforeCommand(): void;
  afterCommand(): void;
}

export type ResumeOutcome = { ok: true } | { ok: false; status: 404 | 409; error: string };

export async function resumeWorker(host: ResumeHost, id: string): Promise<ResumeOutcome> {
  const cmd = host.command();
  if (!cmd) return { ok: false, status: 409, error: "This session's runtime has no subagents extension that can resume workers." };
  if (host.foreign())
    return { ok: false, status: 409, error: "Another program is writing to this session, so we won't start its workers from here." };
  host.beforeCommand();
  try {
    await cmd.handler(id, host.commandContext());
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    return { ok: false, status: 409, error: message };
  } finally {
    host.afterCommand();
  }
  return { ok: true };
}
