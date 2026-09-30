import { createResource, createSignal, For, Show } from "solid-js";
import { singletonRunningText, titleCase } from "../../shared/profiles";
import { listCwds, startProfileSession } from "../lib/api";
import { adoptStarted, closeProfileStart, profileStartSheet } from "../lib/profile-start";
import { Banner, trapFocus } from "./ui";

/**
 * "Start {label}" (§app.session-list/profile-shelf): a folder and an optional first message, then a
 * new session with that profile. A One at a time profile that is live answers with the picker's alert.
 */
export function ProfileStartSheet() {
  return (
    <Show when={profileStartSheet()} keyed>
      {(s) => <Sheet profile={s.profile} cwd={s.cwd} />}
    </Show>
  );
}

function Sheet(props: { profile: import("../../shared/profiles").Profile; cwd?: string }) {
  const [cwds] = createResource(() => listCwds().catch(() => [] as string[]));
  const [cwd, setCwd] = createSignal(props.cwd ?? "");
  const [message, setMessage] = createSignal(props.profile.firstMessage ?? "");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [running, setRunning] = createSignal<{ id: string; title: string } | null>(null);
  const folder = () => cwd() || props.cwd || cwds()?.[0] || "";
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!folder()) return setError("Pick a folder.");
    setBusy(true);
    setError(null);
    try {
      const s = await startProfileSession(folder(), props.profile.id, message());
      closeProfileStart();
      adoptStarted(s);
    } catch (err) {
      const body = (err as { body?: { running?: { id: string; title: string } } }).body;
      if (body?.running) setRunning(body.running);
      else setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  const cancel = () => !busy() && closeProfileStart();
  return (
    <>
      <div class="scrim" onClick={cancel} />
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="ps-title" ref={(el) => trapFocus(el)} onKeyDown={(e) => e.key === "Escape" && cancel()}>
        <div class="modal-head">
          <h2 class="modal-title" id="ps-title">
            Start {props.profile.label}
          </h2>
        </div>
        <form class="modal-body" id="ps-form" onSubmit={submit}>
          <Show when={props.profile.description}>
            <p>{props.profile.description}</p>
          </Show>
          <Show when={running()}>
            {(r) => (
              <Banner
                tone="warn"
                title={singletonRunningText(props.profile.label)}
                action={
                  <a class="button button-sm button-primary" href={`#/sid/${encodeURIComponent(r().id)}`} onClick={() => closeProfileStart()}>
                    Open the Running {titleCase(props.profile.label)}
                  </a>
                }
              />
            )}
          </Show>
          <label class="field">
            <span class="field-label">Folder</span>
            <select class="input" value={folder()} onChange={(e) => setCwd(e.currentTarget.value)}>
              <Show when={props.cwd && !(cwds() ?? []).includes(props.cwd)}>
                <option value={props.cwd}>{props.cwd}</option>
              </Show>
              <For each={cwds() ?? []}>{(c) => <option value={c}>{c}</option>}</For>
            </select>
          </label>
          <label class="field">
            <span class="field-label">First message</span>
            <textarea class="input" rows={3} value={message()} onInput={(e) => setMessage(e.currentTarget.value)} />
            <span class="field-hint">Optional. Leave it empty to open the session and wait.</span>
          </label>
          <Show when={error()}>{(m) => <p class="field-error" role="alert">{m()}</p>}</Show>
        </form>
        <div class="modal-foot">
          <button type="button" class="button button-ghost" disabled={busy()} onClick={cancel}>
            Cancel
          </button>
          <button type="submit" form="ps-form" class="button button-primary" disabled={busy() || !!running()}>
            Start Session
          </button>
        </div>
      </div>
    </>
  );
}
