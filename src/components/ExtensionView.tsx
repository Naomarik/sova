import { createEffect, createSignal, For, Index, onCleanup, Show, untrack } from "solid-js";
import type { ExtensionInfo, SessionSummary } from "../../shared/protocol";
import { extFrameSrc, extHref, extRouteFromHash, MAXIMIZED, parseExtMessage, subFromExtHash } from "../lib/ext-route";
import { additionsMuted, additionsOff, slotPolicy } from "../lib/reply-place";
import { rowAdditionsMuted, rowAdditionsOff, rowPolicy } from "../lib/row-place";
import { offersPlace } from "../../shared/extension-offers";
import { cardLineMuted, cardLineOff, cardLines, cardPolicy, createCardAdditions, type CardLine } from "../lib/card-place";
import { Chip, Icon } from "./ui";
import "../extensions.css";

const warned = new Set<string>();
/** An extension that keeps posting the same bad request warns once, not per message. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/** The manifest's icon name, as a mask like <Icon>; a card with none gets the generic one. */
function ExtIcon(props: { name?: string }) {
  return <span class="icon ext-card-icon" style={{ "--icon": `url(/icons/${props.name ?? "sliders"}.svg)` }} aria-hidden="true" />;
}

/** Status is said in a word as well as a colour; "down" also carries the reason the host saw. */
function ExtStatus(props: { info: ExtensionInfo }) {
  return (
    <Show when={props.info.status === "down"} fallback={<Chip tone="success">Running</Chip>}>
      <Chip tone="error" title={props.info.error}>
        Down
      </Chip>
    </Show>
  );
}

const TONE_CLASS: Record<NonNullable<CardLine["tone"]>, string> = { ok: " chip-success", warn: " chip-warn", error: " chip-error", info: " chip-info", muted: "" };

/** One line of the card place: Sova's reason line as it always was, or an extension's status line. */
function CardLineView(props: { line: CardLine }) {
  return (
    <Show when={props.line.kind === "status"} fallback={<p class="ext-card-error">Its backend isn't answering: {props.line.reason}.</p>}>
      <p class="ext-card-status">
        <i class={`chip-dot${TONE_CLASS[props.line.tone ?? "muted"]}`} aria-hidden="true" />
        <span>{props.line.text}</span>
      </p>
    </Show>
  );
}

/**
 * The landing page's Extensions section: one card per installed extension, each a link to its
 * route. A card whose backend is down stays a link (its UI may still explain itself) and says why.
 */
export function ExtensionCards(props: { extensions: ExtensionInfo[] }) {
  // The card place's extension lane (lib/card-place): asks each extension once per drawing.
  const card = createCardAdditions();
  createEffect(() => card.sync(props.extensions));
  return (
    <section class="explain-section" aria-labelledby="ext-section-title">
      <h2 class="explain-section-head" id="ext-section-title">
        Extensions <span class="text-num">{props.extensions.length}</span>
      </h2>
      <ul class="ext-grid">
        <For each={props.extensions}>
          {(ext) => (
            <li>
              <a class="card ext-card" href={extHref(ext.id)}>
                <div class="ext-card-head">
                  <ExtIcon name={ext.icon} />
                  <h3 class="ext-card-title">{ext.title}</h3>
                  <ExtStatus info={ext} />
                </div>
                <Show when={ext.description}>
                  <p class="ext-card-body">{ext.description}</p>
                </Show>
                <Index each={cardLines(ext, () => card.line(ext.id))}>{(line) => <CardLineView line={line()} />}</Index>
              </a>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

/**
 * `#/ext/<id>[/<sub>]`: the extension's own UI, iframed same-origin from /ext/<id>/ under a page
 * head. Not sandboxed: the extension mirrors Sova's theme from this document and calls Sova's API,
 * both of which need the same origin (the manifest is the user's explicit install).
 *
 * The iframe talks to the page by postMessage (ext-contract §3.6, §3.7): it hands over sessions to
 * open, asks to be maximized (the head and the sidebar go, the iframe fills the viewport) and
 * restored, and reports its own navigation, which the page mirrors into its URL. The iframe is
 * loaded once per mount and never reloaded by any of that.
 */
export function ExtensionView(props: {
  id: string;
  /** The sub-route the page was opened at; read once, for the iframe's first URL. */
  sub: string | null;
  /** Its manifest entry; undefined while the list loads, or when nothing by this id is installed. */
  info: ExtensionInfo | undefined;
  /** The list has loaded at least once, so a missing `info` means not installed. */
  loaded: boolean;
  titleRef(el: HTMLHeadingElement): void;
  /** Open a session the extension created, the way New Session opens its own (ext-contract §3.6). */
  onOpenSession(session: SessionSummary): void;
  /** The extension moved to its own route `sub` (null: its home): mirror it into the page URL. */
  onRoute(sub: string | null): void;
  /** Maximized or not, for the app root's `data-ext-maximized`. */
  onMaximized(on: boolean): void;
}) {
  let frame: HTMLIFrameElement | undefined;
  const firstSrc = untrack(() => extFrameSrc(props.id, props.sub));
  /** Where the extension is now, as far as it has told us: for Open in New Tab and a reload. */
  const [sub, setSub] = createSignal(untrack(() => props.sub));
  const [maximized, setMaximized] = createSignal(false);

  /** Apply maximize/restore and always answer, so an extension waiting on the reply never times out. */
  const setMax = (on: boolean) => {
    if (maximized() !== on) {
      setMaximized(on);
      props.onMaximized(on);
    }
    frame?.contentWindow?.postMessage({ type: MAXIMIZED, on }, location.origin);
  };
  const restore = () => setMax(false);

  const onMessage = (event: MessageEvent) => {
    const r = parseExtMessage(event, { origin: location.origin, frame: frame?.contentWindow });
    if (!r) return;
    if ("error" in r) {
      warnOnce(`[ext ${props.id}] ignored ${r.error}`);
      return;
    }
    switch (r.kind) {
      // A fresh session has no messages, so it isn't in the list yet, and a plain `#/s/<path>`
      // would find nothing: the extension hands the session over instead.
      case "open-session":
        return props.onOpenSession(r.session);
      case "maximize":
        return setMax(true);
      case "restore":
        return restore();
      case "route": {
        const next = subFromExtHash(r.hash);
        setSub(next);
        return props.onRoute(next);
      }
    }
  };
  // Any navigation of the page restores (the host binds no key, so Esc stays the extension's).
  // Mirroring the extension's own route uses replaceState, which fires no hashchange. A new
  // sub-route of this extension (a pasted link, Back) is passed into the iframe by its hash, which
  // navigates the extension without reloading it.
  const onHashChange = () => {
    restore();
    const r = extRouteFromHash(location.hash);
    if (r?.id !== props.id) return;
    setSub(r.sub);
    const want = r.sub ? `#/${r.sub}` : "#/";
    try {
      const w = frame?.contentWindow;
      if (w && (w.location.hash || "#/") !== want) w.location.hash = want;
    } catch {
      // not ours to read (it navigated away from Sova's origin): leave it alone
    }
  };
  window.addEventListener("message", onMessage);
  window.addEventListener("hashchange", onHashChange);
  onCleanup(() => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("hashchange", onHashChange);
    if (maximized()) props.onMaximized(false);
  });
  const reload = () => {
    restore();
    try {
      frame?.contentWindow?.location.reload();
    } catch {
      if (frame) frame.src = extFrameSrc(props.id, sub());
    }
  };
  return (
    <Show
      when={props.info || !props.loaded}
      fallback={
        <div class="center-fill">
          <div class="empty">
            <p class="empty-title">No extension named “{props.id}” is installed.</p>
            <p class="empty-body">Extensions come from Sova's extensions manifest, and this one isn't in it.</p>
            <a class="button empty-action" href="#/">
              Back to Sessions
            </a>
          </div>
        </div>
      }
    >
      <header class="session-head ext-head">
        <a class="button button-icon button-ghost app-back" href="#/" aria-label="Back to Sessions">
          <Icon name="chevron-left" />
        </a>
        <div class="session-head-main">
          <h1 class="session-head-title" tabindex="-1" ref={props.titleRef}>
            {props.info?.title ?? props.id}
          </h1>
          <Show when={props.info}>
            {(info) => (
              <p class="session-head-meta">
                <ExtStatus info={info()} />
                <Show when={info().status === "down"} fallback={<Show when={info().description}><span>{info().description}</span></Show>}>
                  <span title={info().error}>Backend not answering: {info().error ?? "no reason given"}</span>
                </Show>
                <Show when={offersPlace(info().offers, "reply") && !additionsOff(info().id) && additionsMuted(info().id)}>
                  <span>Hidden under replies until you reload: what it sent broke Sova's rules for them.</span>
                </Show>
                <Show when={offersPlace(info().offers, "row") && !rowAdditionsOff(info().id) && rowAdditionsMuted(info().id)}>
                  <span>Hidden on session rows until you reload: what it sent broke Sova's rules for them.</span>
                </Show>
                <Show when={offersPlace(info().offers, "card") && !cardLineOff(info().id) && cardLineMuted(info().id)}>
                  <span>Hidden on its home card until you reload: what it sent broke Sova's rules for it.</span>
                </Show>
              </p>
            )}
          </Show>
        </div>
        {/* The user's switch for what it adds under replies (lib/reply-place), only for one that does. */}
        <Show when={offersPlace(props.info?.offers, "reply")}>
          <button type="button" class="button button-sm button-ghost" onClick={() => slotPolicy.setOff(props.id, !additionsOff(props.id))}>
            {additionsOff(props.id) ? "Show Under Replies" : "Hide Under Replies"}
          </button>
        </Show>
        {/* The same switch for what it adds to session rows (lib/row-place), only for one that does. */}
        <Show when={offersPlace(props.info?.offers, "row")}>
          <button type="button" class="button button-sm button-ghost" onClick={() => rowPolicy.setOff(props.id, !rowAdditionsOff(props.id))}>
            {rowAdditionsOff(props.id) ? "Show on Session Rows" : "Hide on Session Rows"}
          </button>
        </Show>
        {/* The user's switch for its status line on the home card (lib/card-place), only for one that adds one. */}
        <Show when={offersPlace(props.info?.offers, "card")}>
          <button type="button" class="button button-sm button-ghost" onClick={() => cardPolicy.setOff(props.id, !cardLineOff(props.id))}>
            {cardLineOff(props.id) ? "Show on Home Card" : "Hide on Home Card"}
          </button>
        </Show>
        <button type="button" class="button button-icon button-ghost" onClick={reload} aria-label="Reload Extension" title="Reload Extension">
          <Icon name="refresh" />
        </button>
        <a
          class="button button-icon button-ghost"
          href={extFrameSrc(props.id, sub())}
          target="_blank"
          rel="noopener"
          aria-label="Open in New Tab"
          title="Open in New Tab"
        >
          <Icon name="external" />
        </a>
      </header>
      <iframe
        class="ext-frame"
        classList={{ "ext-frame-max": maximized() }}
        ref={frame}
        src={firstSrc}
        title={props.info?.title ?? props.id}
        allow="fullscreen"
        allowfullscreen
      />
    </Show>
  );
}
