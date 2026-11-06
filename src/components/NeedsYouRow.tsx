import { type JSX, Show } from "solid-js";
import type { NeedsRow } from "../lib/needs-you-row";
import { Chip, Icon } from "./ui";

/**
 * One Needs you row (§app.session-list/needs-you): the link is stretched over the whole row, so the row is its target.
 * It says where and what; why is its hover text, and no word says what it opens. What acts is a real button, a sibling of
 * the link and above it, its own tab stop: Dismiss on a chat's row (`onDismiss`, §app.session-list/needs-you-dismiss), and
 * `children` (Merge Branch, Cancel) on a line of their own under the title.
 */
export function NeedsYouRowView(props: { row: NeedsRow; label?: string; current?: boolean; onDismiss?: (button: HTMLButtonElement) => void; children?: JSX.Element }) {
  const r = () => props.row;
  return (
    <li class="ny-row" classList={{ "ny-row-current": props.current, "ny-row-dismissable": !!props.onDismiss }} data-kind-word={r().chip.word}>
      <a class="ny-link" href={r().href} title={r().tip} aria-current={props.current ? "page" : undefined}>
        <span class="ny-top">
          <span class="ny-name" title={r().place ?? undefined}>
            {props.label ?? r().name}
          </span>
          <Chip tone={r().chip.tone}>{r().chip.word}</Chip>
        </span>
        <span class="ny-title" classList={{ "ny-title-muted": r().titleMuted }}>
          {r().title}
        </span>
      </a>
      <Show when={props.onDismiss}>
        <button
          class="button button-icon button-ghost ny-dismiss"
          type="button"
          aria-label={`Dismiss ${r().title}`}
          title="Dismiss"
          onClick={(e) => props.onDismiss!(e.currentTarget)}
        >
          <Icon name="close" small />
        </button>
      </Show>
      <div class="ny-acts">{props.children}</div>
    </li>
  );
}
