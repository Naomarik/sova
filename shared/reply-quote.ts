// A reply to an earlier message (§chat.composer/reply-text): the one place that writes the reply's
// text into a message and reads it back. The link to the original lives only in the message's
// first line, so every surface that draws a message (the transcript, the queued row, the Timeline,
// share pages) asks parseReply, and nothing else stores it. Pure: no DOM, no Solid, no fs, so the
// server (drafts), the app and the share page all import it.

/** Whose message the reply quotes: yours, or the agent's reply. */
export type ReplyRole = "user" | "assistant";

/** A reply staged in the composer, as the draft stores it: the quote already cut to what is sent. */
export interface StagedReply {
  /** The original's entry id. */
  entryId: string;
  role: ReplyRole;
  /** A passage selected inside the message, rather than the whole of it. */
  part: boolean;
  /** The quoted words, line ends `\n`, already cut by capQuote. */
  quote: string;
  /** capQuote cut it: the model gets its start and end. */
  trimmed: boolean;
}

/** A message read back as a reply. */
export interface ParsedReply {
  entryId: string;
  role: ReplyRole;
  part: boolean;
  quote: string;
  /** Everything after the quote: what was typed, staged answers' lines, image paths. */
  words: string;
}

/** Over this many characters a quote keeps its start and end only. */
export const REPLY_CAP = 4000;
export const REPLY_HEAD = 3000;
export const REPLY_TAIL = 1000;
/** The line standing where a long quote was cut. */
export const REPLY_ELISION = "[…]";
/** What an entry id may look like: pi's are 8 hex characters; anything close enough is accepted. */
const ID = /^[A-Za-z0-9_-]{4,64}$/;
/** Generous bound for a stored quote: a cut one is ~4,000 characters. */
const STORED_QUOTE_MAX = 8000;

const PHRASES: Record<string, { role: ReplyRole; part: boolean }> = {
  "your earlier reply": { role: "assistant", part: false },
  "my earlier message": { role: "user", part: false },
  "part of your earlier reply": { role: "assistant", part: true },
  "part of my earlier message": { role: "user", part: true },
};
const phraseOf = (role: ReplyRole, part: boolean): string =>
  `${part ? "part of " : ""}${role === "assistant" ? "your earlier reply" : "my earlier message"}`;
const HEAD = /^\[Replying to (your earlier reply|my earlier message|part of your earlier reply|part of my earlier message) · ([A-Za-z0-9_-]{4,64})\]$/;

/** Steps an index off the low half of a surrogate pair, so a cut never splits a character. */
const safeCut = (s: string, i: number, back: boolean): number => {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff ? (back ? i - 1 : i + 1) : i;
};

/** The quote as it is sent: line ends `\n`, outer blank space gone, and over REPLY_CAP its first
    REPLY_HEAD and last REPLY_TAIL characters around a REPLY_ELISION line. */
export function capQuote(text: string): { quote: string; trimmed: boolean } {
  const clean = text.replace(/\r\n?/g, "\n").replace(/^[ \t]+$/gm, "").replace(/^\n+/, "").trimEnd();
  if (clean.length <= REPLY_CAP) return { quote: clean, trimmed: false };
  const head = clean.slice(0, safeCut(clean, REPLY_HEAD, true)).trimEnd();
  const tail = clean.slice(safeCut(clean, clean.length - REPLY_TAIL, false)).replace(/^\s*\n/, "");
  return { quote: `${head}\n${REPLY_ELISION}\n${tail}`, trimmed: true };
}

/** The reply's first line, as the model reads it. */
export const replyHeader = (r: Pick<StagedReply, "entryId" | "role" | "part">): string =>
  `[Replying to ${phraseOf(r.role, r.part)} · ${r.entryId}]`;

/** The message the model reads: the first line, the quote behind "> ", a blank line, the rest. */
export function composeReply(r: StagedReply, words: string): string {
  const quoted = r.quote.split("\n").map((l) => (l ? `> ${l}` : ">"));
  return [replyHeader(r), ...quoted].join("\n") + (words ? `\n\n${words}` : "");
}

/** A message read back as a reply, or null when it doesn't begin with a reply's first line and at
    least one quote line. A hand-typed lookalike reads as a reply too, by design. */
export function parseReply(text: string): ParsedReply | null {
  if (!text.startsWith("[Replying to ")) return null;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const m = HEAD.exec(lines[0]!);
  if (!m) return null;
  const quote: string[] = [];
  let i = 1;
  for (; i < lines.length && lines[i]!.startsWith(">"); i++) quote.push(lines[i]!.replace(/^> ?/, ""));
  if (quote.length === 0) return null;
  if (i < lines.length && lines[i]!.trim() === "") i++;
  const { role, part } = PHRASES[m[1]!]!;
  return { entryId: m[2]!, role, part, quote: quote.join("\n"), words: lines.slice(i).join("\n") };
}

/** A sent reply read back as the composer stages it. */
export const stagedOf = (p: ParsedReply): StagedReply => ({
  entryId: p.entryId,
  role: p.role,
  part: p.part,
  quote: p.quote,
  trimmed: p.quote.split("\n").includes(REPLY_ELISION),
});

/**
 * Texts going back to the composer (a Rewind, Stop's hand-back, a refused send), in order, and the
 * reply to stage from them. One reply is staged at a time: the first text that replies to another
 * comes back as its words with its reply to stage, when it may be staged: nothing is staged
 * (`staged` null) or the caller replaces what is (`replace`: a Rewind or a Stop, the user's own
 * ask). Every other reply, that first one included when it may not be staged, comes back whole,
 * first line and quote and all, since a quote dropped silently would be lost. `reply` is null when
 * nothing is to be staged.
 */
export function takeBack(
  texts: readonly string[],
  opts: { staged?: StagedReply | null; replace?: boolean } = {},
): { texts: string[]; reply: StagedReply | null } {
  const mayStage = opts.replace === true || !opts.staged;
  let reply: StagedReply | null = null;
  let seen = false;
  const out = texts.map((t) => {
    if (seen || !mayStage) return t;
    const p = parseReply(t);
    if (!p) return t;
    seen = true;
    reply = stagedOf(p);
    return p.words;
  });
  return { texts: out, reply };
}

/** What share pages carry in place of a reply's own entry id: the quote and its label stay, the
    message id goes (§app.session-share/content). */
export const SHARED_REPLY_ID = "shared";

/** A message with its reply's entry id replaced by SHARED_REPLY_ID; any other text as it is. */
export function withoutReplyId(text: string): string {
  const r = parseReply(text);
  return r ? composeReply({ entryId: SHARED_REPLY_ID, role: r.role, part: r.part, quote: r.quote, trimmed: false }, r.words) : text;
}

/** The words of a message: after the quote for a reply, else the whole text. */
export const replyWords = (text: string): string => parseReply(text)?.words ?? text;

/** Whose message a reply quotes, in the words every surface shows (§chat.composer/replying). */
export const replyLabel = (r: Pick<StagedReply, "role" | "part">): string =>
  `Replying to ${r.part ? "part of " : ""}${r.role === "assistant" ? "the agent's reply" : "your message"}`;

/** A quote's first non-empty line, for a one-line preview. */
export const quoteFirstLine = (quote: string): string => quote.split("\n").find((l) => l.trim()) ?? "";

/** A stored or sent draft's reply, checked: null when anything about it is off. */
export function cleanStagedReply(raw: unknown): StagedReply | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<StagedReply>;
  if (typeof r.entryId !== "string" || !ID.test(r.entryId)) return null;
  if (r.role !== "user" && r.role !== "assistant") return null;
  if (typeof r.quote !== "string" || !r.quote.trim() || r.quote.length > STORED_QUOTE_MAX) return null;
  return { entryId: r.entryId, role: r.role, part: r.part === true, quote: r.quote, trimmed: r.trimmed === true };
}

export const sameStagedReply = (a: StagedReply | null | undefined, b: StagedReply | null | undefined): boolean =>
  a === b ||
  (!!a && !!b && a.entryId === b.entryId && a.role === b.role && a.part === b.part && a.quote === b.quote && a.trimmed === b.trimmed);
