// The message's right-click menu (§chat.transcript/message-actions "Right-click", §app/context-menus),
// as data: its rows are the strip's own items (lib/message-actions `messageItems`, through the reply
// place's built-ins) in the strip's order, plus one row of the menu's own, Copy as Plain Text, right
// after Copy. What a press does, and the plain text that row copies. No DOM here: the drawn body and
// the reading of the rendered message are components/MessageMenu.tsx.
import MarkdownIt from "markdown-it";
import type { TranscriptItem } from "../../shared/protocol";
import type { MessageActionItem } from "../components/MessageActions";
import { entryIdOf } from "./jump";
import { ACTION_CONFIRM, ACTION_LABEL, COPY_PLAIN, type LandedActionKind, MENU_LABEL, type MessageStrip } from "./message-actions";

export type MessageMenuKind = LandedActionKind | "copy-plain";

/** One row of the menu. */
export interface MessageMenuRow {
  kind: MessageMenuKind;
  /** The menu's words (MENU_LABEL). */
  label: string;
  /** The strip button's accessible name. */
  aria: string;
  /** Why it can't run now: the strip's own reason. */
  disabled?: string;
  /** A branch action asks first, with the strip's own confirm. */
  confirm?: { label: string; note: string };
  run(): void | Promise<void>;
}

/** The screen a branch action's confirm is shown on. */
export const confirmScreen = (kind: MessageMenuKind) => `confirm:${kind}`;

/**
 * The menu's rows from the strip's items: each item one row, in order, running the item's own
 * `run`; Copy as Plain Text right after Copy, present and off exactly when Copy is.
 */
export function messageMenuRows(items: readonly MessageActionItem[], copyPlain: () => void | Promise<void>): MessageMenuRow[] {
  return items.flatMap((it): MessageMenuRow[] => {
    if (it.kind === "remove") return []; // a queued message's: it has no menu
    const row: MessageMenuRow = { kind: it.kind, label: MENU_LABEL[it.kind], aria: it.label ?? ACTION_LABEL[it.kind], disabled: it.reason ?? undefined, confirm: ACTION_CONFIRM[it.kind], run: it.run };
    if (it.kind !== "copy") return [row];
    return [row, { kind: "copy-plain", label: COPY_PLAIN.label, aria: COPY_PLAIN.aria, disabled: row.disabled, run: copyPlain }];
  });
}

/** What pressing a row does (the menu closes first, unless it asks): a branch action shows its confirm, every other row runs. */
export const rowAct = (row: MessageMenuRow, show: (screen: string) => void) => () => (row.confirm ? show(confirmScreen(row.kind)) : row.run());

/** The row a confirm screen asks about, while it can still run; none: the screen gives way to the rows. */
export const confirmRow = (rows: readonly MessageMenuRow[], screen: string | null): MessageMenuRow | undefined =>
  rows.find((r) => r.confirm && !r.disabled && confirmScreen(r.kind) === screen);

// ---- Copy as Plain Text --------------------------------------------------------------------------

/** One rendered row of a strip's message: its id (the row's `data-entry`), its source, and whether that is Markdown. */
export interface MessageBlock {
  id: string;
  text: string;
  markdown: boolean;
}

/** The rows a strip's message is drawn as: your message's one row, or every text block of the reply, in order.
    Found by the entry, not by index: older rows arriving above move every index. */
export function stripBlocks(rows: readonly TranscriptItem[], strip: MessageStrip): MessageBlock[] {
  const kind = strip.role === "user" ? "user" : "assistant-text";
  return rows
    .filter((r) => r.kind === kind && entryIdOf(r.id) === strip.entryId)
    .map((r) => ({ id: r.id, text: r.text ?? "", markdown: strip.role === "assistant" }));
}

/**
 * The message as it reads: each block's drawn text (`read`: the rendered body's visible text, null
 * when it isn't drawn), else its source without Markdown's marks; blocks joined by a blank line, as
 * Copy joins them.
 */
export function plainText(blocks: readonly MessageBlock[], read: (id: string) => string | null): string {
  return blocks
    .map((b) => read(b.id) ?? (b.markdown ? plainMarkdown(b.text) : b.text))
    .map((t) => t.trim())
    .filter(Boolean)
    .join("\n\n");
}

const md = new MarkdownIt({ html: false, linkify: true });
type Token = ReturnType<typeof md.parse>[number];

/** An inline run's words: code keeps its text, a link its words, an image its alt. */
const inlineText = (t: Token): string =>
  (t.children ?? []).map((c) => (c.type === "text" || c.type === "code_inline" ? c.content : c.type === "softbreak" || c.type === "hardbreak" ? "\n" : c.type === "image" ? c.content : "")).join("");

/**
 * Markdown source without its marks, for a block that isn't drawn: paragraphs, headings and quotes
 * as their words, code blocks as their code, lists with a bullet or their number, table cells
 * split by tabs.
 */
export function plainMarkdown(src: string): string {
  let out = "";
  const lists: { n: number | null }[] = [];
  let line = "";
  let cells: string[] | null = null;
  /** A list or a table starts: a blank line before its first line, as before a paragraph. */
  let gap = false;
  /** A block on its own line: a blank line between paragraphs, none between a list's items or a table's rows. */
  const push = (text: string, tight = lists.length > 0) => {
    out += (out ? (tight && !gap ? "\n" : "\n\n") : "") + text;
    gap = false;
  };
  for (const t of md.parse(src, {})) {
    switch (t.type) {
      case "bullet_list_open":
      case "ordered_list_open":
        if (!lists.length) gap = true;
        lists.push({ n: t.type === "bullet_list_open" ? null : Number(t.attrGet("start") ?? 1) });
        break;
      case "bullet_list_close":
      case "ordered_list_close":
        lists.pop();
        break;
      case "list_item_open": {
        const list = lists[lists.length - 1]!;
        line = `${"  ".repeat(lists.length - 1)}${list.n === null ? "•" : `${list.n++}.`} `;
        break;
      }
      case "table_open":
        gap = true;
        break;
      case "tr_open":
        cells = [];
        break;
      case "tr_close":
        push(cells!.join("\t"), true);
        cells = null;
        break;
      case "inline":
        if (cells) cells.push(inlineText(t));
        else {
          push(line + inlineText(t));
          line = "";
        }
        break;
      case "fence":
      case "code_block":
        push(t.content.replace(/\n$/, ""));
        break;
    }
  }
  return out.trim();
}
