// The kill guard's inline extension: every agent chat that has bash (an ordinary chat, a worker, a
// team member, a hidden chat) loads it, so on macOS a mis-written kill is refused before it runs and
// the refusal is the tool's own reply. It hooks tool_call alone, so pi's user_bash event isn't hooked:
// a command the user runs from shell mode is checked by its chat before it runs (server/chat-shell.ts),
// and pi's own terminal `!` isn't checked. The decision itself is server/shell-guard.ts.
import type { PiExtensionAPI } from "./harness/pi/extension-types";
import { killGuardRefusal } from "./shell-guard";

/** Block a `bash` tool call whose command the guard refuses on this platform. */
export function shellGuardExtension(platform: string = process.platform): (pi: PiExtensionAPI) => void {
  return (pi) => {
    // Linux and the rest: no hook at all, so nothing changes there.
    if (platform !== "darwin") return;
    pi.on("tool_call", (event) => {
      if (event.toolName !== "bash") return undefined;
      const command = (event.input as { command?: unknown } | undefined)?.command;
      if (typeof command !== "string") return undefined;
      const reason = killGuardRefusal(command, platform);
      return reason ? { block: true, reason } : undefined;
    });
  };
}

/** The factory entry chats load. */
export const SHELL_GUARD_FACTORY = { name: "sova-shell-guard", factory: shellGuardExtension() };
