import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { SHARE_TEXT_MAX, type BatonView, type GoneWhy, type ShareServerMessage } from "../../shared/baton";
import { Item, LinkedText, Reply } from "./thread";
import { visitTab } from "./visit-tab";

/**
 * The share page (§app.baton/outsider-view): one conversation, as the person holding this link may
 * see it. Everything it shows arrives already filtered by the server; it has no other API.
 */

const TOKEN = /^\/h\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname)?.[1] ?? null;
/** This tab's visit id (§app.baton/visits): a reload or a reconnect continues the same visit. */
const storage = (): Storage | null => {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
};
const VISIT = visitTab(storage());

type Problem = { title: string; body: string };
const GONE: Problem = { title: "This link is no longer active.", body: "The conversation was closed or the link was turned off. Ask the person who sent it for a new one." };
/** The only two reasons a dead link names (the server sends no other): anything more, such as
    "they left the organization", would tell whoever holds a forwarded link. */
const GONE_WHY: Record<GoneWhy, Problem> = {
  expired: { title: "This link has expired.", body: "Links last 14 days. Ask the person who sent it for a new one." },
  withdrawn: { title: "This question went to someone else.", body: "Nothing more is needed from you." },
};
const gone = (why: unknown): Problem => (typeof why === "string" && Object.hasOwn(GONE_WHY, why) ? GONE_WHY[why as GoneWhy] : GONE);
const UNKNOWN: Problem = { title: "This link doesn't open a conversation.", body: "Check that you copied the whole link, or ask the person who sent it for a new one." };

export function ShareApp() {
  const [view, setView] = createSignal<BatonView | null>(null);
  const [problem, setProblem] = createSignal<Problem | null>(TOKEN ? null : UNKNOWN);
  const [streaming, setStreaming] = createSignal("");
  const [pending, setPending] = createSignal<string[]>([]);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [elsewhere, setElsewhere] = createSignal(false);
  let listEnd: HTMLDivElement | undefined;

  const apply = (v: BatonView) => {
    setView(v);
    setStreaming("");
    // The server labels the viewer's own messages "you" (it sends no person ids).
    const mine = new Set(v.items.filter((i) => i.kind === "message" && i.by === "you").map((i) => (i as { text: string }).text));
    setPending((p) => p.filter((t) => !mine.has(t)));
  };

  const load = async () => {
    if (!TOKEN) return;
    const res = await fetch(`/api/h/${TOKEN}?v=${VISIT}`, { cache: "no-store" }).catch(() => null);
    if (!res) return;
    if (res.status === 410) return setProblem(gone(((await res.json().catch(() => ({}))) as { why?: unknown }).why));
    if (res.status === 404) return setProblem(UNKNOWN);
    if (res.ok) apply((await res.json()) as BatonView);
  };

  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = 2000;
  let stopped = false;
  const connect = () => {
    if (!TOKEN || stopped) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/h?token=${TOKEN}&v=${VISIT}`);
    socket = ws;
    ws.onopen = () => (backoff = 2000);
    ws.onmessage = (e) => {
      let msg: ShareServerMessage;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === "view") apply(msg.view);
      else if (msg.type === "streaming") setStreaming(msg.text);
      else if (msg.type === "error" && msg.code === "gone") setProblem(gone(msg.why));
    };
    ws.onclose = (e) => {
      if (socket !== ws || stopped) return;
      // The `gone` frame before this close carried the reason; keep it.
      if (e.code === 4410) return setProblem((p) => p ?? GONE);
      if (e.code === 4000) return setElsewhere(true);
      retry = setTimeout(() => {
        void load();
        connect();
      }, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    };
  };

  onMount(() => {
    void load().then(connect);
  });
  onCleanup(() => {
    stopped = true;
    clearTimeout(retry);
    socket?.close();
  });
  createEffect(on([() => view()?.items.length, pending, streaming], () => queueMicrotask(() => listEnd?.scrollIntoView({ block: "end" })), { defer: true }));

  const send = async (e?: Event) => {
    e?.preventDefault();
    const text = draft().trim();
    if (!text || sending() || !TOKEN) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch(`/api/h/${TOKEN}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.status === 410) return setProblem(gone(((await res.json().catch(() => ({}))) as { why?: unknown }).why));
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSendError(body.error ?? "Your message didn't go through. Try again.");
        void load();
        return;
      }
      setPending((p) => [...p, text]);
      setDraft("");
    } catch {
      setSendError("We couldn't reach the conversation. Check your connection and send again; your text is still here.");
    } finally {
      setSending(false);
    }
  };

  const statusLine = () => {
    const v = view();
    if (!v) return "";
    if (v.state === "done") return "This conversation is done. Thank you.";
    if (v.state === "closed") return "This conversation was closed.";
    // An open offer nobody has taken: anyone invited may answer, and the first to answer takes it.
    if (v.viewer?.canWrite && v.holder === null && v.state === "open") return `${v.viewer.name}, this is open to a few people. The first to answer takes it.`;
    if (v.viewer?.canWrite) return `Your turn, ${v.viewer.name}.`;
    if (v.viewer?.reason === "budget") return "This conversation has reached its message limit.";
    if (v.viewer?.reason === "taken") return "Someone else is answering right now. If they stop, it opens to you again here.";
    if (v.viewer?.reason === "withdrawn") return "This question went to someone else. Nothing more is needed from you.";
    if (v.viewer?.reason === "newer-link") return "You have a newer link to this conversation. Use that one to write.";
    return v.holder ? `Waiting on ${v.holder}.` : "Waiting.";
  };

  return (
    <main class="share">
      <Show
        when={!problem()}
        fallback={
          <div class="empty share-empty">
            <p class="empty-title">{problem()!.title}</p>
            <p class="empty-body">{problem()!.body}</p>
          </div>
        }
      >
        <header class="share-head">
          <h1 class="share-title">{view()?.publicTitle ?? "Loading the conversation."}</h1>
          <p class="share-status" role="status" aria-live="polite">
            {statusLine()}
          </p>
          <Show when={elsewhere()}>
            <p class="share-note">This link is open in another tab or device, so updates go there. Reload to bring them here.</p>
          </Show>
        </header>
        <section class="share-thread" aria-label="Conversation">
          <For each={view()?.items ?? []}>{(it) => <Item item={it} />}</For>
          <For each={pending()}>
            {(t) => (
              <article class="share-msg share-msg-own" aria-label="You, sending">
                <span class="share-who">You · sending</span>
                <LinkedText text={t} />
              </article>
            )}
          </For>
          <Show when={streaming()}>
            <article class="share-msg share-msg-reply" aria-label="Facilitator, writing">
              <span class="share-who">Facilitator · writing</span>
              <Reply text={streaming()} />
            </article>
          </Show>
          <div ref={listEnd} />
        </section>
        <Show when={view()?.viewer?.canWrite}>
          <form class="share-composer" onSubmit={send}>
            <label class="visually-hidden" for="share-text">
              Your reply
            </label>
            <textarea
              id="share-text"
              class="input textarea share-input"
              rows={3}
              maxlength={SHARE_TEXT_MAX}
              placeholder="Write your reply"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
              }}
            />
            <Show when={sendError()}>
              <p class="field-error" role="alert">
                {sendError()}
              </p>
            </Show>
            <div class="share-composer-foot">
              <span class="field-hint">
                {draft().length.toLocaleString("en-US")} of {SHARE_TEXT_MAX.toLocaleString("en-US")} characters · Ctrl+Enter sends
              </span>
              <button type="submit" class="button button-primary" aria-disabled={sending() || !draft().trim() ? "true" : undefined}>
                {sending() ? "Sending" : "Send"}
              </button>
            </div>
          </form>
        </Show>
      </Show>
    </main>
  );
}
