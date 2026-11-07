// Which of a session's messages the user typed or dictated, and what a label is judged on
// (§app.message-labels/labelling). Pure over what the file's reader gave, so a reload reads
// the same answer as the moment it was sent: nothing here is held in memory by a chat.

import type { HEntry } from "../shared/harness";
import type { TranscriptItem } from "../shared/protocol";
import { isOwnInput, sendersOf } from "../shared/senders";
import { readPi } from "./harness/pi/reader";
import { rowsOf } from "./transcript";

/** What a message is when a button composed it. Quick actions and the Overseer's card clicks have none:
    they only exist in Overseer sessions, which are never labelled. `pressed` is a button the server sent for, known by
    the note it left (an offer's answer: message-labels.ts `acted`), and `regenerate` is read from the tree. */
export type InputAction = "playbook" | "review" | "picks" | "command" | "no-words" | "regenerate" | "pressed";

// Exact words, each held to the function that composes it by message-input.test.ts: shared/playbooks.ts
// playbookTurnText, src/lib/align-review.ts reviewRequestMessage, src/lib/align-picks.ts acceptAllMessage and
// picksMessage, shared/transcript-cards.ts cardPickLine.
const PLAYBOOK_RE = /^Playbook: .+ — .+\nEvery relative path in this playbook is relative to that directory; read its files as the playbook directs\.\n/;
const REVIEW_RE = /^al_\d+: run the adversarial \w+ review now \(align review, phase \w+\), whatever the rule says\.$/;
const ACCEPT_ALL_RE = /^al_\d+: go with your recommendations for every open question, and go ahead\.$/;
/** A slash command that left a message in the chat, as the file keeps it. */
const COMMAND_RE = /^(?:\/[a-z][\w:-]*(?:\s|$)|<skill\b)/i;
const PICK_LINE_RE = /^(?:al_\d+: (?:take your recommendation on [^\n]+\.(?: My answers: [^\n]+\.)?|my answers: [^\n]+\.)|cd_\d+: [^\n]+\.)$/;

/**
 * The button behind a message, read from its words; null when the user typed it. A picks line with words of the
 * user's own after it is typed: those words are what the label is about. Typing a button's exact words reads as the
 * button, which is what they do.
 */
export function inputActionOf(text: string): InputAction | null {
  const t = text.trim();
  if (COMMAND_RE.test(t)) return "command";
  if (PLAYBOOK_RE.test(t)) return "playbook";
  if (REVIEW_RE.test(t)) return "review";
  if (ACCEPT_ALL_RE.test(t)) return "picks";
  const lines = t.split("\n").filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => PICK_LINE_RE.test(l.trim())) ? "picks" : null;
}

/** Characters a label is judged on, the same as the turn card's excerpt (§app.decisions/asks-user). */
export const MESSAGE_HEAD_CHARS = 600;
export const REPLY_TAIL_CHARS = 1500;
/** Kept of a reply: more than its tail, since its closing spec lines are cut before the tail is taken. */
const REPLY_KEPT_CHARS = REPLY_TAIL_CHARS * 2;

export interface OwnMessage {
  id: string;
  /** Epoch ms the message's entry says it was sent. A held one's press time is kept beside the session. */
  sentAt: number;
  /** The button behind it; null: the user typed or dictated it. */
  action: InputAction | null;
  /** The head of its words, with no attachment paths. */
  text: string;
  /** Its words whole when `text` is cut: what an offer's note is matched on. */
  fullText?: string;
  /** It carries an image. */
  image: boolean;
  /** The turn before it delivered or showed results (`deliveredResults`). */
  delivered: boolean;
  /** The end of the last reply above it. */
  previousReply: string;
}

const ATTACHMENT_RE = /(?:^|\s)\/\S+\/(?:attachments\/\S+|sova-[\w-]+)\.(?:png|jpe?g|webp|gif)\b/gi;
const IMAGE_PATH_RE = /\S\.(?:png|jpe?g|webp|gif)\b/i;
/** Tools that change the work, by their name without a server prefix. A shell's effect can't be read from its call. */
const CHANGING_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "notebookedit"]);
/** A worker or a team handing in its work. */
const REPORT_NOTES = new Set(["subagent-complete", "team-report"]);

const textOfBlocks = (blocks: readonly { type: string; text?: unknown }[]): string =>
  blocks.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
const hasImage = (blocks: readonly { type: string }[]): boolean => blocks.some((b) => b.type === "image");
const toolName = (name: unknown): string => String(name ?? "").split("__").pop()!.toLowerCase();

/**
 * Whether one entry of a turn delivered or showed results, counted in code: a tool that changes files succeeded, a
 * tool result carried an image, a worker or team handed in its report, or a reply named an image file. A turn that
 * only read, ran a shell or talked did not.
 */
export function deliveredResults(h: HEntry): boolean {
  if (h.kind === "tool-result") return h.isError !== true && (CHANGING_TOOLS.has(toolName(h.tool)) || hasImage(h.blocks));
  if (h.kind === "note") return typeof h.noteType === "string" && REPORT_NOTES.has(h.noteType);
  if (h.kind === "assistant") return IMAGE_PATH_RE.test(textOfBlocks(h.blocks));
  return false;
}

const timeOf = (h: HEntry): number => {
  const sent = "sentAt" in h ? h.sentAt : undefined;
  if (typeof sent === "number" && Number.isFinite(sent)) return sent;
  const at = typeof h.at === "string" ? Date.parse(h.at) : NaN;
  return Number.isFinite(at) ? at : 0;
};

/** What each entry carries forward to the entries under it. */
interface Before {
  /** The nearest message above it, past the state entries a rewind or a marker leaves. */
  anchor: string | null;
  reply: string;
  delivered: boolean;
}
const NOTHING: Before = { anchor: null, reply: "", delivered: false };
const MESSAGE_KINDS = new Set<HEntry["kind"]>(["user", "assistant", "tool-result", "note", "shell", "summary"]);

/**
 * Every message the user sent, on every branch, in file order: a message rewound away from keeps its time. Each is
 * judged on what stood above it in the tree. The same words sent again from the same place are a regenerate.
 */
export function ownMessages(entries: readonly HEntry[], items: readonly TranscriptItem[]): OwnMessage[] {
  const senders = sendersOf(items);
  const rows = new Map<string, TranscriptItem>();
  for (const it of items) if (it.kind === "user") rows.set(it.id, it);
  const before = new Map<string, Before>();
  const sentFrom = new Set<string>();
  const out: OwnMessage[] = [];
  for (const h of entries) {
    const above = (h.parentId ? before.get(h.parentId) : undefined) ?? NOTHING;
    const here: Before = {
      anchor: h.id && MESSAGE_KINDS.has(h.kind) ? h.id : above.anchor,
      reply: h.kind === "assistant" ? textOfBlocks(h.blocks).trim().slice(-REPLY_KEPT_CHARS) || above.reply : above.reply,
      delivered: above.delivered || deliveredResults(h),
    };
    const row = h.kind === "user" && h.id ? rows.get(h.id) : undefined;
    if (row && isOwnInput(row, senders)) {
      const raw = row.text ?? "";
      const words = raw.replace(ATTACHMENT_RE, " ").trim();
      const hasAttachment = (h.kind === "user" && hasImage(h.blocks)) || !!row.attachments?.length || words.length !== raw.trim().length;
      const place = `${above.anchor}\n${raw}`;
      out.push({
        id: h.id!,
        sentAt: timeOf(h),
        action: sentFrom.has(place) ? "regenerate" : !words ? "no-words" : inputActionOf(raw),
        text: words.slice(0, MESSAGE_HEAD_CHARS),
        ...(words.length > MESSAGE_HEAD_CHARS ? { fullText: words } : {}),
        image: hasAttachment,
        delivered: above.delivered,
        previousReply: above.reply,
      });
      sentFrom.add(place);
      here.delivered = false;
    }
    if (h.id) before.set(h.id, here);
  }
  return out;
}

/** A session file's messages, read from the file, never a write. A fork's copied messages aren't this session's. */
export async function sessionOwnMessages(path: string): Promise<OwnMessage[]> {
  const { header, entries } = await readPi(path);
  const began = Date.parse(header?.at ?? "");
  const own = ownMessages(entries, rowsOf(entries));
  return Number.isFinite(began) ? own.filter((m) => m.sentAt >= began) : own;
}
