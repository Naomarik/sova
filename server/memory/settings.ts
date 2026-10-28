// Settings → Memory (§chat.memory/settings): <agent dir>/mode-memory.json, the summarizer (a worker tuple
// plus an optional fallback, the spec writer's shape), each type's Summary size (every chat's and the
// Overseer's: no chat has a size of its own) and the memory type new chats start from. Only Sova reads
// it: the engine is the server's. A missing or malformed file reads as the defaults; a slot that doesn't
// parse takes its default alone. Written atomically.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_EFFORTS, DELEGATE_BACKENDS, parseChoice, PI_EFFORTS, statCachedReader, writeJsonAtomic } from "../../pi-config/extensions/mode/delegate.ts";
import type { ChatMemoryChoice, MemorySaveResult, MemorySettings, MemorySettingsInfo, MemoryType, WorkerChoice } from "../../shared/protocol";
import { MEMORY_SIZE_MAX, MEMORY_SIZE_MIN } from "../../shared/protocol";
import { BUILTIN_MEMORY_CHOICE, isMemoryType, MEMORY_TYPE_INFO, MEMORY_TYPES, memoryTypeInfo } from "../../shared/memory";
import { agentRoot } from "../state-root";
import { delegateOptions, verifySlots, type DelegateSources } from "../delegate";

export const MEMORY_FILE_NAME = "mode-memory.json";
export const memoryFile = (): string => join(agentRoot(), MEMORY_FILE_NAME);

/** Haiku 5.5 at low effort: what the spike measured (§chat.memory/summarizer). */
export const DEFAULT_SUMMARIZER: WorkerChoice = { backend: "claude-code", model: "claude-haiku-5-5", effort: "low" };

/** Each type's own size: what a type uses until Settings → Memory sets one. */
export const builtinMemorySizes = (): Record<MemoryType, number> =>
  Object.fromEntries(MEMORY_TYPES.map((t) => [t, memoryTypeInfo(t).defaultSize])) as Record<MemoryType, number>;

export function memoryDefaults(): MemorySettings {
  return { version: 1, summarizer: { primary: { ...DEFAULT_SUMMARIZER }, fallback: null }, sizes: builtinMemorySizes() };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isSize = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= MEMORY_SIZE_MIN && v <= MEMORY_SIZE_MAX;
const SIZE_RULE = `a whole number of KB from ${MEMORY_SIZE_MIN} to ${MEMORY_SIZE_MAX}`;
const TYPE_RULE = () => `one of: ${MEMORY_TYPE_INFO.map((t) => t.id).join(", ")}`;

/**
 * A memory patch from a chat's menu or the Overseer's switch, or the reason it isn't one: a type only.
 * A `size` is ignored, never refused (an older client still sends one): the size is Settings' for the
 * type (§chat.memory/choice).
 */
export function parseMemoryPatch(value: unknown): { type?: MemoryType } | { error: string } {
  if (!isRecord(value)) return { error: "memory must be an object { type }" };
  if (value.type === undefined) return value.size !== undefined ? {} : { error: "memory: send a type" };
  if (!isMemoryType(value.type)) return { error: `memory.type must be ${TYPE_RULE()}` };
  return { type: value.type };
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
  const sizes = isRecord(value.sizes) ? value.sizes : {};
  for (const t of MEMORY_TYPES) if (isSize(sizes[t])) out.sizes![t] = sizes[t];
  const d = isRecord(value.default) ? value.default : undefined;
  if (d && isMemoryType(d.type)) {
    out.default = { type: d.type };
    // An older file saved a size with its default: it becomes that type's size once, while `sizes` names
    // none for it. The default is written without it from then on, so this runs before any rewrite.
    if (isSize(d.size) && sizes[d.type] === undefined) out.sizes![d.type] = d.size;
  }
  return out;
}

/** A PUT body, strictly: a bad slot is an error, never a silent default. */
export function parseMemorySettings(value: unknown): MemorySettings | { error: string } {
  if (!isRecord(value) || value.version !== 1) return { error: "Expected { version: 1, summarizer: { primary, fallback }, sizes?, default? }" };
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
  if (value.sizes !== undefined) {
    if (!isRecord(value.sizes)) return { error: `sizes must be { ${MEMORY_TYPES.join("?, ")}? }` };
    const sizes: Partial<Record<MemoryType, number>> = {};
    for (const [t, n] of Object.entries(value.sizes)) {
      if (!isMemoryType(t)) return { error: `sizes: ${t} is not a memory type (${TYPE_RULE()})` };
      if (!isSize(n)) return { error: `sizes.${t} must be ${SIZE_RULE}` };
      sizes[t] = n;
    }
    out.sizes = sizes;
  }
  if (value.default !== undefined) {
    if (!isRecord(value.default) || !isMemoryType(value.default.type)) return { error: `default: type must be ${TYPE_RULE()}` };
    out.default = { type: value.default.type };
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

/** The Summary size every chat (and the Overseer) of `type` uses: Settings' for that type. */
export function memorySizeFor(type: MemoryType, settings: MemorySettings): number {
  return settings.sizes?.[type] ?? memoryTypeInfo(type).defaultSize;
}

/** The choice a chat with no record of its own uses: the saved default type, else UniiChat, at Settings' size. */
export function defaultMemoryChoice(file = memoryFile()): ChatMemoryChoice {
  const s = loadMemorySettings(file);
  const type = s.default?.type ?? BUILTIN_MEMORY_CHOICE.type;
  return { type, size: memorySizeFor(type, s) };
}

/** Save `type` as the one new chats start from, keeping the summarizer and the sizes (an older default's
    size among them: the load moved it into `sizes` first). */
export function saveDefaultMemoryType(type: MemoryType, file = memoryFile()): void {
  saveMemorySettings({ ...loadMemorySettings(file), default: { type } }, file);
}

/** An overseer's memory as saved (`memory` in its overseer.json), or absent: no choice made yet. `size`: an
    older file's, kept as it is and read by nothing (the size is Settings → Memory's). */
export interface OverseerMemorySetting {
  on: boolean;
  type: ChatMemoryChoice["type"];
  size?: number;
}

/** An overseer's memory in force: its switch and type, at Settings' size for that type. */
export interface OverseerMemoryInForce {
  on: boolean;
  type: ChatMemoryChoice["type"];
  size: number;
}

/**
 * An overseer's memory in force: its saved switch and type, else on with the built-in UniiChat (never the
 * default type Settings → Memory saved for ordinary chats), at Settings' size for the type. The one reading
 * every overseer path uses (the chat, the routes, the turned-on edge).
 */
export function overseerMemoryOf(saved: OverseerMemorySetting | undefined | null, file = memoryFile()): OverseerMemoryInForce {
  const on = saved ? saved.on : true;
  const type = saved ? saved.type : BUILTIN_MEMORY_CHOICE.type;
  return { on, type, size: memorySizeFor(type, loadMemorySettings(file)) };
}

/** A saved overseer memory setting read tolerantly (a stored file's `memory`), or undefined. A size outside
    the range is dropped, never the setting. */
export function parseOverseerMemory(m: unknown): OverseerMemorySetting | undefined {
  if (!isRecord(m) || typeof m.on !== "boolean" || !isMemoryType(m.type)) return undefined;
  return { on: m.on, type: m.type, ...(isSize(m.size) ? { size: m.size } : {}) };
}

/**
 * A PUT body for an overseer's switch `{ on?, type? }` over its saved setting: the next saved setting, or the
 * reason the body isn't one. A `size` is ignored, never refused (the size is Settings'); a size the saved
 * setting holds is kept. Shared by `/api/overseer/memory` and a project overseer's.
 */
export function patchOverseerMemory(saved: OverseerMemorySetting | undefined, body: unknown): OverseerMemorySetting | { error: string } {
  if (!isRecord(body)) return { error: "Expected JSON body { on?, type? }" };
  if (body.on !== undefined && typeof body.on !== "boolean") return { error: "on must be true or false" };
  if (body.type !== undefined && !isMemoryType(body.type)) return { error: `type must be ${TYPE_RULE()}` };
  const cur = overseerMemoryOf(saved);
  return {
    on: typeof body.on === "boolean" ? body.on : cur.on,
    type: isMemoryType(body.type) ? body.type : cur.type,
    ...(saved?.size !== undefined ? { size: saved.size } : {}),
  };
}

/** A record's choice completed: the record's type (else the saved default's) at Settings' size for it. A
    size the record holds is an older chat's own, and ignored. */
export function choiceOf(record: { type: MemoryType; size?: number } | null | undefined, file = memoryFile()): ChatMemoryChoice {
  const s = loadMemorySettings(file);
  const type = record?.type ?? s.default?.type ?? BUILTIN_MEMORY_CHOICE.type;
  return { type, size: memorySizeFor(type, s) };
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
  saveMemorySettings(
    {
      ...parsed,
      sizes: { ...stored.sizes, ...parsed.sizes },
      ...(parsed.default ? {} : stored.default ? { default: stored.default } : {}),
    },
    file,
  );
  return { ...memorySettingsInfo(file), warnings: verdict.warnings };
}
