// The playbook delivery's pi half (§chat.schedules/playbook-read, §chat.schedules/delivery): an inline
// extension every ordinary hosted runtime loads.
// - `playbook_read` is registered always and in the loadout only once a fire has delivered a playbook
//   on the session's branch (or the prompt starting this run carries one), so no other session ever
//   has it, and a Claude Code chat's tool set changes once, at its first delivery;
// - a compaction written while a fired run is still going re-sends the entry whole, as a note
//   steered in before the run's next request, so the run never works from a diff it no longer holds.
import { PLAYBOOK_NOTE, PLAYBOOK_READ_TOOL, parseBlockTags } from "../../../shared/playbook-delivery";
import type { HookCtx, ToolCtx } from "../../../shared/harness";
import { deliveredHint, hasDelivery, playbookReadTool, type PlaybookToolDeps } from "../../playbook-tools";
import { agentRoot } from "../../state-root";
import { linkSandbox, sandboxOf } from "../../link-sandbox";
import type { PiExtensionAPI } from "./extension-types";
import { extensionEntries } from "./state";
import { toolCtx, toPiTool } from "./tools";

export interface PlaybookHost extends Omit<PlaybookToolDeps, "readDenial"> {
  /** The entry whole for this session's playbook, for a re-prime; null when it has none. */
  reprime(ctx: HookCtx): Promise<{ block: string; playbook: string; sha: string } | null>;
}

/** The session's own sandbox, as its tools have it (server/link-sandbox.ts): off allows, unresolvable refuses. */
export function sessionReadDenial(ctx: ToolCtx, canonical: string): string | undefined {
  return linkSandbox.read(sandboxOf({ sessionId: ctx.sessionId, cwd: ctx.cwd }, extensionEntries(ctx.branch()), { agentDir: agentRoot() }), canonical);
}

/** The run's input is a fire that delivered a playbook: the branch's newest user message has a block. */
function inFiredRun(ctx: ToolCtx): boolean {
  const branch = ctx.branch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const h = branch[i]!;
    if (h.kind !== "user") continue;
    return parseBlockTags(h.blocks.map((b) => (b.type === "text" ? b.text : "")).join("")).length > 0;
  }
  return false;
}

export function playbookExtension(host: PlaybookHost) {
  return {
    name: "sova-playbook",
    hidden: true,
    factory: (pi: PiExtensionAPI) => {
      pi.registerTool(toPiTool(playbookReadTool({ ...host, readDenial: sessionReadDenial })));
      const sync = (want: boolean) => {
        try {
          const current = pi.getActiveTools();
          const has = current.includes(PLAYBOOK_READ_TOOL);
          if (want && !has) pi.setActiveTools([...current, PLAYBOOK_READ_TOOL]);
          else if (!want && has) pi.setActiveTools(current.filter((t) => t !== PLAYBOOK_READ_TOOL));
        } catch {
          // No loadout to change yet.
        }
      };
      pi.on("session_start", async (_e, ctx) => sync(hasDelivery(toolCtx(ctx))));
      pi.on("before_agent_start", async (e, ctx) => sync(parseBlockTags(e.prompt ?? "").length > 0 || hasDelivery(toolCtx(ctx))));
      pi.on("session_compact", async (_e, ctx) => {
        try {
          if (ctx.isIdle()) return; // between runs: the next fire sends the entry whole anyway
          const c = toolCtx(ctx);
          if (!deliveredHint(c) || !inFiredRun(c)) return;
          const p = await host.reprime(c);
          if (!p) return;
          pi.sendMessage({ customType: PLAYBOOK_NOTE, content: p.block, display: true, details: { v: 1, playbook: p.playbook, sha: p.sha, load: "full" } }, { deliverAs: "steer" });
        } catch (err) {
          console.warn(`[playbook] re-prime after compaction failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    },
  };
}
