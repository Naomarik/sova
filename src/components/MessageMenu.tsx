/**
 * The message's right-click menu (§chat.transcript/message-actions "Right-click"): a right-click,
 * Shift+F10 or the Menu key on a delivered message that has a strip opens the strip's own actions
 * through the page's one right-click menu (ContextMenu.tsx). The rows come from the same items the
 * strip draws (the reply place's built-ins), so the two can't drift; Copy as Plain Text is the
 * menu's only row of its own. Rewind… and Regenerate… ask on a screen, with the strip's confirm.
 */
import { createEffect, createMemo, createUniqueId, Index, Match, on, Switch } from "solid-js";
import { COPY_PLAIN, type MessageStrip, stripLabel } from "../lib/message-actions";
import { confirmRow, type MessageBlock, type MessageMenuKind, messageMenuRows, plainText, rowAct } from "../lib/message-menu";
import { builtInItems, type ReplyPlace } from "../lib/reply-place";
import { copyText } from "../lib/ui-state";
import type { ActionMenuApi } from "./ActionMenu";
import { openContextMenu } from "./ContextMenu";
import { ACTION_ICON, type MessageActionItem } from "./MessageActions";
import { Icon, type IconName } from "./ui";

const ROW_ICON: Record<MessageMenuKind, IconName> = { ...ACTION_ICON, "copy-plain": "copy" };
/** The rows that copy or share, before the ones that change the branch or fork it. */
const SAFE: readonly MessageMenuKind[] = ["copy", "copy-plain", "share"];

/** What the rendered body leaves out of the words you read: a code block's head (its language and
    buttons), a drawing in place of its source, drawings, screen-reader-only notes, decoration. */
const NOT_WORDS = ".md-code-head, .md-code-rendered, .md-vis, .md-vis-pending, .visually-hidden, [aria-hidden='true']";

/**
 * A drawn row's message body as it reads on screen: its visible text (innerText, so a code block
 * keeps its text and a link collapses to its words), without the author line, images, attachment
 * chips or code-block controls; list items keep their bullet or number, and folded working notes
 * are read open. Null when the row's body isn't drawn (not mounted, or drawn by an extension's kind).
 */
export function readDrawnBlock(scope: ParentNode, id: string): string | null {
  const article = scope.querySelector(`.entry[data-entry="${CSS.escape(id)}"] article.message`);
  const parts = article?.querySelectorAll(":scope > .message-body, :scope > .md-working-notes");
  if (!parts?.length) return null;
  const copy = document.createElement("div");
  for (const p of parts) copy.append(p.cloneNode(true));
  for (const n of copy.querySelectorAll(NOT_WORDS)) n.remove();
  for (const d of copy.querySelectorAll("details")) d.open = true;
  for (const li of copy.querySelectorAll("li")) {
    const list = li.parentElement;
    let depth = 0;
    for (let up = list; up && up !== copy; up = up.parentElement) if (up.tagName === "LI") depth++;
    const mark = list?.tagName === "OL" ? `${(list as HTMLOListElement).start + Array.from(list.children).indexOf(li)}.` : "•";
    li.prepend(`${"  ".repeat(depth)}${mark} `);
  }
  // innerText needs a laid-out box: the copy sits off screen for the one read, then goes.
  copy.setAttribute("aria-hidden", "true");
  copy.style.cssText = "position:fixed;left:-10000px;top:0;width:40rem;pointer-events:none";
  document.body.append(copy);
  try {
    return copy.innerText;
  } finally {
    copy.remove();
  }
}

/** The menu's body: the strip's rows (plus Copy as Plain Text), and the confirm screen. */
export function MessageMenuBody(props: { menu: ActionMenuApi; label: string; items: MessageActionItem[]; copyPlain(): void | Promise<void> }) {
  const menu = props.menu;
  const rows = createMemo(() => messageMenuRows(props.items, props.copyPlain));
  /** The branch action the screen asks about, while it still can run. */
  const asking = createMemo(() => confirmRow(rows(), menu.screen()));
  let list: HTMLDivElement | undefined;
  // An action that became impossible while it was asked (a turn started): the rows come back, focus
  // on its row, which now says why — as the strip's confirm gives way to its button.
  createEffect(
    on(
      () => menu.screen() !== null && !asking(),
      (gaveWay) => {
        if (!gaveWay) return;
        const kind = menu.screen()!.slice("confirm:".length);
        menu.show(null);
        const aria = rows().find((r) => r.kind === kind)?.aria;
        if (aria) queueMicrotask(() => list?.querySelector<HTMLElement>(`[aria-label="${CSS.escape(aria)}"]`)?.focus());
      },
      { defer: true },
    ),
  );
  const noteId = createUniqueId();
  const group = (safe: boolean) => rows().filter((r) => SAFE.includes(r.kind) === safe);
  const items = (each: () => ReturnType<typeof group>) => (
    <Index each={each()}>
      {(r) => (
        <menu.Item
          label={r().label}
          aria={r().aria}
          icon={<Icon name={ROW_ICON[r().kind]} small />}
          disabled={r().disabled}
          stayOpen={!!r().confirm}
          onRun={() => void rowAct(r(), menu.show)()}
        />
      )}
    </Index>
  );
  return (
    <Switch
      fallback={
        <div ref={list} class="model-menu-list" role="menu" aria-label={props.label}>
          <div class="model-menu-group" role="group" aria-label="Copy and share">
            {items(() => group(true))}
          </div>
          {group(false).length > 0 && (
            <div class="model-menu-group" role="group" aria-label="Branch">
              {items(() => group(false))}
            </div>
          )}
        </div>
      }
    >
      <Match when={asking()}>
        {(row) => (
          // The strip's own confirm: its sentence, said to the button that acts on it, then Cancel.
          <div class="group-menu-screen" role="group" aria-label={row().aria}>
            <p class="group-tools-question" id={noteId}>
              {row().confirm!.note}
            </p>
            <div class="cluster">
              <button
                ref={(b) => queueMicrotask(() => b.focus())}
                type="button"
                class="button button-sm button-destructive"
                aria-describedby={noteId}
                onClick={() => {
                  const now = asking();
                  if (now) menu.run(() => void now.run());
                }}
              >
                {row().confirm!.label}
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => menu.dismiss()}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </Match>
    </Switch>
  );
}

/**
 * A message row's right-click and Shift+F10: the strip's actions as a menu, at the pointer or under
 * the focused element. `el` is the row (`.entry`); `blocks` the rows its message is drawn as (for
 * Copy as Plain Text). Focus goes back to the strip, the message's own keyboard stop.
 */
export function openMessageMenu(e: MouseEvent, at: { el: HTMLElement; place: ReplyPlace; strip: MessageStrip; blocks: () => MessageBlock[] }) {
  return openContextMenu(e, {
    el: at.el,
    menu: () => ({
      label: stripLabel(at.strip.role),
      origin: at.el.querySelector<HTMLElement>(".message-actions button") ?? at.el,
      body: (menu) => (
        <MessageMenuBody
          menu={menu}
          label={stripLabel(at.strip.role)}
          items={builtInItems(at.place, at.strip)}
          copyPlain={async () => {
            const scope = at.el.parentElement ?? document;
            void (await copyText(plainText(at.blocks(), (id) => readDrawnBlock(scope, id)), COPY_PLAIN.done));
          }}
        />
      ),
    }),
  });
}
