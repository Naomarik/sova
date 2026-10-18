import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { ASSISTANT_TEXT_MAX, type AssistantServerMessage, type AssistantView } from "../../shared/project-assistant";
import { LinkedText, Reply } from "./thread";

/**
 * The Project Assistant on the owner page (§app.project-assistant/chat): the conversation, newest
 * at the bottom, the reply as it is written, and a composer. It renders what the server sends and
 * nothing else; the operator's preview gets it read-only.
 */

export interface AssistantApi {
  load(): Promise<AssistantView>;
  /** Absent: read only (the operator's preview). */
  send?(text: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** Live frames; returns the unsubscribe. */
  subscribe?(on: (m: AssistantServerMessage) => void): () => void;
}

/** What a refused message says to the owner (§design.copy-deck/owner-page). */
export function sendRefusal(code: string, op: string): string {
  if (code === "not-ready") return `The Project Assistant isn't ready yet. ${op} has to finish setting it up.`;
  if (code === "busy") return "Wait for the answer first.";
  if (code === "rate-limited") return "Too many messages. Wait a minute.";
  return "Your message didn't go through. Try again.";
}

export function AssistantChat(props: { first: string; op: string; api: AssistantApi; back: { href: string; onClick(e: MouseEvent): void } }) {
  const [view, setView] = createSignal<AssistantView | null>(null);
  const [streaming, setStreaming] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal("");
  const [loadFailed, setLoadFailed] = createSignal(false);
  let list: HTMLElement | undefined;
  let input: HTMLTextAreaElement | undefined;

  const toBottom = () => queueMicrotask(() => list?.lastElementChild?.scrollIntoView({ block: "end" }));
  const apply = (v: AssistantView) => {
    setView(v);
    setStreaming(v.busy ? (v.streaming ?? "") : "");
    setLoadFailed(false);
    toBottom();
  };
  const reload = () =>
    props.api
      .load()
      .then(apply)
      .catch(() => setLoadFailed(true));

  onMount(() => {
    void reload();
    const off = props.api.subscribe?.((m) => {
      if (m.type === "view") apply(m.view);
      else if (m.type === "streaming") {
        setStreaming(m.text);
        toBottom();
      }
    });
    // No socket (or it dropped): read again while a reply is being written.
    const poll = setInterval(() => {
      if (view()?.busy && document.visibilityState === "visible") void reload();
    }, 3000);
    onCleanup(() => {
      off?.();
      clearInterval(poll);
    });
  });

  const send = async (e?: Event) => {
    e?.preventDefault();
    const text = draft().trim();
    if (!text || sending() || !props.api.send) return;
    setSending(true);
    setError("");
    const r = await props.api.send(text).catch(() => ({ ok: false as const, code: "failed", message: "" }));
    setSending(false);
    if (!r.ok) {
      setError(sendRefusal(r.code, props.op));
      return;
    }
    setDraft("");
    void reload();
    input?.focus();
  };

  const busy = () => !!view()?.busy;
  const who = (role: string, name?: string) => (role === "owner" ? "You" : role === "operator" ? (name ?? props.op) : "Project Assistant");

  return (
    <>
      <a class="owner-back" href={props.back.href} onClick={(e) => props.back.onClick(e)}>
        ← All projects
      </a>
      <header class="owner-head">
        <h1 class="owner-org">Project Assistant</h1>
      </header>
      <Show when={view()?.ready === false}>
        <div class="banner banner-warn owner-banner" role="status">
          <div class="banner-main">
            <p class="banner-body">The Project Assistant isn't ready yet. {props.op} has to finish setting it up.</p>
          </div>
        </div>
      </Show>
      <Show when={loadFailed() && !view()}>
        <div class="empty owner-problem" role="alert">
          <p class="empty-title">We couldn't load this page.</p>
          <p class="empty-body">Your link still works. Try again in a minute.</p>
          <button type="button" class="button empty-action" onClick={() => void reload()}>
            Try Again
          </button>
        </div>
      </Show>
      <section class="owner-thread owner-assistant" aria-label="Conversation with the Project Assistant" aria-live="polite" ref={list}>
        <Show when={view() && !view()!.messages.length && !streaming()}>
          <p class="owner-empty">Hi {props.first}. I know your projects and what has been agreed so far. Ask me anything, tell me about a problem, or ask for something new.</p>
        </Show>
        <For each={view()?.messages ?? []}>
          {(m) => (
            <article class="share-msg" classList={{ "share-msg-own": m.role === "owner", "share-msg-reply": m.role === "assistant" }} aria-label={who(m.role, m.name)}>
              <span class="share-who" classList={{ "visually-hidden": m.role === "owner" }}>
                {who(m.role, m.name)}
              </span>
              <Show when={m.role === "assistant"} fallback={<LinkedText text={m.text} />}>
                <Reply text={m.text} />
              </Show>
            </article>
          )}
        </For>
        <Show when={busy()}>
          <article class="share-msg share-msg-reply" aria-label="Project Assistant, writing">
            <span class="share-who">Project Assistant · writing</span>
            <Show when={streaming()} fallback={<p class="owner-meta">Writing…</p>}>
              <Reply text={streaming()} streaming />
            </Show>
          </article>
        </Show>
      </section>
      <Show when={props.api.send}>
        <form class="share-composer owner-assistant-composer" onSubmit={(e) => void send(e)}>
          <div class="share-field" onClick={(e) => e.target === e.currentTarget && input?.focus()}>
            <label class="visually-hidden" for="assistant-text">
              Your message
            </label>
            <div class="share-compose-row">
              <textarea
                ref={input}
                id="assistant-text"
                class="share-input"
                rows={1}
                maxlength={ASSISTANT_TEXT_MAX}
                placeholder="Write a message"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
                }}
              />
              <button
                type="submit"
                class="button button-icon share-send"
                aria-label={sending() ? "Sending" : "Send"}
                title={sending() ? "Sending" : "Send"}
                aria-disabled={sending() || busy() || !draft().trim() || view()?.ready === false ? "true" : undefined}
              >
                <span class="icon share-icon-send" aria-hidden="true" />
              </button>
            </div>
          </div>
          <Show when={error()}>
            <p class="field-error" role="alert">
              {error()}
            </p>
          </Show>
        </form>
      </Show>
    </>
  );
}
