// An ordinary chat's server-hosted tools, in a chat process of its own (§app/chat-processes): the
// extension the chat loads in place of the one that would run the tool in this process. Same name,
// same position in the loadout, the same tool declarations (each run is a call to the server,
// chat-manager's serverToolSpec), so the prompt and the tool list read exactly as in the server.
import type { HookCtx, ToolSpec } from "../shared/harness";
import type { PiExtensionAPI } from "./harness/pi/extension-types";
import { toPiTool } from "./harness/pi/tools";
import { registerNoteHooks } from "./project-services/note";

export function servedToolsExtension(name: string, specs: readonly ToolSpec[], note?: (ctx: HookCtx) => Promise<string | null>) {
  return {
    name,
    hidden: true,
    factory: (pi: PiExtensionAPI) => {
      for (const spec of specs) pi.registerTool(toPiTool(spec));
      // project_verbs' instance note (§app.project-services/instance-note), rendered by the server.
      if (note) registerNoteHooks(pi, note);
    },
  };
}
