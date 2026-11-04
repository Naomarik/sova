// Subfolder instruction files, pi's half (the engine is server/deeper-context.ts): an inline extension
// every chat with file tools loads. At a read, edit or write's tool_result it appends the instruction
// files of the folders the call touched that the branch hasn't loaded yet.
import { blocksToAttach, loadedInstructions, LOADING_TOOLS } from "../../deeper-context";
import type { PiExtensionAPI } from "./extension-types";
import { toolCtx } from "./tools";

export function deeperContextExtension(opts: { allow?: (abs: string) => boolean } = {}) {
  return {
    name: "sova-deeper-context",
    hidden: true,
    factory: (pi: PiExtensionAPI) => {
      /** Files attached this turn: two calls of one batch never both attach one. */
      const inFlight = new Set<string>();
      const pathOf = (input: unknown): string | undefined => {
        const p = (input as { path?: unknown } | undefined)?.path;
        return typeof p === "string" && p ? p : undefined;
      };

      pi.on("tool_result", async (event, ctx) => {
        const path = LOADING_TOOLS.has(event.toolName) ? pathOf(event.input) : undefined;
        if (!path || event.isError) return;
        try {
          const input = event.input as { offset?: unknown; limit?: unknown };
          const blocks = blocksToAttach(ctx.cwd, {
            path,
            ...(event.toolName === "read" ? { selfRead: { path, offset: input.offset, limit: input.limit } } : {}),
            loaded: () => loadedInstructions(toolCtx(ctx).branch()),
            inFlight,
            ...(opts.allow ? { allow: opts.allow } : {}),
          });
          if (!blocks.length) return;
          return { content: [...event.content, ...blocks.map((text) => ({ type: "text" as const, text }))] };
        } catch (err) {
          console.warn(`[deeper-context] ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      });
      pi.on("turn_end", async () => {
        inFlight.clear();
      });
    },
  };
}
