// The memory summarizer (§chat.memory/summarizer): one model call per tree node, never a session. It follows
// the one-shot pattern of server/decide-llm.ts: the model policy is asked before each call, a call claims
// its provider's request slot as background work (claudeRun / piText do that), runs on this host's Claude
// login, and is recorded in the usage ledger as the chat's own spend with purpose "memory".
import { withUsageContext } from "../../pi-config/extensions/llm-inflight/attribution.ts";
import { claudeCliId } from "../../pi-config/extensions/claude-code/catalog.ts";
import { fixedSettingsJson } from "../../pi-config/extensions/claude-code/fixed-settings.ts";
import { DecisionError, failureMessage, type DecisionFailure } from "../decide";
import { claudeRun, parseClaudeEnvelope, piText, type LlmProviderDeps } from "../decide-llm";
import type { MemorySettings, WorkerChoice } from "../../shared/protocol";

/** One summary's spend cap on Claude Code (it is quota on a subscription). */
export const SUMMARY_BUDGET_USD = 0.05;
/** One summary's deadline, its slot wait included. */
export const SUMMARY_TIMEOUT_MS = 90_000;

export interface SummaryCall {
  /** The summarizer's system prompt: the compaction guide, then the stable compaction-view prefix. */
  system: string;
  /** The newer compaction-view lines and the task. */
  prompt: string;
  /** The chat it is for (the ledger's owner). */
  sessionId: string;
  cwd?: string;
}

export interface SummarizerDeps extends LlmProviderDeps {
  settings(): MemorySettings;
  /** Why the model policy refuses this model now, or null. */
  denied(choice: WorkerChoice): string | null;
}

export interface SummaryResult {
  text: string;
  model: string;
}

/** The argv of one Claude Code summary: no tools, no settings, no session, the fixed settings. */
export function summaryClaudeArgs(choice: WorkerChoice, system: string): string[] {
  return [
    "-p",
    "--model", claudeCliId(choice.model),
    "--tools", "",
    "--setting-sources", "",
    "--settings", fixedSettingsJson(),
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--output-format", "json",
    "--max-budget-usd", SUMMARY_BUDGET_USD.toFixed(2),
    "--system-prompt", system,
    ...(choice.effort ? ["--effort", choice.effort] : []),
  ];
}

const fail = (failure: DecisionFailure, message: string) => new DecisionError(failure, message.slice(0, 300));

async function callOne(choice: WorkerChoice, call: SummaryCall, deps: SummarizerDeps): Promise<string> {
  const denied = deps.denied(choice);
  if (denied) throw fail("unavailable", denied);
  const timeoutMs = deps.timeoutMs ?? SUMMARY_TIMEOUT_MS;
  if (choice.backend === "pi") {
    const out = await piText(choice, { systemPrompt: call.system, prompt: call.prompt, maxTokens: (reasoning) => (reasoning ? 4096 : 1024) }, deps, timeoutMs, fail);
    return out.text;
  }
  const stdout = await claudeRun(summaryClaudeArgs(choice, call.system), call.prompt, deps, timeoutMs, fail);
  const env = JSON.parse(stdout) as { result?: unknown; is_error?: boolean };
  if (env.is_error) parseClaudeEnvelope(stdout, fail); // throws with the CLI's own reason
  if (typeof env.result !== "string" || !env.result.trim()) throw fail("malformed-answer", "claude returned no line");
  return env.result;
}

/**
 * One summary: the primary, then the fallback when the primary can't run or fails. Throws the last
 * failure when neither gave a line; the caller tries the node again at the next message.
 */
export async function summarize(call: SummaryCall, deps: SummarizerDeps): Promise<SummaryResult> {
  const { primary, fallback } = deps.settings().summarizer;
  return withUsageContext({ owner: call.sessionId, ...(call.cwd ? { cwd: call.cwd } : {}), purpose: "memory", kind: "oneshot" }, async () => {
    let last: unknown;
    for (const choice of fallback ? [primary, fallback] : [primary]) {
      try {
        return { text: await callOne(choice, call, deps), model: choice.model };
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new Error(failureMessage(last));
  });
}

/** One sentence for the status when summaries can't be written (§chat.memory/status). */
export function problemOf(err: unknown): string {
  if (err instanceof DecisionError) {
    switch (err.failure) {
      case "unavailable":
        return `The memory summarizer can't run: ${err.message}`;
      case "auth":
        return "The memory summarizer's login failed: check Settings → Accounts.";
      case "quota":
      case "rate-limit":
        return "The memory summarizer hit a usage limit; summaries wait until it clears.";
      default:
        return `Memory summaries are failing: ${err.message}`;
    }
  }
  return `Memory summaries are failing: ${failureMessage(err)}`;
}
