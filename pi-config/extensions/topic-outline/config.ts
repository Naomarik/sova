/** Config loading for topic-outline: global file, project override only when trusted. */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { OutlineConfig, SummarizerSpec } from "./types.ts";

export const DEFAULT_CONFIG: OutlineConfig = {
  summarizers: [
    { backend: "claude-code", model: "haiku", timeoutMs: 45_000, maxBudgetUsd: 0.05 },
    { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", timeoutMs: 60_000 },
  ],
  trigger: { debounceMs: 3_000, minNewMessages: 2 },
  shareWithSessions: "now-only",
  shareLastHeading: true,
  claudeBin: join(homedir(), ".local/bin/claude"),
  limits: { maxTopics: 40, maxBullets: 3 },
};

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeSummarizers(value: unknown): SummarizerSpec[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: SummarizerSpec[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Partial<SummarizerSpec>;
    if ((raw.backend !== "claude-code" && raw.backend !== "pi") || typeof raw.model !== "string" || !raw.model) continue;
    const spec: SummarizerSpec = { backend: raw.backend, model: raw.model };
    if (typeof raw.timeoutMs === "number" && raw.timeoutMs > 0) spec.timeoutMs = raw.timeoutMs;
    if (typeof raw.maxBudgetUsd === "number" && raw.maxBudgetUsd > 0) spec.maxBudgetUsd = raw.maxBudgetUsd;
    out.push(spec);
  }
  return out.length ? out : undefined;
}

function merge(raw: Record<string, unknown> | undefined, base: OutlineConfig): OutlineConfig {
  if (!raw) return base;
  const config: OutlineConfig = {
    ...base,
    trigger: { ...base.trigger },
    limits: { ...base.limits },
    summarizers: sanitizeSummarizers(raw.summarizers) ?? base.summarizers,
  };
  if (raw.shareWithSessions === "off" || raw.shareWithSessions === "now-only" || raw.shareWithSessions === "summary") {
    config.shareWithSessions = raw.shareWithSessions;
  }
  if (typeof raw.shareLastHeading === "boolean") config.shareLastHeading = raw.shareLastHeading;
  if (typeof raw.claudeBin === "string" && raw.claudeBin) config.claudeBin = raw.claudeBin;
  const trigger = raw.trigger as Partial<OutlineConfig["trigger"]> | undefined;
  if (trigger) {
    if (typeof trigger.debounceMs === "number" && trigger.debounceMs >= 0) config.trigger.debounceMs = trigger.debounceMs;
    if (typeof trigger.minNewMessages === "number" && trigger.minNewMessages >= 0) config.trigger.minNewMessages = trigger.minNewMessages;
  }
  const limits = raw.limits as Partial<OutlineConfig["limits"]> | undefined;
  if (limits) {
    if (typeof limits.maxTopics === "number" && limits.maxTopics > 0) config.limits.maxTopics = limits.maxTopics;
    if (typeof limits.maxBullets === "number" && limits.maxBullets > 0) config.limits.maxBullets = limits.maxBullets;
  }
  return config;
}

/**
 * Global config at ~/.pi/agent/topic-outline.json always applies.
 * Project-local .pi/topic-outline.json applies only when the project is trusted.
 */
export function loadConfig(cwd: string, projectTrusted: boolean, configDir?: string): OutlineConfig {
  const globalDir = configDir ?? join(homedir(), ".pi/agent");
  let config = merge(readJson(join(globalDir, "topic-outline.json")), DEFAULT_CONFIG);
  if (projectTrusted && cwd) {
    config = merge(readJson(join(cwd, ".pi", "topic-outline.json")), config);
  }
  return config;
}
