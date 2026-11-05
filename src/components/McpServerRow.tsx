import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { McpServerRow, McpSignIn } from "../../shared/mcp";
import { ApiError, approveMcpServer, cancelMcpSignIn, checkMcpServer, finishMcpSignIn, readMcpSignIn, removeMcpSecret, removeMcpServer, saveMcpSecret, startMcpSignIn, switchMcpServer } from "../lib/api";
import {
  APPROVE_CHANGED,
  checkFailedLine,
  errorLineText,
  NO_CHECK,
  NO_ERRORS,
  refusedLines,
  removeQuestion,
  replacedLine,
  rowFacts,
  SECRET_SAVED,
  secretNeeded,
  SIGN_IN_BODY,
  signInTitle,
  stateTone,
  stateWord,
  UNPINNED,
  WAITING_CHANGED,
  WAITING_LEAD,
} from "../lib/mcp";
import { clearWantedMcpRow, wantedMcpRow } from "../lib/mcp-link";
import { Chip, Icon, trapFocus } from "./ui";
import { TextField, Toggle } from "./form";
import { sentence } from "./WorkerSlotRow";
import "./McpServers.css";

const errText = (err: unknown) => sentence(err instanceof Error ? err.message : String(err));

/** The saved-secret line of a row, or its field while there is none or it is being replaced. */
function SecretField(props: { rowId: string; name: string; saved: boolean; busy: boolean; act: (fn: () => Promise<McpServerRow>) => Promise<void> }) {
  const [replacing, setReplacing] = createSignal(false);
  const [value, setValue] = createSignal("");
  const save = async () => {
    if (!value()) return;
    await props.act(() => saveMcpSecret(props.rowId, props.name, value()));
    setValue("");
    setReplacing(false);
  };
  return (
    <div class="mcp-secret">
      <span class="text-mono mcp-secret-name">{props.name}</span>
      <Show
        when={!props.saved || replacing()}
        fallback={
          <>
            <span class="field-hint">{SECRET_SAVED}</span>
            <span class="button-row">
              <button type="button" class="button button-sm" aria-label={`Replace ${props.name}`} disabled={props.busy} onClick={() => setReplacing(true)}>
                Replace
              </button>
              <button type="button" class="button button-sm button-destructive" aria-label={`Remove ${props.name}`} disabled={props.busy} onClick={() => void props.act(() => removeMcpSecret(props.rowId, props.name))}>
                Remove
              </button>
            </span>
          </>
        }
      >
        <Show when={!props.saved}>
          <span class="field-hint">{secretNeeded(props.name)}</span>
        </Show>
        <form
          class="mcp-secret-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <TextField hideLabel label={`Value of ${props.name}`} inputClass="input-mono" type="password" autocomplete="off" value={value()} onInput={setValue} />
          <button type="submit" class="button button-sm" disabled={props.busy || !value()}>
            Save Secret
          </button>
          <Show when={replacing()}>
            <button type="button" class="button button-sm button-ghost" onClick={() => setReplacing(false)}>
              Cancel
            </button>
          </Show>
        </form>
      </Show>
    </div>
  );
}

const SIGN_IN_POLL_MS = 1500;

/**
 * Sign In (§app.mcp/sign-in): the service's page in a new tab. On this computer the sign-in finishes
 * by itself, which the dialog sees by polling; from anywhere else the person pastes the address the
 * page ended on. Closing it cancels a sign-in still waiting.
 */
function SignInDialog(props: { row: McpServerRow; onClose: () => void; onDone: (row: McpServerRow) => void }) {
  const [flow, setFlow] = createSignal<McpSignIn | null>(null);
  const [address, setAddress] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const url = () => {
    const f = flow();
    return f?.state === "waiting" ? f.url : null;
  };
  const take = (next: McpSignIn) => {
    if (closed) return;
    setFlow(next);
    if (next.state === "done") {
      closed = true;
      props.onDone(next.row);
    } else if (next.state === "failed") setError(sentence(next.error));
    else if (next.state === "waiting") setError(null);
    if (next.state === "starting" || next.state === "waiting") {
      clearTimeout(timer);
      timer = setTimeout(() => void readMcpSignIn(props.row.id).then(take, () => take(next)), SIGN_IN_POLL_MS);
    }
  };
  const open = async () => {
    const known = url();
    if (known) return void window.open(known, "_blank", "noopener,noreferrer");
    // Opened inside the press, or the browser blocks it; the address comes after the request.
    const tab = window.open("about:blank", "_blank");
    setError(null);
    setFlow({ state: "starting" });
    try {
      const next = await startMcpSignIn(props.row.id);
      if (next.state === "waiting" && tab) {
        tab.opener = null;
        tab.location.href = next.url;
      } else tab?.close();
      take(next);
    } catch (err) {
      tab?.close();
      setFlow(null);
      setError(errText(err));
    }
  };
  const finish = async () => {
    const a = address().trim();
    if (!a) return;
    setSending(true);
    try {
      take(await finishMcpSignIn(props.row.id, a));
    } catch (err) {
      setError(errText(err));
    } finally {
      setSending(false);
    }
  };
  const cancel = () => props.onClose();
  onCleanup(() => {
    clearTimeout(timer);
    const f = flow();
    if (!closed && (f?.state === "waiting" || f?.state === "starting")) void cancelMcpSignIn(props.row.id).catch(() => {});
    closed = true;
  });
  return (
    <Portal>
      <div class="scrim mcp-scrim" onClick={cancel} />
      <div
        class="modal mcp-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mcp-sign-in-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            cancel();
          }
        }}
      >
        <div class="modal-head">
          <h2 class="modal-title" id="mcp-sign-in-title">
            {signInTitle(props.row.name)}
          </h2>
        </div>
        <div class="modal-body stack">
          <p class="mcp-line">{SIGN_IN_BODY}</p>
          <TextField label="Address from the browser" inputClass="input-mono" error={error()} value={address()} autocomplete="off" spellcheck={false} disabled={!url() || sending()} onInput={setAddress} />
        </div>
        <div class="modal-foot">
          <button type="button" class="button button-ghost" onClick={cancel}>
            Cancel
          </button>
          <button type="button" class={url() ? "button" : "button button-primary"} aria-busy={flow()?.state === "starting" ? "true" : undefined} disabled={flow()?.state === "starting"} onClick={() => void open()}>
            Open Sign-in Page
          </button>
          <Show when={url()}>
            <button type="button" class="button button-primary" disabled={!address().trim() || sending()} onClick={() => void finish()}>
              {sending() ? "Signing In…" : "Finish Sign-In"}
            </button>
          </Show>
        </div>
      </div>
    </Portal>
  );
}

/**
 * One server (§app.mcp/rows): its name, kind, tool count and one state, and its New Chats switch; open,
 * what it runs, its tools with their switches, its secrets and last error lines, and what can be done
 * to it. Every action applies at once and answers the row. A project's row has no Edit or Remove.
 */
export function McpRow(props: {
  row: McpServerRow;
  onChange: (row: McpServerRow) => void;
  /** computer rows */
  onEdit?: (row: McpServerRow) => void;
  onRemoved?: () => void;
  /** Open from the start: the row Add and Check just made. */
  open?: boolean;
}) {
  const [open, setOpen] = createSignal(!!props.open);
  const [busy, setBusy] = createSignal(false);
  const [checking, setChecking] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [confirm, setConfirm] = createSignal(false);
  const [signingIn, setSigningIn] = createSignal(false);
  let li!: HTMLLIElement;
  const r = () => props.row;
  const refused = () => !!r().refused;
  const waiting = () => r().state === "waiting";

  // A chat's note asked for this row.
  createEffect(() => {
    if (wantedMcpRow() !== r().id) return;
    clearWantedMcpRow();
    setOpen(true);
    queueMicrotask(() => li.scrollIntoView({ block: "center" }));
  });

  const act = async (fn: () => Promise<McpServerRow>) => {
    setBusy(true);
    setError(null);
    try {
      props.onChange(await fn());
    } catch (err) {
      if (err instanceof ApiError && (err.body as { code?: string } | undefined)?.code === "changed") {
        setError(APPROVE_CHANGED);
        const row = (err.body as { row?: McpServerRow }).row;
        if (row) props.onChange(row);
      } else setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  const check = async () => {
    setChecking(true);
    await act(() => checkMcpServer(r().id));
    setChecking(false);
  };
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await removeMcpServer(r().id);
      props.onRemoved?.();
    } catch (err) {
      setError(errText(err));
      setBusy(false);
    }
  };
  const checkLabel = () => (checking() || r().checking ? "Checking…" : "Check Again");

  return (
    <li class="mcp-row" data-mcp-row={r().name} ref={li}>
      <div class="mcp-row-head">
        <button type="button" class="mcp-row-open" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <Icon name="chevron-right" small class={open() ? "icon-twist mcp-twist-open" : "icon-twist"} />
          <span class="mcp-row-title">
            <span class="mcp-row-name">{r().name}</span>
            <span class="mcp-row-facts">{rowFacts(r())}</span>
          </span>
        </button>
        <Chip tone={stateTone(r().state)}>{stateWord(r().state)}</Chip>
        <Show when={r().refused?.why !== "reserved"}>
          <Toggle
            switch
            class="mcp-switch"
            label={<>New Chats<span class="visually-hidden">: {r().name}</span></>}
            checked={r().newChats}
            disabled={busy()}
            onChange={(newChats) => void act(() => switchMcpServer(r().id, { newChats }))}
          />
        </Show>
      </div>
      <For each={refusedLines(r().refused)}>{(l) => <p class="field-error mcp-note">{l}</p>}</For>
      <For each={r().replacedIn ?? []}>{(x) => <p class="field-hint mcp-note">{replacedLine(x, x.name)}</p>}</For>
      <Show when={error() && !open()}>
        <p class="field-error mcp-note">{error()}</p>
      </Show>
      <Show when={open()}>
        <div class="mcp-row-body">
          <Show when={waiting() && !refused()}>
            <div class="mcp-group">
              <p class="mcp-line">{r().changed ? WAITING_CHANGED : WAITING_LEAD}</p>
              <dl class="mcp-runs">
                <Show when={r().entry.runs}>
                  {(x) => (
                    <div>
                      <dt>Runs</dt>
                      <dd class="text-mono">{x()}</dd>
                    </div>
                  )}
                </Show>
                <Show when={r().entry.address}>
                  {(x) => (
                    <div>
                      <dt>Address</dt>
                      <dd class="text-mono">{x()}</dd>
                    </div>
                  )}
                </Show>
                <Show when={r().entry.values.length}>
                  <div>
                    <dt>Values</dt>
                    <dd class="text-mono">{r().entry.values.join(", ")}</dd>
                  </div>
                </Show>
                <Show when={r().entry.secrets.length}>
                  <div>
                    <dt>Secrets</dt>
                    <dd class="text-mono">{r().entry.secrets.join(", ")}</dd>
                  </div>
                </Show>
              </dl>
              <Show when={r().entry.unpinned}>
                <p class="mcp-line">{UNPINNED}</p>
              </Show>
              <span class="button-row">
                <button type="button" class="button button-sm button-primary" aria-label={`Approve ${r().name}`} disabled={busy()} onClick={() => void act(() => approveMcpServer(r().id, r().entry.version))}>
                  Approve
                </button>
              </span>
            </div>
          </Show>
          <Show when={r().state === "no-check"}>
            <p class="mcp-line">{NO_CHECK}</p>
          </Show>
          <Show when={r().tools.length}>
            <div class="mcp-group">
              <h4 class="mcp-heading">Tools</h4>
              <ul class="mcp-tools">
                <For each={r().tools}>
                  {(t) => (
                    <li class="mcp-tool">
                      <span class="mcp-tool-text">
                        <span class="text-mono">{t.name}</span>
                        <Show when={t.description}>
                          <span class="field-hint">{t.description}</span>
                        </Show>
                      </span>
                      <Toggle switch label={<span class="visually-hidden">Use {t.name}</span>} checked={t.on} disabled={busy()} onChange={(on) => void act(() => switchMcpServer(r().id, { tool: t.name, on }))} />
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
          <Show when={r().secrets.length}>
            <div class="mcp-group">
              <h4 class="mcp-heading">Secrets</h4>
              <For each={r().secrets}>{(s) => <SecretField rowId={r().id} name={s.name} saved={s.saved} busy={busy()} act={act} />}</For>
            </div>
          </Show>
          <Show when={!waiting() && !refused()}>
            <div class="mcp-group">
              <h4 class="mcp-heading">Last Error Lines</h4>
              <Show when={r().state === "failed"}>
                <p class="mcp-line">{checkFailedLine(r().name)}</p>
              </Show>
              <Show when={r().errors.length} fallback={<p class="mcp-line">{NO_ERRORS}</p>}>
                <ul class="mcp-errors">
                  <For each={r().errors}>{(e) => <li class="text-mono">{errorLineText(e)}</li>}</For>
                </ul>
              </Show>
            </div>
          </Show>
          <Show when={error()}>
            <p class="field-error">{error()}</p>
          </Show>
          <div class="button-row mcp-actions">
            <Show when={!waiting() && !refused()}>
              <button type="button" class="button button-sm" aria-busy={checking() || r().checking ? "true" : undefined} disabled={busy() || r().checking} onClick={() => void check()}>
                {checkLabel()}
              </button>
              <Show when={r().signsIn}>
                <button type="button" class="button button-sm" disabled={busy()} onClick={() => setSigningIn(true)}>
                  Sign In
                </button>
              </Show>
            </Show>
            <Show when={r().source === "computer"}>
              <Show when={props.onEdit && r().refused?.why !== "reserved"}>
                <button type="button" class="button button-sm" disabled={busy()} onClick={() => props.onEdit?.(r())}>
                  Edit
                </button>
              </Show>
              <button type="button" class="button button-sm button-destructive" aria-expanded={confirm()} disabled={busy()} onClick={() => setConfirm(true)}>
                Remove
              </button>
            </Show>
          </div>
          <Show when={confirm()}>
            <div class="mcp-confirm" role="group" aria-label={`Remove ${r().name}`}>
              <p class="mcp-line">{removeQuestion(r().name)}</p>
              <span class="button-row">
                <button type="button" class="button button-sm button-destructive" disabled={busy()} onClick={() => void remove()}>
                  Remove
                </button>
                <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(false)}>
                  Keep
                </button>
              </span>
            </div>
          </Show>
        </div>
      </Show>
      <Show when={signingIn()}>
        <SignInDialog
          row={r()}
          onClose={() => setSigningIn(false)}
          onDone={(row) => {
            setSigningIn(false);
            props.onChange(row);
          }}
        />
      </Show>
    </li>
  );
}
