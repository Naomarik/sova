import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import type { SessionSummary } from "../../shared/protocol";
import { ApiError, createSession, listCwds } from "../lib/api";
import { tildePath } from "../lib/format";
import { home } from "../lib/ui-state";
import { FolderPicker } from "./FolderPicker";
import { Banner, Icon, trapFocus } from "./ui";

const MAX_RECENT = 20;

/**
 * Asks for a folder, creates an empty webapp-owned session, and hands it back (DESIGN_NOTES §5).
 * The folder is chosen, never typed: the Folder field opens the folder picker in place.
 */
export function NewSessionDialog(props: {
  prefill: string;
  /** Folders already used by sessions; the suggestions if /api/cwds is unavailable. */
  knownCwds: string[];
  onCreated(s: SessionSummary): void;
  onCancel(): void;
}) {
  const [cwds] = createResource(() => listCwds().catch(() => props.knownCwds));
  const [cwd, setCwd] = createSignal(props.prefill);
  const [picking, setPicking] = createSignal(false);
  const [fieldError, setFieldError] = createSignal<string | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  let field!: HTMLButtonElement;
  let form!: HTMLFormElement;
  onMount(() => field.focus());

  const recent = createMemo(() => (cwds() ?? []).slice(0, MAX_RECENT));
  const pick = (path: string) => {
    setCwd(path);
    setFieldError(null);
  };

  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (pending()) return;
    const value = cwd().trim();
    if (!value) return;
    setPending(true);
    setFieldError(null);
    setFailed(false);
    try {
      props.onCreated(await createSession(value));
    } catch (err) {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        setFieldError(err.message || "That folder doesn't exist. Pick one that does.");
        setPicking(false);
        field.focus();
      } else {
        setFailed(true);
      }
      setPending(false);
    }
  };

  const cancel = () => !pending() && props.onCancel();

  return (
    <>
      <div class="scrim" onClick={cancel} />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ns-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") cancel();
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="ns-title">
            New Session
          </h2>
        </div>
        <form class="modal-body" id="ns-form" ref={form} onSubmit={submit}>
          <Show when={failed()}>
            <Banner tone="error" title="Couldn't create the session." body="Nothing was written. Try again." />
          </Show>
          <div class="field">
            <label class="field-label" for="ns-cwd">
              Folder
            </label>
            <button
              ref={field}
              type="button"
              class="input input-mono folder-field"
              id="ns-cwd"
              title={cwd() || undefined}
              aria-expanded={picking() ? "true" : "false"}
              aria-controls="ns-picker"
              aria-invalid={fieldError() ? "true" : undefined}
              aria-describedby="ns-cwd-hint ns-cwd-error"
              onClick={() => setPicking((v) => !v)}
            >
              <span class="folder-field-value truncate" classList={{ "folder-field-empty": !cwd() }}>
                {cwd() ? tildePath(cwd(), home()) : "Choose a folder"}
              </span>
              <Icon name="chevron-down" small class="icon-twist" />
            </button>
            <span class="field-hint" id="ns-cwd-hint">
              pi runs in this folder and can read and change files in it.
            </span>
            <span class="field-error" id="ns-cwd-error">
              {fieldError()}
            </span>
          </div>
          <Show when={picking()}>
            <FolderPicker start={cwd()} recents={recent()} onPick={pick} onClose={() => setPicking(false)} />
          </Show>
          <Show when={!picking() && recent().length > 0}>
            <div class="field">
              <span class="field-label" id="ns-recent">
                Recent folders
              </span>
              <ul class="list folder-list" role="listbox" aria-labelledby="ns-recent">
                <For each={recent()}>
                  {(c) => (
                    <li
                      class="list-row list-row-interactive"
                      role="option"
                      tabindex="0"
                      title={c}
                      aria-selected={c === cwd().trim() ? "true" : "false"}
                      onClick={() => pick(c)}
                      onDblClick={() => {
                        pick(c);
                        form.requestSubmit();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          pick(c);
                        }
                      }}
                    >
                      <Icon name="folder" small />
                      <span class="list-title truncate">{tildePath(c, home())}</span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
        </form>
        <div class="modal-foot">
          <button
            type="submit"
            form="ns-form"
            class="button button-primary"
            aria-disabled={pending() || !cwd().trim() ? "true" : undefined}
          >
            {pending() ? "Creating…" : "Create Session"}
          </button>
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={cancel}>
            Cancel
          </button>
        </div>
      </div>
    </>
  );
}
