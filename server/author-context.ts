// A baton chat's model context (§app.baton/attribution, §app.organizations/privacy), as its context hook
// shapes it wherever the chat runs (server/chat-special.ts): who wrote each message, and the holder's
// profile phrases blanked from the model's own replies. Pure: no org state; what it needs comes as data
// (the run's context pack). server/baton-view.ts re-exports it.
import { BATON_HANDOFF_ENTRY, BATON_OFFER_ENTRY, BATON_SENT_ENTRY, BATON_WRAPUP_ENTRY, OPERATOR, type PersonRef } from "../shared/baton";
import type { HEntry } from "../shared/harness";
import { REDACTED, redactExtensionMessages, serverRedactor } from "./overseer-redact";

/** A state entry's data (pi's custom entry's), as its writer wrote it. */
export const dataOf = (h: HEntry & { kind: "state" }): Record<string, any> | null | undefined => h.data as Record<string, any> | null | undefined;

export const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
};

/** Replace every case-insensitive occurrence of each phrase with [redacted], as whole words (a
    phrase "Gate" never blanks part of "delegate"). Pure. */
export function redactPhrases(text: string, phrases: readonly string[]): string {
  let out = text;
  for (const p of phrases) {
    if (!p) continue;
    const word = /[\p{L}\p{N}]/u;
    const body = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`${word.test(p[0]!) ? "(?<![\\p{L}\\p{N}])" : ""}${body}${word.test(p.at(-1)!) ? "(?![\\p{L}\\p{N}])" : ""}`, "giu");
    out = out.replace(re, REDACTED);
  }
  return out;
}

/**
 * Which profile phrases are secrets here (§app.organizations/privacy): a phrase that is also
 * ordinary vocabulary — the title, anyone's name, role or decision areas, a decision's area, or
 * words someone wrote in this conversation themselves — is never blanked. Pure.
 */
export function secretPhrases(phrases: readonly string[], vocabulary: readonly string[]): string[] {
  const fold = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const known = vocabulary.map(fold).join("\n");
  return [...new Set(phrases)].filter((p) => !known.includes(fold(p)));
}

/**
 * Who wrote each user message on the branch (§app.baton/attribution): the sender its
 * `sova-baton-sent` marker names. The marker lands a microtask after the message: until then, the
 * last message is the holder's. The one rule the share pages, the operator's view and the model's
 * context all read. Pure.
 */
export function messageSenders(branch: readonly HEntry[], holder: PersonRef | null): Map<string, string> {
  const by = new Map<string, string>();
  for (const h of branch) {
    const d = h.kind === "state" && h.key === BATON_SENT_ENTRY ? dataOf(h) : undefined;
    if (typeof d?.targetId === "string" && typeof d?.by === "string") by.set(d.targetId, d.by);
  }
  let lastUserId: string | null | undefined;
  for (const h of branch) if (h.kind === "user") lastUserId = h.id;
  if (lastUserId && holder && !by.has(lastUserId)) by.set(lastUserId, holder);
  return by;
}

/** A user message's note for the model: its timestamp and text (to find it in a model context),
    and the lines that say who wrote it and how the baton moved since the message before. */
export interface AuthorNote {
  timestamp: unknown;
  text: string;
  note: string;
}

/**
 * The author notes for a baton session's model context (§app.baton/attribution): every person's
 * message before the wrap-up, oldest first, labelled with its sender's name ("Omar (the operator)"
 * for the operator's), after a line for each hand-off or offer since the message before. Names only:
 * never an id, a role, a contact or a question. Deterministic per message, so earlier turns never
 * change (the prompt cache). Pure.
 */
export function authorNotes(branch: readonly HEntry[], names: Record<string, string>, holder: PersonRef | null): AuthorNote[] {
  const senders = messageSenders(branch, holder);
  const name = (ref: unknown): string =>
    ref === OPERATOR ? `${names[OPERATOR] || "The operator"} (the operator)` : (typeof ref === "string" && names[ref]) || "someone";
  const out: AuthorNote[] = [];
  let moves: string[] = [];
  for (const h of branch) {
    // The wrap-up's own prompt is nobody's message.
    if (h.kind === "state" && h.key === BATON_WRAPUP_ENTRY) break;
    if (h.kind === "state" && h.key === BATON_HANDOFF_ENTRY) moves.push(`[The conversation passed from ${name(dataOf(h)?.from)} to ${name(dataOf(h)?.to)}]`);
    else if (h.kind === "state" && h.key === BATON_OFFER_ENTRY && Array.isArray(dataOf(h)?.to))
      moves.push(`[${name(dataOf(h)!.from)} offered the conversation to ${dataOf(h)!.to.map(name).join(", ")}]`);
    if (h.kind !== "user") continue;
    out.push({ timestamp: h.sentAt, text: textOf(h.blocks), note: [...moves, `[From ${name(h.id === null ? undefined : senders.get(h.id))}]`].join("\n") });
    moves = [];
  }
  return out;
}

/**
 * `messages` (a model context) with each person's message opened by its author note, as a text
 * block of its own before what they wrote. A message is found by its timestamp and text in
 * `original` (the context before redaction, index for index), in branch order; one that isn't
 * found (not on the branch) is left alone. Returns `messages` itself when nothing is labelled.
 */
export function labelAuthors<M>(messages: M[], notes: readonly AuthorNote[], original: readonly unknown[] = messages): M[] {
  let from = 0;
  let changed = false;
  const out = messages.map((m, i) => {
    const o = original[i] as { role?: string; content?: unknown; timestamp?: unknown } | undefined;
    if (o?.role !== "user") return m;
    const text = textOf(o.content);
    const k = notes.findIndex((n, j) => j >= from && n.timestamp === o.timestamp && n.text === text);
    if (k < 0) return m;
    from = k + 1;
    const msg = m as { content?: unknown };
    const label = { type: "text", text: `${notes[k]!.note}\n` };
    const content = typeof msg.content === "string" ? [label, { type: "text", text: msg.content }] : Array.isArray(msg.content) ? [label, ...msg.content] : [label];
    changed = true;
    return { ...msg, content } as M;
  });
  return changed ? out : messages;
}

/** The text of the people's messages in a model context (the conversation's own words). */
const userTexts = (messages: readonly unknown[]): string[] =>
  messages.flatMap((m) => {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== "user") return [];
    return [typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((b: any) => (b?.type === "text" ? String(b.text ?? "") : "")).join("") : ""];
  });

/** The holder's profile phrases that are secrets in this model context, from the run's pack: none
    that is ordinary vocabulary (a name, role, decision area, the title, or what someone wrote here). */
export function batonContextPhrases(pack: { holderTexts: readonly string[]; vocabulary: readonly string[] }, messages: readonly unknown[]): string[] {
  return pack.holderTexts.length ? secretPhrases(pack.holderTexts, [...pack.vocabulary, ...userTexts(messages)]) : [];
}

/** Redact message text for the model's own context: secrets everywhere, and the holder's profile
    phrases from the model's own earlier replies. What people wrote reaches it as they wrote it. */
export function redactContext<M>(messages: M[], phrases: readonly string[]): M[] {
  const secrets = serverRedactor();
  const redactMsgs = redactExtensionMessages(messages, secrets);
  if (!phrases.length) return redactMsgs;
  let changed = redactMsgs !== messages;
  const out = redactMsgs.map((m) => {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== "assistant") return m;
    if (typeof msg.content === "string") {
      const t = redactPhrases(msg.content, phrases);
      if (t === msg.content) return m;
      changed = true;
      return { ...msg, content: t } as M;
    }
    if (!Array.isArray(msg.content)) return m;
    let hit = false;
    const content = msg.content.map((b: any) => {
      if (b?.type !== "text" || typeof b.text !== "string") return b;
      const t = redactPhrases(b.text, phrases);
      if (t === b.text) return b;
      hit = true;
      return { ...b, text: t };
    });
    if (!hit) return m;
    changed = true;
    return { ...msg, content } as M;
  });
  return changed ? out : messages;
}
