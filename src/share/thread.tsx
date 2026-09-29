import { createEffect, For, Match, onCleanup, Show, Switch } from "solid-js";
import type { BatonViewItem } from "../../shared/baton";
import { linkSegments } from "../lib/share-linkify";
import "./thread.css";
import { createMarkdownPatcher } from "../vis/hydrate";
import { renderShareMarkdown, type ShareVisual } from "./markdown";
import { mountShareVisual } from "./vis";

// A conversation's items as an outsider reads them: the share page and the owner page render the
// same thread with these.

const othersWord = (n: number) => (n === 1 ? "1 other person" : `${n} other people`);
const peopleWord = (n: number) => (n === 1 ? "1 person" : `${n} people`);

/** A reply as markdown, its drawings mounted into it. The HTML reaches the DOM one top-level block
    at a time (vis/hydrate.tsx), so while a reply streams the drawings above stay put.
    `streaming`: an unclosed `vis` fence is still being written. */
export function Reply(props: { text: string; streaming?: boolean }) {
  let el!: HTMLDivElement;
  let patcher: ReturnType<typeof createMarkdownPatcher<ShareVisual>> | undefined;
  createEffect(() => {
    const r = renderShareMarkdown(props.text, !!props.streaming);
    patcher ??= createMarkdownPatcher(el, mountShareVisual);
    patcher.patch(r);
  });
  onCleanup(() => patcher?.dispose());
  return <div ref={el} class="share-md" />;
}

/** Plain text with its explicit http(s) addresses as links: DOM nodes, never HTML. */
export function LinkedText(props: { text: string }) {
  return (
    <div class="share-text">
      <For each={linkSegments(props.text)}>
        {(seg) =>
          "href" in seg ? (
            <a href={seg.href} target="_blank" rel="noopener noreferrer nofollow">
              {seg.text}
            </a>
          ) : (
            seg.text
          )
        }
      </For>
    </div>
  );
}

/** `reader`: whoever reads without holding a turn (the owner page) sees an offer as the count it
    went to, not as an invitation to them. */
export function Item(props: { item: BatonViewItem; reader?: boolean }) {
  const it = props.item;
  return (
    <Switch>
      <Match when={it.kind === "message" && it}>
        {(m) => (
          <article class="share-msg" classList={{ "share-msg-own": m().by === "you" }} aria-label={`${m().by === "you" ? "You" : m().name}`}>
            <span class="share-who">{m().by === "you" ? "You" : m().name}</span>
            <LinkedText text={m().text} />
          </article>
        )}
      </Match>
      <Match when={it.kind === "reply" && it}>
        {(r) => (
          <article class="share-msg share-msg-reply" aria-label="Facilitator">
            <span class="share-who">Facilitator</span>
            <Reply text={r().text} />
            <Show when={r().cutOff}>
              <p class="share-cutoff">This reply was cut off.</p>
            </Show>
          </article>
        )}
      </Match>
      <Match when={it.kind === "handoff" && it}>
        {(h) => (
          <aside class="share-card" aria-label={`Passed to ${h().to}`}>
            <span class="share-card-head">
              {h().n === 1 ? `For ${h().to}` : `Passed from ${h().from} to ${h().to}`}
            </span>
            <LinkedText text={h().question} />
            <Show when={h().briefing}>
              <div class="share-brief">
                <span class="share-card-head">What you need to know</span>
                <LinkedText text={h().briefing ?? ""} />
              </div>
            </Show>
          </aside>
        )}
      </Match>
      <Match when={it.kind === "offer" && it}>
        {(o) => (
          <aside class="share-card" aria-label="Offered">
            {/* Counted, never named: the server sends the count only, so "someone else is answering" names nobody. */}
            <span class="share-card-head">
              {props.reader ? `Offered to ${peopleWord(o().invited)}: the first to answer takes it` : `Open to you and ${othersWord(o().invited - 1)}: the first to answer takes it`}
            </span>
            <LinkedText text={o().question} />
            <Show when={o().briefing}>
              <div class="share-brief">
                <span class="share-card-head">What you need to know</span>
                <LinkedText text={o().briefing ?? ""} />
              </div>
            </Show>
          </aside>
        )}
      </Match>
      <Match when={it.kind === "decision" && it}>
        {(d) => (
          <aside class="share-card share-card-quiet" aria-label="Noted">
            <span class="share-card-head">Noted · {d().area}</span>
            <LinkedText text={d().statement} />
          </aside>
        )}
      </Match>
      <Match when={it.kind === "done" && it}>
        {(d) => (
          <aside class="share-card" aria-label="Done">
            <span class="share-card-head">Done</span>
            <LinkedText text={d().summary} />
          </aside>
        )}
      </Match>
    </Switch>
  );
}
