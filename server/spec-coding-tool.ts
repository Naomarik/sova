// The coding chats' spec look-up: `spec`, a read-only ToolSpec in every ordinary chat and every worker
// (team members included, a team's monitor not), whatever its modes. It runs the spec tools Sova ships (`sova-spec.mjs`) on
// the chat's own working tree, drafts included, through the shared runner (spec-runner.ts: argv, no
// shell, `--json`, a timeout): the same reads the spec mode's shell line gives, without a shell.
//
// Unlike `spec_lookup` (spec-lookup.ts: the main line's committed spec, opaque handles, for gathering
// and the overseers), this one reads what the coding agent works on and answers with § ids.
//
// The root is confined to the session's working directory or an active worktree the session tracks; a
// remote session (its cwd a target placeholder) still lists the tool and is refused, since its files are
// on the target. A root that doesn't exist is refused too: the spec tools answer it as they answer a folder
// with no spec, and only the second is that. Node builtins, the harness types and the worktrees state rules only: a chat process
// and a worker load it.
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { ToolCtx, ToolResult, ToolSpec } from "../shared/harness";
import { activeTrees, canonical, isWithin, treeOf } from "../pi-config/extensions/worktrees/state.ts";
import { SPEC_TOOL_NAME } from "../pi-config/extensions/mode/spec-guard.ts";
import { WORKTREES } from "./harness/state-kinds";
import { runSpecTool } from "./spec-runner";
import { targetOfCwd } from "./targets";

/** The tool's name: the census's own (it counts the tool's reads and skips it). */
export const SPEC_CODING_TOOL = SPEC_TOOL_NAME;

export const SPEC_OPS = ["where", "map", "toc", "read", "impact"] as const;
export type SpecOp = (typeof SPEC_OPS)[number];
export const TOC_DIRS = ["out", "in", "down", "up", "mentions"] as const;

export interface SpecParams {
  op: SpecOp;
  query?: string;
  id?: string;
  dir?: (typeof TOC_DIRS)[number];
  whole?: boolean;
  noFrame?: boolean;
  near?: boolean;
  cursor?: string;
  root?: string;
  draft?: string;
}

/** A refusal the model reads as the tool's answer (an error result): it names what to do instead. */
export class SpecToolRefusal extends Error {}

export const NO_SPEC_HERE = "This project has no spec here.";
export const REMOTE_REFUSAL = "The spec tool reads local files; this session runs on a remote target, so it is not available here.";
const OUTPUT_MAX = 48 * 1024;

const text = (t: string): ToolResult<undefined> => ({ content: [{ type: "text", text: t }], details: undefined });

/** `folder`, once it is one: a root that doesn't exist must not reach the spec tools, which would read it as a project with no spec. */
function existingFolder(folder: string, what: string): string {
  let isFolder: boolean;
  try {
    isFolder = statSync(folder).isDirectory();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new SpecToolRefusal(`${what} ${folder} does not exist, so this answer says nothing about whether the project has a spec. If a command in this same step is creating it, call spec again once it has finished; otherwise check the path.`);
    }
    throw new SpecToolRefusal(`${what} ${folder} can't be read: ${(err as Error).message}`);
  }
  if (!isFolder) throw new SpecToolRefusal(`${what} ${folder} is not a folder; name the project's folder.`);
  return folder;
}

/**
 * The root a call may read: `root` (absolute, or relative to the session's cwd) when it is at or below the
 * session's cwd or inside one of its active tracked worktrees, the folders a worker may start in; the
 * session's cwd when absent. Throws a SpecToolRefusal naming those folders otherwise, and in a remote session;
 * and one saying so when an allowed root doesn't exist or isn't a folder.
 */
export function specRootFor(ctx: Pick<ToolCtx, "cwd" | "state">, root: string | undefined): string {
  if (!ctx.cwd) throw new SpecToolRefusal("This session has no folder to read a spec in.");
  if (targetOfCwd(ctx.cwd)) throw new SpecToolRefusal(REMOTE_REFUSAL);
  if (root === undefined || root === "") return existingFolder(ctx.cwd, "This session's folder");
  const want = canonical(isAbsolute(root) ? root : resolve(ctx.cwd, root));
  if (isWithin(want, canonical(ctx.cwd))) return existingFolder(want, "root");
  let set;
  try {
    set = ctx.state().latest(WORKTREES)?.data ?? undefined;
  } catch {
    set = undefined;
  }
  if (treeOf(set, want)) return existingFolder(want, "root");
  const allowed = [ctx.cwd, ...activeTrees(set).map((t) => t.path)];
  throw new SpecToolRefusal(`root ${want} is outside this session's folder and its tracked worktrees (${[...new Set(allowed)].join(", ")}); omit root or name one of them.`);
}

/** A draft of the root, by its name, as the CLI's `--spec` takes it: `.sova/spec/drafts/<name>/spec`. */
export function draftDir(draft: string): string {
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(draft)) throw new SpecToolRefusal(`draft names one of the root's drafts (a folder under .sova/spec/drafts), not a path: ${draft}`);
  return `.sova/spec/drafts/${draft}/spec`;
}

/** The CLI's argument list for one call (before `--root … --json`); throws a SpecToolRefusal on a call it can't spell. */
export function specArgs(p: SpecParams): string[] {
  const need = (v: string | undefined, what: string): string => {
    if (typeof v !== "string" || !v.trim()) throw new SpecToolRefusal(`${p.op} needs ${what}.`);
    return v.trim();
  };
  const flagIs = (v: string, what: string): string => {
    if (v.startsWith("-")) throw new SpecToolRefusal(`${what} must not start with "-".`);
    return v;
  };
  let args: string[];
  switch (p.op) {
    case "where":
      args = ["where", ...need(p.query, "query (3–5 of the task's words, a path or a name)").split(/\s+/).map((w) => flagIs(w, "a query word"))];
      break;
    case "map": {
      const at = p.id?.trim() || p.query?.trim();
      args = ["map", ...(at ? [flagIs(at, "the namespace or §id")] : [])];
      break;
    }
    case "toc":
      args = ["toc", flagIs(need(p.id, "id (a §id)"), "id"), "--dir", p.dir ?? "out"];
      break;
    case "read":
      args = ["read", flagIs(need(p.id, "id (a §id)"), "id"), ...(p.whole ? ["--whole"] : []), ...(p.noFrame ? ["--no-frame"] : [])];
      break;
    case "impact":
      args = ["impact", flagIs(need(p.id, "id (a §id)"), "id"), ...(p.near ? ["--near"] : [])];
      break;
    default:
      throw new SpecToolRefusal(`Unknown op ${String((p as { op?: unknown }).op)}: one of ${SPEC_OPS.join(", ")}.`);
  }
  if (p.cursor) args.push("--cursor", p.cursor);
  if (p.draft) args.push("--spec", draftDir(p.draft));
  return args;
}

/** The answer the model reads: the tool's JSON as is; a plain line when the project has no spec. */
export function specAnswer(out: Record<string, any>): string {
  const findings: { code?: string }[] = Array.isArray(out.findings) ? out.findings : [];
  if (out.cause === "manifest-not-found" || findings.some((f) => f?.code === "manifest-not-found")) return NO_SPEC_HERE;
  const json = JSON.stringify(out);
  return json.length > OUTPUT_MAX ? `${json.slice(0, OUTPUT_MAX)}\n[cut at ${OUTPUT_MAX} bytes: narrow the query, or page with cursor]` : json;
}

export function specCodingTool(): ToolSpec<SpecParams> {
  return {
    name: SPEC_CODING_TOOL,
    label: "Spec",
    description:
      "Look up this project's spec (.sova/spec: promises under § ids, each with the code files that carry it out), read-only: where (query: 3–5 task words, a path or a name), map (optional namespace or §id), toc (id, dir), read (id; whole, noFrame), impact (id; near). cursor continues a page; draft reads one of the root's drafts by name. Answers the spec tools' JSON.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: [...SPEC_OPS] },
        query: { type: "string", description: "where: the words, path or name; map: a namespace" },
        id: { type: "string", description: "A §id (toc, read, impact, map)" },
        dir: { type: "string", enum: [...TOC_DIRS], description: "toc: which links (default out)" },
        whole: { type: "boolean", description: "read: the whole claim" },
        noFrame: { type: "boolean", description: "read: without the frame (every read after the first)" },
        near: { type: "boolean", description: "impact: what relies on it, nearest first" },
        cursor: { type: "string", description: "The previous answer's next cursor" },
        root: { type: "string", description: "Project root (default your working directory): it or a folder below it, or a worktree you track" },
        draft: { type: "string", description: "A draft's name, read instead of the current spec" },
      },
      required: ["op"],
      additionalProperties: false,
    },
    executionMode: "parallel",
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx) throw new SpecToolRefusal("The spec tool needs a session.");
      const args = specArgs(params);
      const root = specRootFor(ctx, params.root);
      return text(specAnswer(await runSpecTool(root, args)));
    },
  };
}
