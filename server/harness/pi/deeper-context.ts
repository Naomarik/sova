// Subfolder instruction files and skills, pi's half (the engines are server/deeper-context.ts and
// server/subfolder-skills.ts): an inline extension every chat with file tools loads. At a read, edit or
// write's tool_result it appends the instruction files and skills of the folders the call touched that the
// branch hasn't got yet. Its `input` hook expands `/skill:name` where pi's own expansion can't: a subfolder's
// skill (no list of pi's has it), a rescued one (pi's parser throws on it), and Claude's placeholders
// (quirk P41, §chat.subfolder-skills/command, §chat.skill-sources/arguments). Neither looks below a chat's folder
// where server/skill-descent.ts says it doesn't (the home folder and above, a plain folder): starting skills alone.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, sep } from "node:path";
import { blocksToAttach, loadedInstructions, LOADING_TOOLS } from "../../deeper-context";
import { APPROVAL_PENDING, type ApprovalPendingData } from "../state-kinds";
import { isContextOff, isSkillOff, loadoutOnBranch, type LoadoutEntryData } from "../../session-loadout";
import { expandedSkill, fillPlaceholders, skillBody, skillCommand } from "../../skill-sources";
import { skillDescentAllowed } from "../../skill-descent";
import { nestedSkillFile, offeredDirs, offeredSkills, skillBlocksToAttach } from "../../subfolder-skills";
import type { PiExtensionAPI } from "./extension-types";
import { piCanExpand, piSkillsIn, skillArgumentNames } from "./skill-sources";
import { stateViewOf } from "./state-view-of";
import { toolCtx } from "./tools";

/** `inProject`: the chat's folder belongs to a project added to Sova, as its build was told (absent: not). */
export function deeperContextExtension(opts: { allow?: (abs: string) => boolean; skills?: boolean; skillOff?: (s: { name: string; filePath: string }) => boolean; inProject?: boolean } = {}) {
  const withSkills = opts.skills !== false;
  /** Asked at each call from the chat's own folder: a repository made there is noticed as the chat works. */
  const descends = (cwd: string) => skillDescentAllowed(cwd, { home: homedir(), inProject: opts.inProject === true });
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
      /** Items this chat already has a "wasn't loaded" line for (its branch's, and this process's). */
      const noted = new Set<string>();
      /** An item an asking chat's fixed list doesn't name (and the chat never switched off): kept out, with
          one transcript line offering Approve and Disallow, never sent to the model. */
      const unlisted = (d: LoadoutEntryData | null, kind: ApprovalPendingData["kind"], path: string) =>
        !!d?.asking && (kind === "context" ? !d.offContext.includes(path) && !d.onlyContext?.includes(path) : !d.offSkills.includes(path) && !d.onlySkills?.includes(path));
      const note = (branch: readonly unknown[], item: ApprovalPendingData) => {
        if (noted.size === 0) for (const e of stateViewOf(branch).list(APPROVAL_PENDING)) noted.add(e.data.path);
        if (noted.has(item.path)) return;
        noted.add(item.path);
        pi.appendEntry(APPROVAL_PENDING.type, item);
      };

      pi.on("tool_result", async (event, ctx) => {
        const path = LOADING_TOOLS.has(event.toolName) ? pathOf(event.input) : undefined;
        if (!path || event.isError) return;
        try {
          // Where the chat doesn't look below its folder: nothing offered, and no "wasn't loaded" line.
          if (!descends(ctx.cwd)) return;
          const input = event.input as { offset?: unknown; limit?: unknown };
          const h = toolCtx(ctx);
          const branch = h.branch();
          const entry = loadoutOnBranch(branch);
          const pending: ApprovalPendingData[] = [];
          // What this chat's fixed list keeps out (§chat.context-approval/fixed), beside any confinement of its own.
          const allowContext = (abs: string) => {
            if (opts.allow && !opts.allow(abs)) return false;
            if (!isContextOff(entry, abs)) return true;
            // Named by its place below the chat's folder ("sub/AGENTS.md"); the path stays absolute.
            if (unlisted(entry, "context", abs)) pending.push({ kind: "context", path: abs, name: relative(ctx.cwd, abs).split(sep).join("/") || abs });
            return false;
          };
          const skillOff = (s: { name: string; filePath: string }) => {
            if (opts.skillOff?.(s)) return true;
            if (!isSkillOff(entry, s)) return false;
            if (unlisted(entry, "skill", s.filePath) && !entry?.offSkills.includes(s.name)) pending.push({ kind: "skill", path: s.filePath, name: s.name });
            return true;
          };
          const blocks = blocksToAttach(ctx.cwd, {
            path,
            ...(event.toolName === "read" ? { selfRead: { path, offset: input.offset, limit: input.limit } } : {}),
            loaded: () => loadedInstructions(h.branch()),
            inFlight,
            allow: allowContext,
          });
          const skills = withSkills
            ? skillBlocksToAttach(ctx.cwd, {
                path,
                read: piSkillsIn,
                offered: () => offeredDirs(h.branch()),
                // By file: a skill approved mid-chat in a folder already offered is offered at the next touch there.
                offeredFiles: () => new Set(offeredSkills(h.branch()).map((s) => s.filePath)),
                inFlight: skillsInFlight,
                ignored,
                startingFile: (f) => startingSkills().some((c) => c.sourceInfo.path === f),
                off: skillOff,
                ...(opts.allow ? { allow: opts.allow } : {}),
              })
            : [];
          for (const p of pending) note(branch, p);
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
          if (!starting && isSkillOff(loadoutOnBranch(branch), { name: cmd.name, filePath: "" })) return { action: "continue" as const };
          // A subfolder's skill only where the chat looks below its folder; else the text goes as typed.
          if (!starting && !descends(ctx.cwd)) return { action: "continue" as const };
          const file = starting ? starting.sourceInfo.path : nestedSkillFile(ctx.cwd, cmd.name, branch, piSkillsIn);
          if (!file) return { action: "continue" as const };
          // A subfolder's skill this chat's list keeps out stays as typed, as a switched-off name does.
          if (!starting && isSkillOff(loadoutOnBranch(branch), { name: cmd.name, filePath: file })) return { action: "continue" as const };
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
