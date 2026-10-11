// Settings → Memory (§chat.memory/settings): <agent dir>/mode-memory.json, the summarizer (a worker tuple
// plus an optional fallback, the spec writer's shape) and the memory choice new chats start from. Only
// Sova reads it: the engine is the server's. A missing or malformed file reads as the defaults; a slot
// that doesn't parse takes its default alone. Written atomically.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_EFFORTS, DELEGATE_BACKENDS, parseChoice, PI_EFFORTS, statCachedReader, writeJsonAtomic } from "../../pi-config/extensions/mode/delegate.ts";
import type { ChatMemoryChoice, MemorySaveResult, MemorySettings, MemorySettingsInfo, WorkerChoice } from "../../shared/protocol";
import { MEMORY_SIZE_MAX, MEMORY_SIZE_MIN } from "../../shared/protocol";
import { BUILTIN_MEMORY_CHOICE, isMemoryType, MEMORY_TYPE_INFO, memoryTypeInfo } from "../../shared/memory";
import { agentRoot } from "../state-root";
import { delegateOptions, verifySlots, type DelegateSources } from "../delegate";

export const MEMORY_FILE_NAME = "mode-memory.json";
export const memoryFile = (): string => join(agentRoot(), MEMORY_FILE_NAME);

/** Haiku 5.5 at low effort: what the spike measured (§chat.memory/summarizer). */
export const DEFAULT_SUMMARIZER: WorkerChoice = { backend: "claude-code", model: "claude-haiku-5-5", effort: "low" };

export function memoryDefaults(): MemorySettings {
  return { version: 1, summarizer: { primary: { ...DEFAULT_SUMMARIZER }, fallback: null } };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A memory choice, or the reason it isn't one. `partial`: a patch (either field may be absent). */
export function parseMemoryChoice(value: unknown, partial: true): Partial<ChatMemoryChoice> | { error: string };
export function parseMemoryChoice(value: unknown, partial?: false): ChatMemoryChoice | { error: string };
export function parseMemoryChoice(value: unknown, partial = false): Partial<ChatMemoryChoice> | { error: string } {
  if (!isRecord(value)) return { error: "memory must be an object { type?, size? }" };
  const out: Partial<ChatMemoryChoice> = {};
  if (value.type !== undefined || !partial) {
    if (!isMemoryType(value.type)) return { error: `memory.type must be one of: ${MEMORY_TYPE_INFO.map((t) => t.id).join(", ")}` };
    out.type = value.type;
  }
  if (value.size !== undefined || !partial) {
    const size = value.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < MEMORY_SIZE_MIN || size > MEMORY_SIZE_MAX)
      return { error: `memory.size must be a whole number of KB from ${MEMORY_SIZE_MIN} to ${MEMORY_SIZE_MAX}` };
    out.size = size;
  }
  if (partial && out.type === undefined && out.size === undefined) return { error: "memory: send type and/or size" };
  return out;
}

/** Tolerant read of the file's content. */
export function normalizeMemorySettings(value: unknown): MemorySettings {
  const out = memoryDefaults();
  if (!isRecord(value)) return out;
  const s = isRecord(value.summarizer) ? value.summarizer : undefined;
  if (s) {
    const primary = parseChoice(s.primary);
    if (!("error" in primary)) out.summarizer.primary = primary;
    if (s.fallback !== null && s.fallback !== undefined) {
      const fallback = parseChoice(s.fallback);
      if (!("error" in fallback)) out.summarizer.fallback = fallback;
    }
  }
  if (value.default !== undefined) {
    const d = parseMemoryChoice(value.default);
    if (!("error" in d)) out.default = d;
  }
  return out;
}

/** A PUT body, strictly: a bad slot is an error, never a silent default. */
export function parseMemorySettings(value: unknown): Omit<MemorySettings, "default"> & { default?: ChatMemoryChoice } | { error: string } {
  if (!isRecord(value) || value.version !== 1) return { error: "Expected { version: 1, summarizer: { primary, fallback }, default? }" };
  if (!isRecord(value.summarizer)) return { error: "summarizer must be { primary, fallback }" };
  const primary = parseChoice(value.summarizer.primary);
  if ("error" in primary) return { error: `summarizer.primary: ${primary.error}` };
  let fallback: WorkerChoice | null = null;
  if (value.summarizer.fallback !== null && value.summarizer.fallback !== undefined) {
    const f = parseChoice(value.summarizer.fallback);
    if ("error" in f) return { error: `summarizer.fallback: ${f.error}` };
    fallback = f;
  }
  const out: MemorySettings = { version: 1, summarizer: { primary, fallback } };
  if (value.default !== undefined) {
    const d = parseMemoryChoice(value.default);
    if ("error" in d) return { error: `default: ${d.error}` };
    out.default = d;
  }
  return out;
}

export function loadMemorySettings(file = memoryFile()): MemorySettings {
  try {
    return normalizeMemorySettings(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return memoryDefaults();
  }
}

export function saveMemorySettings(settings: MemorySettings, file = memoryFile()): void {
  writeJsonAtomic(file, normalizeMemorySettings(settings));
}

/** The settings as each summary reads them (one stat per read). */
export function memorySettingsReader(file = memoryFile()): () => MemorySettings {
  return statCachedReader(file, loadMemorySettings, memoryDefaults);
}

/** The choice a chat with no record of its own uses: the saved default, else UniiChat at its size. */
export function defaultMemoryChoice(file = memoryFile()): ChatMemoryChoice {
  return loadMemorySettings(file).default ?? { ...BUILTIN_MEMORY_CHOICE };
}

/** Save `choice` as the default new chats start from, keeping the summarizer. */
export function saveDefaultMemoryChoice(choice: ChatMemoryChoice, file = memoryFile()): void {
  saveMemorySettings({ ...loadMemorySettings(file), default: { ...choice } }, file);
}

/** A choice after a patch: a new type without a size of its own takes that type's default size. */
export function applyMemoryPatch(cur: ChatMemoryChoice, patch: Partial<ChatMemoryChoice>): ChatMemoryChoice {
  const type = patch.type ?? cur.type;
  const size = patch.size ?? (type !== cur.type ? memoryTypeInfo(type).defaultSize : cur.size);
  return { type, size };
}

/** A record's choice completed: a size absent from it is the type's own default. */
export function choiceOf(record: { type: ChatMemoryChoice["type"]; size?: number } | null | undefined, file = memoryFile()): ChatMemoryChoice {
  if (!record) return defaultMemoryChoice(file);
  return { type: record.type, size: record.size ?? memoryTypeInfo(record.type).defaultSize };
}

const BACKEND_LABELS = { pi: "pi", "claude-code": "Claude Code" } as const;

export function memorySettingsInfo(file = memoryFile()): MemorySettingsInfo {
  return {
    settings: loadMemorySettings(file),
    defaults: memoryDefaults(),
    backends: DELEGATE_BACKENDS.map((id) => ({ id, label: BACKEND_LABELS[id], efforts: [...(id === "pi" ? PI_EFFORTS : CLAUDE_EFFORTS)] })),
    types: [...MEMORY_TYPE_INFO],
    file,
  };
}

/** PUT /api/settings/memory: shape first, then Delegate's discovery check (a CHANGED tuple its backend
    can't run is refused; an unverifiable or policy-denied one saves with a warning). */
export async function putMemorySettings(body: unknown, sources: DelegateSources, file = memoryFile()): Promise<MemorySaveResult | { error: string }> {
  const parsed = parseMemorySettings(body);
  if ("error" in parsed) return parsed;
  const stored = loadMemorySettings(file);
  const verdict = verifySlots(
    [
      { label: "Memory summarizer primary", choice: parsed.summarizer.primary, stored: stored.summarizer.primary },
      { label: "Memory summarizer fallback", choice: parsed.summarizer.fallback, stored: stored.summarizer.fallback },
    ],
    await delegateOptions(sources),
    "memory summaries",
  );
  if ("error" in verdict) return verdict;
  saveMemorySettings({ ...parsed, ...(parsed.default ? {} : stored.default ? { default: stored.default } : {}) }, file);
  return { ...memorySettingsInfo(file), warnings: verdict.warnings };
}
