import { createSignal, For, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { McpServerRow } from "../../shared/mcp";
import { addMcpServer, editMcpServer } from "../lib/api";
import { ADD_WAYS, type AddFields, type AddWay, canSend, editedServer, nameTaken, newServer, pastedName, SECRET_HINT } from "../lib/mcp";
import { SECRET_NAME_RULE, SERVER_NAME_RULE } from "../../shared/mcp-limits";
import { TextArea, TextField } from "./form";
import { McpRow } from "./McpServerRow";
import { trapFocus } from "./ui";
import { sentence } from "./WorkerSlotRow";

/**
 * Add Server and Edit (§app.mcp/add-server): an address, a command, or an entry pasted from another
 * tool. Sending saves it, counts as approving it and runs a Check, and the dialog then shows the
 * result on the new row. Edit has no Paste tab: its name is fixed and what it changes is the entry.
 */
export function McpServerDialog(props: { editing?: McpServerRow; taken?: readonly string[]; onClose: () => void; onChanged: () => void }) {
  const e = props.editing;
  const [way, setWay] = createSignal<AddWay>(e?.kind ?? "address");
  const [name, setName] = createSignal(e?.name ?? "");
  const [fields, setFields] = createSignal<AddFields>({ address: e?.edit?.address ?? "", command: e?.edit?.command ?? "", paste: "", secret: "", secretName: e?.edit?.secretName ?? "" });
  const [nameError, setNameError] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  /** The row it made: the dialog's result. */
  const [result, setResult] = createSignal<McpServerRow | null>(null);
  const set = (k: keyof AddFields, v: string) => setFields({ ...fields(), [k]: v });
  const ways = () => (e ? ADD_WAYS.filter((w) => w.id !== "paste") : ADD_WAYS);
  const ready = () => canSend(way(), fields(), e ? null : name(), props.taken ?? []);
  /** Why the Name can't be sent beyond its rule (reserved): taken, or what the server last said. */
  const nameProblem = () => nameError() ?? (e ? null : nameTaken(name(), props.taken ?? []));
  const title = e ? `Edit ${e.name}` : "Add Server";
  const send = async () => {
    if (!ready() || sending()) return;
    setError(null);
    setSending(true);
    try {
      const w = way();
      const row = e && w !== "paste" ? await editMcpServer(e.id, editedServer(w, fields())) : await addMcpServer(newServer(w, name(), fields()));
      setResult(row);
      props.onChanged();
    } catch (err) {
      const code = (err as { body?: { code?: string } }).body?.code;
      const text = sentence(err instanceof Error ? err.message : String(err));
      if (code === "reserved" || code === "exists") setNameError(text);
      else setError(text);
    } finally {
      setSending(false);
    }
  };
  return (
    <Portal>
      <div class="scrim mcp-scrim" onClick={() => props.onClose()} />
      <div
        class="modal mcp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-add-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(ev) => {
          if (ev.key === "Escape") {
            ev.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="mcp-add-title">
            {title}
          </h2>
        </div>
        <Show
          when={result()}
          fallback={
            <form
              class="mcp-form"
              onSubmit={(ev) => {
                ev.preventDefault();
                void send();
              }}
            >
              <div class="modal-body stack">
                <div class="tabs" role="tablist" aria-label="How to add it">
                  <For each={ways()}>
                    {(w) => (
                      <button type="button" role="tab" class={way() === w.id ? "tab tab-active" : "tab"} aria-selected={way() === w.id ? "true" : "false"} onClick={() => setWay(w.id)}>
                        {w.label}
                      </button>
                    )}
                  </For>
                </div>
                <Show when={!e}>
                  <TextField
                    id="mcp-name"
                    label="Name"
                    rule={SERVER_NAME_RULE}
                    error={nameProblem()}
                    value={name()}
                    autocomplete="off"
                    onInput={(raw) => (setName(raw), setNameError(null))}
                  />
                </Show>
                <Show when={way() === "address"}>
                  <TextField label="Address" inputClass="input-mono" value={fields().address} autocomplete="off" spellcheck={false} onInput={(raw) => set("address", raw)} />
                </Show>
                <Show when={way() === "command"}>
                  <TextField label="Command" inputClass="input-mono" value={fields().command} autocomplete="off" spellcheck={false} onInput={(raw) => set("command", raw)} />
                </Show>
                <Show when={way() === "paste"}>
                  <TextArea
                    label="Paste from Another Tool"
                    inputClass="input-mono"
                    rows={6}
                    spellcheck={false}
                    value={fields().paste}
                    onInput={(text) => {
                      set("paste", text);
                      const named = pastedName(text);
                      if (named && !name().trim()) setName(named);
                    }}
                  />
                </Show>
                <Show when={way() !== "paste"}>
                  <Show when={way() === "command"}>
                    <TextField id="mcp-secret-name" label="Secret's Name" rule={SECRET_NAME_RULE} inputClass="input-mono" value={fields().secretName} autocomplete="off" spellcheck={false} onInput={(raw) => set("secretName", raw)} />
                  </Show>
                  <TextField id="mcp-secret" label="Secret" hint={SECRET_HINT} inputClass="input-mono" type="password" value={fields().secret} autocomplete="off" onInput={(raw) => set("secret", raw)} />
                </Show>
                <Show when={error()}>{(t) => <p class="field-error">{t()}</p>}</Show>
              </div>
              <div class="modal-foot">
                <button type="button" class="button button-ghost" onClick={() => props.onClose()}>
                  Cancel
                </button>
                <button type="submit" class="button button-primary" aria-busy={sending() ? "true" : undefined} disabled={!ready() || sending()}>
                  {e ? "Save and Check" : "Add and Check"}
                </button>
              </div>
            </form>
          }
        >
          {(row) => (
            <>
              <div class="modal-body">
                <ul class="mcp-rows">
                  <McpRow
                    row={row()}
                    open
                    onRemoved={() => {
                      props.onChanged();
                      props.onClose();
                    }}
                    onChange={(next) => {
                      setResult(next);
                      props.onChanged();
                    }}
                  />
                </ul>
              </div>
              <div class="modal-foot">
                {/* The form that held focus is gone: focus moves here, so Escape and Tab stay in the dialog. */}
                <button type="button" class="button button-primary" ref={(el) => queueMicrotask(() => el.focus())} onClick={() => props.onClose()}>
                  Close
                </button>
              </div>
            </>
          )}
        </Show>
      </div>
    </Portal>
  );
}
