import { type JSX, Show } from "solid-js";
import type { NeedsRow } from "../lib/needs-you-row";
import { Chip, Icon } from "./ui";

/**
 * One Needs you row (§app.session-list/needs-you): the link is stretched over the whole row, so the row is its target
 * and says everything once; what it opens is words inside that link, never a second control. An action that acts
 * (`children`: Merge Branch, Cancel) is a real button, a sibling of the link and above it: its own tab stop.
 */
export function NeedsYouRowView(props: { row: NeedsRow; label?: string; current?: boolean; children?: JSX.Element }) {
  const r = () => props.row;
  return (
    <li class="ny-row" classList={{ "ny-row-current": props.current }} data-kind-word={r().chip.word}>
      <a class="ny-link" href={r().href} aria-current={props.current ? "page" : undefined}>
        <span class="ny-top">
          <span class="ny-name" title={r().place ?? undefined}>
            {props.label ?? r().name}
          </span>
          <Chip tone={r().chip.tone}>{r().chip.word}</Chip>
        </span>
        <span class="ny-title" classList={{ "ny-title-muted": r().titleMuted }} title={r().title}>
          {r().title}
        </span>
        <Show when={r().detail}>
          <span class="ny-detail" title={r().detailTip}>
            {r().detail}
          </span>
        </Show>
        <span class="ny-action">
          {r().action}
          <Icon name="arrow-right" small />
        </span>
      </a>
      <div class="ny-acts">{props.children}</div>
    </li>
  );
}
