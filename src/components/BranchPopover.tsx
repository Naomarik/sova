import { createResource, createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fetchSessionInsight } from "../lib/api";
import { placeHelpCard } from "../lib/help-popover";
import { Icon, Placeholder, trapFocus } from "./ui";
import { WorktreeQueueRow, type QueueWorktree } from "./WorktreesModal";
import "./branch-popover.css";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** While the card is open it reads its branch again this often: a Land moves it to In line, then Checking. */
const REREAD_MS = 5000;
let seq = 0;

/**
 * A ready branch's name on the project page's Sessions tab: a button that opens that branch's own row from its chat's
 * Worktrees window (WorktreeQueueRow: the chip, its commits, lines and age, what the branch does, Review Changes, and
 * Land with its confirm) in a card beside the name. The row is read from the chat's own worktrees when the card opens,
 * so the card and the chat's window always agree.
 *
 * The card is a non-modal dialog under the name (above it when only that side has room), a bottom sheet at folded
 * width. It is not in the top layer: the changes viewer its Review Changes opens is a modal of the page's, and covers
 * it. It closes on Escape, its ×, or a press outside it, and gives focus back to the name.
 */
export function BranchPopover(props: {
  branch: string;
  /** The chat that tracks the branch: its session file, and the folder it runs in (Review Changes reads there). */
  sessionPath: string;
  cwd?: string;
  /** More classes on the name's button. */
  class?: string;
  /** Something on the row changed the queue (Land, Remove from Queue): the page reads its branches again. */
  onChanged?(): void;
}) {
  const id = `branch-pop-${++seq}`;
  let button!: HTMLButtonElement;
  const [open, setOpen] = createSignal(false);
  const [rows, { refetch }] = createResource(
    () => (open() ? props.sessionPath : null),
    // A failed read is an answer, not a throw: the card says so and offers Retry.
    (path) =>
      fetchSessionInsight(path).then(
        (i): { list: QueueWorktree[] } | { error: string } => ({ list: (i.worktrees ?? []) as QueueWorktree[] }),
        (x) => ({ error: errText(x) }),
      ),
  );
  const read = () => rows.latest;
  const failed = () => {
    const r = read();
    return r && "error" in r ? r.error : null;
  };
  /** The branch's row; null once its chat no longer tracks it; undefined until it is read. */
  const tree = (): QueueWorktree | null | undefined => {
    const r = read();
    return r && "list" in r ? (r.list.find((w) => w.branch === props.branch && w.status !== "dropped") ?? null) : undefined;
  };
  const close = (refocus: boolean) => {
    if (!open()) return;
    setOpen(false);
    if (refocus) queueMicrotask(() => button.isConnected && button.focus());
  };
  const changed = () => {
    void refetch();
    props.onChanged?.();
  };

  /** The open card: placed against the name, kept in the window, and re-read while it shows. */
  const Card = () => {
    let card!: HTMLDivElement;
    const place = () => {
      if (!card.isConnected) return;
      const at = placeHelpCard(button.getBoundingClientRect(), card.getBoundingClientRect(), { width: innerWidth, height: innerHeight });
      card.style.setProperty("--branch-pop-top", `${at.top}px`);
      card.style.setProperty("--branch-pop-left", `${at.left}px`);
    };
    // What is layered over the card is not "outside" it: the changes viewer and any modal (the page's scrim), a menu
    // or sheet in the top layer.
    const above = (t: Element) => !!t.closest(".modal, .scrim:not(.branch-pop-scrim), :popover-open");
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || card.contains(t) || button.contains(t) || above(t)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // A menu or the changes viewer above the card takes the key first; the row's own confirm stops it itself.
      if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(":popover-open, .changes-dialog")) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    const grown = new ResizeObserver(place);
    const reread = setInterval(() => !rows.loading && void refetch(), REREAD_MS);
    addEventListener("pointerdown", onPointerDown, true);
    addEventListener("resize", place);
    addEventListener("scroll", place, true);
    document.addEventListener("keydown", onKey);
    onCleanup(() => {
      grown.disconnect();
      clearInterval(reread);
      removeEventListener("pointerdown", onPointerDown, true);
      removeEventListener("resize", place);
      removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", onKey);
    });
    return (
      <Portal>
        <div class="scrim branch-pop-scrim" onClick={() => close(false)} />
        <div
          class="branch-pop"
          id={id}
          role="dialog"
          aria-labelledby={`${id}-title`}
          tabindex="-1"
          ref={(el) => {
            card = el;
            // Focus starts on the card itself (its name is read), not on its ×; Tab then walks its controls.
            queueMicrotask(() => el.isConnected && el.focus());
            trapFocus(el);
            grown.observe(el);
            queueMicrotask(place);
          }}
        >
          <div class="sheet-grip" aria-hidden="true" />
          <div class="branch-pop-head">
            <h4 class="branch-pop-title" id={`${id}-title`}>
              Worktree
            </h4>
            <button type="button" class="button button-icon button-ghost" aria-label="Close" onClick={() => close(true)}>
              <Icon name="close" small />
            </button>
          </div>
          <div class="branch-pop-body">
            <Show
              when={tree()}
              fallback={
                <Show
                  when={tree() === null}
                  fallback={
                    <Show when={failed()} fallback={<Placeholder lines={3} label={`Reading ${props.branch}`} />}>
                      <p class="field-error">
                        Couldn't read this branch. {failed()}{" "}
                        <button type="button" class="button button-sm" onClick={() => void refetch()}>
                          Retry
                        </button>
                      </p>
                    </Show>
                  }
                >
                  <p class="text-caption text-muted branch-pop-gone">Its chat no longer tracks {props.branch}. Open the chat to see where it went.</p>
                </Show>
              }
            >
              {(w) => (
                <ul class="list wt-queue-list branch-pop-list">
                  <WorktreeQueueRow worktree={w()} onChanged={changed} review={{ sessionPath: props.sessionPath, cwd: props.cwd }} onAnswerInChat={() => close(false)} />
                </ul>
              )}
            </Show>
          </div>
        </div>
      </Portal>
    );
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        class={`branch-pop-open text-mono${props.class ? ` ${props.class}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open() ? "true" : "false"}
        aria-controls={open() ? id : undefined}
        aria-label={`${props.branch}: ready to land. Show its summary`}
        title={props.branch}
        onClick={() => (open() ? close(false) : setOpen(true))}
      >
        <span class="branch-pop-dot" aria-hidden="true" />
        <span class="branch-pop-name">{props.branch}</span>
        <Icon name="chevron-down" small />
      </button>
      <Show when={open()}>
        <Card />
      </Show>
    </>
  );
}
