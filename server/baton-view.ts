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
import type { HEntry } from "../shared/harness";
import { typedText } from "./harness/pi/reader";
import { REDACTED } from "./overseer-redact";

/**
 * The outsider view (§app.baton/outsider-view): a baton session's active branch reduced to what a
 * participant may see. Pure: the caller reads the branch, the names and the redaction phrases.
 *
 * An ALLOWLIST over the branch's entries, never a denylist over rendered rows: a user message, the
 * reply's text blocks, and the three baton cards. Thinking, tool calls and results, system messages,
 * model/thinking changes, compactions, every other state entry and anything pi adds later are
 * dropped because nothing here names them.
 */

/** A state entry's data (pi's custom entry's), as its writer wrote it. */
const dataOf = (h: HEntry & { kind: "state" }): Record<string, any> | null | undefined => h.data as Record<string, any> | null | undefined;

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
export function conversationVocabulary(branch: readonly HEntry[]): string[] {
  const out: string[] = [];
  for (const h of branch) {
    if (h.kind === "state" && h.key === BATON_WRAPUP_ENTRY) break;
    if (h.kind === "user") out.push(textOf(h.blocks));
    else if (h.kind === "state" && h.key === BATON_DECISION_ENTRY && typeof dataOf(h)?.area === "string") out.push(dataOf(h)!.area);
  }
  return out;
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
  /** The active branch, oldest first (server/harness/pi/reader.ts readBranch). */
  branch: readonly HEntry[];
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
  for (const h of branch) {
    // The wrap-up is the operator's: nothing from its marker on is anyone else's to see.
    if (h.kind === "state" && h.key === BATON_WRAPUP_ENTRY) break;
    const id = h.id ?? "";
    const at = typeof h.at === "string" ? h.at : undefined;
    if (h.kind === "user" || h.kind === "assistant") {
      if (h.kind === "user") {
        // Shown as typed: pi's resize notes are for the model (§chat.images/resize-notes).
        const text = typedText(textOf(h.blocks), h).trim();
        const blocks = imagesOf(h.blocks);
        // A message of photos alone is still a row (§app.baton/images).
        if (!text && !blocks.length) continue;
        const images = blocks.map((b) => {
          input.collect?.push(b);
          return { n: photos++, mime: b.mimeType };
        });
        const sender = by.get(id) ?? "";
        items.push({ kind: "message", id, by: sender, name: sender ? name(sender) : "Someone", text: redact(text), ...(at ? { at } : {}), ...(images.length ? { images } : {}) });
      } else {
        const text = textOf(h.blocks).trim();
        if (!text) continue;
        // Stopped before it finished (the stream guard, a shutdown, Take back, Stop): its start
        // only, marked, never a runaway's whole text on someone's phone.
        const stop = h.stop;
        if (stop === "error" || stop === "aborted") items.push({ kind: "reply", id, text: cutReply(said(text), CUT_REPLY_MAX), cutOff: true, ...(at ? { at } : {}) });
        else items.push({ kind: "reply", id, text: said(text), ...(at ? { at } : {}) });
      }
      continue;
    }
    if (h.kind !== "state") continue;
    const d = dataOf(h) ?? {};
    if (h.key === BATON_HANDOFF_ENTRY && typeof d.n === "number") {
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
    } else if (h.key === BATON_OFFER_ENTRY && typeof d.n === "number" && Array.isArray(d.to)) {
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
    } else if (h.key === BATON_DECISION_ENTRY) {
      items.push({ kind: "decision", id, by: name(d.by), area: redact(String(d.area ?? "")), statement: said(String(d.statement ?? "")) });
    } else if (h.key === BATON_DONE_ENTRY) {
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
