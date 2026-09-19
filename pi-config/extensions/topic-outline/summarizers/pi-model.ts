/**
 * Pi model-registry summarizer backend (e.g. ollama-cloud/deepseek-v4.1-flash).
 * Goes through ctx.modelRegistry so auth resolution and provider transports are
 * Pi's own; no keys or endpoints handled here.
 */

import { randomUUID } from "node:crypto";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { Summarizer, SummarizeInput, SummarizerResult, SummarizerSpec } from "../types.ts";
import { SummarizerError } from "../types.ts";
import { buildPrompt, parseSummarizerJson } from "./chain.ts";

export const SUMMARIZER_SYSTEM_PROMPT =
  "You maintain incremental topic outlines of conversations. Follow the user's instructions exactly and respond with a single JSON object only.";

export function createPiModelSummarizer(spec: SummarizerSpec, ctx: ExtensionContext): Summarizer {
  const timeoutMs = spec.timeoutMs ?? 60_000;
  const slash = spec.model.indexOf("/");
  const name = `pi/${spec.model}`;
  return {
    name,
    async summarize(input: SummarizeInput): Promise<SummarizerResult> {
      if (slash <= 0) throw new SummarizerError(`expected "provider/model" id, got "${spec.model}"`);
      const providerId = spec.model.slice(0, slash);
      const modelId = spec.model.slice(slash + 1);
      const model = ctx.modelRegistry.find(providerId, modelId);
      if (!model) throw new SummarizerError(`model ${spec.model} not found in registry`);
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new SummarizerError(`no auth configured for ${spec.model}`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
      timer.unref();
      const onAbort = () => controller.abort(input.signal.reason ?? new Error("aborted"));
      input.signal.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await ctx.modelRegistry.complete(
          model,
          {
            systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
            messages: [{ role: "user", content: [{ type: "text", text: buildPrompt(input) }], timestamp: Date.now() }],
          },
          { signal: controller.signal, maxTokens: 2000, cacheRetention: "none", sessionId: randomUUID() },
        );
        const failed = (response.stopReason === "error" || response.stopReason === "aborted") && !response.content.some(
          block => block.type === "text" && block.text.trim());
        if (failed) {
          const reason = (response as { errorMessage?: string }).errorMessage;
          throw new SummarizerError(reason?.trim() || `stopReason=${response.stopReason}`);
        }
        // Reasoning/thinking blocks are ignored; only text blocks carry the answer.
        const text = response.content
          .filter((block): block is { type: "text"; text: string } => block.type === "text")
          .map(block => block.text)
          .join("\n");
        if (!text.trim()) throw new SummarizerError("empty response text");
        return parseSummarizerJson(text, input.validRefs);
      } catch (error) {
        if (error instanceof SummarizerError) throw error;
        throw new SummarizerError(error instanceof Error ? error.message : String(error));
      } finally {
        clearTimeout(timer);
        input.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
