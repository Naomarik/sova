// Subfolder instruction files and skills, pi's half (the engines are server/deeper-context.ts and
// server/subfolder-skills.ts): an inline extension every chat with file tools loads. At a read, edit or
// write's tool_result it appends the instruction files and skills of the folders the call touched that the
// branch hasn't got yet. Its `input` hook expands `/skill:name` where pi's own expansion can't: a subfolder's
// skill (no list of pi's has it), a rescued one (pi's parser throws on it), and Claude's placeholders
// (quirk P40, §chat.subfolder-skills/command, §chat.skill-sources/arguments).
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { blocksToAttach, loadedInstructions, LOADING_TOOLS } from "../../deeper-context";
import { loadoutOnBranch } from "../../session-loadout";
import { expandedSkill, fillPlaceholders, skillBody, skillCommand } from "../../skill-sources";
import { nestedSkillFile, offeredDirs, skillBlocksToAttach } from "../../subfolder-skills";
import type { PiExtensionAPI } from "./extension-types";
import { piCanExpand, piSkillsIn, skillArgumentNames } from "./skill-sources";
import { toolCtx } from "./tools";

export function deeperContextExtension(opts: { allow?: (abs: string) => boolean; skills?: boolean } = {}) {
  const withSkills = opts.skills !== false;
  return {
    name: "sova-deeper-context",
    hidden: true,
    factory: (pi: PiExtensionAPI) => {
      /** Files and folders attached this turn: two calls of one batch never both attach one. */
      const inFlight = new Set<string>();
      const skillsInFlight = new Set<string>();
      /** Each skills folder's answer from git, kept for this chat. */
      const ignored = new Map<string, boolean>();
      const pathOf = (input: unknown): string | undefined => {
        const p = (input as { path?: unknown } | undefined)?.path;
        return typeof p === "string" && p ? p : undefined;
      };
      const startingSkills = () => pi.getCommands().filter((c) => c.source === "skill");

      pi.on("tool_result", async (event, ctx) => {
        const path = LOADING_TOOLS.has(event.toolName) ? pathOf(event.input) : undefined;
        if (!path || event.isError) return;
        try {
          const input = event.input as { offset?: unknown; limit?: unknown };
          const h = toolCtx(ctx);
          const blocks = blocksToAttach(ctx.cwd, {
            path,
            ...(event.toolName === "read" ? { selfRead: { path, offset: input.offset, limit: input.limit } } : {}),
            loaded: () => loadedInstructions(h.branch()),
            inFlight,
            ...(opts.allow ? { allow: opts.allow } : {}),
          });
          const skills = withSkills
            ? skillBlocksToAttach(ctx.cwd, {
                path,
                read: piSkillsIn,
                offered: () => offeredDirs(h.branch()),
                inFlight: skillsInFlight,
                ignored,
                startingFile: (f) => startingSkills().some((c) => c.sourceInfo.path === f),
                off: (name) => (loadoutOnBranch(h.branch())?.offSkills ?? []).includes(name),
                ...(opts.allow ? { allow: opts.allow } : {}),
              })
            : [];
          if (!blocks.length && !skills.length) return;
          return { content: [...event.content, ...[...blocks, ...skills].map((text) => ({ type: "text" as const, text }))] };
        } catch (err) {
          console.warn(`[deeper-context] ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      });
      pi.on("turn_end", async () => {
        inFlight.clear();
        skillsInFlight.clear();
      });
      if (!withSkills) return;

      pi.on("input", async (event, ctx) => {
        const cmd = skillCommand(event.text);
        if (!cmd) return { action: "continue" as const };
        try {
          const starting = startingSkills().find((c) => c.name === `skill:${cmd.name}`);
          const branch = toolCtx(ctx).branch();
          // A name this chat switched off stays off (§chat.transcript/setup-card-toggles): pi leaves the text as typed.
          if (!starting && (loadoutOnBranch(branch)?.offSkills ?? []).includes(cmd.name)) return { action: "continue" as const };
          const file = starting ? starting.sourceInfo.path : nestedSkillFile(ctx.cwd, cmd.name, branch, piSkillsIn);
          if (!file) return { action: "continue" as const };
          const raw = readFileSync(file, "utf8");
          const skillDir = dirname(file);
          const body = skillBody(raw);
          const filled = fillPlaceholders(body, { args: cmd.args, skillDir, names: skillArgumentNames(raw) });
          // Nothing to fill in a starting skill pi can read: pi's own expansion, as ever.
          if (starting && filled.text === body && piCanExpand(raw)) return { action: "continue" as const };
          return { action: "transform" as const, text: expandedSkill({ name: cmd.name, filePath: file, skillDir, body: filled.text, args: filled.used ? "" : cmd.args }) };
        } catch (err) {
          console.warn(`[deeper-context] /skill:${cmd.name}: ${err instanceof Error ? err.message : String(err)}`);
          return { action: "continue" as const };
        }
      });
    },
  };
}
