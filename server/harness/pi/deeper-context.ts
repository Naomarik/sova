// Subfolder instruction files, pi's half (the engine is server/deeper-context.ts): an inline extension
// every chat with file tools loads. At a read, edit or write's tool_result it appends the instruction
// files of the folders the call touched that the branch hasn't loaded yet. A codemode script's nested
// calls (tool_call with parentToolCallId) are collected and attached at the codemode call's own result.
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
      /** A codemode call's nested read/edit/write paths, by the codemode call's id. */
      const nested = new Map<string, string[]>();
      const pathOf = (input: unknown): string | undefined => {
        const p = (input as { path?: unknown } | undefined)?.path;
        return typeof p === "string" && p ? p : undefined;
      };

      pi.on("tool_call", async (event) => {
        if (!event.parentToolCallId || !LOADING_TOOLS.has(event.toolName)) return;
        const p = pathOf(event.input);
        if (!p) return;
        // A nested call's parent may itself be nested: the root id is the transcript's.
        const root = event.parentToolCallId.split("/")[0]!;
        nested.set(root, [...(nested.get(root) ?? []), p]);
      });
      pi.on("tool_result", async (event, ctx) => {
        if (event.parentToolCallId) return;
        const own = LOADING_TOOLS.has(event.toolName) ? pathOf(event.input) : undefined;
        const touched = [...(own ? [own] : []), ...(nested.get(event.toolCallId) ?? [])];
        nested.delete(event.toolCallId);
        if (!touched.length || event.isError) return;
        try {
          const input = event.input as { offset?: unknown; limit?: unknown };
          const blocks = blocksToAttach(ctx.cwd, {
            touched,
            ...(event.toolName === "read" && own ? { selfRead: { path: own, offset: input.offset, limit: input.limit } } : {}),
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
        nested.clear();
      });
    },
  };
}
