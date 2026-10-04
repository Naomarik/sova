// The harness contract, tools (§app/harness). Types only: imports nothing but its siblings, emits nothing.
// Sova's tools are ToolSpecs; the adapter (server/harness/pi/tools.ts) turns each into the harness's own
// tool (§app.harness/tools). M2 adds ToolCtx.branch(), M4 adds ToolCtx.state() and deletes rawBranch().
import type { EntryId, HarnessId, SessionKey } from "./harness-core";

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
  /** The harness's own context, opaque; only `fromPiTool` unwraps it (the Overseer's subagent tools). */
  readonly native?: HarnessNative;
}

/** What a hook handler in one of Sova's inline extensions reads: a ToolCtx plus two facts the resource
    monitor needs. Sova hooks call the adapter's `toolCtx(ctx)` first and read nothing else of the
    harness's context (pi's `model` aside, until the plugin API). */
export interface HookCtx extends ToolCtx {
  /** The session's key (pi: the canonical file path), null while the session has no file. */
  readonly key: SessionKey | null;
  /** The session's name as recorded (pi: the newest session_info), or undefined. */
  title(): string | undefined;
}

export interface ToolSpec<P = any, D = any> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  /** Bullets added to the system prompt's guidelines while the tool is active (session-powers). */
  promptGuidelines?: string[];
  parameters: JsonSchema;
  /** Rewrites the raw arguments before they are checked against `parameters`; a throw refuses the call
      with its message (record_decision's owner area). */
  prepareArguments?(args: unknown): unknown;
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
