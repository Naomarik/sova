// The message's right-click menu (§chat.transcript/message-actions "Right-click", §app/context-menus),
// as one declaration (lib/menu-place): its rows are the strip's own items (the reply place's
// built-ins) in the strip's order, plus one row of the menu's own, Copy as Plain Text, right after
// Copy; Rewind… and Regenerate… ask with the strip's confirm. Every row runs the strip's own act
// (a chat's socket request, its refusals and its note under the message), never a catalogue command.
import type { TranscriptItem } from "../../shared/protocol";
import type { MessageActionItem } from "../components/MessageActions";
import { entryIdOf } from "./jump";
import { renderMarkdown } from "./markdown";
import type { MenuDecl, MenuItem } from "./menu-place";
import { ACTION_CONFIRM, ACTION_ICON, ACTION_LABEL, COPY_PLAIN, MENU_LABEL, type MessageStrip, stripLabel } from "./message-actions";
import { builtInItems, type ReplyPlace } from "./reply-place";
import { copyText } from "./ui-state";

/** What a message's menu is about: its strip, the strip's items as they are now, and Copy as Plain Text. */
export interface MessageMenuSubject {
  strip: MessageStrip;
  items: readonly MessageActionItem[];
  copyPlain(): unknown;
}

/** The copy and share rows, then, past a divider, the ones that change the branch or fork it. */
export const MESSAGE_MENU: MenuDecl<MessageMenuSubject> = {
  label: ({ strip }) => stripLabel(strip.role),
  table: ({ items, copyPlain }) => {
    const safe: MenuItem[] = [];
    const branch: MenuItem[] = [];
    for (const it of items) {
      if (it.kind === "remove") continue; // a queued message's: it has no menu
      const confirm = ACTION_CONFIRM[it.kind];
      const disabled = it.reason ?? undefined;
      const row: MenuItem = {
        label: MENU_LABEL[it.kind],
        aria: it.label ?? ACTION_LABEL[it.kind],
        icon: ACTION_ICON[it.kind],
        disabled,
        act: confirm ? { screen: { kind: "confirm", note: confirm.note, confirm: confirm.label, act: { local: it.run } } } : { local: it.run },
      };
      (it.kind === "copy" || it.kind === "share" ? safe : branch).push(row);
      if (it.kind === "copy") safe.push({ label: COPY_PLAIN.label, aria: COPY_PLAIN.aria, icon: "copy", disabled, act: { local: copyPlain } });
    }
    return [
      { name: "Copy and share", rows: safe },
      { name: "Branch", rows: branch },
    ];
  },
};

/** A strip's menu as its door builds it: the items as the strip draws them now, and the plain text read from `scope`, the thread. */
export const messageMenuOf = (place: ReplyPlace, strip: MessageStrip, blocks: () => MessageBlock[], scope: ParentNode): MessageMenuSubject => ({
  strip,
  items: builtInItems(place, strip),
  copyPlain: () => copyText(plainText(blocks(), scope), COPY_PLAIN.done),
});

/** Each reply's strip by its entry: where an earlier text block of a reply drawn as several finds the strip hung off its last. */
export function repliesByEntry(strips: Iterable<MessageStrip>): Map<string, MessageStrip> {
  const by = new Map<string, MessageStrip>();
  for (const s of strips) if (s.role === "assistant") by.set(s.entryId, s);
  return by;
}

/**
 * The strip whose menu a right-click on a row opens: the row's own, or, for any text block of a
 * reply, that reply's (one strip per entry, under its last text block: lib/message-actions
 * `messageStrips`). Tool cards, thinking and every other row open none.
 */
export function menuStripOf(row: TranscriptItem, own: MessageStrip | undefined, replies: ReadonlyMap<string, MessageStrip>): MessageStrip | undefined {
  return own ?? (row.kind === "assistant-text" ? replies.get(entryIdOf(row.id)) : undefined);
}

/** The few element calls `focusOnce` makes, so the rule runs on a stand-in too. */
export interface FocusRow {
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: "blur", fn: (e: { relatedTarget: unknown }) => void): void;
  removeEventListener(type: "blur", fn: (e: { relatedTarget: unknown }) => void): void;
}

/**
 * Where focus goes back to after a menu opened by the pointer: the message row itself, focusable
 * for that (tabindex -1, so never a Tab stop) until focus leaves it for anything but the menu
 * (`intoMenu`; the press of a right-click may focus the row before the menu takes focus). Not the
 * strip's first button: focus inside the strip shows it (:focus-within), so the strip would stay up
 * after the menu closed. A row that already takes focus is left as it is.
 */
export function focusOnce<T extends FocusRow>(row: T, intoMenu: (to: unknown) => boolean): T {
  if (row.hasAttribute("tabindex")) return row;
  row.setAttribute("tabindex", "-1");
  const left = (e: { relatedTarget: unknown }) => {
    if (intoMenu(e.relatedTarget)) return;
    row.removeAttribute("tabindex");
    row.removeEventListener("blur", left);
  };
  row.addEventListener("blur", left);
  return row;
}

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

/** What the rendered body leaves out of the words you read: a code block's head (its language and
    buttons), a drawing in place of its source, drawings, screen-reader-only notes, decoration. */
const NOT_WORDS = ".md-code-head, .md-code-rendered, .md-vis, .md-vis-pending, .visually-hidden, [aria-hidden='true']";

/**
 * The message as it reads on screen: each block's body as the page draws it (cloned from the thread
 * in `scope`; a block that isn't on screen, such as a step inside a folded work run, is drawn off
 * screen by the page's own Markdown drawing just for this), without the author line, images,
 * attachment chips or code-block controls; list items keep their bullet or number, and folded
 * working notes are read open. Its paragraphs, lists, code blocks and tables, and its blocks, are
 * apart by a blank line, as Copy joins blocks.
 */
export function plainText(blocks: readonly MessageBlock[], scope: ParentNode): string {
  const copy = document.createElement("div");
  for (const b of blocks) {
    const parts = scope.querySelectorAll(`.entry[data-entry="${CSS.escape(b.id)}"] article.message > :is(.message-body, .md-working-notes)`);
    if (parts.length) for (const p of parts) copy.append(p.cloneNode(true));
    else {
      const body = copy.appendChild(document.createElement("div"));
      body.className = "message-body";
      if (b.markdown) body.innerHTML = renderMarkdown(b.text).html;
      else body.textContent = b.text;
    }
  }
  for (const n of copy.querySelectorAll(NOT_WORDS)) n.remove();
  for (const d of copy.querySelectorAll("details")) d.open = true;
  for (const li of copy.querySelectorAll("li")) {
    const list = li.parentElement;
    let depth = 0;
    for (let up = list; up && up !== copy; up = up.parentElement) if (up.tagName === "LI") depth++;
    const mark = list?.tagName === "OL" ? `${(list as HTMLOListElement).start + Array.from(list.children).indexOf(li)}.` : "•";
    // In a span of its own that keeps its spaces: innerText drops leading white space, and the indent with it.
    const lead = document.createElement("span");
    lead.style.whiteSpace = "pre";
    lead.textContent = `${"  ".repeat(depth)}${mark} `;
    li.prepend(lead);
  }
  // innerText needs a laid-out box: the copy sits off screen for the one read, then goes.
  copy.setAttribute("aria-hidden", "true");
  copy.style.cssText = "position:fixed;left:-10000px;top:0;width:40rem;pointer-events:none";
  document.body.append(copy);
  try {
    // A body's own blocks one by one: innerText gives a list and the code block after it one line break, not a blank line.
    const reads = Array.from(copy.children).flatMap((part) => (part.classList.contains("message-body") && part.children.length ? Array.from(part.children) : [part]));
    return reads
      .map((el) => (el as HTMLElement).innerText.trim())
      .filter(Boolean)
      .join("\n\n");
  } finally {
    copy.remove();
  }
}
