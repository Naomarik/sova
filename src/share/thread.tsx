import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import type { BatonViewImage, BatonViewItem } from "../../shared/baton";
import { linkSegments } from "../lib/share-linkify";
import "./thread.css";
import { createMarkdownPatcher } from "../vis/hydrate";
import { renderShareMarkdown, type ShareVisKinds, type ShareVisual } from "./markdown";
import { mountShareVisual } from "./vis";

// A conversation's items as an outsider reads them: the share page and the owner page render the
// same thread with these.

const othersWord = (n: number) => (n === 1 ? "1 other person" : `${n} other people`);
const peopleWord = (n: number) => (n === 1 ? "1 person" : `${n} people`);

/** A reply as markdown, its drawings mounted into it. The HTML reaches the DOM one top-level block
    at a time (vis/hydrate.tsx), so while a reply streams the drawings above stay put.
    `streaming`: an unclosed `vis` fence is still being written. `kinds`: the fences drawn (the
    business kinds unless the page says otherwise). */
export function Reply(props: { text: string; streaming?: boolean; kinds?: ShareVisKinds }) {
  let el!: HTMLDivElement;
  let patcher: ReturnType<typeof createMarkdownPatcher<ShareVisual>> | undefined;
  createEffect(() => {
    const r = renderShareMarkdown(props.text, !!props.streaming, props.kinds);
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

export const photoCount = (n: number) => (n === 1 ? "1 photo" : `${n} photos`);

/**
 * A message's photos (§app.baton/images): one fitted in 320 × 240, more as 96 px tiles, and a
 * lightbox (a native <dialog>) that steps through this message's photos only. `src` is each
 * photo's address; `from` names the sender for the alt text ("you" for the viewer's own).
 */
export function MessagePhotos(props: { srcs: string[]; from: string }) {
  let dialog!: HTMLDialogElement;
  let opener: HTMLElement | null = null;
  const [at, setAt] = createSignal(0);
  const n = () => props.srcs.length;
  const alt = (i: number) => (n() === 1 ? `Photo from ${props.from}` : `Photo ${i + 1} of ${n()} from ${props.from}`);
  const open = (i: number, e: MouseEvent) => {
    opener = e.currentTarget as HTMLElement;
    setAt(i);
    dialog.showModal();
  };
  const step = (d: number) => setAt((i) => (i + d + n()) % n());
  return (
    <>
      <ul class="share-photos" classList={{ "share-photos-single": n() === 1 }} aria-label={photoCount(n())}>
        <For each={props.srcs}>
          {(src, i) => (
            <li>
              <button class="share-thumb" type="button" aria-haspopup="dialog" onClick={(e) => open(i(), e)}>
                <img src={src} alt={alt(i())} loading="lazy" decoding="async" />
              </button>
            </li>
          )}
        </For>
      </ul>
      <dialog
        ref={dialog}
        class="share-lightbox"
        aria-label={alt(at())}
        onClose={() => opener?.focus()}
        onClick={(e) => {
          if (e.target === dialog || (e.target as HTMLElement).classList.contains("share-lightbox-stage")) dialog.close();
        }}
        onKeyDown={(e) => {
          if (n() < 2) return;
          if (e.key === "ArrowLeft") step(-1);
          else if (e.key === "ArrowRight") step(1);
        }}
      >
        <div class="share-lightbox-bar">
          <p class="share-lightbox-caption">{alt(at())}</p>
          <Show when={n() > 1}>
            <span class="share-lightbox-count" aria-hidden="true">
              {at() + 1} / {n()}
            </span>
          </Show>
          <button class="button button-icon button-ghost" type="button" aria-label="Close Photo" autofocus onClick={() => dialog.close()}>
            <span class="icon share-icon-close" aria-hidden="true" />
          </button>
        </div>
        <div class="share-lightbox-stage">
          <img class="share-lightbox-img" src={props.srcs[at()]} alt={alt(at())} />
          <Show when={n() > 1}>
            <button class="button button-icon share-lightbox-prev" type="button" aria-label="Previous Photo" onClick={() => step(-1)}>
              <span class="icon share-icon-prev" aria-hidden="true" />
            </button>
            <button class="button button-icon share-lightbox-next" type="button" aria-label="Next Photo" onClick={() => step(1)}>
              <span class="icon share-icon-next" aria-hidden="true" />
            </button>
          </Show>
        </div>
      </dialog>
    </>
  );
}

/** `reader`: whoever reads without holding a turn (the owner page) sees an offer as the count it
    went to, not as an invitation to them. `photo`: where a message's photo `n` is served (the
    share page); without it a message's photos show as their count (the owner page). */
export function Item(props: { item: BatonViewItem; reader?: boolean; photo?: (n: number) => string }) {
  const it = props.item;
  const photos = (m: { images?: BatonViewImage[] }) => m.images ?? [];
  return (
    <Switch>
      <Match when={it.kind === "message" && it}>
        {(m) => (
          <article class="share-msg" classList={{ "share-msg-own": m().by === "you" }} aria-label={`${m().by === "you" ? "You" : m().name}`}>
            <span class="share-who">{m().by === "you" ? "You" : m().name}</span>
            <Show when={photos(m()).length}>
              <Show when={props.photo} fallback={<p class="share-photo-count">{photoCount(photos(m()).length)}</p>}>
                {(url) => <MessagePhotos srcs={photos(m()).map((p) => url()(p.n))} from={m().by === "you" ? "you" : m().name} />}
              </Show>
            </Show>
            <Show when={m().text}>
              <LinkedText text={m().text} />
            </Show>
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
