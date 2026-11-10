import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { DesignAsk, DesignChatView, DesignDelivery } from "../../shared/design";
import type { DesignStore } from "../lib/design-store";
import type { DesignCoordinatorInfo } from "../lib/design-ui";
import { Markdown } from "./Markdown";
import { TextArea, TextField } from "./form";
import { Chip, Icon } from "./ui";

const STATUS_WORD = { starting: "Starting", running: "Working", idle: "Idle", ended: "Stopped" } as const;

export function designKey(): string {
  return `k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** The line that says where a message stands: on its way, or left with you. */
export function DesignDeliveryLine(props: { delivery?: DesignDelivery; name: string }) {
  return (
    <Show when={props.delivery}>
      {(d) => (
        <Show when={d().state === "queued"} fallback={<p class="field-error">{d().error || `That didn't reach ${props.name}. Your text is still in the box.`}</p>}>
          <p class="text-caption text-muted">Queued for {props.name}, after its current work.</p>
        </Show>
      )}
    </Show>
  );
}

/** A message box that keeps your words until they're handed over, under one key, so a retry can't send twice. */
export function DesignMessageBox(props: { placeholder: string; label: string; delivery?: DesignDelivery; name: string; send(text: string, key: string, images?: readonly string[]): Promise<unknown>; onSent?(): void; upload?(file: File): Promise<{ path: string; name: string }> }) {
  const [text, setText] = createSignal("");
  const [images, setImages] = createSignal<{ path: string; name: string }[]>([]);
  const [uploading, setUploading] = createSignal(0);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let key = designKey();
  let field: HTMLTextAreaElement | undefined;
  // Auto-grow fallback where `field-sizing: content` isn't supported, as in the main composer.
  createEffect(
    on(text, () => {
      if (!field || CSS.supports("field-sizing", "content")) return;
      field.style.height = "auto";
      field.style.height = `${field.scrollHeight}px`;
    }),
  );
  const attach = (files: File[]) => {
    setError("");
    setUploading((n) => n + files.length);
    for (const file of files)
      props.upload!(file)
        .then((u) => setImages((list) => [...list, { path: u.path, name: u.name }]))
        .catch((e) => setError(e instanceof Error ? e.message : "That image couldn't be attached."))
        .finally(() => setUploading((n) => n - 1));
  };
  const submit = async () => {
    const body = text().trim();
    if ((!body && images().length === 0) || busy() || uploading() > 0) return;
    setBusy(true);
    setError("");
    try {
      await props.send(body, key, images().map((x) => x.path));
      key = designKey();
      setText("");
      setImages([]);
      props.onSent?.();
    } catch (e) {
      setError(e instanceof Error ? `${e.message} Your text is still in the box.` : "That didn't go through. Your text is still in the box.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="composer-inner design-message-box"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div class="design-box-status">
        <Show when={error() === "" && (images().length > 0 || uploading() > 0)}>
          <p class="text-caption text-muted">
            {uploading() > 0 ? "Attaching your image." : `${images().length} image${images().length === 1 ? "" : "s"} attached. Goes with your next message.`}{" "}
            <button type="button" class="design-box-link" onClick={() => setImages([])}>
              Remove
            </button>
          </p>
        </Show>
        <Show when={error()} fallback={<Show when={images().length === 0 && uploading() === 0}><DesignDeliveryLine delivery={props.delivery} name={props.name} /></Show>}>
          <p class="field-error" role="alert">
            {error()}
          </p>
        </Show>
      </div>
      <div class="composer-row">
        <TextArea
          class="design-message-field"
          inputClass="composer-input"
          label={props.label}
          hideLabel
          rows="1"
          placeholder={props.placeholder}
          value={text()}
          ref={field}
          onInput={setText}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith("image/"));
            if (!files.length || !props.upload) return;
            e.preventDefault();
            attach(files);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div class="composer-actions">
          <button type="submit" class="button button-primary" aria-disabled={busy() || uploading() > 0 || (!text().trim() && images().length === 0) ? "true" : undefined}>
            <Icon name="arrow-right" small />
            <span class="button-label">Send</span>
          </button>
        </div>
      </div>
    </form>
  );
}

export function DesignAskPanel(props: { ask: DesignAsk; store: DesignStore }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [fields, setFields] = createSignal<Record<string, string>>({});
  const answer = async (value: unknown) => {
    setBusy(true);
    setError("");
    try {
      await props.store.api.coordinatorAnswer(props.ask.id, value);
      setFields({});
      props.store.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const words: Record<string, [string, string]> = { site: ["Allow Site", "Don't Allow"], "capture-signed-in": ["Capture Its Images", "Don't Capture"], "start-project": ["Start Copy", "Don't Start"], "stop-project": ["Stop Copy", "Keep Running"], spend: ["Start Designs", "Don't Start"] };
  const secret = (f: string) => f === "password";
  const formFields = () => (props.ask.kind === "sign-in" ? props.ask.fields : props.ask.kind === "test-account" ? ["username", "password"] : null);
  const ready = () => (formFields() ?? []).every((f) => (fields()[f] ?? "").trim() !== "");
  return (
    <div class="design-ask" role="group" aria-label="The coordinator needs your say">
      <p>{props.ask.text}</p>
      <Show when={props.ask.kind === "site" && props.ask.origin}>{(o) => <code>{o()}</code>}</Show>
      <Show
        when={formFields()}
        fallback={
          <div class="button-row">
            <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={() => void answer("no")}>
              {words[props.ask.kind]?.[1] ?? "No"}
            </button>
            <button type="button" class="button button-sm button-primary" disabled={busy()} onClick={() => void answer("yes")}>
              {words[props.ask.kind]?.[0] ?? "Yes"}
            </button>
          </div>
        }
      >
        {(sign) => (
          <form
            class="stack-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (ready()) void answer(fields());
            }}
          >
            <For each={sign()}>
              {(f) => (
                <TextField
                  label={f === "code" ? "One-Time Code" : `${f[0]!.toUpperCase()}${f.slice(1)}`}
                  autocomplete="off"
                  type={secret(f) ? "password" : "text"}
                  value={fields()[f] ?? ""}
                  onInput={(raw) => setFields({ ...fields(), [f]: raw })}
                />
              )}
            </For>
            <p class="field-hint">These go straight to the browser, never to a model or a transcript.</p>
            <button type="submit" class="button button-primary" disabled={busy() || !ready()}>
              Sign In
            </button>
          </form>
        )}
      </Show>
      <Show when={error()}>
        <p class="field-error" role="alert">
          {error()}
        </p>
      </Show>
    </div>
  );
}

/** What the coordinator has concluded and made so far, with a box to prompt it further. */
export function DesignCoordinatorPanel(props: { coordinator: DesignCoordinatorInfo; view: DesignChatView | null; store: DesignStore; onOpen?(): void; bare?: boolean; /** Only its status and its box: during the brief, its words are on the brief and its question lays over it. */ strip?: boolean }) {
  const tracking = () => props.view?.designs.length ?? 0;
  return (
    <div class="design-coordinator" classList={{ "design-coordinator-bare": props.bare }}>
      <div class="design-coordinator-head">
        <strong class="design-coordinator-title" classList={{ "visually-hidden": props.bare }}>
          Coordinator
        </strong>
        <Chip live={props.coordinator.status === "running" || props.coordinator.status === "starting"} tone={props.coordinator.status === "running" ? "accent" : undefined}>
          {tracking() > 0 ? `Tracking ${tracking()} designs` : STATUS_WORD[props.coordinator.status]}
        </Chip>
        <Show when={props.onOpen}>
          <button type="button" class="button button-sm" onClick={() => props.onOpen!()}>
            Open Chat
          </button>
        </Show>
      </div>
      <Show when={!props.strip}>
        <div class="design-coordinator-card" classList={{ "design-coordinator-card-bare": props.bare }}>
          <Show when={props.coordinator.ask}>{(a) => <DesignAskPanel ask={a()} store={props.store} />}</Show>
          <Show when={props.coordinator.card} fallback={<p class="text-muted">Nothing on its card yet. It writes here as it goes.</p>}>
            <Markdown text={props.coordinator.card} />
          </Show>
        </div>
      </Show>
      <Show when={props.bare}>
        <div class="design-box-status">
          <DesignDeliveryLine delivery={props.coordinator.delivery} name="the coordinator" />
        </div>
      </Show>
      <Show when={!props.bare}>
        <DesignMessageBox
          label="Message the coordinator"
          placeholder={props.strip ? "Tell the coordinator what to change" : "Message the coordinator"}
          delivery={props.coordinator.delivery}
          name="the coordinator"
          send={(text, key, images) => props.store.api.coordinatorMessage(text, key, images)}
          upload={props.store.api.uploadImage}
          onSent={() => props.store.refresh()}
        />
      </Show>
    </div>
  );
}
