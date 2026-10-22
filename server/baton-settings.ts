import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  FILE_MB,
  MB,
  MESSAGES_CAP,
  MESSAGES_DEFAULT,
  MESSAGES_MIN,
  PHOTO_DEFAULTS,
  PHOTO_MB,
  PHOTOS_PER_CONVERSATION,
  PHOTOS_PER_MESSAGE,
  type BatonFileSettings,
  type BatonPhotoSettings,
  type BatonSettings,
} from "../shared/baton";
import type { ModelPick } from "../shared/powers";
import { THINKING_LEVELS, type ThinkingLevel } from "../shared/profiles";
import { stateRoot } from "./state-root";

/**
 * The host's defaults for baton sessions (§app.baton/goal-and-loadout), set in Settings →
 * Organizations: the message limit for new sessions, photos in gathering chats
 * (§app.baton/images), which every session on this host follows from its next message, and the
 * Project Assistant's default model (`assistant`, §app.project-assistant/models). Host
 * state, like the links (never the workspace repo): a restored org keeps each session's own limit
 * in its baton statechart. Same file rules as web-settings.ts: tolerant read, re-read + merge on write,
 * atomic tmp + rename.
 */
const file = () => join(stateRoot(), "baton-settings.json");

const whole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const validLimit = (v: unknown): v is number => whole(v, MESSAGES_MIN, MESSAGES_CAP);
const validMaxBytes = (v: unknown): v is number => typeof v === "number" && v % MB === 0 && whole(v / MB, PHOTO_MB.min, PHOTO_MB.max);
const validFileBytes = (v: unknown): v is number => typeof v === "number" && v % MB === 0 && whole(v / MB, FILE_MB.min, FILE_MB.max);
export const FILE_DEFAULTS: BatonFileSettings = { maxBytes: FILE_MB.default * MB };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored or sent default model: "provider/model" and an optional thinking level, else null. */
export function assistantPickOf(v: unknown): ModelPick | null {
  if (!isRecord(v) || typeof v.model !== "string" || !/^[^\s/]+\/\S+$/.test(v.model.trim())) return null;
  const t = v.thinking;
  return { model: v.model.trim(), ...(typeof t === "string" && (THINKING_LEVELS as readonly string[]).includes(t) ? { thinking: t as ThinkingLevel } : {}) };
}

/** A PUT's `assistant`: absent keeps what is stored, null clears it, a bad pick is an error. */
function assistantOf(v: unknown): ModelPick | null | { error: string } | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const p = assistantPickOf(v);
  if (!p) return { error: "assistant.model is written as provider/model" };
  if (isRecord(v) && v.thinking !== undefined && v.thinking !== null && p.thinking === undefined) return { error: `assistant.thinking must be one of ${THINKING_LEVELS.join(", ")}` };
  return p;
}

/** The stored file settings (§app.baton/files): a bad value reads as its default. */
function readFiles(raw: unknown): BatonFileSettings {
  const f = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { maxBytes: validFileBytes(f.maxBytes) ? f.maxBytes : FILE_DEFAULTS.maxBytes };
}

/** A PUT's `files`, or an error; absent keeps what is stored. */
function filesOf(v: unknown): BatonFileSettings | { error: string } | undefined {
  if (v === undefined) return undefined;
  const f = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!f || !validFileBytes(f.maxBytes)) return { error: `files.maxBytes must be a whole number of MB from ${FILE_MB.min} to ${FILE_MB.max}` };
  return { maxBytes: f.maxBytes };
}

/** The stored photo settings, each field on its own: a bad one reads as its default. */
function readPhotos(raw: unknown): BatonPhotoSettings {
  const p = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : PHOTO_DEFAULTS.enabled,
    perMessage: whole(p.perMessage, PHOTOS_PER_MESSAGE.min, PHOTOS_PER_MESSAGE.max) ? p.perMessage : PHOTO_DEFAULTS.perMessage,
    maxBytes: validMaxBytes(p.maxBytes) ? p.maxBytes : PHOTO_DEFAULTS.maxBytes,
    perConversation: whole(p.perConversation, PHOTOS_PER_CONVERSATION.min, PHOTOS_PER_CONVERSATION.max) ? p.perConversation : PHOTO_DEFAULTS.perConversation,
  };
}

/** The stored defaults; a missing, corrupt or out-of-bounds value reads as the built-in default. */
export function readBatonSettings(path = file()): BatonSettings {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return { messagesMax: validLimit(raw?.messagesMax) ? raw.messagesMax : MESSAGES_DEFAULT, photos: readPhotos(raw?.photos), files: readFiles(raw?.files), assistant: assistantPickOf(raw?.assistant) };
  } catch {
    return { messagesMax: MESSAGES_DEFAULT, photos: { ...PHOTO_DEFAULTS }, files: { ...FILE_DEFAULTS }, assistant: null };
  }
}

/** The host's Project Assistant default (§app.project-assistant/models), or null. */
export const assistantDefault = (path = file()): ModelPick | null => readBatonSettings(path).assistant ?? null;

/** Whether the first default already adopted the organizations' matching picks (it happens once per host). */
export function assistantPicksAdopted(path = file()): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return typeof raw?.assistantAdoptedAt === "string";
  } catch {
    return false;
  }
}

/** Marks the one-time adoption done (re-read + merge, atomic). */
export function markAssistantPicksAdopted(now = Date.now(), path = file()): void {
  let stored: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(raw)) stored = raw;
  } catch {
    stored = {};
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...stored, assistantAdoptedAt: new Date(now).toISOString() }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** A PUT's `photos`, or an error; absent keeps what is stored. */
function photosOf(v: unknown): BatonPhotoSettings | { error: string } | undefined {
  if (v === undefined) return undefined;
  const p = typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  if (!p || typeof p.enabled !== "boolean") return { error: "photos.enabled must be true or false" };
  if (!whole(p.perMessage, PHOTOS_PER_MESSAGE.min, PHOTOS_PER_MESSAGE.max)) return { error: `photos.perMessage must be a whole number from ${PHOTOS_PER_MESSAGE.min} to ${PHOTOS_PER_MESSAGE.max}` };
  if (!validMaxBytes(p.maxBytes)) return { error: `photos.maxBytes must be a whole number of MB from ${PHOTO_MB.min} to ${PHOTO_MB.max}` };
  if (!whole(p.perConversation, PHOTOS_PER_CONVERSATION.min, PHOTOS_PER_CONVERSATION.max))
    return { error: `photos.perConversation must be a whole number from ${PHOTOS_PER_CONVERSATION.min} to ${PHOTOS_PER_CONVERSATION.max}` };
  return { enabled: p.enabled, perMessage: p.perMessage, maxBytes: p.maxBytes, perConversation: p.perConversation };
}

/** Validate and persist; `{ error }` for a bad body. Keys this version doesn't know survive. */
export function writeBatonSettings(body: unknown, path = file()): BatonSettings | { error: string } {
  const b = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const v = b.messagesMax;
  if (!validLimit(v)) return { error: `messagesMax must be a whole number from ${MESSAGES_MIN} to ${MESSAGES_CAP}` };
  const photos = photosOf(b.photos);
  if (photos && "error" in photos) return photos;
  const files = filesOf(b.files);
  if (files && "error" in files) return files;
  // The Project Assistant's default is never set here: it has its own route, which needs mesh `admin`
  // (PUT /api/settings/project-assistant, writeAssistantDefault); this one takes `sessions`.
  if (b.assistant !== undefined) return { error: "assistant is set through PUT /api/settings/project-assistant" };
  let stored: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) stored = raw;
  } catch {
    stored = {};
  }
  const nextPhotos = photos ?? readPhotos(stored.photos);
  const nextFiles = files ?? readFiles(stored.files);
  const nextAssistant = assistantPickOf(stored.assistant);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...stored, version: 1, messagesMax: v, photos: nextPhotos, files: nextFiles }, null, 2)}\n`);
  renameSync(tmp, path);
  return { messagesMax: v, photos: nextPhotos, files: nextFiles, assistant: nextAssistant };
}

/** Set or clear the Project Assistant's default (PUT /api/settings/project-assistant {assistant}); `{ error }`
    for a bad pick. Every other key is kept (re-read + merge, atomic). */
export function writeAssistantDefault(body: unknown, path = file()): { assistant: ModelPick | null } | { error: string } {
  const b = isRecord(body) ? body : {};
  if (!("assistant" in b)) return { error: "Expected { assistant: {model, thinking?} | null }" };
  const assistant = assistantOf(b.assistant);
  if (assistant && "error" in assistant) return assistant;
  let stored: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (isRecord(raw)) stored = raw;
  } catch {
    stored = {};
  }
  const { assistant: _old, ...rest } = stored;
  const next = assistant ?? null;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...rest, version: 1, ...(next ? { assistant: next } : {}) }, null, 2)}\n`);
  renameSync(tmp, path);
  return { assistant: next };
}
