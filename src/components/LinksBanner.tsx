import { For, Show } from "solid-js";
import type { OfferLink } from "../../shared/baton";
import { openSettings } from "../lib/settings-nav";
import { copyText } from "../lib/ui-state";
import { Banner, CopyButton } from "./ui";

export type Links = OfferLink[];

/** Links just minted or got (a new session or offer, Get Link, New Link): one row per person, each
    with Copy Link; a live one stays copyable afterwards from where it is listed. `warning`: why they
    may not open from outside yet, the server's text verbatim, with a way to Settings → Public links. `replaced`: a link a Get
    Link elsewhere turned off, said in place of its text and Copy Link. */
export function LinksBanner(props: { links: Links; warning?: string; replaced?(link: OfferLink): boolean; onDismiss(): void }) {
  return (
    <Banner
      tone={props.warning ? "warn" : "info"}
      title={props.links.length === 1 ? `${props.links[0]!.name}'s link` : `${props.links.length} links`}
      body={
        <span class="project-links">
          <For each={props.links}>
            {(l) => (
              <span class="project-link-row">
                <Show when={props.links.length > 1}>
                  <span class="project-link-name">{l.name}</span>
                </Show>
                <Show
                  when={!props.replaced?.(l)}
                  fallback={<span class="field-hint">Replaced by a newer link.</span>}
                >
                  <span class="orgs-mono orgs-link">{l.link}</span>
                  <CopyButton label={`Copy ${l.name}'s Link`} text={() => l.link} onCopy={(t) => copyText(t, "Link copied.")} />
                </Show>
              </span>
            )}
          </For>
          <Show when={props.warning}>
            <span class="field-hint">{props.warning}</span>
          </Show>
        </span>
      }
      action={
        <>
          <Show when={props.warning}>
            <button type="button" class="button button-sm button-ghost" onClick={() => openSettings("public-links")}>
              Open Settings
            </button>
          </Show>
          <button type="button" class="button button-sm button-ghost" onClick={() => props.onDismiss()}>
            Done
          </button>
        </>
      }
    />
  );
}
