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
  abilitiesOf,
  drawsHtml,
  OPERATOR,
  type BatonSession,
  type BatonView,
  type BatonViewItem,
  type PersonRef,
} from "../shared/baton";
import type { HEntry } from "../shared/harness";
import { normalizeTourAttachment, normalizeTourDetachment, SHOW_TOUR_TOOL, TOUR_ATTACHMENT_ENTRY, TOUR_DETACHMENT_ENTRY } from "../shared/tour";
import { shareFences } from "../src/share/markdown";
import { visKindWord } from "../src/vis/parse";
import { canonicalKind } from "../src/vis/registry";
import { typedText } from "./harness/pi/reader";
import { REDACTED } from "./overseer-redact";
import { authorNotes, dataOf, labelAuthors, messageSenders, redactPhrases, secretPhrases, textOf } from "./author-context";
import { FILE_LINE_RE } from "./project-files";

/**
 * The outsider view (§app.baton/outsider-view): a baton session's active branch reduced to what a
 * participant may see. Pure: the caller reads the branch, the names and the redaction phrases.
 *
 * An ALLOWLIST over the branch's entries, never a denylist over rendered rows: a user message, the
 * reply's text blocks, and the three baton cards. Thinking, tool calls and results, system messages,
 * model/thinking changes, compactions, every other state entry and anything pi adds later are
 * dropped because nothing here names them.
 */



/** What a withheld drawing becomes: a fence of no kind a page draws, so it shows the quiet line. */
const WITHHELD_KIND = "vis withheld";
export const WITHHELD_FENCE = `\`\`\`${WITHHELD_KIND}\n\`\`\``;

/** The text a person would read in markup: entities and script escapes decoded; `tags` "" joins
    what a tag split (`Sec<b>ret`), " " keeps words a tag separated apart (`Secret<br>phrase`). */
function markupTexts(body: string): string[] {
  const decoded = body
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_, h: string) => cp(parseInt(h, 16)))
    .replace(/&#([0-9]{1,7});?/g, (_, d: string) => cp(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_, n: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[n.toLowerCase() as "amp"])
    .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_, a?: string, b?: string, c?: string) => cp(parseInt((a ?? b ?? c)!, 16)));
  const fold = (t: string) => t.replace(/\s+/g, " ");
  return [fold(decoded), fold(decoded.replace(/<[^>]*>/g, "")), fold(decoded.replace(/<[^>]*>/g, " "))];
}
const cp = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "");

/** Whether a phrase is in a markup text, as a whole phrase, any whitespace between its words. */
function phraseIn(texts: readonly string[], phrase: string): boolean {
  const word = /[\p{L}\p{N}]/u;
  const body = phrase.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  const re = new RegExp(`${word.test(phrase.trim()[0] ?? "") ? "(?<![\\p{L}\\p{N}])" : ""}${body}${word.test(phrase.trim().at(-1) ?? "") ? "(?![\\p{L}\\p{N}])" : ""}`, "iu");
  return texts.some((t) => re.test(t));
}

/**
 * The markup backstop (§app.baton/outsider-view), after the plain pass (redactPhrases): a `vis html`
 * or `vis svg` fence is checked again with its entities and escapes decoded and its tags stripped,
 * since a phrase written `S&#101;cret` or `Sec<b>ret` would pass the plain pass and still read
 * whole on the person's page. Fences are found exactly as the page finds them, by its own
 * markdown-it parse (src/share/markdown.ts shareFences): nested in a list item or a quote too, and a
 * vis line inside another code block is no fence. A phrase found that way withholds the whole fence:
 * its opening line becomes `vis withheld` (its list or quote prefix kept, so it stays where it was)
 * and its body goes, which the page draws as the quiet line. An unclosed one (a reply still
 * streaming) is dropped with everything after it, so its source never crosses the socket. `onHit`
 * hears which kind, never the phrase. Pure.
 */
export function markupBackstop(text: string, phrases: readonly string[], onHit?: (kind: string) => void): string {
  if (!phrases.length || !/vis/i.test(text)) return text;
  const lines = text.split("\n");
  // Last first, so an earlier fence's line numbers still hold.
  for (const f of shareFences(text).reverse()) {
    const word = visKindWord(f.info);
    const kind = word ? canonicalKind(word) : null;
    if (kind !== "html" && kind !== "svg") continue;
    const texts = markupTexts(f.content);
    if (!phrases.some((p) => p && phraseIn(texts, p))) continue;
    onHit?.(kind);
    if (!f.closed) {
      lines.length = f.start;
      continue;
    }
    const open = lines[f.start]!;
    lines.splice(f.start, f.end - 1 - f.start, `${open.slice(0, open.indexOf(f.markup))}${f.markup}${WITHHELD_KIND}`);
  }
  return lines.join("\n");
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




/** `quote` without the author-note lines a model copied into it from its context (a quote is
    someone's own words; those lines never are). */
export const withoutAuthorNotes = (quote: string): string =>
  quote.replace(/^(?:\s*\[(?:From [^\]\n]*|The conversation passed from [^\]\n]*|[^\]\n]* offered the conversation to [^\]\n]*)\])+\s*/, "");


export interface ViewInput {
  row: Pick<BatonSession, "publicTitle" | "state" | "holder" | "abilities">;
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
  /** The files received in this session, by id (§app.baton/files): a message's line for one its
      sender sent becomes a file row. Absent: every such line stays text. */
  files?: ReadonlyMap<string, { name: string; size: number; personId: string }>;
}

/** A person's message text without the lines that announce files they sent, and those files. Pure. */
export function splitFileLines(text: string, sender: string, files: ViewInput["files"]): { text: string; files: { name: string; size: number }[] } {
  if (!files?.size || !text.includes("· file f_")) return { text, files: [] };
  const found: { name: string; size: number }[] = [];
  const kept = text.split("\n").filter((line) => {
    const id = FILE_LINE_RE.exec(line.trim())?.[1];
    const f = id ? files.get(id) : undefined;
    if (!f || f.personId !== sender) return true;
    found.push({ name: f.name, size: f.size });
    return false;
  });
  return { text: kept.join("\n").trim(), files: found };
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

  // Revocation is authority, not conversation text: a later tombstone must also revoke an
  // offer-cut reader who cannot see that later part of the conversation.
  const detached = new Set(branch.flatMap(h => h.kind === "state" && h.key === TOUR_DETACHMENT_ENTRY ? normalizeTourDetachment(h.data)?.handle ?? [] : []));
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
        const sender = by.get(id) ?? "";
        // A file's line becomes its row, only for a file this sender sent here (§app.baton/files).
        const { text, files } = splitFileLines(typedText(textOf(h.blocks), h).trim(), sender, input.files);
        const blocks = imagesOf(h.blocks);
        // A message of photos alone is still a row (§app.baton/images), and one of files alone.
        if (!text && !blocks.length && !files.length) continue;
        const images = blocks.map((b) => {
          input.collect?.push(b);
          return { n: photos++, mime: b.mimeType };
        });
        items.push({ kind: "message", id, by: sender, name: sender ? name(sender) : "Someone", text: redact(text), ...(at ? { at } : {}), ...(images.length ? { images } : {}), ...(files.length ? { files: files.map((f) => ({ name: redact(f.name), size: f.size })) } : {}) });
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
    if (h.kind === "tool-result") {
      // The model showing an attached tour shows it here too, re-checked on every view: only a tour
      // already visible above in this same view (attached, not detached, inside the cut). Its copy
      // comes from that attachment, never from the result's payload; the attachment stays the authority.
      const handle = h.tool === SHOW_TOUR_TOOL && !h.isError && h.details && typeof h.details === "object" ? (h.details as { handle?: unknown }).handle : undefined;
      const shown = typeof handle === "string" ? items.find((i) => i.kind === "tour" && i.handle === handle) : undefined;
      if (shown?.kind === "tour") items.push({ ...shown, id });
      continue;
    }
    if (h.kind !== "state") continue;
    const d = dataOf(h) ?? {};
    if (h.key === TOUR_ATTACHMENT_ENTRY) {
      const tour = normalizeTourAttachment(d);
      if (tour && !detached.has(tour.handle)) items.push({ kind: "tour", id, handle: tour.handle, title: said(tour.title), summary: said(tour.summary), steps: tour.steps });
    } else if (h.key === BATON_HANDOFF_ENTRY && typeof d.n === "number") {
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
    // The session's abilities as they are now: the strip's change reaches the page's next view.
    drawings: { html: drawsHtml(abilitiesOf(input.row)) },
    items,
  };
}

// The model context's helpers live in a module of their own (a chat process loads them): here as before.
export { type AuthorNote, authorNotes, batonContextPhrases, labelAuthors, messageSenders, redactContext, redactPhrases, secretPhrases } from "./author-context";
