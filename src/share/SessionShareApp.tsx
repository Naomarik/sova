import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { HOP_LOST_CLOSE, RECONNECT_BACKOFF_MS } from "../../shared/public-links";
import {
  SESSION_SHARE_GONE_CLOSE,
  type SessionShareClientMessage,
  type SessionShareImageRef,
  type SessionShareItem,
  type SessionShareLookbook,
  type SessionShareServerMessage,
  type SessionShareView,
} from "../../shared/session-share";
import { earlierLine, ShareViewKeeper, type ShareAnswer } from "../lib/share-slice";
import { createOpenDesign, DesignOverlay, LookbookBlock } from "./Lookbook";
import { DesignPage } from "./DesignPage";
import { designHash, findDesign, parseDesignHash, parseDesignQuery, placeLookbooks, shareDesignUrls, type DesignAddress, type DesignUrls } from "./lookbook-model";
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
/** `?design=<label>[&v=<n>]`: one design on its own page (Open in New Tab), not the conversation. */
const DESIGN = parseDesignQuery(location.search);
const storage = (): Storage | null => {
  try {
    return sessionStorage;
  } catch {
    return null;
  }
};

export type Problem = { title: string; body: string };
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
  /** Where its designs are drawn from; absent: no Lookbook shows (an older caller). */
  designs?: DesignUrls;
  /** Keep the open design in the page's address (the share page only, never inside the app). */
  remember?: boolean;
}) {
  const placed = createMemo(() => (props.designs ? placeLookbooks(props.view) : { top: [], after: new Map() }));
  const open = createOpenDesign(!!props.remember, () => parseDesignHash(location.hash), {
    push: (a) => history.pushState(history.state, "", `${location.pathname}${location.search}${designHash(a)}`),
    replace: (a) => history.replaceState(history.state, "", `${location.pathname}${location.search}${a ? designHash(a) : ""}`),
    back: () => history.back(),
  });
  const shown = createMemo(() => {
    const a = open.open();
    if (!a || !props.designs) return null;
    const hit = findDesign(props.view.lookbooks, a.label);
    if (!hit || (a.v && !hit.design.versions.some((x) => x.n === a.v))) return null;
    return { at: a, lookbook: hit.lookbook, urls: props.designs };
  });
  // A version no longer shared (an address kept from before Update to Now) opens its block instead.
  createEffect(() => {
    const a = open.open();
    if (!a?.v || shown() || !props.designs) return;
    const hit = findDesign(props.view.lookbooks, a.label);
    if (!hit) return;
    open.close();
    queueMicrotask(() => document.getElementById(`lookbook-${hit.lookbook.id}`)?.scrollIntoView({ block: "start" }));
  });
  const blocks = (list: readonly SessionShareLookbook[] | undefined) => (
    <Show when={props.designs && list?.length}>
      <For each={list}>{(lb) => <LookbookBlock lookbook={lb} urls={props.designs!} onOpen={(a: DesignAddress) => open.show(a)} />}</For>
    </Show>
  );
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
        {blocks(placed().top)}
        <For each={props.view.items}>
          {(it) => (
            <>
              <Item item={it} imageUrl={props.imageUrl} />
              {blocks(placed().after.get(it.n))}
            </>
          )}
        </For>
      </Show>
      {/* Not keyed: a push or a move changes what it shows, never closes it. */}
      <Show when={shown()}>
        {(o) => <DesignOverlay lookbook={o().lookbook} at={o().at} urls={o().urls} onMove={(a) => open.show(a)} onBack={() => open.close()} />}
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

/** What a share page reads: the view as the keeper holds it, the page's problem, and whether the
    host is offline, kept current by its socket. The conversation and a design's own page both use it. */
export interface SessionFeed {
  view(): SessionShareView | null;
  problem(): Problem | null;
  offline(): boolean;
  earlier(): "busy" | string | null;
  /** Show Earlier; "ok", "none" or "failed" as the keeper said. */
  showEarlier(keepPlace: boolean): Promise<string>;
}

function createSessionFeed(opts: { onView?(v: SessionShareView, first: boolean): void }): SessionFeed {
  const VISIT = visitTab(storage());
  const [view, setView] = createSignal<SessionShareView | null>(null);
  const [problem, setProblem] = createSignal<Problem | null>(TOKEN ? null : UNKNOWN);
  const [offline, setOffline] = createSignal(false);
  const [earlier, setEarlier] = createSignal<"busy" | string | null>(null);

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
      const first = view() === null;
      opts.onView?.(v, first);
      setView(v);
    },
    problem: (a) => setProblem(a.kind === "gone" ? gone(a.why) : a.kind === "unknown" ? UNKNOWN : BUSY),
    offline: setOffline,
  });
  const load = async () => {
    if (TOKEN) await keeper.newest();
  };

  const showEarlier = async (keepPlace: boolean): Promise<string> => {
    if (view()?.before === undefined || earlier() === "busy") return "none";
    setEarlier("busy");
    const doc = document.documentElement;
    const fromBottom = doc.scrollHeight - window.scrollY;
    const r = await keeper.earlier();
    setEarlier(r === "failed" ? "Couldn't load earlier messages. Try again." : null);
    // Keep the reader's place: what they were reading stays under their eyes.
    if (r === "ok" && keepPlace) queueMicrotask(() => window.scrollTo(0, doc.scrollHeight - fromBottom));
    return r;
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
  return { view, problem, offline, earlier, showEarlier };
}

/** A dead, unknown or busy link's whole page. */
export function ProblemPage(props: { problem: Problem }) {
  return (
    <div class="empty share-empty">
      <p class="empty-title">{props.problem.title}</p>
      <p class="empty-body">{props.problem.body}</p>
    </div>
  );
}

export function SessionShareApp() {
  return TOKEN && DESIGN ? <DesignPageApp token={TOKEN} at={DESIGN} /> : <ConversationApp />;
}

/** One design on its own page, under the share link: the same wall, and it dies with the link. */
function DesignPageApp(props: { token: string; at: DesignAddress }) {
  const feed = createSessionFeed({});
  return <DesignPage token={props.token} first={props.at} feed={feed} urls={shareDesignUrls(props.token)} />;
}

function ConversationApp() {
  /** Near the bottom when a live push lands: stay there, so new messages come into view. */
  const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80;
  const feed = createSessionFeed({
    onView: (v, first) => {
      const pin = !first && atBottom();
      document.title = v.title;
      if (pin) queueMicrotask(() => window.scrollTo(0, document.documentElement.scrollHeight));
    },
  });
  const imageUrl = (n: number) => `/api/s/${TOKEN}/img/${n}`;
  const designs = TOKEN ? shareDesignUrls(TOKEN) : undefined;

  return (
    <main class="share">
      <Show when={!feed.problem()} fallback={<ProblemPage problem={feed.problem()!} />}>
        <SessionShareHead view={feed.view()} />
        <Show when={feed.offline()}>
          <p class="share-note" role="status">
            {OFFLINE}
          </p>
        </Show>
        <Show when={feed.view()}>{(v) => <SessionThread view={v()} imageUrl={imageUrl} onEarlier={() => void feed.showEarlier(true)} earlierState={feed.earlier()} designs={designs} remember />}</Show>
      </Show>
    </main>
  );
}
