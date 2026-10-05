import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CLAUDE_EFFORTS, DELEGATE_BACKENDS, parseChoice, PI_EFFORTS, sameChoice } from "../pi-config/extensions/mode/delegate.ts";
import type { SessionTitleSettings, SessionTitleSettingsInfo, WorkerChoice } from "../shared/protocol";
import { stateRoot } from "./state-root";

// Settings → Summaries → Session titles (§app.settings-dialog/summaries, §app.session-list/auto-titles):
// `<stateRoot>/session-titles-settings.json`, Sova's own file — nothing outside Sova reads it, and
// each host has its own. Tolerant read (a missing file, or a field that doesn't parse, is that
// field's default), strict PUT, atomic write — the rules of decide-settings.ts.

export const sessionTitleSettingsFile = () => join(stateRoot(), "session-titles-settings.json");

export const INTERVAL_RANGE = { min: 1, max: 1440 } as const;
export const QUIET_RANGE = { min: 0, max: 1440 } as const;

const BACKEND_LABELS = { pi: "pi", "claude-code": "Claude Code" } as const;

/** On (a file that says `enabled: false` keeps it off); every 5 minutes after 5 quiet ones; pi deepseek-v4.1-flash, then Claude Code sonnet at low. */
export function sessionTitleDefaults(): SessionTitleSettings {
  return {
    version: 1,
    enabled: true,
    intervalMinutes: 5,
    quietMinutes: 5,
    primary: { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", effort: "off" },
    fallback: { backend: "claude-code", model: "sonnet", effort: "low" },
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const minutes = (v: unknown, range: { min: number; max: number }): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= range.min && v <= range.max ? v : null;

const KEYS = ["version", "enabled", "intervalMinutes", "quietMinutes", "primary", "fallback"];

/** Strict: the whole shape, or the first reason it isn't one. */
export function parseSessionTitleSettings(value: unknown): SessionTitleSettings | { error: string } {
  if (!isRecord(value)) return { error: "Expected { version: 1, enabled, intervalMinutes, quietMinutes, primary, fallback }" };
  const extra = Object.keys(value).filter((k) => !KEYS.includes(k));
  if (extra.length) return { error: `Unknown field ${extra.map((k) => JSON.stringify(k)).join(", ")}` };
  if (value.version !== 1) return { error: "version must be 1" };
  if (typeof value.enabled !== "boolean") return { error: "enabled must be true or false" };
  const intervalMinutes = minutes(value.intervalMinutes, INTERVAL_RANGE);
  if (intervalMinutes === null) return { error: `intervalMinutes must be a whole number from ${INTERVAL_RANGE.min} to ${INTERVAL_RANGE.max}` };
  const quietMinutes = minutes(value.quietMinutes, QUIET_RANGE);
  if (quietMinutes === null) return { error: `quietMinutes must be a whole number from ${QUIET_RANGE.min} to ${QUIET_RANGE.max}` };
  const primary = parseChoice(value.primary);
  if ("error" in primary) return { error: `primary: ${primary.error}` };
  if (!("fallback" in value)) return { error: "fallback is required (null for none)" };
  let fallback: WorkerChoice | null = null;
  if (value.fallback !== null) {
    const parsed = parseChoice(value.fallback);
    if ("error" in parsed) return { error: `fallback: ${parsed.error} (or null for none)` };
    if (sameChoice(parsed, primary)) return { error: "The fallback is the same as the primary. Choose another model, or no fallback." };
    fallback = parsed;
  }
  return { version: 1, enabled: value.enabled, intervalMinutes, quietMinutes, primary, fallback };
}

/** Tolerant: each field that doesn't parse takes its default; a missing/corrupt file is the defaults. */
export function normalizeSessionTitleSettings(value: unknown): SessionTitleSettings {
  const d = sessionTitleDefaults();
  if (!isRecord(value) || value.version !== 1) return d;
  const primary = parseChoice(value.primary);
  const out: SessionTitleSettings = {
    version: 1,
    enabled: typeof value.enabled === "boolean" ? value.enabled : d.enabled,
    intervalMinutes: minutes(value.intervalMinutes, INTERVAL_RANGE) ?? d.intervalMinutes,
    quietMinutes: minutes(value.quietMinutes, QUIET_RANGE) ?? d.quietMinutes,
    primary: "error" in primary ? d.primary : primary,
    fallback: d.fallback,
  };
  if (value.fallback === null) out.fallback = null;
  else if (value.fallback !== undefined) {
    const fb = parseChoice(value.fallback);
    if (!("error" in fb)) out.fallback = fb;
  }
  if (out.fallback && sameChoice(out.fallback, out.primary)) out.fallback = null;
  return out;
}

let cache: { file: string; stamp: string; value: SessionTitleSettings } | undefined;

/** The stored settings, re-parsed only when the file's stat changes. */
export function readSessionTitleSettings(file = sessionTitleSettingsFile()): SessionTitleSettings {
  let stamp: string;
  try {
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    cache = undefined;
    return sessionTitleDefaults();
  }
  if (cache?.file === file && cache.stamp === stamp) return cache.value;
  let value: SessionTitleSettings;
  try {
    value = normalizeSessionTitleSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    value = sessionTitleDefaults();
  }
  cache = { file, stamp, value };
  return value;
}

/** Whole and atomic (tmp + rename). */
export function writeSessionTitleSettings(settings: SessionTitleSettings, file = sessionTitleSettingsFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file);
  cache = undefined;
}

/**
 * GET's answer: the settings, the defaults, each backend's efforts for the rows, and why each
 * configured model can't run right now (`usable`, server/session-autotitle.ts modelProblem).
 */
export async function sessionTitleSettingsInfo(
  usable: (choice: WorkerChoice) => Promise<string | null>,
  file = sessionTitleSettingsFile(),
): Promise<SessionTitleSettingsInfo> {
  const settings = readSessionTitleSettings(file);
  const [primary, fallback] = await Promise.all([usable(settings.primary), settings.fallback ? usable(settings.fallback) : Promise.resolve(null)]);
  return {
    settings,
    defaults: sessionTitleDefaults(),
    backends: DELEGATE_BACKENDS.map((id) => ({ id, label: BACKEND_LABELS[id], efforts: [...(id === "pi" ? PI_EFFORTS : CLAUDE_EFFORTS)] })),
    ...(primary || fallback ? { unusable: { ...(primary ? { primary } : {}), ...(fallback ? { fallback } : {}) } } : {}),
    file,
  };
}
