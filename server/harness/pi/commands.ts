// The extension commands Sova runs directly on pi (§app.harness/session-history, P14): `/mode`,
// `/claude-login`, `/sandbox` and `agent-resume`, each called through its handler with a command context
// (pi's own extension-command path, AgentSession._tryExecuteExtensionCommand, minus the prompt text it
// falls back to), never through prompt(), so no command text reaches the model. A command counts only when
// the extension that owns it registered it, told by its source path, so another extension's command of the
// same name never runs.
import type { CommandOwner } from "../../../shared/harness";

/** The entry file of the extension that owns each command. */
const OWNER_SOURCE: Record<CommandOwner, RegExp> = {
  mode: /[\\/]extensions[\\/]mode[\\/]index\.ts$/,
  "claude-login": /[\\/]extensions[\\/]claude-code[\\/]index\.ts$/,
  sandbox: /[\\/]extensions[\\/]sandbox[\\/]index\.ts$/,
  "agent-resume": /[\\/]extensions[\\/]subagents[\\/]index\.ts$/,
};

/** `owner`'s own command from a runner (pi's extensionRunner), the very object the runner returned, or
    undefined when it isn't loaded or another extension's command has the name. */
export function ownedCommand<C extends { sourceInfo?: { path?: string } }>(runner: { getCommand(name: string): C | undefined }, owner: CommandOwner): C | undefined {
  const cmd = runner.getCommand(owner);
  return cmd && OWNER_SOURCE[owner].test(cmd.sourceInfo?.path ?? "") ? cmd : undefined;
}

/** The sandbox extension's own /sandbox command (server/sandbox-state.ts runs it). */
export const sandboxCommandOf = <C extends { sourceInfo?: { path?: string } }>(runner: { getCommand(name: string): C | undefined }): C | undefined =>
  ownedCommand(runner, "sandbox");

/** The subagents extension's own `agent-resume` (server/worker-resume.ts runs it). */
export const resumeCommandOf = <C extends { sourceInfo?: { path?: string } }>(runner: { getCommand(name: string): C | undefined }): C | undefined =>
  ownedCommand(runner, "agent-resume");

/** A fresh context for a command's handler (pi's extensionRunner.createCommandContext). */
export function commandContextOf(runner: { createCommandContext(): unknown }): unknown {
  return runner.createCommandContext();
}
