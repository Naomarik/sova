// The recall tools (§chat.memory/recall): zoom(id, n) and date(id), as Sova ToolSpecs. Active only while
// memory is on (the adapter syncs them); each reads the calling chat's engine.
import type { ToolCtx, ToolSpec } from "../../shared/harness";
import { MEMORY_DATE_TOOL, MEMORY_ZOOM_TOOL } from "../../shared/memory";
import type { MemoryEngine } from "./engine";

export type EngineOf = (ctx: ToolCtx | undefined) => MemoryEngine | undefined;

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

function engineOrThrow(engineOf: EngineOf, ctx: ToolCtx | undefined): MemoryEngine {
  const engine = engineOf(ctx);
  if (!engine) throw new Error("Memory is off in this chat: there is nothing to open.");
  // The tools read the branch as it is now: what the view was built from, plus this turn so far.
  if (ctx) engine.sync(ctx.branch());
  return engine;
}

export function zoomTool(engineOf: EngineOf): ToolSpec<{ id: number; n: number }> {
  return {
    name: MEMORY_ZOOM_TOOL,
    label: "Zoom",
    description: "Open the line id+n of the memory view into the two lines of n/2 under it; n = 1 gives the message whole.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 0, description: "The line's first message id" },
        n: { type: "integer", minimum: 1, description: "How many messages the line covers (a power of 2)" },
      },
      required: ["id", "n"],
      additionalProperties: false,
    },
    executionMode: "parallel",
    async execute(_id, params, _signal, _update, ctx) {
      return text(engineOrThrow(engineOf, ctx).zoom(params.id, params.n));
    },
  };
}

export function dateTool(engineOf: EngineOf): ToolSpec<{ id: number }> {
  return {
    name: MEMORY_DATE_TOOL,
    label: "Date",
    description: "The date and time of message id in the memory view.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer", minimum: 0, description: "The message id" } },
      required: ["id"],
      additionalProperties: false,
    },
    executionMode: "parallel",
    async execute(_id, params, _signal, _update, ctx) {
      return text(engineOrThrow(engineOf, ctx).date(params.id));
    },
  };
}
