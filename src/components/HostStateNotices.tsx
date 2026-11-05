import { createEffect, createSignal, on, Show } from "solid-js";
import { fetchMeshResync } from "../lib/api";
import { hostLabel, peerInfo, readingOf, selfLabel } from "../lib/mesh";
import { behindName, displayWarningWords, sendingOffWords, updateNeededWords } from "../lib/mesh-compat";
import { type MeshResync, resyncView } from "../lib/mesh-resync";
import { MeshResyncSheet } from "./MeshResyncSheet";
import { Banner } from "./ui";

// What a session shows for its host's state (§mesh/compatibility): the notice in place of the
// composer, the warning bar over the chat, and the page in place of a chat that can't open. Styles:
// src/mesh.css.

/** `Resync` for a host whose build is older than this host's, the host menu's confirm sheet behind
    it; nothing for any other host. Read here, so a chat opened straight on a host offers it too. */
export function HostResyncOffer(props: { host: string }) {
  const [info, setInfo] = createSignal<MeshResync | null>(null);
  const [sheet, setSheet] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  const read = () => void fetchMeshResync().then(setInfo, () => {});
  // Again when the state changes: a resync that landed takes the offer away with the notice.
  createEffect(on(() => `${props.host}\n${readingOf(props.host)}`, read));
  const offer = () => {
    const r = info();
    return r ? resyncView(r.hosts.find((h) => h.id === props.host), r.self).button : null;
  };
  return (
    <>
      <Show when={offer()}>
        {(b) => (
          <button
            ref={button}
            type="button"
            class="button button-sm"
            aria-label={`Resync ${hostLabel(props.host)}`}
            aria-disabled={b().reason ? "true" : undefined}
            title={b().reason ?? `Bring ${hostLabel(props.host)} up to this host's build`}
            onClick={() => !b().reason && setSheet(true)}
          >
            Resync
          </button>
        )}
      </Show>
      <Show when={sheet() ? info() : null}>
        {(r) => (
          <MeshResyncSheet
            hostId={props.host}
            info={r()}
            onChanged={setInfo}
            onClose={() => {
              setSheet(false);
              read();
              button?.focus();
            }}
          />
        )}
      </Show>
    </>
  );
}

const behind = (host: string, r: "read-only" | "display"): string | null => {
  const p = peerInfo(host);
  return p ? behindName(r, p, { self: selfLabel(), peer: hostLabel(host) }) : null;
};

/** In a chat's composer's place on a host that can't take sends from this page: Stop goes with it. */
export function HostSendNotice(props: { host: string; reading: "read-only" | "display" }) {
  const words = () => sendingOffWords(hostLabel(props.host), behind(props.host, props.reading));
  return (
    <div class="host-send-notice" data-testid="host-send-notice" data-host-state={props.reading}>
      <Banner tone="warn" title={words().title} body={words().body} action={<HostResyncOffer host={props.host} />} />
    </div>
  );
}

/** Over a chat on a host in Display may be wrong. */
export function HostDisplayBar(props: { host: string }) {
  const words = () => displayWarningWords(behind(props.host, "display"));
  return (
    <div class="host-display-bar" data-testid="host-display-bar">
      <Banner tone="warn" title={words().title} body={words().body} action={<HostResyncOffer host={props.host} />} />
    </div>
  );
}

/** In a session's place on a host in Update needed: a whole page, or one workspace pane's body. */
export function HostUpdatePage(props: { host: string }) {
  const words = () => updateNeededWords(hostLabel(props.host));
  return (
    <div class="center-fill" data-testid="host-update-page">
      <div class="empty">
        <p class="empty-title">{words().title}</p>
        <p class="empty-body">{words().body}</p>
        <a class="button empty-action" href="#/mesh">
          See Hosts
        </a>
      </div>
    </div>
  );
}
