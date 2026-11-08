// A chat's switch of its whole Models part to another profile (§chat.profiles/switch, /edited): what the
// server hands the chat to switch to, what the chat records, and the state its menu, its thread and the
// usage-limit row read. Types and pure helpers only: the server, the chat runtime and the client share them.

/** `customType` of the hidden entry a switch writes: which joined profile the chat is on now (never LLM context, no row). */
export const CHAT_PROFILE_ENTRY = "sova-chat-profile";

/** The hidden entry's data: the joined profile's id and key, its name, and the model and effort it sets for the chat. */
export interface ChatProfileEntryData {
  v: 1;
  /** The joined id ("off", a session profile's id, a library-only profile's library id). */
  id: string;
  /** The joined key (§chat.profiles/joined), when the server knew it. */
  key?: string;
  name: string;
  /** The chat's own model the profile sets (a ref); absent: it keeps the chat's own. */
  model?: string;
  thinking?: string;
}

/** A switch as the chat takes it: everything already resolved from the joined list on the server. */
export interface ProfileSwitchTarget {
  id: string;
  key?: string;
  name: string;
  /** The chat's own model the profile sets; absent: the chat keeps its model. */
  model?: string;
  thinking?: string;
  /** The helper pick the chat gets: a library id, or "off". */
  subagents: string;
  /** How many helper roles the profile sets (the waiting line's {n}). */
  helpers: number;
}

/** What a chat's profile is now, and the switch waiting for its reply to end (the `chat_profile` message). */
export interface ChatProfileState {
  /** The profile the chat is on ("off"/"Off" when none). `edited`: its model was changed by hand and differs
      from the profile's (§chat.profiles/edited). `model`: what the chat runs now. */
  current: { id: string; key?: string; name: string; edited: boolean; model?: string; profileModel?: string };
  /** A switch held until the running reply ends (Cancel Switch drops it). */
  pending?: { id: string; key?: string; name: string; helpers: number; setsModel: boolean };
  /** The newest switch that applied, until the chat's next turn starts: "This chat and its helpers are on {name}." */
  applied?: { id: string; name: string; at: number };
  /** A held switch whose turn-end check failed: "Couldn't switch to {name}." with `reason`. Cleared like `applied`. */
  failed?: { id: string; name: string; reason: string };
}

/** The answer of a switch: it applied now, or waits for the reply to end. */
export interface ProfileSwitchResult {
  applies: "now" | "after-turn";
  state: ChatProfileState;
}

/** Normalize the hidden entry's data, or null. */
export function normalizeChatProfile(d: unknown): ChatProfileEntryData | null {
  if (!d || typeof d !== "object" || Array.isArray(d)) return null;
  const r = d as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string" && v !== "";
  if (r.v !== 1 || !str(r.id) || typeof r.name !== "string") return null;
  return {
    v: 1,
    id: r.id,
    name: r.name,
    ...(str(r.key) ? { key: r.key } : {}),
    ...(str(r.model) ? { model: r.model } : {}),
    ...(str(r.thinking) ? { thinking: r.thinking } : {}),
  };
}

/** The waiting line's sentence (§chat.profiles/switch). */
export function waitingLine(p: { name: string; helpers: number; setsModel: boolean }): string {
  const helpers = `${p.helpers} helper${p.helpers === 1 ? "" : "s"}`;
  const moves = p.setsModel ? `this chat's model, its ${helpers}, and alignment settings` : `this chat's ${helpers} and alignment settings`;
  return `Switching to ${p.name} when this reply ends. Moves ${moves}. Tools and modes stay.`;
}
