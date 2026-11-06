// Background jobs, pi's half (the rules are server/background-jobs-capture.ts): an inline extension every
// chat with `bash` loads. At a bash call's start it marks the call (pi hands `tool_call` handlers the
// call's own copy of its arguments, so the mark never reaches the transcript); at its result, which pi
// gives every call that ran, failed, timed out or was aborted, it keeps what the call left running and
// tells the result so (§app.background-jobs/keeping).
import { captureCall, capturing, markedCommand, newMark, realCaptureDeps, unmarkedContent, type CaptureDeps } from "../../background-jobs-capture";
import type { PiExtensionAPI } from "./extension-types";

const SANDBOX_STATE_EVENT = "sandbox:state";

export function backgroundJobsExtension(deps: () => CaptureDeps = realCaptureDeps) {
  return {
    name: "sova-background-jobs",
    hidden: true,
    factory: (pi: PiExtensionAPI) => {
      const calls = new Map<string, { mark: string; command: string; cwd: string }>();
      /** A sandboxed chat's commands end with their call (§chat.sandbox/limits): nothing to keep. */
      let confined = false;
      pi.events?.on?.(SANDBOX_STATE_EVENT, (e: unknown) => {
        confined = !!(e as { on?: boolean } | undefined)?.on;
      });
      /** One capture at a time: two calls returning together never take one job id. */
      let chain: Promise<unknown> = Promise.resolve();

      pi.on("tool_call", async (event, ctx) => {
        if (event.toolName !== "bash" || confined) return;
        const input = event.input as { command?: unknown };
        if (typeof input?.command !== "string") return;
        const sm = ctx.sessionManager;
        if (!capturing(deps().env, sm.getSessionId?.(), sm.getSessionFile?.())) return;
        const mark = newMark();
        calls.set(event.toolCallId, { mark, command: input.command, cwd: ctx.cwd });
        input.command = markedCommand(input.command, mark);
      });

      pi.on("tool_result", async (event, ctx) => {
        const call = calls.get(event.toolCallId);
        if (!call) return;
        calls.delete(event.toolCallId);
        const sm = ctx.sessionManager;
        const run = chain.then(() => captureCall({ ...call, sessionId: sm.getSessionId?.(), sessionFile: sm.getSessionFile?.() }, deps()));
        chain = run.catch(() => {});
        // The shell's own report of a syntax error on the first line quotes that line, mark included.
        const own = unmarkedContent(event.content, call.mark);
        try {
          const out = await run;
          if (out?.error) console.warn(`[background-jobs] ${out.error}`);
          if (!out) return own === event.content ? undefined : { content: own };
          return { content: [...own, { type: "text" as const, text: `\n\n${out.line}` }] };
        } catch (err) {
          console.warn(`[background-jobs] capture failed: ${err instanceof Error ? err.message : String(err)}`);
          return own === event.content ? undefined : { content: own };
        }
      });
    },
  };
}
