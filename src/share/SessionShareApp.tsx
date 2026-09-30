import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { HOP_LOST_CLOSE, RECONNECT_BACKOFF_MS } from "../../shared/public-links";
import {
  SESSION_SHARE_GONE_CLOSE,
  type SessionShareClientMessage,
  type SessionShareImageRef,
  type SessionShareItem,
  type SessionShareServerMessage,
  type SessionShareView,
} from "../../shared/session-share";
import { earlierLine, ShareViewKeeper, type ShareAnswer } from "../lib/share-slice";
import { SESSION_VIS_KINDS } from "./markdown";
import { LinkedText, Reply } from "./thread";
import { visitTab } from "./visit-tab";
import "./session-share.css";

/**
 * A shared session (§app/session-share): the conversation as its recipients read it, read-only.
 * Everything it shows arrives filtered by the server; it has no other API and sends nothing but
 * whether the page is visible. The Share sheet's Preview renders the same thread (SessionThread).
 */

const TOKEN = /^\/s\/([A-Za-z0-9_-]{43})\/?$/.exec(location.pathname)?.[1] ?? null;
const storage = (): Storage | null => {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
};

type Problem = { title: string; body: string };
const GONE: Problem = { title: "This link is no longer active.", body: "It was turned off, or the session isn't shared anymore. Ask the person who sent it for a new one." };
const EXPIRED: Problem = { title: "This link has expired.", body: "Ask the person who sent it for a new one." };
const UNKNOWN: Problem = { title: "This link doesn't open a shared session.", body: "Check that you copied the whole link, or ask the person who sent it for a new one." };
const BUSY: Problem = { title: "This link is being read a lot right now.", body: "Nothing is wrong with it. Try again in a minute." };
const gone = (why: unknown): Problem => (why === "expired" ? EXPIRED : GONE);
/** The host behind a public gateway is offline (§mesh.public/offline): the page keeps what it
    shows and keeps trying. */
const OFFLINE = "Offline. We'll keep trying, and the page stays as it is.";

// ---- times --------------------------------------------------------------------------------------

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const moment = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** The line under the title: when it was shared and how far it goes. */
export function viewLine(v: Pick<SessionShareView, "mode" | "sharedAt" | "through">): string {
  if (v.mode === "live") return `Shared ${day(v.sharedAt)} · read only`;
  return v.through ? `Shared ${day(v.sharedAt)} · up to ${moment(v.through)} · read only` : `Shared ${day(v.sharedAt)} · read only`;
}

// ---- the thread ---------------------------------------------------------------------------------

function Images(props: { images: SessionShareImageRef[] | undefined; url(n: number): string }) {
  return (
    <Show when={props.images?.length}>
      <div class="ss-images">
        <For each={props.images}>
          {(img) => (
            <a class="ss-image" href={props.url(img.n)} target="_blank" rel="noopener noreferrer">
              <img src={props.url(img.n)} alt={`Image ${img.n + 1}`} loading="lazy" decoding="async" />
            </a>
          )}
        </For>
      </div>
    </Show>
  );
}

function Item(props: { item: SessionShareItem; imageUrl(n: number): string }) {
  const it = props.item;
  return it.kind === "user" ? (
    <article class="share-msg share-msg-own ss-msg" aria-label="Message">
      <Show when={it.text}>
        <LinkedText text={it.text} />
      </Show>
      <Images images={it.images} url={props.imageUrl} />
    </article>
  ) : (
    <article class="share-msg share-msg-reply ss-msg" aria-label="Reply">
      <Show when={it.text}>
        <Reply text={it.text} kinds={SESSION_VIS_KINDS} />
      </Show>
      <Images images={it.images} url={props.imageUrl} />
    </article>
  );
}

/**
 * The thread of a view: Show Earlier on top when there is more, then the items, oldest first.
 *   earlier       load the page before; absent: no button (the Preview reads the newest page only)
 *   earlierState  "busy" while it loads, or the line saying it failed
 */
export function SessionThread(props: {
  view: SessionShareView;
  imageUrl(n: number): string;
  onEarlier?(): void;
  earlierState?: "busy" | string | null;
}) {
  return (
    <section class="share-thread ss-thread" aria-label="Conversation">
      <Show when={props.view.before !== undefined && props.onEarlier}>
        <div class="ss-earlier">
          <button type="button" class="button button-sm" aria-disabled={props.earlierState === "busy" ? "true" : undefined} onClick={() => props.earlierState !== "busy" && props.onEarlier?.()}>
            {props.earlierState === "busy" ? "Loading Earlier Messages" : "Show Earlier"}
          </button>
          <Show when={props.earlierState && props.earlierState !== "busy"}>
            <p class="ss-note" role="status">
              {props.earlierState}
            </p>
          </Show>
        </div>
      </Show>
      <Show
        when={props.view.items.length > 0}
        fallback={
          <div class="empty">
            <p class="empty-title">Nothing to read yet.</p>
            <p class="empty-body">{props.view.mode === "live" ? "This session has no messages yet. New ones show up here as they're written." : "This session had no messages when it was shared."}</p>
          </div>
        }
      >
        {/* A slice that starts partway says so once, above its first item (§app.session-share/slice). */}
        <Show when={earlierLine(props.view)}>
          <p class="ss-note ss-earlier-line">Earlier messages aren't part of this share.</p>
        </Show>
        <For each={props.view.items}>{(it) => <Item item={it} imageUrl={props.imageUrl} />}</For>
      </Show>
    </section>
  );
}

/** The view's head: the public title, the line under it, and a Live chip while it follows along. */
export function SessionShareHead(props: { view: SessionShareView | null }) {
  return (
    <header class="share-head">
      <h1 class="share-title">{props.view?.title ?? "Loading the conversation."}</h1>
      <Show when={props.view}>
        {(v) => (
          <p class="share-status ss-status">
            <Show when={v().mode === "live"}>
              <span class="chip chip-accent" title="New messages appear here as the session goes on.">
                <span class="chip-dot" aria-hidden="true" />
                Live
              </span>
            </Show>
            <span>{viewLine(v())}</span>
          </p>
        )}
      </Show>
    </header>
  );
}

// ---- the page -----------------------------------------------------------------------------------

export function SessionShareApp() {
  const VISIT = visitTab(storage());
  const [view, setView] = createSignal<SessionShareView | null>(null);
  const [problem, setProblem] = createSignal<Problem | null>(TOKEN ? null : UNKNOWN);
  const [offline, setOffline] = createSignal(false);
  const [earlier, setEarlier] = createSignal<"busy" | string | null>(null);
  const imageUrl = (n: number) => `/api/s/${TOKEN}/img/${n}`;

  /** Near the bottom when a live push lands: stay there, so new messages come into view. */
  const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;

  /** One read, with no effect of its own: the keeper decides whether its answer still acts. */
  const read = async (before?: number): Promise<ShareAnswer> => {
    const res = await fetch(`/api/s/${TOKEN}?v=${VISIT}${before === undefined ? "" : `&before=${before}`}`, { cache: "no-store" }).catch(() => null);
    if (!res) return { kind: "failed" };
    if (res.status === 410) return { kind: "gone", why: ((await res.json().catch(() => ({}))) as { why?: unknown }).why };
    if (res.status === 404) return { kind: "unknown" };
    if (res.status === 429) return { kind: "busy" };
    if (res.status === 503) return { kind: "offline" };
    if (!res.ok) return { kind: "failed" };
    const view = (await res.json().catch(() => null)) as SessionShareView | null;
    return view ? { kind: "view", view } : { kind: "failed" };
  };

  // Reads and pushes act in order (ShareViewKeeper): an answer overtaken by a newer view is dropped
  // whole, its gone or offline state included, so a late wider slice never returns over a push.
  const keeper = new ShareViewKeeper(TOKEN ? read : async () => ({ kind: "failed" }), {
    view: (v) => {
      const pin = view() !== null && atBottom();
      setView(v);
      document.title = v.title;
      if (pin) queueMicrotask(() => window.scrollTo(0, document.documentElement.scrollHeight));
    },
    problem: (a) => setProblem(a.kind === "gone" ? gone(a.why) : a.kind === "unknown" ? UNKNOWN : BUSY),
    offline: setOffline,
  });
  const load = async () => {
    if (TOKEN) await keeper.newest();
  };

  const showEarlier = async () => {
    if (view()?.before === undefined || earlier() === "busy") return;
    setEarlier("busy");
    const doc = document.documentElement;
    const fromBottom = doc.scrollHeight - window.scrollY;
    const r = await keeper.earlier();
    setEarlier(r === "failed" ? "Couldn't load earlier messages. Try again." : null);
    // Keep the reader's place: what they were reading stays under their eyes.
    if (r === "ok") queueMicrotask(() => window.scrollTo(0, doc.scrollHeight - fromBottom));
  };

  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = 2000;
  let stopped = false;
  const tell = (m: SessionShareClientMessage) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify(m));
  const onVisibility = () => tell({ t: "vis", on: document.visibilityState === "visible" });
  const connect = () => {
    if (!TOKEN || stopped || problem()) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/s?token=${TOKEN}&v=${VISIT}`);
    socket = ws;
    ws.onopen = () => {
      backoff = 2000;
      setOffline(false);
      onVisibility();
    };
    ws.onmessage = (e) => {
      let msg: SessionShareServerMessage;
      try {
        msg = JSON.parse(String(e.data));
      } catch {
        return;
      }
      if (msg.type === "view") keeper.push(msg.view, msg.reset === true);
      else if (msg.type === "error" && msg.code === "gone") setProblem(gone(msg.why));
    };
    ws.onclose = (e) => {
      if (socket !== ws || stopped) return;
      // The `gone` frame before this close carried the reason; keep it.
      if (e.code === SESSION_SHARE_GONE_CLOSE) return setProblem((p) => p ?? GONE);
      // The host went offline: back off from 5 s to 60 s until it answers again.
      if (e.code === HOP_LOST_CLOSE) setOffline(true);
      if (offline()) backoff = Math.max(backoff, RECONNECT_BACKOFF_MS.first);
      retry = setTimeout(() => {
        // A snapshot changes only by a push, but one missed while away is read again here.
        void load().then(connect);
      }, backoff);
      backoff = Math.min(backoff * 2, offline() ? RECONNECT_BACKOFF_MS.max : 30_000);
    };
  };

  onMount(() => {
    document.addEventListener("visibilitychange", onVisibility);
    void load().then(connect);
  });
  onCleanup(() => {
    stopped = true;
    clearTimeout(retry);
    document.removeEventListener("visibilitychange", onVisibility);
    socket?.close();
  });

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
        <SessionShareHead view={view()} />
        <Show when={offline()}>
          <p class="share-note" role="status">
            {OFFLINE}
          </p>
        </Show>
        <Show when={view()}>{(v) => <SessionThread view={v()} imageUrl={imageUrl} onEarlier={() => void showEarlier()} earlierState={earlier()} />}</Show>
      </Show>
    </main>
  );
}
