import { createSignal, For, Show } from "solid-js";
import type { DesignAsk, DesignChatView, DesignDelivery } from "../../shared/design";
import type { DesignStore } from "../lib/design-store";
import type { DesignCoordinatorInfo } from "../lib/design-ui";
import { Markdown } from "./Markdown";
import { Chip } from "./ui";

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
          <p class="text-caption text-muted">Queued: {props.name} takes your message when it finishes its current work.</p>
        </Show>
      )}
    </Show>
  );
}

/** A message box that keeps your words until they're handed over, under one key, so a retry can't send twice. */
export function DesignMessageBox(props: { placeholder: string; label: string; send(text: string, key: string): Promise<unknown>; onSent?(): void }) {
  const [text, setText] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  let key = designKey();
  const submit = async () => {
    const body = text().trim();
    if (!body || busy()) return;
    setBusy(true);
    setError("");
    try {
      await props.send(body, key);
      key = designKey();
      setText("");
      props.onSent?.();
    } catch (e) {
      setError(e instanceof Error ? `${e.message} Your text is still in the box.` : "That didn't go through. Your text is still in the box.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      class="design-message-box"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <textarea
        class="input textarea"
        rows="2"
        aria-label={props.label}
        placeholder={props.placeholder}
        value={text()}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <Show when={error()}>
        <p class="field-error" role="alert">
          {error()}
        </p>
      </Show>
      <div class="button-row design-message-actions">
        <button type="submit" class="button button-primary" disabled={busy() || !text().trim()}>
          Send
        </button>
      </div>
    </form>
  );
}

function DesignAskPanel(props: { ask: DesignAsk; store: DesignStore }) {
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
  const words: Record<string, [string, string]> = { site: ["Allow Site", "Don't Allow"], "start-project": ["Start Copy", "Don't Start"], "stop-project": ["Stop Copy", "Keep Running"], spend: ["Start Designs", "Don't Start"] };
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
            <button type="button" class="button button-ghost" disabled={busy()} onClick={() => void answer("no")}>
              {words[props.ask.kind]?.[1] ?? "No"}
            </button>
            <button type="button" class="button button-primary" disabled={busy()} onClick={() => void answer("yes")}>
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
                <label class="field">
                  <span class="field-label">{f === "code" ? "One-Time Code" : `${f[0]!.toUpperCase()}${f.slice(1)}`}</span>
                  <input
                    class="input"
                    autocomplete="off"
                    type={secret(f) ? "password" : "text"}
                    value={fields()[f] ?? ""}
                    onInput={(e) => setFields({ ...fields(), [f]: e.currentTarget.value })}
                  />
                </label>
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
export function DesignCoordinatorPanel(props: { coordinator: DesignCoordinatorInfo; view: DesignChatView | null; store: DesignStore; onOpen?(): void; bare?: boolean }) {
  const tracking = () => props.view?.designs.length ?? 0;
  return (
    <div class="design-coordinator">
      <div class="design-coordinator-head">
        <strong class="design-coordinator-title">Coordinator</strong>
        <Chip live={props.coordinator.status === "running" || props.coordinator.status === "starting"} tone={props.coordinator.status === "running" ? "accent" : undefined}>
          {tracking() > 0 ? `Tracking ${tracking()} designs` : STATUS_WORD[props.coordinator.status]}
        </Chip>
        <Show when={props.onOpen}>
          <button type="button" class="button button-sm" onClick={() => props.onOpen!()}>
            Open Chat
          </button>
        </Show>
      </div>
      <Show when={props.coordinator.ask}>{(a) => <DesignAskPanel ask={a()} store={props.store} />}</Show>
      <Show when={props.coordinator.card} fallback={<p class="text-muted">Nothing on its card yet. It writes here as it goes.</p>}>
        <div class="design-coordinator-card">
          <Markdown text={props.coordinator.card} />
        </div>
      </Show>
      <DesignDeliveryLine delivery={props.coordinator.delivery} name="the coordinator" />
      <Show when={!props.bare}>
        <DesignMessageBox
          label="Message the coordinator"
          placeholder="Tell the coordinator what you want from these designs"
          send={(text, key) => props.store.api.coordinatorMessage(text, key)}
          onSent={() => props.store.refresh()}
        />
      </Show>
    </div>
  );
}
