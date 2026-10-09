/**
 * Claude Code CLI summarizer backend.
 *
 * Spawns the `claude` binary directly (never via a user shell, which may inject
 * permission-skipping aliases). Runs in an empty private temp directory so no
 * CLAUDE.md or project settings load; strips CLAUDECODE from the environment so
 * claude does not detect a nested session. Prompt goes on stdin.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { Summarizer, SummarizeInput, SummarizerResult, SummarizerSpec } from "../types.ts";
import { SummarizerError } from "../types.ts";
import { buildPrompt, parseSummarizerJson } from "./chain.ts";
import { claudeBaseEnv, hostLogins } from "../../claude-code/accounts.ts";
import { claudeCliId } from "../../claude-code/catalog.ts";
import { fixedSettingsJson } from "../../claude-code/fixed-settings.ts";
import { beginClaudeOneShot } from "../../llm-inflight/claude.ts";
import { resolveUsageAttribution } from "../../llm-inflight/attribution.ts";
import { recordClaudeEnvelope } from "../../llm-inflight/record.ts";

/** This host's first usable Claude login's environment (CLAUDE_CONFIG_DIR, or none for `default`). */
function loginEnv(): Record<string, string> {
  try { return hostLogins().select().env; } catch { return {}; }
}

interface ClaudeEnvelope {
  type?: string;
  is_error?: boolean;
  result?: string;
  subtype?: string;
  terminal_reason?: string;
  api_error_status?: number;
}

/** The one-shot's argv: no tools, no user settings (the fixed ones only), no MCP, no session record. Pure. */
export function claudeCliArgs(model: string, budgetUsd: number): string[] {
  return [
    "-p",
    "--model", claudeCliId(model),
    "--tools", "",
    "--setting-sources", "",
    "--settings", fixedSettingsJson(),
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--output-format", "json",
    "--max-budget-usd", budgetUsd.toFixed(2),
  ];
}

export function createClaudeCliSummarizer(spec: SummarizerSpec, claudeBin: string): Summarizer {
  const timeoutMs = spec.timeoutMs ?? 45_000;
  const budget = spec.maxBudgetUsd ?? 0.05;
  return {
    name: `claude-code/${spec.model}`,
    summarize(input: SummarizeInput): Promise<SummarizerResult> {
      return new Promise((resolve, reject) => {
        if (!existsSync(claudeBin)) {
          reject(new SummarizerError(`claude binary not found at ${claudeBin}`));
          return;
        }
        let cwd: string;
        try {
          cwd = mkdtempSync(join(tmpdir(), "topic-outline-"));
        } catch (error) {
          reject(new SummarizerError(`cannot create temp dir: ${String(error)}`));
          return;
        }
        // Less an inherited CLAUDE_CONFIG_DIR naming a login's directory: `default` is ~/.claude.
        const env = claudeBaseEnv(process.env) as Record<string, string | undefined>;
        delete env.CLAUDECODE;
        delete env.CLAUDE_CODE_ENTRYPOINT;
        delete env.CLAUDE_AGENT_SDK_VERSION;
        Object.assign(env, loginEnv());
        const args = claudeCliArgs(spec.model, budget);
        let child;
        try {
          child = spawn(claudeBin, args, { cwd, env: env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
        } catch (error) {
          rmSync(cwd, { recursive: true, force: true });
          reject(new SummarizerError(`failed to spawn claude: ${String(error)}`));
          return;
        }
        // Its login may not leave this device while it runs (claude-code accounts.ts leases).
        try { hostLogins().leaseChild(env as Record<string, string | undefined>, child); } catch { /* no lease */ }
        // One LLM call in flight (llm-inflight), approximately: from the spawn to the process's real
        // exit. A kill (abort, timeout) is only intent: it counts until the process has gone.
        const endCall = beginClaudeOneShot();
        const who = resolveUsageAttribution(undefined, { purpose: "outline" });
        child.once("exit", endCall);
        child.once("close", endCall);
        // 'error' also reports a failed kill of a live process; only a spawn that never ran ends it.
        child.on("error", () => { if (child.pid === undefined) endCall(); });
        const settle = (error: Error | undefined, value?: SummarizerResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          input.signal.removeEventListener("abort", onAbort);
          try { rmSync(cwd, { recursive: true, force: true }); } catch { /* temp dir cleanup is best-effort */ }
          if (error) reject(error);
          else resolve(value as SummarizerResult);
        };
        const onAbort = () => { child.kill("SIGKILL"); settle(new SummarizerError("aborted by session shutdown")); };
        const timer = setTimeout(() => { child.kill("SIGKILL"); settle(new SummarizerError(`timed out after ${timeoutMs}ms`)); }, timeoutMs);
        timer.unref();
        let settled = false;
        let stdout = "";
        let stderr = "";
        const limit = 2 * 1024 * 1024;
        child.stdout.on("data", chunk => { if ((stdout += chunk).length > limit) { child.kill("SIGKILL"); settle(new SummarizerError("output exceeded 2MiB limit")); } });
        child.stderr.on("data", chunk => { if (stderr.length < 64_000) stderr += chunk; });
        child.on("error", error => settle(new SummarizerError(`spawn failed: ${error.message}`)));
        input.signal.addEventListener("abort", onAbort, { once: true });
        child.on("close", code => {
          // What it spent, from its envelope (a failed run's too), for the session the outline is for.
          if (stdout) recordClaudeEnvelope(stdout, who, claudeCliId(spec.model));
          if (settled) return;
          if (code !== 0) {
            settle(new SummarizerError(`claude exited with code ${code}: ${stderr.slice(-400)}`));
            return;
          }
          let envelope: ClaudeEnvelope;
          try {
            envelope = JSON.parse(stdout) as ClaudeEnvelope;
          } catch {
            settle(new SummarizerError(`output was not the expected JSON envelope: ${stdout.slice(0, 160)}`));
            return;
          }
          if (envelope.is_error || typeof envelope.result !== "string" || !envelope.result.trim()) {
            const reason = envelope.result || stderr.slice(-200) || `terminal_reason=${envelope.terminal_reason ?? "unknown"}`;
            settle(new SummarizerError(`claude reported an error: ${reason.slice(0, 240)}`));
            return;
          }
          try {
            settle(undefined, parseSummarizerJson(envelope.result, input.validRefs));
          } catch (error) {
            settle(error instanceof SummarizerError ? error : new SummarizerError(String(error)));
          }
        });
        child.stdin.on("error", () => { /* EPIPE if the child exits early; close event reports it */ });
        child.stdin.write(buildPrompt(input));
        child.stdin.end();
      });
    },
  };
}
