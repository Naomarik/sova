import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { SHARE_TEXT_MAX, type BatonView, type GoneWhy, type ShareServerMessage } from "../../shared/baton";
import { HOP_LOST_CLOSE, RECONNECT_BACKOFF_MS } from "../../shared/public-links";
import { uploadPhoto } from "./photos";
import { uploadFile } from "./files";
import { ShareComposer, type Attachment, type SendOutcome } from "./ShareComposer";
import { batonKinds } from "./markdown";
import { Item, LinkedText, MessageFiles, MessagePhotos, Reply } from "./thread";
import { prefillTourDraft, TOUR_PREFILL_LINES, tourPrefillMessage } from "../lib/tour-draft";
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
/** The host behind a public gateway is offline (a 503, or the hop closed with HOP_LOST_CLOSE):
    the page stays, the draft stays, and it keeps trying (§mesh.public/offline). */
const RECONNECTING = "Reconnecting. Your draft is kept.";
const NOT_SENT_OFFLINE = "Not sent. The page is offline; your message is still here.";
/** A sent message not in the view yet: dropped once the view holds `expect` messages of the viewer's own. */
interface Pending {
  cid: string;
  text: string;
  thumbs: string[];
  files: { name: string; size: number }[];
  expect: number;
}
let seq = 0;
const cid = () => `c${++seq}`;

const UNKNOWN: Problem = { title: "This link doesn't open a conversation.", body: "Check that you copied the whole link, or ask the person who sent it for a new one." };

export function ShareApp() {
  // A store reconciled by item id: an unchanged row keeps its elements (and its photos' <img>s) across view pushes.
  const [store, setStore] = createStore<{ v: BatonView | null }>({ v: null });
  const view = () => store.v;
  const [problem, setProblem] = createSignal<Problem | null>(TOKEN ? null : UNKNOWN);
  const [streaming, setStreaming] = createSignal("");
  const [pending, setPending] = createSignal<Pending[]>([]);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [elsewhere, setElsewhere] = createSignal(false);
  const [offline, setOffline] = createSignal(false);
  /** The host answers again: drop the offline note, and the send error it caused. */
  const online = () => {
    setOffline(false);
    setSendError((e) => (e === NOT_SENT_OFFLINE ? null : e));
  };

  /** The viewer's own messages in the view (the server labels them "you"; it sends no person ids). */
  const ownCount = () => (view()?.items ?? []).filter((i) => i.kind === "message" && i.by === "you").length;
  const apply = (v: BatonView) => {
    setStore("v", reconcile(v, { key: "id", merge: false }));
    setStreaming("");
    const own = ownCount();
    setPending((p) => p.filter((x) => own < x.expect));
  };
  const photos = () => (view()?.viewer?.canWrite ? (view()?.viewer?.photos ?? null) : null);
  /** Files (§app.baton/files): while the link writes and the session takes them. */
  const files = () => (view()?.viewer?.canWrite ? (view()?.viewer?.files ?? null) : null);
  const photoSrc = (n: number) => `/api/h/${TOKEN}/img/${n}`;

  const load = async () => {
    if (!TOKEN) return;
    const res = await fetch(`/api/h/${TOKEN}?v=${VISIT}`, { cache: "no-store" }).catch(() => null);
    if (!res) return;
    if (res.status === 410) return setProblem(gone(((await res.json().catch(() => ({}))) as { why?: unknown }).why));
    if (res.status === 404) return setProblem(UNKNOWN);
    if (res.status === 503) return setOffline(true);
    if (res.ok) {
      online();
      apply((await res.json()) as BatonView);
    }
  };

  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = 2000;
  let stopped = false;
  const connect = () => {
    if (!TOKEN || stopped) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/h?token=${TOKEN}&v=${VISIT}`);
    socket = ws;
    ws.onopen = () => {
      backoff = 2000;
      online();
    };
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
      // The host went offline: back off from 5 s to 60 s until it answers again. While offline, a
      // refused upgrade (the gateway's 503) shows here only as an abnormal close, so it keeps the
      // offline pace.
      if (e.code === HOP_LOST_CLOSE) setOffline(true);
      if (offline()) backoff = Math.max(backoff, RECONNECT_BACKOFF_MS.first);
      retry = setTimeout(() => {
        void load();
        connect();
      }, backoff);
      backoff = Math.min(backoff * 2, offline() ? RECONNECT_BACKOFF_MS.max : 30_000);
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
  // To the page's end, not the thread's: the composer is the last thing in the flow, so the newest
  // item then ends just above it. scrollIntoView on the thread's end would tuck it under the
  // sticky composer.
  createEffect(on([() => view()?.items.length, pending, streaming], () => queueMicrotask(() => window.scrollTo(0, document.documentElement.scrollHeight)), { defer: true }));
  // The composer's text box, once it exists (a tour's Ask puts its words in it).
  let box: { input: HTMLTextAreaElement; fit(): void } | undefined;

  const prefillTour = async (question: string) => {
    const outcome = await prefillTourDraft(question, {
      canWrite: () => !!TOKEN && view()?.viewer?.canWrite === true,
      // A click must not reuse a turn that ended since the last socket view.
      recheck: async () => {
        const response = await fetch(`/api/h/${TOKEN}`, { cache: "no-store" }).catch(() => null);
        if (!response?.ok) return null;
        const latest = (await response.json()) as BatonView;
        apply(latest);
        return { canWrite: latest.viewer?.canWrite === true };
      },
      draft,
    });
    if (outcome.status !== "ready") {
      if (outcome.status === "failed") console.warn(`[tours] Ask not added (${outcome.reason}).`);
      setSendError(tourPrefillMessage(outcome));
      return;
    }
    setSendError((e) => (e !== null && TOUR_PREFILL_LINES.includes(e) ? null : e));
    setDraft(outcome.draft);
    queueMicrotask(() => { box?.fit(); box?.input.focus(); box?.input.setSelectionRange(outcome.draft.length, outcome.draft.length); });
  };

  /** One send of the composer's text and attachments; the composer uploads expired ones again once. */
  const send = async (text: string, photos: Attachment[], files: Attachment[], again: boolean): Promise<SendOutcome> => {
    if (sending() || !TOKEN) return "kept";
    setSending(true);
    setSendError(null);
    const expect = ownCount() + pending().length + 1;
    try {
      const res = await fetch(`/api/h/${TOKEN}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          ...(photos.length ? { images: photos.map((a) => a.id) } : {}),
          ...(files.length ? { files: files.map((a) => a.id) } : {}),
        }),
      });
      // A staged photo or file expired (a restart, a day's wait): the composer uploads them again, once.
      if (res.status === 409 && !again && (photos.length || files.length)) {
        const body = (await res.clone().json().catch(() => ({}))) as { code?: string };
        if (body.code === "photo-expired" && photos.length) return { expired: "photo" };
        if (body.code === "file-expired" && files.length) return { expired: "file" };
      }
      if (res.status === 410) {
        setProblem(gone(((await res.json().catch(() => ({}))) as { why?: unknown }).why));
        return "kept";
      }
      // Never resent on its own: the text stays in the composer for the person to send again.
      if (res.status === 503) {
        setOffline(true);
        setSendError(NOT_SENT_OFFLINE);
        return "kept";
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSendError(body.error ?? "Your message didn't go through. Try again.");
        void load();
        return "kept";
      }
      setPending((p) => [...p, { cid: cid(), text, thumbs: photos.flatMap((a) => (a.thumb ? [a.thumb] : [])), files: files.map((a) => ({ name: a.name, size: a.size })), expect }]);
      return "sent";
    } catch {
      setSendError("We couldn't reach the conversation. Check your connection and send again; your text is still here.");
      return "kept";
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
    <main class="share share-baton">
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
          {/* Until the view arrives the title is a placeholder, and the loading line is status, never the heading. */}
          <Show when={view()} fallback={<div class="skeleton skeleton-title share-title-skeleton" aria-hidden="true" />}>
            <h1 class="share-title">{view()!.publicTitle}</h1>
          </Show>
          <p class="share-status" role="status" aria-live="polite">
            {view() ? statusLine() : "Loading the conversation."}
          </p>
          <Show when={offline()}>
            <p class="share-note" role="status">
              {RECONNECTING}
            </p>
          </Show>
          <Show when={elsewhere()}>
            <p class="share-note">This link is open in another tab or device, so updates go there. Reload to bring them here.</p>
          </Show>
        </header>
        <section class="share-thread" aria-label="Conversation">
          <For each={view()?.items ?? []}>{(it) => <Item item={it} photo={photoSrc} viewer={view()?.viewer?.name} drawings={view()?.drawings} tour={{ base: handle => `/api/h/${TOKEN}/tours/${encodeURIComponent(handle)}`, progress: true, onAsk: view()?.viewer?.canWrite ? question => void prefillTour(question) : undefined, onRequestCoverage: view()?.viewer?.canWrite ? question => void prefillTour(question) : undefined }} />}</For>
          <For each={pending()}>
            {(t) => (
              <article class="share-msg share-msg-own" aria-label="You, sending">
                <span class="share-who share-who-sending">
                  <span class="visually-hidden">You · </span>Sending
                </span>
                <Show when={t.thumbs.length}>
                  <MessagePhotos srcs={t.thumbs} from="you" />
                </Show>
                <Show when={t.files.length}>
                  <MessageFiles files={t.files} />
                </Show>
                <Show when={t.text}>
                  <LinkedText text={t.text} />
                </Show>
              </article>
            )}
          </For>
          <Show when={streaming()}>
            <article class="share-msg share-msg-reply" aria-label="Facilitator, writing">
              <span class="share-who">Facilitator · writing</span>
              <Reply text={streaming()} streaming kinds={batonKinds(view()?.drawings?.html === true)} />
            </article>
          </Show>
        </section>
        <Show when={view()?.viewer?.canWrite}>
          <ShareComposer
            id="share-text"
            label="Your reply"
            placeholder="Write your reply"
            maxLength={SHARE_TEXT_MAX}
            sendKey="mod-enter"
            draft={draft}
            setDraft={setDraft}
            error={sendError}
            photos={photos}
            files={files}
            uploadPhoto={(blob, progress) => uploadPhoto(`/api/h/${TOKEN}/image`, blob, progress)}
            uploadFile={(blob, name, progress) => uploadFile(TOKEN!, blob, name, progress)}
            onUploadRefused={(r) => r.status === 410 && setProblem(gone(undefined))}
            sending={sending}
            send={send}
            ref={(b) => (box = b)}
          />
        </Show>
      </Show>
    </main>
  );
}
