import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  MB,
  MESSAGES_CAP,
  MESSAGES_DEFAULT,
  MESSAGES_MIN,
  PHOTO_DEFAULTS,
  PHOTO_MB,
  PHOTOS_PER_CONVERSATION,
  PHOTOS_PER_MESSAGE,
  type BatonPhotoSettings,
  type BatonSettings,
} from "../shared/baton";
import { stateRoot } from "./state-root";

/**
 * The host's defaults for baton sessions (§app.baton/goal-and-loadout), set in Settings →
 * Organizations: the message limit for new sessions, and photos in gathering chats
 * (§app.baton/images), which every session on this host follows from its next message. Host
 * state, like the links (never the workspace repo): a restored org keeps each session's own limit
 * in its baton statechart. Same file rules as web-settings.ts: tolerant read, re-read + merge on write,
 * atomic tmp + rename.
 */
const file = () => join(stateRoot(), "baton-settings.json");

const whole = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const validLimit = (v: unknown): v is number => whole(v, MESSAGES_MIN, MESSAGES_CAP);
const validMaxBytes = (v: unknown): v is number => typeof v === "number" && v % MB === 0 && whole(v / MB, PHOTO_MB.min, PHOTO_MB.max);

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
    return { messagesMax: validLimit(raw?.messagesMax) ? raw.messagesMax : MESSAGES_DEFAULT, photos: readPhotos(raw?.photos) };
  } catch {
    return { messagesMax: MESSAGES_DEFAULT, photos: { ...PHOTO_DEFAULTS } };
  }
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
  let stored: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) stored = raw;
  } catch {
    stored = {};
  }
  const nextPhotos = photos ?? readPhotos(stored.photos);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...stored, version: 1, messagesMax: v, photos: nextPhotos }, null, 2)}\n`);
  renameSync(tmp, path);
  return { messagesMax: v, photos: nextPhotos };
}
