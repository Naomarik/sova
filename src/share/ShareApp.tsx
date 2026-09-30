import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { SHARE_TEXT_MAX, type BatonView, type GoneWhy, type ShareServerMessage } from "../../shared/baton";
import { HOP_LOST_CLOSE, RECONNECT_BACKOFF_MS } from "../../shared/public-links";
import { PhotoFormatError, processPhoto, sizeLabel, uploadPhoto, type UploadRefusal } from "./photos";
import { Item, LinkedText, MessagePhotos, Reply } from "./thread";
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
/** A photo in the composer (§app.baton/images): processed on the device, then uploaded at once. */
interface Attachment {
  cid: string;
  name: string;
  size: number;
  /** The processed bytes, kept for a retry or a re-upload after `photo-expired`; null once refused on the device. */
  blob: Blob | null;
  thumb: string | null;
  state: "processing" | "uploading" | "ready" | "failed";
  progress: number;
  id?: string;
  reason?: string;
  abort?: () => void;
}
/** A sent message not in the view yet: dropped once the view holds `expect` messages of the viewer's own. */
interface Pending {
  cid: string;
  text: string;
  thumbs: string[];
  expect: number;
}
let seq = 0;
const cid = () => `c${++seq}`;
const photosWord = (n: number) => (n === 1 ? "1 photo" : `${n} photos`);

const UNKNOWN: Problem = { title: "This link doesn't open a conversation.", body: "Check that you copied the whole link, or ask the person who sent it for a new one." };

export function ShareApp() {
  // A store reconciled by item id: an unchanged row keeps its elements (and its photos' <img>s) across view pushes.
  const [store, setStore] = createStore<{ v: BatonView | null }>({ v: null });
  const view = () => store.v;
  const [problem, setProblem] = createSignal<Problem | null>(TOKEN ? null : UNKNOWN);
  const [streaming, setStreaming] = createSignal("");
  const [pending, setPending] = createSignal<Pending[]>([]);
  const [atts, setAtts] = createStore<Attachment[]>([]);
  const [announce, setAnnounce] = createSignal("");
  const [dropping, setDropping] = createSignal(false);
  let fileInput: HTMLInputElement | undefined;
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
  let listEnd: HTMLDivElement | undefined;

  /** The viewer's own messages in the view (the server labels them "you"; it sends no person ids). */
  const ownCount = () => (view()?.items ?? []).filter((i) => i.kind === "message" && i.by === "you").length;
  const apply = (v: BatonView) => {
    setStore("v", reconcile(v, { key: "id", merge: false }));
    setStreaming("");
    const own = ownCount();
    setPending((p) =>
      p.filter((x) => {
        if (own < x.expect) return true;
        for (const t of x.thumbs) URL.revokeObjectURL(t);
        return false;
      }),
    );
  };
  const photos = () => (view()?.viewer?.canWrite ? (view()?.viewer?.photos ?? null) : null);
  const photoSrc = (n: number) => `/api/h/${TOKEN}/img/${n}`;

  // ---- photos in the composer (§app.baton/images) ----
  const patch = (id: string, p: Partial<Attachment>) => setAtts((a) => a.cid === id, p);
  const find = (id: string) => atts.find((a) => a.cid === id);
  const live = () => atts.filter((a) => a.state !== "failed" || a.blob !== null);
  const uploading = () => atts.some((a) => a.state === "processing" || a.state === "uploading");
  const ready = () => atts.filter((a) => a.state === "ready" && a.id);
  const upload = async (id: string): Promise<boolean> => {
    const a = find(id);
    if (!a?.blob || !TOKEN) return false;
    const up = uploadPhoto(TOKEN, a.blob, (p) => patch(id, { progress: p }));
    patch(id, { state: "uploading", progress: 0, reason: undefined, id: undefined, abort: up.abort });
    try {
      const staged = await up.done;
      if (!find(id)) return false;
      patch(id, { state: "ready", id: staged.id, progress: 1, abort: undefined });
      return true;
    } catch (err) {
      const r = err as UploadRefusal;
      if (!find(id) || r.code === "aborted") return false;
      if (r.status === 410) setProblem(gone(undefined));
      patch(id, { state: "failed", reason: r.status ? r.error : "Upload failed.", abort: undefined });
      setAnnounce(`${a.name} wasn't attached. ${r.status ? r.error : "Upload failed."}`);
      return false;
    }
  };
  const addFiles = async (files: readonly File[], pasted = false) => {
    const limits = photos();
    if (!limits || !files.length) return;
    let added = 0;
    for (const file of files) {
      const name = pasted ? "Pasted photo" : file.name || "Photo";
      const id = cid();
      if (live().length >= limits.perMessage) {
        const reason = `Up to ${limits.perMessage} photos per message.`;
        setAtts(atts.length, { cid: id, name, size: file.size, blob: null, thumb: null, state: "failed", progress: 0, reason });
        setAnnounce(`${name} wasn't attached. ${reason}`);
        continue;
      }
      setAtts(atts.length, { cid: id, name, size: file.size, blob: null, thumb: null, state: "processing", progress: 0 });
      let blob: Blob;
      try {
        blob = await processPhoto(file);
      } catch (err) {
        const reason = err instanceof PhotoFormatError ? err.message : "This photo's format can't be sent.";
        patch(id, { state: "failed", reason });
        setAnnounce(`${name} wasn't attached. ${reason}`);
        continue;
      }
      if (!find(id)) continue;
      if (blob.size > limits.maxBytes) {
        const reason = `Over ${Math.round(limits.maxBytes / (1024 * 1024))} MB.`;
        patch(id, { state: "failed", reason });
        setAnnounce(`${name} wasn't attached. ${reason}`);
        continue;
      }
      patch(id, { blob, size: blob.size, thumb: URL.createObjectURL(blob) });
      added++;
      void upload(id);
    }
    if (added) setAnnounce(`${photosWord(added)} attached.`);
  };
  const remove = (id: string) => {
    const a = find(id);
    a?.abort?.();
    if (a?.thumb) URL.revokeObjectURL(a.thumb);
    setAtts((list) => list.filter((x) => x.cid !== id));
  };
  const imageFiles = (list: FileList | null | undefined): File[] => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
  // A stray drop anywhere else on the page must not navigate away to the file.
  const stray = (e: DragEvent) => {
    if (photos() && e.dataTransfer?.types.includes("Files")) e.preventDefault();
  };
  window.addEventListener("dragover", stray);
  window.addEventListener("drop", stray);
  onCleanup(() => {
    window.removeEventListener("dragover", stray);
    window.removeEventListener("drop", stray);
  });

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
  createEffect(on([() => view()?.items.length, pending, streaming], () => queueMicrotask(() => listEnd?.scrollIntoView({ block: "end" })), { defer: true }));

  const send = async (e?: Event) => {
    e?.preventDefault();
    const text = draft().trim();
    if ((!text && !ready().length) || sending() || uploading() || !TOKEN) return;
    setSending(true);
    setSendError(null);
    const expect = ownCount() + pending().length + 1;
    try {
      const post = () =>
        fetch(`/api/h/${TOKEN}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ready().length ? { text, images: ready().map((a) => a.id) } : { text }),
        });
      let res = await post();
      // A staged photo expired (a restart, a day's wait): upload them again, once, and resend.
      if (res.status === 409 && ready().length) {
        const body = (await res.clone().json().catch(() => ({}))) as { code?: string };
        if (body.code === "photo-expired") {
          const ok = await Promise.all(ready().map((a) => upload(a.cid)));
          if (ok.every(Boolean)) res = await post();
        }
      }
      if (res.status === 410) return setProblem(gone(((await res.json().catch(() => ({}))) as { why?: unknown }).why));
      // Never resent on its own: the text stays in the composer for the person to send again.
      if (res.status === 503) {
        setOffline(true);
        setSendError(NOT_SENT_OFFLINE);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSendError(body.error ?? "Your message didn't go through. Try again.");
        void load();
        return;
      }
      const sent = ready();
      setPending((p) => [...p, { cid: cid(), text, thumbs: sent.flatMap((a) => (a.thumb ? [a.thumb] : [])), expect }]);
      // The thumbnails now belong to the sending echo; everything else in the strip goes.
      for (const a of atts) if (a.thumb && !sent.includes(a)) URL.revokeObjectURL(a.thumb);
      setAtts([]);
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
          <For each={view()?.items ?? []}>{(it) => <Item item={it} photo={photoSrc} />}</For>
          <For each={pending()}>
            {(t) => (
              <article class="share-msg share-msg-own" aria-label="You, sending">
                <span class="share-who">You · sending</span>
                <Show when={t.thumbs.length}>
                  <MessagePhotos srcs={t.thumbs} from="you" />
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
              <Reply text={streaming()} streaming />
            </article>
          </Show>
          <div ref={listEnd} />
        </section>
        <Show when={view()?.viewer?.canWrite}>
          <form
            class="share-composer"
            classList={{ "share-composer-drop": dropping() }}
            onSubmit={send}
            onDragOver={(e) => {
              if (!photos() || !e.dataTransfer?.types.includes("Files")) return;
              e.preventDefault();
              setDropping(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDropping(false);
            }}
            onDrop={(e) => {
              if (!photos()) return;
              e.preventDefault();
              setDropping(false);
              void addFiles(imageFiles(e.dataTransfer?.files));
            }}
          >
            <Show when={atts.length}>
              <ul class="share-atts" aria-label="Photos to send">
                <For each={atts}>
                  {(a) => (
                    <li class="share-att" classList={{ "share-att-failed": a.state === "failed" }}>
                      <Show when={a.thumb} fallback={<span class="icon share-icon-alert share-att-icon" aria-hidden="true" />}>
                        <img class="share-att-thumb" src={a.thumb!} alt="" />
                      </Show>
                      <span class="share-att-text">
                        <span class="share-att-name" title={a.name}>
                          {a.name}
                        </span>
                        <span class="share-att-meta">
                          {a.state === "failed"
                            ? a.reason
                            : a.state === "processing"
                              ? "Preparing"
                              : a.state === "uploading"
                                ? `${sizeLabel(a.size)} · Uploading ${Math.round(a.progress * 100)}%`
                                : sizeLabel(a.size)}
                        </span>
                        <Show when={a.state === "uploading"}>
                          <progress class="share-att-progress" max="1" value={a.progress} aria-hidden="true" />
                        </Show>
                      </span>
                      <Show when={a.state === "failed" && a.blob}>
                        <button type="button" class="button button-ghost share-att-retry" aria-label={`Retry ${a.name}`} onClick={() => void upload(a.cid)}>
                          Retry
                        </button>
                      </Show>
                      <button type="button" class="button button-icon button-ghost" aria-label={`Remove ${a.name}`} onClick={() => remove(a.cid)}>
                        <span class="icon share-icon-close" aria-hidden="true" />
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <label class="visually-hidden" for="share-text">
              Your reply
            </label>
            <div class="share-compose-row">
              <Show when={photos()}>
                <button type="button" class="button button-icon share-clip" aria-label="Attach Photos" title="Attach Photos" onClick={() => fileInput?.click()}>
                  <span class="icon share-icon-attach" aria-hidden="true" />
                </button>
                <input
                  ref={fileInput}
                  class="visually-hidden"
                  type="file"
                  accept="image/*"
                  multiple
                  tabindex="-1"
                  aria-hidden="true"
                  onChange={(e) => {
                    const files = imageFiles(e.currentTarget.files);
                    e.currentTarget.value = "";
                    void addFiles(files);
                  }}
                />
              </Show>
              <textarea
                id="share-text"
                class="input textarea share-input"
                rows={3}
                maxlength={SHARE_TEXT_MAX}
                placeholder="Write your reply"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onPaste={(e) => {
                  const files = photos() ? imageFiles(e.clipboardData?.files) : [];
                  if (!files.length) return;
                  // A paste with text keeps its text and attaches the image too.
                  if (!e.clipboardData?.types.includes("text/plain")) e.preventDefault();
                  void addFiles(files, true);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send();
                }}
              />
            </div>
            <Show when={sendError()}>
              <p class="field-error" role="alert">
                {sendError()}
              </p>
            </Show>
            <div class="share-composer-foot">
              <span class="field-hint">
                {uploading()
                  ? "Waiting for photos to finish."
                  : `${draft().length.toLocaleString("en-US")} of ${SHARE_TEXT_MAX.toLocaleString("en-US")} characters · Ctrl+Enter sends`}
              </span>
              <button type="submit" class="button button-primary" aria-disabled={sending() || uploading() || (!draft().trim() && !ready().length) ? "true" : undefined}>
                {sending() ? "Sending" : "Send"}
              </button>
            </div>
            <p class="visually-hidden" aria-live="polite">
              {announce()}
            </p>
          </form>
        </Show>
      </Show>
    </main>
  );
}
