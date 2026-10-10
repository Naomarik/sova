// The memory minor mode's pi half (§chat.memory/turn, §chat.memory/zoomable): an inline extension every
// ordinary hosted runtime (and the Overseer's) loads. The engine is harness-neutral (server/memory/); this
// file is where pi's hooks meet it:
// - `context`: with UniiChat on, every request of a run sends one view message in place of the history
//   before the run's input (the standing mode notes kept after it), the view built at the run's first
//   request and the same for its every request;
// - `session_before_compact`: UniiChat cancels every compaction (pi's own, Claude Code's automatic one,
//   /compact, compact-handoff); zoomable compaction replaces the summary with the compacted part's view;
// - the recall tools, active exactly while memory is on; and a sync of the engine at every settle and
//   branch move, so summaries are built in the background.
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { HookCtx, ToolCtx } from "../../../shared/harness";
import type { MemoryType } from "../../../shared/protocol";
import { MEMORY_TOOLS } from "../../../shared/memory";
import { MODE_NOTE_TYPE } from "../../../pi-config/extensions/mode/state.ts";
import type { MemoryEngine } from "../../memory/engine";
import { dateTool, zoomTool } from "../../memory/tools";
import type { PiExtensionAPI } from "./extension-types";

type AgentMessage = ContextEvent["messages"][number];
import { toolCtx, toPiTool } from "./tools";

/** What the extension asks the chat that hosts it. */
export interface MemoryHost {
  /** This chat's memory now. */
  choice(): { on: boolean; type: MemoryType; size: number };
  /** The chat's engine (made on first use). */
  engine(): MemoryEngine;
}

/** Where a run's input starts in a request's messages: just after the last reply or tool result. */
export function inputIndex(messages: readonly { role?: string }[]): number {
  for (let k = messages.length - 1; k >= 0; k--) {
    const role = messages[k]?.role;
    if (role === "assistant" || role === "toolResult") return k + 1;
  }
  return 0;
}

/** The history before `k` that stays after the view: the mode notes (a minor switch told after the head). */
export function standingNotes(messages: readonly AgentMessage[], k: number): AgentMessage[] {
  return messages.slice(0, k).filter((m) => (m as { role?: string }).role === "custom" && (m as { customType?: string }).customType === MODE_NOTE_TYPE);
}

/** A request's messages with the history before `k` replaced by the view message. */
export function withView(messages: readonly AgentMessage[], k: number, content: { type: "text"; text: string }[], timestamp: number): AgentMessage[] {
  const view = { role: "user", content, timestamp } as AgentMessage;
  return [view, ...standingNotes(messages, k), ...messages.slice(k)];
}

export const MEMORY_COMPACTION_REFUSAL = "Memory (UniiChat) is on: this chat doesn't compact; the model works from its memory.";

export function memoryExtension(host: () => MemoryHost | null) {
  return {
    name: "sova-memory",
    hidden: true,
    factory: (pi: PiExtensionAPI) => {
      const on = (): { on: boolean; type: MemoryType; size: number } | undefined => {
        try {
          return host()?.choice();
        } catch {
          return undefined;
        }
      };
      const engineOf = (_ctx: ToolCtx | undefined) => (on()?.on ? host()?.engine() : undefined);
      pi.registerTool(toPiTool(zoomTool(engineOf)));
      pi.registerTool(toPiTool(dateTool(engineOf)));

      // The recall tools are in the loadout exactly while memory is on; pi activates every tool at
      // registration, so session_start takes them out of a chat without memory before any request.
      const syncTools = () => {
        try {
          const want = on()?.on ?? false;
          const current = pi.getActiveTools();
          const has = MEMORY_TOOLS.every((t) => current.includes(t));
          if (want && !has) pi.setActiveTools([...current.filter((t) => !MEMORY_TOOLS.includes(t)), ...MEMORY_TOOLS]);
          else if (!want && current.some((t) => MEMORY_TOOLS.includes(t))) pi.setActiveTools(current.filter((t) => !MEMORY_TOOLS.includes(t)));
        } catch {
          // No loadout to change yet.
        }
      };
      /** Bring the engine in step with the branch, in the background (summaries of what's new). */
      const sync = (c: HookCtx) => {
        const h = host();
        if (!h || !on()?.on) return;
        try {
          h.engine().sync(c.branch());
        } catch (err) {
          console.warn(`[memory] sync failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      };

      /** This run's view: decided at its first request, the same for its every request. */
      let run: { decided: boolean; view?: { k: number; content: { type: "text"; text: string }[]; ts: number } } | undefined;

      pi.on("session_start", async (_e, ctx) => {
        syncTools();
        sync(toolCtx(ctx));
      });
      pi.on("before_agent_start", async () => syncTools());
      pi.on("agent_start", async () => {
        run = { decided: false };
      });
      pi.on("context", async (event, ctx) => {
        const h = host();
        if (!h) return;
        run ??= { decided: false };
        if (!run.decided) {
          run.decided = true;
          const c = on();
          if (!c?.on || c.type !== "uniichat") return;
          const k = inputIndex(event.messages as { role?: string }[]);
          // The system prompt shares the prefix's cached block where the provider joins them (splitView).
          const tv = await h.engine().turnView(toolCtx(ctx).branch(), c.size, Buffer.byteLength(ctx.getSystemPrompt()));
          if (!tv) return; // still preparing: the turn goes out as without memory
          run.view = { k, content: tv.content, ts: Date.now() };
        }
        if (!run.view) return;
        return { messages: withView(event.messages, run.view.k, run.view.content, run.view.ts) };
      });
      pi.on("session_before_compact", async (event, ctx) => {
        const c = on();
        if (!c?.on) return;
        if (c.type === "uniichat") return { cancel: true };
        const h = host();
        if (!h) return;
        const branch = toolCtx(ctx).branch();
        const firstKept = event.preparation.firstKeptEntryId;
        const keptAt = branch.findIndex((e) => e.id === firstKept);
        try {
          const out = await h.engine().compactionSummary(branch, keptAt < 0 ? branch.length : keptAt, c.size);
          if (!out) return; // pi's own summary
          return {
            compaction: {
              summary: out.summary,
              firstKeptEntryId: firstKept,
              tokensBefore: event.preparation.tokensBefore,
              details: { sovaMemory: { v: 1, messages: out.messages, lines: out.lines } },
            },
          };
        } catch (err) {
          console.warn(`[memory] zoomable compaction fell back to pi's summary: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      });
      pi.on("agent_settled", async (_e, ctx) => {
        run = undefined;
        syncTools();
        sync(toolCtx(ctx));
      });
      pi.on("session_tree", async (_e, ctx) => sync(toolCtx(ctx)));
    },
  };
}
