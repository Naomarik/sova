import {
  BATON_DECISION_ENTRY,
  BATON_DONE_ENTRY,
  BATON_HANDOFF_ENTRY,
  BATON_OFFER_ENTRY,
  BATON_SENT_ENTRY,
  BATON_WRAPUP_ENTRY,
  CUT_REPLY_MAX,
  LIMIT_QUESTION,
  LIMIT_REACHED_FOR_PEOPLE,
  OPERATOR,
  type BatonSession,
  type BatonView,
  type BatonViewItem,
  type PersonRef,
} from "../shared/baton";
import { stripImageNotes } from "../shared/image-note";
import { REDACTED } from "./overseer-redact";

/**
 * The outsider view (§app.baton/outsider-view): a baton session's active branch reduced to what a
 * participant may see. Pure: the caller reads the branch, the names and the redaction phrases.
 *
 * An ALLOWLIST over raw entries, never a denylist over rendered rows: a user message, the reply's
 * text blocks, and the three baton cards. Thinking, tool calls and results, system messages,
 * model/thinking changes, compactions, every other custom entry and anything pi adds later are
 * dropped because nothing here names them.
 */

type Entry = Record<string, any>;

const textOf = (content: unknown): string => {
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

/** The conversation's own public words: what people wrote, and the decisions' areas (before the wrap-up). */
export function conversationVocabulary(branch: readonly Entry[]): string[] {
  const out: string[] = [];
  for (const e of branch) {
    if (e.type === "custom" && e.customType === BATON_WRAPUP_ENTRY) break;
    if (e.type === "message" && e.message?.role === "user") out.push(textOf(e.message.content));
    else if (e.type === "custom" && e.customType === BATON_DECISION_ENTRY && typeof e.data?.area === "string") out.push(e.data.area);
  }
  return out;
}

/**
 * Who wrote each user message on the branch (§app.baton/attribution): the sender its
 * `sova-baton-sent` marker names. The marker lands a microtask after the message: until then, the
 * last message is the holder's. The one rule the share pages, the operator's view and the model's
 * context all read. Pure.
 */
export function messageSenders(branch: readonly Entry[], holder: PersonRef | null): Map<string, string> {
  const by = new Map<string, string>();
  for (const e of branch)
    if (e.type === "custom" && e.customType === BATON_SENT_ENTRY && typeof e.data?.targetId === "string" && typeof e.data?.by === "string") by.set(e.data.targetId, e.data.by);
  let lastUserId: string | undefined;
  for (const e of branch) if (e.type === "message" && e.message?.role === "user") lastUserId = e.id;
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
export function authorNotes(branch: readonly Entry[], names: Record<string, string>, holder: PersonRef | null): AuthorNote[] {
  const senders = messageSenders(branch, holder);
  const name = (ref: unknown): string =>
    ref === OPERATOR ? `${names[OPERATOR] || "The operator"} (the operator)` : (typeof ref === "string" && names[ref]) || "someone";
  const out: AuthorNote[] = [];
  let moves: string[] = [];
  for (const e of branch) {
    // The wrap-up's own prompt is nobody's message.
    if (e.type === "custom" && e.customType === BATON_WRAPUP_ENTRY) break;
    if (e.type === "custom" && e.customType === BATON_HANDOFF_ENTRY) moves.push(`[The conversation passed from ${name(e.data?.from)} to ${name(e.data?.to)}]`);
    else if (e.type === "custom" && e.customType === BATON_OFFER_ENTRY && Array.isArray(e.data?.to))
      moves.push(`[${name(e.data.from)} offered the conversation to ${e.data.to.map(name).join(", ")}]`);
    if (e.type !== "message" || e.message?.role !== "user") continue;
    out.push({ timestamp: e.message.timestamp, text: textOf(e.message.content), note: [...moves, `[From ${name(senders.get(e.id))}]`].join("\n") });
    moves = [];
  }
  return out;
}

/** `quote` without the author-note lines a model copied into it from its context (a quote is
    someone's own words; those lines never are). */
export const withoutAuthorNotes = (quote: string): string =>
  quote.replace(/^(?:\s*\[(?:From [^\]\n]*|The conversation passed from [^\]\n]*|[^\]\n]* offered the conversation to [^\]\n]*)\])+\s*/, "");

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

export interface ViewInput {
  row: Pick<BatonSession, "publicTitle" | "state" | "holder">;
  /** The active branch, oldest first (server/transcript.ts readActiveBranch). */
  branch: Entry[];
  /** personId (and "operator") → display name. */
  names: Record<string, string>;
  /** The viewer: a person id (the share page) or undefined (the project overseer's reads: every briefing). */
  viewer?: PersonRef;
  /** Applied to every string that reaches the view. */
  redact: (text: string) => string;
  /** Applied, after `redact`, to what the model wrote (replies, hand-off and offer questions and
      briefings, decision statements, the done summary): the profile phrases a model could repeat. */
  said?: (text: string) => string;
  /** An invitee who has not held the offer: the view ends with offer card `untilOffer`, and the
      holder is not named. */
  untilOffer?: number;
  /** Receives each photo the view shows, in view order (index = its `n`): the image route serves
      bytes from exactly the view the viewer gets, cuts included. */
  collect?: { data: string; mimeType: string }[];
}

/** A user message's image blocks (pi's `{type: "image", data, mimeType}`). */
const imagesOf = (content: unknown): { data: string; mimeType: string }[] =>
  Array.isArray(content)
    ? content.filter((b) => b && typeof b === "object" && b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string").map((b) => ({ data: b.data as string, mimeType: b.mimeType as string }))
    : [];

/** At most `max` characters, never ending in half a surrogate pair. */
function cutReply(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max).trimEnd();
}

export function batonView(input: ViewInput): BatonView {
  const { branch, names, viewer, redact } = input;
  const said = (t: string) => (input.said ?? ((x: string) => x))(redact(t));
  const name = (ref: unknown): string => (typeof ref === "string" && names[ref]) || (ref === OPERATOR ? "Operator" : "Someone");
  const by = messageSenders(branch, input.row.holder);

  const items: BatonViewItem[] = [];
  let photos = 0;
  for (const e of branch) {
    // The wrap-up is the operator's: nothing from its marker on is anyone else's to see.
    if (e.type === "custom" && e.customType === BATON_WRAPUP_ENTRY) break;
    const id = typeof e.id === "string" ? e.id : "";
    const at = typeof e.timestamp === "string" ? e.timestamp : undefined;
    if (e.type === "message") {
      const role = e.message?.role;
      if (role === "user") {
        // Shown as typed: pi's resize notes are for the model (§chat.images/resize-notes).
        const text = stripImageNotes(textOf(e.message.content), e.message.content).trim();
        const blocks = imagesOf(e.message.content);
        // A message of photos alone is still a row (§app.baton/images).
        if (!text && !blocks.length) continue;
        const images = blocks.map((b) => {
          input.collect?.push(b);
          return { n: photos++, mime: b.mimeType };
        });
        const sender = by.get(id) ?? "";
        items.push({ kind: "message", id, by: sender, name: sender ? name(sender) : "Someone", text: redact(text), ...(at ? { at } : {}), ...(images.length ? { images } : {}) });
      } else if (role === "assistant") {
        const text = textOf(e.message.content).trim();
        if (!text) continue;
        // Stopped before it finished (the stream guard, a shutdown, Take back, Stop): its start
        // only, marked, never a runaway's whole text on someone's phone.
        const stop = e.message.stopReason;
        if (stop === "error" || stop === "aborted") items.push({ kind: "reply", id, text: cutReply(said(text), CUT_REPLY_MAX), cutOff: true, ...(at ? { at } : {}) });
        else items.push({ kind: "reply", id, text: said(text), ...(at ? { at } : {}) });
      }
      continue;
    }
    if (e.type !== "custom") continue;
    const d = e.data ?? {};
    if (e.customType === BATON_HANDOFF_ENTRY && typeof d.n === "number") {
      const addressee = viewer === undefined || viewer === d.to;
      // The limit's hand-off tells the operator what to do; the people only that the limit was reached.
      const question = viewer !== undefined && d.to === OPERATOR && d.question === LIMIT_QUESTION ? LIMIT_REACHED_FOR_PEOPLE : said(String(d.question ?? ""));
      items.push({
        kind: "handoff",
        id,
        n: d.n,
        from: name(d.from),
        to: name(d.to),
        question,
        ...(addressee && typeof d.briefing === "string" && d.briefing.trim() ? { briefing: said(d.briefing) } : {}),
      });
    } else if (e.customType === BATON_OFFER_ENTRY && typeof d.n === "number" && Array.isArray(d.to)) {
      const invited = viewer === undefined || d.to.includes(viewer);
      items.push({
        kind: "offer",
        id,
        n: d.n,
        from: name(d.from),
        // Nobody on a share page learns who else was asked (with two, "someone else" would name them).
        to: viewer === undefined ? d.to.map((t: unknown) => name(t)) : [],
        invited: d.to.length,
        question: said(String(d.question ?? "")),
        ...(invited && typeof d.briefing === "string" && d.briefing.trim() ? { briefing: said(d.briefing) } : {}),
      });
      if (input.untilOffer === d.n) break;
    } else if (e.customType === BATON_DECISION_ENTRY) {
      items.push({ kind: "decision", id, by: name(d.by), area: redact(String(d.area ?? "")), statement: said(String(d.statement ?? "")) });
    } else if (e.customType === BATON_DONE_ENTRY) {
      items.push({ kind: "done", id, summary: said(String(d.summary ?? "")) });
    }
  }
  return {
    publicTitle: redact(input.row.publicTitle),
    state: input.row.state,
    holder: input.row.holder === null || input.untilOffer !== undefined ? null : name(input.row.holder),
    items,
  };
}

/** The reply's text so far from a streaming assistant message: text blocks only. */
export const streamingText = (message: unknown): string => textOf((message as { content?: unknown } | null)?.content);
