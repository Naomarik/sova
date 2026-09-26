import { For, Show } from "solid-js";
import type { OfferLink } from "../../shared/baton";
import { copyText } from "../lib/ui-state";
import { Banner, CopyButton } from "./ui";

export type Links = OfferLink[];

/** Links minted for a new session or offer: shown once, one row per person. */
export function LinksBanner(props: { links: Links; onDismiss(): void }) {
  return (
    <Banner
      tone="info"
      title={props.links.length === 1 ? `${props.links[0]!.name}'s link — shown once` : `${props.links.length} links — shown once`}
      body={
        <span class="project-links">
          <For each={props.links}>
            {(l) => (
              <span class="project-link-row">
                <Show when={props.links.length > 1}>
                  <span class="project-link-name">{l.name}</span>
                </Show>
                <span class="orgs-mono orgs-link">{l.link}</span>
                <CopyButton label={`Copy ${l.name}'s Link`} text={() => l.link} onCopy={(t) => copyText(t, "Link copied.")} />
              </span>
            )}
          </For>
        </span>
      }
      action={
        <button type="button" class="button button-sm button-ghost" onClick={() => props.onDismiss()}>
          Done
        </button>
      }
    />
  );
}
