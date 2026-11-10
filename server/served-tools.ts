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

/** `active` with `tool` where a fresh chat has it: before the first active tool registered after it. */
export function atRegisteredPlace(active: readonly string[], tool: string, registered: readonly string[]): string[] {
  const later = new Set(registered.slice(registered.indexOf(tool) + 1));
  const at = active.findIndex((name) => later.has(name));
  return at < 0 ? [...active, tool] : [...active.slice(0, at), tool, ...active.slice(at)];
}

/**
 * An extension whose tool is active only once `offered` says so (§app.project-services/tool-offered). It stays
 * registered and declared everywhere; a chat with the tool from its start sees no change at all, because
 * nothing is set when nothing changes. Asked as the chat opens, at each message and after each step (at
 * turn_end the next request of the same run has it, P23). Once yes, yes until the chat opens again.
 */
export function offeredToolExtension<E extends { factory: (pi: PiExtensionAPI) => void }>(base: E, tool: string, offered: (ctx: HookCtx, prompt?: string) => Promise<boolean>): E {
  return { ...base, factory: (pi: PiExtensionAPI) => {
    base.factory(pi);
    let yes = false;
    const sync = async (ctx: HookCtx, prompt?: string) => {
      yes = yes || (await offered(ctx, prompt));
      const current = pi.getActiveTools();
      if (yes === current.includes(tool)) return;
      if (!yes) return pi.setActiveTools(current.filter((name) => name !== tool));
      const registered = pi.getAllTools().map((t) => t.name);
      if (registered.includes(tool)) pi.setActiveTools(atRegisteredPlace(current, tool, registered));
    };
    pi.on("session_start", async (_event, ctx) => {
      yes = false;
      await sync(toolCtx(ctx));
    });
    pi.on("before_agent_start", async (event, ctx) => void (await sync(toolCtx(ctx), event.prompt)));
    pi.on("turn_end", async (_event, ctx) => void (await sync(toolCtx(ctx))));
  } };
}

export function servedToolsExtension(name: string, specs: readonly ToolSpec[], note?: (ctx: HookCtx) => Promise<string | null>, noteType?: string) {
  return {
    name,
    hidden: true,
    factory: (pi: PiExtensionAPI) => {
      for (const spec of specs) pi.registerTool(toPiTool(spec));
      // project_verbs' instance note (§app.project-services/instance-note), or the offer tool's
      // run outcome (§chat.offers/card), rendered by the server.
      if (note) registerNoteHooks(pi, note, noteType);
    },
  };
}
