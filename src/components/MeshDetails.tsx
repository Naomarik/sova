import { createSignal, For, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fetchMesh, fetchMeshDetails, putHostLabel } from "../lib/api";
import { isMeshHash, MESH_HREF, SELF_FILTER, setMeshState } from "../lib/mesh";
import { createPoll } from "../lib/poll";
import {
  askHostFilter,
  connectedCount,
  DETAILS_POLL_MS,
  detailRows,
  labelProblem,
  type MeshHostDetails,
  renameRefusal,
  stateWord,
  unavailableText,
} from "../lib/mesh-details";
import { announce, toast } from "../lib/ui-state";
import { Banner, Icon, trapFocus } from "./ui";

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
              <dd>{v}</dd>
            </>
          )}
        </For>
      </dl>
    </section>
  );
}
