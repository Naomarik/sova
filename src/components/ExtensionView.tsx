import { For, Show } from "solid-js";
import type { ExtensionInfo } from "../../shared/protocol";
import { extFrameSrc, extHref } from "../lib/ext-route";
import { Chip, Icon } from "./ui";
import "../extensions.css";

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

/**
 * The landing page's Extensions section: one card per installed extension, each a link to its
 * route. A card whose backend is down stays a link (its UI may still explain itself) and says why.
 */
export function ExtensionCards(props: { extensions: ExtensionInfo[] }) {
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
                <Show when={ext.status === "down"}>
                  <p class="ext-card-error">Its backend isn't answering: {ext.error ?? "no reason given"}.</p>
                </Show>
              </a>
            </li>
          )}
        </For>
      </ul>
    </section>
  );
}

/**
 * `#/ext/<id>`: the extension's own UI, iframed same-origin from /ext/<id>/ under a page head.
 * Not sandboxed: the extension mirrors Sova's theme from this document and calls Sova's API, both
 * of which need the same origin (the manifest is the user's explicit install).
 */
export function ExtensionView(props: {
  id: string;
  /** Its manifest entry; undefined while the list loads, or when nothing by this id is installed. */
  info: ExtensionInfo | undefined;
  /** The list has loaded at least once, so a missing `info` means not installed. */
  loaded: boolean;
  titleRef(el: HTMLHeadingElement): void;
}) {
  let frame: HTMLIFrameElement | undefined;
  const reload = () => {
    try {
      frame?.contentWindow?.location.reload();
    } catch {
      if (frame) frame.src = extFrameSrc(props.id);
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
      <header class="session-head">
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
              </p>
            )}
          </Show>
        </div>
        <button type="button" class="button button-icon button-ghost" onClick={reload} aria-label="Reload Extension" title="Reload Extension">
          <Icon name="refresh" />
        </button>
        <a
          class="button button-icon button-ghost"
          href={extFrameSrc(props.id)}
          target="_blank"
          rel="noopener"
          aria-label="Open in New Tab"
          title="Open in New Tab"
        >
          <Icon name="external" />
        </a>
      </header>
      <iframe class="ext-frame" ref={frame} src={extFrameSrc(props.id)} title={props.info?.title ?? props.id} />
    </Show>
  );
}
