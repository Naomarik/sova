// Sova's tools as pi tools, and pi's context as Sova's (§app.harness/tools). A ToolSpec is pi's tool
// shape minus pi's types (TypeBox parameters, ExtensionContext), so the conversion is a spread: every
// field (and marker, such as overseer-redact's REDACTING) reaches pi as written; only execute's context
// is mapped. Hooks in Sova's own inline extensions read pi's context through `toolCtx` too.
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HarnessNative, HookCtx, ToolSpec } from "../../../shared/harness";
import { canonicalPath } from "../../paths";

/** A pi ExtensionContext as Sova's HookCtx (a ToolCtx plus `key` and `title()`); the pi context rides
    along, opaque, as `native`. Reads are live: each member asks pi's session manager when read, as the
    code it replaces did. */
export function toolCtx(ctx: ExtensionContext): HookCtx {
  const sm = ctx.sessionManager;
  return {
    get sessionId() {
      return sm.getSessionId();
    },
    get cwd() {
      return ctx.cwd;
    },
    leafId: () => sm.getLeafId() ?? null,
    rawBranch: () => sm.getBranch() as unknown as readonly Record<string, any>[],
    get key() {
      const file = sm.getSessionFile();
      return file ? canonicalPath(file) : null;
    },
    title: () => sm.getSessionName(),
    native: ctx as unknown as HarnessNative,
  };
}

/** The pi tool for a ToolSpec, built when a session registers it: the spec's own fields, unchanged. */
export function toPiTool(spec: ToolSpec): ToolDefinition<any, any> {
  return {
    ...spec,
    execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: ((partial: any) => void) | undefined, ctx: ExtensionContext | undefined) =>
      spec.execute(toolCallId, params, signal, onUpdate, ctx ? toolCtx(ctx) : undefined),
  } as unknown as ToolDefinition<any, any>;
}

/** A pi tool as a ToolSpec, for Sova code that calls one (the Overseer's subagent tools): the tool gets
    its own pi context back from `native`. */
export function fromPiTool(def: ToolDefinition<any, any>): ToolSpec {
  const execute: ToolSpec["execute"] = (toolCallId, params, signal, onUpdate, ctx) =>
    def.execute(toolCallId, params, signal, onUpdate as never, ctx?.native as unknown as ExtensionContext);
  return { ...def, execute } as unknown as ToolSpec;
}
