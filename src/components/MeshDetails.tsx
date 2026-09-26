import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fetchMesh, fetchMeshDetails, putHostBrowserAccess, putHostLabel } from "../lib/api";
import { isMeshHash, MESH_HREF, SELF_FILTER, setMeshState } from "../lib/mesh";
import { createPoll } from "../lib/poll";
import {
  askHostFilter,
  browserAccessRefusal,
  connectedCount,
  DETAILS_POLL_MS,
  detailRows,
  labelProblem,
  type MeshHostDetails,
  renameRefusal,
  stateWord,
  unavailableText,
} from "../lib/mesh-details";
import { announce, copyText, toast } from "../lib/ui-state";
import { Banner, CopyButton, Icon, trapFocus } from "./ui";

// Styles: src/mesh.css (see MeshHostMenu.tsx for why they are not imported here).

/**
 * Mesh details: one section per host, this one first, from GET /api/mesh/details. Polls every
 * 5 s while open (backing off after failures, paused in a hidden tab) and not at all otherwise
 * (it exists only while open). Pairing, sync and the
 * front door stay on #/mesh; this is what each host says about itself, plus a rename.
 */
export function MeshDetails(props: { onClose(): void }) {
  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), DETAILS_POLL_MS);
  onCleanup(() => clearInterval(clock));
  // Each answer is reconciled into the last by host id, so a host's section (and a rename typed
  // into it) survives every refresh; a failed refresh keeps the last good answer on screen.
  const poll = createPoll(() => fetchMeshDetails(), DETAILS_POLL_MS);
  const hosts = (): MeshHostDetails[] => poll.data()?.hosts ?? [];
  const ownProtocol = () => hosts().find((h) => h.self)?.details?.versions.protocol;
  const count = () => connectedCount(hosts().filter((h) => !h.self).map((h) => ({ state: h.state === "self" ? "up" : h.state })));

  const close = () => props.onClose();

  return (
    <Portal>
      <div class="scrim" onClick={close} />
      <div
        class="modal mesh-details"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mesh-details-title"
        tabindex="-1"
        ref={(el) => {
          trapFocus(el);
          queueMicrotask(() => el.focus());
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !(e.target instanceof HTMLInputElement)) close();
        }}
      >
        <div class="modal-head mesh-card-head">
          <h2 class="modal-title" id="mesh-details-title">
            Mesh details
          </h2>
          <Show when={hosts().length}>
            <span class="text-caption text-muted">
              {count().up}/{count().total} connected
            </span>
          </Show>
        </div>
        <div class="modal-body">
          <Show when={poll.error()}>
            {(message) => <Banner tone="error" title="Couldn't read the mesh details." body={`${message()}. We'll try again in a few seconds.`} />}
          </Show>
          <Show when={poll.pending()}>
            <p class="text-caption text-muted">Asking every host…</p>
          </Show>
          <For each={hosts()}>{(h) => <HostSection host={h} ownProtocol={ownProtocol()} now={now()} onRenamed={() => poll.refetch()} onClose={close} />}</For>
        </div>
        <div class="modal-foot">
          <a
            class="mesh-link"
            href={MESH_HREF}
            onClick={() => {
              close();
            }}
          >
            Pairing, sync and the front door
          </a>
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}

/** A browser address: a link that opens it in a new tab, and an icon-only copy button beside it. */
export function AddressLink(props: { url: string; name?: string }) {
  return (
    <span class="mesh-address-link">
      <a class="text-mono" href={props.url} target="_blank" rel="noopener">
        {props.url}
      </a>
      <CopyButton
        iconOnly
        label={props.name ? `Copy Address of ${props.name}` : "Copy Address"}
        title="Copy address"
        text={() => props.url}
        onCopy={(t) => copyText(t, "Address copied.")}
      />
    </span>
  );
}

function HostSection(props: { host: MeshHostDetails; ownProtocol: string | undefined; now: number; onRenamed(): void; onClose(): void }) {
  const h = () => props.host;
  const d = () => props.host.details;
  const up = () => h().state === "up" || h().state === "self";
  const [naming, setNaming] = createSignal(false);
  const [name, setName] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const titleId = () => `mesh-details-host-${h().id}`;
  let renameButton: HTMLButtonElement | undefined;
  /** Leave the name field; focus goes back to Rename, never to the page behind the dialog. */
  const stopNaming = () => {
    setNaming(false);
    queueMicrotask(() => renameButton?.focus());
  };

  const startRename = () => {
    setName(h().label);
    setError(null);
    setNaming(true);
  };
  const save = async () => {
    if (saving()) return;
    const problem = labelProblem(name());
    if (problem) return setError(problem);
    if (name().trim() === h().label) return stopNaming();
    setSaving(true);
    setError(null);
    try {
      const res = await putHostLabel(h().id, name().trim());
      stopNaming();
      const missed = res.told.filter((t) => !t.ok).length;
      const done = `Renamed to ${res.label}.${missed ? ` ${missed} ${missed === 1 ? "host" : "hosts"} will hear it when back.` : ""}`;
      toast(done);
      announce(done);
      props.onRenamed();
      void fetchMesh().then(setMeshState, () => {});
    } catch (err) {
      setError((err as Error).message);
    }
    setSaving(false);
  };
  const openThrough = () => {
    askHostFilter(h().self ? SELF_FILTER : h().id);
    props.onClose();
    if (isMeshHash(location.hash)) location.hash = "#/";
  };

  const rows = () => detailRows(h(), props.ownProtocol, props.now);

  // Browser access: the host's own setting. The switch shows the saved answer until the next refresh.
  const [browserSaving, setBrowserSaving] = createSignal(false);
  const [browserError, setBrowserError] = createSignal<string | null>(null);
  const browserRefusal = () => browserAccessRefusal(h());
  const setBrowser = async (on: boolean): Promise<boolean> => {
    if (browserSaving()) return false;
    setBrowserSaving(true);
    setBrowserError(null);
    try {
      const res = await putHostBrowserAccess(h().id, on);
      const missed = res.told.filter((t) => !t.ok).length;
      const done = `${on ? `${h().label} has a browser address.` : `${h().label} has no browser address. Every front door leaves it out.`}${missed ? ` ${missed} ${missed === 1 ? "host" : "hosts"} will hear it when back.` : ""}`;
      toast(done);
      announce(done);
      props.onRenamed();
      return true;
    } catch (err) {
      setBrowserError((err as Error).message);
      return false;
    } finally {
      setBrowserSaving(false);
    }
  };

  return (
    <section class="mesh-details-host" aria-labelledby={titleId()}>
      <div class="mesh-details-host-head">
        <h3 class="mesh-details-host-title" id={titleId()}>
          <span class="chip-dot" classList={{ "host-filter-up": up(), "host-filter-down": !up() }} />
          <span class="mesh-details-host-name">{h().label}</span>
          <span class="mesh-details-host-state">{stateWord(h())}</span>
        </h3>
        <Show when={!naming()}>
          <div class="mesh-details-actions">
            <Show when={!renameRefusal(h())}>
              <button type="button" class="button button-sm button-ghost" aria-label={`Rename ${h().label}`} ref={renameButton} onClick={startRename}>
                <Icon name="pencil" small />
                Rename
              </button>
            </Show>
            <Show when={!h().self}>
              <Show
                when={h().open.kind === "direct" ? (h().open as { url: string }).url : null}
                fallback={
                  <button type="button" class="button button-sm button-ghost" onClick={openThrough}>
                    Open Through This Host
                  </button>
                }
              >
                {(url) => (
                  <a class="button button-sm button-ghost" href={url()} target="_blank" rel="noopener">
                    <Icon name="external" small />
                    Open Directly
                  </a>
                )}
              </Show>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={naming()}>
        <form
          class="mesh-details-rename"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div class="field">
            <label class="field-label" for={`${titleId()}-name`}>
              {h().self ? "This host's name" : `${h().label}'s name`}
            </label>
            <input
              id={`${titleId()}-name`}
              class="input"
              maxlength={80}
              value={name()}
              aria-invalid={error() ? "true" : undefined}
              ref={(el) => queueMicrotask(() => el.select())}
              onInput={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  stopNaming();
                }
              }}
            />
            <span class="field-hint">Every host shows this name. Its id, {h().id}, stays.</span>
            <Show when={error()}>
              <span class="field-error">{error()}</span>
            </Show>
          </div>
          <div class="button-row">
            <button type="submit" class="button button-primary button-sm" aria-disabled={saving() ? "true" : undefined}>
              {saving() ? "Saving…" : "Save Name"}
            </button>
            <button type="button" class="button button-ghost button-sm" onClick={stopNaming}>
              Cancel
            </button>
          </div>
        </form>
      </Show>
      {/* One note per host: why it has no details says why it can't be renamed too. */}
      <Show when={!h().unavailable && renameRefusal(h())}>{(why) => <p class="text-caption text-muted">{why()}</p>}</Show>
      <Show when={unavailableText(h())}>{(why) => <p class="mesh-host-warn">{why()}</p>}</Show>
      <dl class="mesh-details-list">
        <For each={rows()}>
          {([k, v]) => (
            <>
              <dt>{k}</dt>
              <dd>{typeof v === "string" ? v : <AddressLink url={v.link} name={h().label} />}</dd>
            </>
          )}
        </For>
      </dl>
      <label class="toggle toggle-switch mesh-sync-row mesh-details-browser">
        <input
          type="checkbox"
          checked={h().browserAccess}
          disabled={browserSaving() || !!browserRefusal()}
          aria-describedby={`${titleId()}-browser-hint`}
          onChange={(e) => {
            const el = e.currentTarget;
            const want = el.checked;
            void setBrowser(want).then((ok) => ok || (el.checked = !want));
          }}
        />
        <span class="mesh-sync-main">
          <span class="mesh-sync-name">Browser access</span>
          <span class="mesh-sync-meta" id={`${titleId()}-browser-hint`}>
            {browserRefusal() ?? "Off: it has no address a browser can open, so every front door leaves it out. Nothing opens or closes."}
          </span>
        </span>
        <span class="toggle-box" />
      </label>
      <Show when={browserError()}>{(msg) => <span class="field-error">Not changed: {msg()}</span>}</Show>
    </section>
  );
}
