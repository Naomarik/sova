import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseChoice } from "../pi-config/extensions/mode/delegate.ts";
import type { DecisionSettings, WorkerChoice } from "../shared/protocol";
import { stateRoot } from "./state-root";

// Settings → Decisions: `<stateRoot>/decisions.json`. Nothing outside Sova reads it. Tolerant read
// (a broken file reads as the defaults: everything off), strict PUT, atomic write.

export const decisionsFile = () => join(stateRoot(), "decisions.json");

export const MAX_EXCLUSIONS = 100;

/** Both features off, no fallback (nothing is picked for the user), Jev's own switch on. */
export function decisionDefaults(): DecisionSettings {
  return { version: 1, jev: { enabled: true }, fallback: null, features: { attention: false, tags: false }, exclusions: [], neverSendTui: false };
}

/** Shown beside the fallback row as hints, never pre-selected. */
export const DECISION_SUGGESTIONS: WorkerChoice[] = [
  { backend: "claude-code", model: "haiku", effort: "low" },
  { backend: "pi", model: "ollama-cloud/deepseek-v4.1-flash", effort: "off" },
];

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** One exclusion: absolute or `~/`-relative, no trailing slash. Null when unusable. */
function cleanPrefix(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let p = v.trim();
  if (!p || p.length > 1024 || !(p.startsWith("/") || p === "~" || p.startsWith("~/"))) return null;
  while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/** Strict: the whole shape, or the first reason it isn't one. */
export function parseDecisionSettings(value: unknown): DecisionSettings | { error: string } {
  if (!isRecord(value)) return { error: "expected a decisions settings object" };
  if (value.version !== 1) return { error: "version must be 1" };
  if (!isRecord(value.jev) || typeof value.jev.enabled !== "boolean") return { error: "jev.enabled must be a boolean" };
  let fallback: WorkerChoice | null = null;
  if (value.fallback !== null) {
    const parsed = parseChoice(value.fallback);
    if ("error" in parsed) return { error: `fallback: ${parsed.error}` };
    fallback = parsed;
  }
  if (!isRecord(value.features) || typeof value.features.attention !== "boolean" || typeof value.features.tags !== "boolean")
    return { error: "features.attention and features.tags must be booleans" };
  if (!Array.isArray(value.exclusions)) return { error: "exclusions must be a list of folders" };
  if (value.exclusions.length > MAX_EXCLUSIONS) return { error: `at most ${MAX_EXCLUSIONS} excluded folders` };
  const exclusions: string[] = [];
  for (const e of value.exclusions) {
    const p = cleanPrefix(e);
    if (!p) return { error: `excluded folder ${JSON.stringify(e).slice(0, 80)} must be an absolute path or start with ~/` };
    if (!exclusions.includes(p)) exclusions.push(p);
  }
  if (typeof value.neverSendTui !== "boolean") return { error: "neverSendTui must be a boolean" };
  return { version: 1, jev: { enabled: value.jev.enabled }, fallback, features: { attention: value.features.attention, tags: value.features.tags }, exclusions, neverSendTui: value.neverSendTui };
}

/** Tolerant: each field that doesn't parse takes its default; a missing/corrupt file is the defaults. */
export function normalizeDecisionSettings(value: unknown): DecisionSettings {
  const d = decisionDefaults();
  if (!isRecord(value) || value.version !== 1) return d;
  const fb = value.fallback === null || value.fallback === undefined ? null : parseChoice(value.fallback);
  return {
    version: 1,
    jev: { enabled: isRecord(value.jev) && typeof value.jev.enabled === "boolean" ? value.jev.enabled : d.jev.enabled },
    fallback: fb && !("error" in fb) ? fb : null,
    features: {
      attention: isRecord(value.features) && value.features.attention === true,
      tags: isRecord(value.features) && value.features.tags === true,
    },
    exclusions: Array.isArray(value.exclusions) ? [...new Set(value.exclusions.map(cleanPrefix).filter((p): p is string => !!p))].slice(0, MAX_EXCLUSIONS) : [],
    neverSendTui: value.neverSendTui === true,
  };
}

let cache: { file: string; stamp: string; value: DecisionSettings } | undefined;

/** The stored settings, re-parsed only when the file's stat changes. */
export function readDecisionSettings(file = decisionsFile()): DecisionSettings {
  let stamp: string;
  try {
    const st = statSync(file);
    stamp = `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    cache = undefined;
    return decisionDefaults();
  }
  if (cache?.file === file && cache.stamp === stamp) return cache.value;
  let value: DecisionSettings;
  try {
    value = normalizeDecisionSettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    value = decisionDefaults();
  }
  cache = { file, stamp, value };
  return value;
}

export function writeDecisionSettings(settings: DecisionSettings, file = decisionsFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file);
  cache = undefined;
}

const expand = (p: string, home: string) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);

/** The cwd is one of the excluded folders or inside one (path-boundary match, `~` expanded). */
export function isExcluded(settings: Pick<DecisionSettings, "exclusions">, cwd: string, home = homedir()): boolean {
  const c = cwd.length > 1 && cwd.endsWith("/") ? cwd.slice(0, -1) : cwd;
  return settings.exclusions.some((e) => {
    const p = expand(e, home);
    return c === p || c.startsWith(p === "/" ? "/" : `${p}/`);
  });
}

export type DecisionFeature = "attention" | "tags";

/**
 * A terminal session, for `neverSendTui`: open in a TUI right now, OR started outside Sova
 * (origin "external") and not hosted by this server — so a TUI session is still held back after
 * the terminal closes. A web-started session, or one this server hosts, is not one.
 */
export function terminalSession(row: { live: unknown; origin: "web" | "external" }, hostedHere = false): boolean {
  return !!row.live || (row.origin !== "web" && !hostedHere);
}

/**
 * May this session's text leave the machine for this feature? The ONE gate both features call
 * before building a state: the feature is on, the folder is not excluded, and — with
 * `neverSendTui` — it is not a terminal session (pass `terminalSession(row, hostedHere)`).
 * Provider availability is the chain's.
 */
export function maySend(
  settings: DecisionSettings,
  feature: DecisionFeature,
  session: { cwd: string; terminal: boolean },
  home = homedir(),
): { ok: true } | { ok: false; reason: "feature-off" | "excluded" | "tui" } {
  if (!settings.features[feature]) return { ok: false, reason: "feature-off" };
  if (isExcluded(settings, session.cwd, home)) return { ok: false, reason: "excluded" };
  if (settings.neverSendTui && session.terminal) return { ok: false, reason: "tui" };
  return { ok: true };
}
