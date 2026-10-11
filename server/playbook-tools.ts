// playbook_read (§chat.schedules/playbook-read): a session a fire delivered a playbook to reads that
// playbook's files through it, contained to the playbook's folder and the session's sandbox, and each
// result records which version it read ({v: 1, playbook, file, sha}) for the next fire's delivery
// (§chat.schedules/delivery). A Sova ToolSpec, harness-neutral; the pi adapter registers it
// (server/harness/pi/playbook.ts).
import type { ToolCtx, ToolSpec } from "../shared/harness";
import { PLAYBOOK_READ_TOOL, parseBlockTags, type BundleRef, type PlaybookReadDetails } from "../shared/playbook-delivery";
import { bundleFile } from "./playbook-payload";
import { playbookVersions, type PlaybookVersions } from "./playbook-versions";

export interface PlaybookToolDeps {
  /** The playbook this session's schedule runs, checked against the keeper's store; null: none. */
  bundleFor(sessionId: string, hint?: { id: string; dir?: string }): Promise<BundleRef | null>;
  /** Why the session's sandbox refuses reading this canonical path, or undefined. */
  readDenial(ctx: ToolCtx, canonical: string): string | undefined;
  versions?: PlaybookVersions;
}

/** The newest playbook a fire delivered on this branch: its tag's id and folder. */
export function deliveredHint(ctx: ToolCtx): { id: string; dir?: string } | undefined {
  const branch = ctx.branch();
  for (let i = branch.length - 1; i >= 0; i--) {
    const h = branch[i]!;
    if (h.kind !== "user") continue;
    const text = h.blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
    const tags = parseBlockTags(text);
    const t = tags[tags.length - 1];
    if (t) return { id: t.id, ...(t.dir ? { dir: t.dir } : {}) };
  }
  return undefined;
}

/** Whether this session has had a playbook delivered (the tool is in its loadout only then). */
export const hasDelivery = (ctx: ToolCtx): boolean => deliveredHint(ctx) !== undefined;

export function playbookReadTool(deps: PlaybookToolDeps): ToolSpec<{ file: string }, PlaybookReadDetails | undefined> {
  return {
    name: PLAYBOOK_READ_TOOL,
    label: "Playbook",
    description:
      "Read a file of the playbook your automation runs: `file` is relative to the playbook's folder (the dir in its playbook block), e.g. references/land.md, or the entry itself. Returns the whole file; use it for the playbook's files instead of a plain read, so the next wake can tell you what changed.",
    promptSnippet: "read a file of the playbook your automation runs (its entry or a detail file such as references/land.md)",
    parameters: {
      type: "object",
      properties: { file: { type: "string", description: "Path relative to the playbook's folder" } },
      required: ["file"],
      additionalProperties: false,
    },
    executionMode: "parallel",
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx) throw new Error("playbook_read needs its session.");
      const bundle = await deps.bundleFor(ctx.sessionId, deliveredHint(ctx));
      if (!bundle) throw new Error("This session runs no automation's playbook, so there is nothing to read.");
      const f = bundleFile(bundle.dir, String(params.file ?? ""));
      if ("error" in f) throw new Error(f.error);
      const denied = deps.readDenial(ctx, f.abs);
      if (denied) throw new Error(`Refused: ${denied}.`);
      const sha = (deps.versions ?? playbookVersions()).keep(f.text);
      const rel = String(params.file).replace(/^\.\//, "");
      return { content: [{ type: "text" as const, text: f.text }], details: { v: 1, playbook: bundle.id, file: rel, sha } };
    },
  };
}
