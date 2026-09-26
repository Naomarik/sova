import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MESSAGES_CAP, MESSAGES_DEFAULT, MESSAGES_MIN, type BatonSettings } from "../shared/baton";
import { stateRoot } from "./state-root";

/**
 * The host's defaults for new baton sessions (§app.baton/goal-and-loadout), set in Settings →
 * Organizations: today the message limit. Host state, like the links (never the workspace repo):
 * a restored org keeps each session's own limit in its baton.json row. Same file rules as
 * web-settings.ts: tolerant read, re-read + merge on write, atomic tmp + rename.
 */
const file = () => join(stateRoot(), "baton-settings.json");

const validLimit = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= MESSAGES_MIN && v <= MESSAGES_CAP;

/** The stored defaults; a missing, corrupt or out-of-bounds value reads as the built-in default. */
export function readBatonSettings(path = file()): BatonSettings {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return { messagesMax: validLimit(raw?.messagesMax) ? raw.messagesMax : MESSAGES_DEFAULT };
  } catch {
    return { messagesMax: MESSAGES_DEFAULT };
  }
}

/** Validate and persist; `{ error }` for a bad body. Keys this version doesn't know survive. */
export function writeBatonSettings(body: unknown, path = file()): BatonSettings | { error: string } {
  const v = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).messagesMax : undefined;
  if (!validLimit(v)) return { error: `messagesMax must be a whole number from ${MESSAGES_MIN} to ${MESSAGES_CAP}` };
  let stored: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) stored = raw;
  } catch {
    stored = {};
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...stored, version: 1, messagesMax: v }, null, 2)}\n`);
  renameSync(tmp, path);
  return { messagesMax: v };
}
