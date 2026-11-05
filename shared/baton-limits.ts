/**
 * Settings → Organizations' limits, read by the form (src/lib/baton-settings-draft.ts) and the save
 * (server/baton-settings.ts), refused in the same words (shared/form-rules.ts). shared/baton.ts
 * re-exports the bounds for everything else that keeps a session within them.
 */
import type { WholeRule } from "./form-rules";

/** A session's message limit: every limit (the default, a start's own, an extension's result) stays within it. */
export const MESSAGES_MIN = 1;
export const MESSAGES_CAP = 1000;
/** The largest file a person may send (§app.baton/files), in MB. */
export const FILE_MB = { min: 1, max: 25, default: 25 } as const;
export const PHOTOS_PER_MESSAGE = { min: 1, max: 8, default: 4 } as const;
export const PHOTO_MB = { min: 1, max: 10, default: 5 } as const;
export const PHOTOS_PER_CONVERSATION = { min: 1, max: 200, default: 40 } as const;

const whole = (label: string, b: { min: number; max: number }): WholeRule => ({ kind: "whole", label, min: b.min, max: b.max });

export const BATON_RULES = {
  messagesMax: whole("Message limit", { min: MESSAGES_MIN, max: MESSAGES_CAP }),
  perMessage: whole("Photos per message", PHOTOS_PER_MESSAGE),
  mb: whole("Largest photo, MB", PHOTO_MB),
  perConversation: whole("Photos per conversation", PHOTOS_PER_CONVERSATION),
  fileMb: whole("Largest file, MB", FILE_MB),
};
