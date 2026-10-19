// An ordinary chat's server-hosted tools, in a chat process of its own (§app/chat-processes): the
// extension the chat loads in place of the one that would run the tool in this process. Same name,
// same position in the loadout, the same tool declarations (each run is a call to the server,
// chat-manager's serverToolSpec), so the prompt and the tool list read exactly as in the server.
import type { HookCtx, ToolSpec } from "../shared/harness";
import type { PiExtensionAPI } from "./harness/pi/extension-types";
import { toolCtx, toPiTool } from "./harness/pi/tools";
import { visOnBranch } from "./vis-check";
import { registerNoteHooks } from "./project-services/note";

/** Tour tools use explicit vis mode, not align's drawing-only Visuals side effect. */
export function servedVisToolsExtension(name: string, specs: readonly ToolSpec[], wanted?: () => boolean | undefined) {
  const base = servedToolsExtension(name, specs);
  return { ...base, factory: (pi: PiExtensionAPI) => {
    base.factory(pi);
    const names = new Set(specs.map(s => s.name));
    const sync = (ctx: HookCtx) => {
      const want = wanted?.() ?? visOnBranch(ctx.state());
      const current = pi.getActiveTools();
      const next = want ? [...current, ...specs.map(s => s.name).filter(n => !current.includes(n))] : current.filter(n => !names.has(n));
      if (next.length !== current.length) pi.setActiveTools(next);
    };
    pi.on("session_start", async (_event, ctx) => sync(toolCtx(ctx)));
    pi.on("before_agent_start", async (_event, ctx) => sync(toolCtx(ctx)));
    pi.on("agent_settled", async (_event, ctx) => sync(toolCtx(ctx)));
  } };
}

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
