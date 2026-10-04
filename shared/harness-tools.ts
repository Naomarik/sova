// The harness contract, tools (§app/harness). Types only: imports nothing but its siblings, emits nothing.
// Sova's tools are ToolSpecs; the adapter (server/harness/pi/, M1) turns each into the harness's own
// tool. M2 adds ToolCtx.branch(), M4 adds ToolCtx.state() and deletes rawBranch().
import type { EntryId, HarnessId } from "./harness-core";

/** A plain JSON Schema object (Sova's tools build theirs with obj/str/bool, overseer-tools.ts). */
export type JsonSchema = { readonly [key: string]: unknown };

export type ToolBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface ToolResult<D = unknown> {
  content: ToolBlock[];
  details: D;
  /** Stop after this tool batch (a baton hand-off or wrap-up). */
  terminate?: boolean;
}

export type ToolUpdate<D = unknown> = (partial: ToolResult<D>) => void;

declare const harnessNative: unique symbol;
/** The harness's own tool context, opaque here. Only that harness's own tools get it back (fromPiTool). */
export interface HarnessNative {
  readonly [harnessNative]: HarnessId;
}

/** What a Sova tool reads about the session that called it. */
export interface ToolCtx {
  readonly sessionId: string;
  readonly cwd: string;
  /** The active branch's leaf, null in an empty session. */
  leafId(): EntryId | null;
  /** TEMPORARY, M1 to M4: the active branch, root first, as the harness stores it. Every call counts in
      the boundary's reader ratchet (§app.harness/boundary). */
  rawBranch(): readonly Record<string, any>[];
  readonly native?: HarnessNative;
}

export interface ToolSpec<P = any, D = any> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: JsonSchema;
  executionMode?: "sequential" | "parallel";
  /** pi's positional order, kept so a ToolSpec is a type swap for every existing tool and wrapper. */
  execute(
    toolCallId: string,
    params: P,
    signal: AbortSignal | undefined,
    onUpdate: ToolUpdate<D> | undefined,
    ctx: ToolCtx | undefined,
  ): Promise<ToolResult<D>>;
}
