import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ASSISTANT_TEXT_MAX, type AssistantServerMessage, type AssistantView } from "../../shared/project-assistant";
import { OFFLINE_PAGE, RECONNECT_BACKOFF_MS } from "../../shared/public-links";
import { assistantProblemText, isDeadLink, OwnerLoadError } from "../lib/owner-problem";
import { keepUnchanged, nearEnd } from "../lib/share-follow";
import { batonKinds } from "./markdown";
import type { UploadRefusal } from "./photos";
import { ShareComposer, type Attachment, type SendOutcome, type Upload } from "./ShareComposer";
import { LinkedText, MessagePhotos, Reply } from "./thread";
import { VersionRows, versionsStarting } from "./versions";
import type { AbilityLine } from "../lib/owner-abilities";
import { AbilityList } from "./owner-abilities-view";

/**
 * The Project Assistant on the owner page (§app.project-assistant/chat, §app.owner-page/content):
 * a chat screen that fills the window, the greeting as its first bubble, the conversation newest at
 * the bottom, the reply as it is written, the owner's photos (§app.project-assistant/photos), the
 * assistant's drawings (§app.project-assistant/drawings), a started version's row
 * (§app.project-assistant/versions), and the composer pinned at the bottom. It renders what the
 * server sends and nothing else; the operator's preview gets it read-only.
 */

/** Its drawings: every kind a hand-off page draws, interactive ones in their frame. */
const KINDS = batonKinds(true);
/** How often the chat reads again while a version on screen is starting. */
const STARTING_MS = 3000;

export interface AssistantApi {
  load(): Promise<AssistantView>;
  /** Absent: read only (the operator's preview). `images`: staged photo ids. */
  send?(text: string, images?: string[]): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** Stage a photo (the composer's upload); absent: no photos. */
  uploadPhoto?(blob: Blob, progress: (p: number) => void): Upload<{ id: string }>;
  /** Where the view's photo `n` is served. */
  photo?(n: number): string;
  /** Live frames; returns the unsubscribe. */
  subscribe?(on: (m: AssistantServerMessage) => void): () => void;
}

/** What a refused message says to the owner (§design.copy-deck/owner-page). */
export function sendRefusal(code: string, op: string): string {
  if (code === "not-ready") return `The Project Assistant isn't ready yet. ${op} has to finish setting it up.`;
  if (code === "busy") return "Wait for the answer first.";
  if (code === "rate-limited") return "Too many messages. Wait a minute.";
  if (code === "no-photos") return PHOTOS_OFF;
  return "Your message didn't go through. Try again.";
}

/** A picture pasted or dropped while photos can't be sent (§design.copy-deck/owner-page). */
export const PHOTOS_OFF = "Photos can't be sent here.";

/** Whether any version row of the view is starting: the chat reads again until none is. */
export const anyStarting = (v: AssistantView | null): boolean => !!v?.messages.some((m) => versionsStarting(m.versions));

export function AssistantChat(props: {
  first: string;
  op: string;
  api: AssistantApi;
  /** A version's Open address; absent in the preview: Open shows, never a link. */
  versionHref?(handle: string): string;
  /** What it can do for the owner (§app.project-assistant/abilities): suggestions before the first
      message, then the What Can I Ask? sheet. Empty while it isn't ready. */
  lines?: AbilityLine[];
  /** The photos note under the sheet's list. */
  photos?: boolean;
  /** A tapped suggestion: the page sets the prefill. */
  pick?(l: AbilityLine): void;
  /** Words a tapped line starts the message box with; `takePrefill` once the box has them. */
  prefill?(): { text: string } | null;
  takePrefill?(): void;
  /** The chat's read failed on the link itself (turned off, unknown, too many requests): the page's
      own dead-link screen takes over. */
  onDeadLink?(err: OwnerLoadError): void;
}) {
  const [view, setView] = createSignal<AssistantView | null>(null);
  const [streaming, setStreaming] = createSignal("");
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal("");
  /** Why the last read failed, while it did; what was shown before stays. */
  const [problem, setProblem] = createSignal<"offline" | "unavailable" | "failed" | null>(null);
  let offlineRetry: ReturnType<typeof setTimeout> | undefined;
  let offlineDelay: number = RECONNECT_BACKOFF_MS.first;
  let list: HTMLElement | undefined;
  let box: { input: HTMLTextAreaElement; fit(): void } | undefined;
  const [boxReady, setBoxReady] = createSignal(false);
  let sheet: HTMLDialogElement | undefined;
  let sheetOpener: HTMLElement | null = null;
  /** A touch-only screen: putting the cursor in the box would raise the keyboard over the conversation. */
  const touchOnly = () => matchMedia("(hover: none) and (pointer: coarse)").matches;

  // The owner's page scrolls to its end, so the newest message ends just above the pinned composer
  // (scrollIntoView on the thread's end would tuck it under it), but only while the owner is at the
  // end: one who scrolled up to read is left there until they come back down or send. The read-only
  // preview scrolls its modal once, at its first read.
  let following = true;
  let previewScrolled = false;
  const toBottom = (force = false) =>
    queueMicrotask(() => {
      if (props.api.send) {
        if (force) following = true;
        if (following) window.scrollTo(0, document.documentElement.scrollHeight);
      } else if (!previewScrolled && list?.lastElementChild) {
        previewScrolled = true;
        list.lastElementChild.scrollIntoView({ block: "end" });
      }
    });
  if (props.api.send) {
    const onScroll = () => (following = nearEnd(window.scrollY, window.innerHeight, document.documentElement.scrollHeight));
    // A wheel up stops following at once, before its scroll event lands under a streamed frame.
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) following = false;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("wheel", onWheel, { passive: true });
    onCleanup(() => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("wheel", onWheel);
    });
  }
  const apply = (v: AssistantView) => {
    // Only what changed is drawn again: a drawing keeps its state through the re-reads.
    setView({ ...v, messages: keepUnchanged(view()?.messages ?? [], v.messages) });
    setStreaming(v.busy ? (v.streaming ?? "") : "");
    setProblem(null);
    offlineDelay = RECONNECT_BACKOFF_MS.first;
    toBottom();
  };
  const reload = () =>
    props.api
      .load()
      .then(apply)
      .catch((err: unknown) => {
        const kind = err instanceof OwnerLoadError ? err.kind : "failed";
        if (err instanceof OwnerLoadError && isDeadLink(kind)) {
          props.onDeadLink?.(err);
          return;
        }
        setProblem(kind === "offline" || kind === "unavailable" ? kind : "failed");
        // Offline: read again from 5 s, backing off to 60 s, until the host answers (as the page does).
        if (kind === "offline") {
          clearTimeout(offlineRetry);
          offlineRetry = setTimeout(() => void reload(), offlineDelay);
          offlineDelay = Math.min(offlineDelay * 2, RECONNECT_BACKOFF_MS.max);
        }
      });

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
      clearTimeout(offlineRetry);
    });
  });
  // A version on screen is starting: read again every 3 s until it runs or failed (no frame says so).
  createEffect(
    on(
      () => anyStarting(view()),
      (starting) => {
        if (!starting) return;
        const t = setInterval(() => {
          if (document.visibilityState === "visible") void reload();
        }, STARTING_MS);
        onCleanup(() => clearInterval(t));
      },
    ),
  );

  const busy = () => !!view()?.busy;
  // "Wait for the answer first." goes once the answer is done; the box still holds the text.
  createEffect(
    on(busy, (b) => {
      if (!b && error() === sendRefusal("busy", props.op)) setError("");
    }),
  );
  // A tapped line (Home's card, a suggestion, the sheet): the box starts with its words, the cursor at
  // their end (not on a touch screen). Nothing is sent until Send.
  createEffect(() => {
    const p = props.prefill?.();
    if (!p || !boxReady() || !box) return;
    setDraft(p.text);
    props.takePrefill?.();
    const input = box.input;
    queueMicrotask(() => {
      box?.fit();
      if (touchOnly()) return;
      input.focus({ preventScroll: true });
      input.setSelectionRange(p.text.length, p.text.length);
    });
  });
  const suggest = (l: AbilityLine) => {
    if (sheet?.open) sheet.close();
    props.pick?.(l);
  };
  const openSheet = (e: MouseEvent) => {
    sheetOpener = e.currentTarget as HTMLElement;
    sheet?.showModal();
  };
  const hasLines = () => !!props.lines?.length;
  const send = async (text: string, photos: Attachment[], _files: Attachment[], again: boolean): Promise<SendOutcome> => {
    if (sending() || !props.api.send) return "kept";
    // While an answer is being written nothing is sent (§app.project-assistant/chat).
    if (busy()) {
      setError(sendRefusal("busy", props.op));
      return "kept";
    }
    setSending(true);
    setError("");
    const ids = photos.flatMap((a) => (a.id ? [a.id] : []));
    const r = await props.api.send(text, ids.length ? ids : undefined).catch(() => ({ ok: false as const, code: "failed", message: "" }));
    setSending(false);
    if (!r.ok) {
      // A staged photo expired: the composer uploads it again once and resends.
      if (r.code === "photo-expired" && !again && ids.length) return { expired: "photo" };
      setError(sendRefusal(r.code, props.op));
      return "kept";
    }
    toBottom(true);
    void reload();
    box?.input.focus();
    return "sent";
  };
  const onUploadRefused = (r: UploadRefusal) => {
    // The link itself died, or photos turned off since the view was read: read again.
    if (r.status === 404 || r.status === 410 || r.code === "no-photos" || r.code === "not-ready") void reload();
  };

  const who = (role: string, name?: string) => (role === "owner" ? "You" : role === "operator" ? (name ?? props.op) : "Project Assistant");

  return (
    <>
      <header class="owner-head owner-chat-head">
        <h1 class="owner-org">Project Assistant</h1>
        <Show when={hasLines() && view()?.messages.length}>
          <button type="button" class="button button-ghost owner-ask-what" onClick={openSheet}>
            What Can I Ask?
          </button>
        </Show>
      </header>
      <Show when={view()?.ready === false}>
        <div class="banner banner-warn owner-banner" role="status">
          <span class="icon banner-icon share-icon-alert" aria-hidden="true" />
          <div class="banner-main">
            <p class="banner-body">The Project Assistant isn't ready yet. {props.op} has to finish setting it up.</p>
          </div>
        </div>
      </Show>
      <Show when={!view() && problem()}>
        {(p) => {
          const text = () => (p() === "offline" ? { title: OFFLINE_PAGE.heading, body: OFFLINE_PAGE.body, tryAgain: true } : assistantProblemText(p() as "unavailable" | "failed", props.op));
          return (
            <div class="empty owner-problem" role="alert">
              <p class="empty-title">{text().title}</p>
              <p class="empty-body">{text().body}</p>
              <Show when={text().tryAgain}>
                <button type="button" class="button empty-action" onClick={() => void reload()}>
                  Try Again
                </button>
              </Show>
            </div>
          );
        }}
      </Show>
      <section class="owner-thread owner-assistant" aria-label="Conversation with the Project Assistant" aria-live="polite" ref={list}>
        <Show when={view()}>
          <article class="share-msg share-msg-reply" aria-label="Project Assistant">
            <span class="share-who">Project Assistant</span>
            <p class="share-text">Hi {props.first}. I know your projects and what has been agreed so far. Ask me anything, tell me about a problem, or ask for something new.</p>
          </article>
          <Show when={hasLines() && !view()!.messages.length && !busy()}>
            <ul class="owner-suggestions" aria-label="Suggestions">
              <For each={props.lines}>
                {(l) => (
                  <li>
                    <button type="button" class="button owner-suggestion" onClick={() => suggest(l)}>
                      {l.name}
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Show>
        <For each={view()?.messages ?? []}>
          {(m) => (
            <article class="share-msg" classList={{ "share-msg-own": m.role === "owner", "share-msg-reply": m.role === "assistant" }} aria-label={who(m.role, m.name)}>
              <span class="share-who" classList={{ "visually-hidden": m.role === "owner" }}>
                {who(m.role, m.name)}
              </span>
              <Show when={m.images?.length && props.api.photo}>
                <MessagePhotos srcs={m.images!.map((p) => props.api.photo!(p.n))} from="you" own />
              </Show>
              <Show when={m.role === "assistant"} fallback={<Show when={m.text}><LinkedText text={m.text} /></Show>}>
                <Reply text={m.text} kinds={KINDS} />
              </Show>
              <Show when={m.versions?.length}>
                <VersionRows versions={m.versions!} href={props.versionHref} />
              </Show>
            </article>
          )}
        </For>
        <Show when={busy()}>
          <article class="share-msg share-msg-reply" aria-label="Project Assistant, writing">
            <span class="share-who">Project Assistant · writing</span>
            <Show when={streaming()} fallback={<p class="owner-meta">Writing…</p>}>
              <Reply text={streaming()} streaming kinds={KINDS} />
            </Show>
          </article>
        </Show>
      </section>
      {/* The message box only once the chat's view has loaded: before that, nothing it sends could land. */}
      <Show when={props.api.send && view()}>
          <ShareComposer
            class="owner-assistant-composer"
            id="assistant-text"
            label="Your message"
            placeholder="Write a message"
            maxLength={ASSISTANT_TEXT_MAX}
            sendKey="enter"
            draft={draft}
            setDraft={setDraft}
            error={() => error() || null}
            photos={() => (props.api.uploadPhoto ? (view()?.photos ?? null) : null)}
            uploadPhoto={(blob, progress) => props.api.uploadPhoto!(blob, progress)}
            onUploadRefused={onUploadRefused}
            photosOff={PHOTOS_OFF}
            blocked={() => busy() || view()?.ready === false}
            sending={sending}
            send={send}
            ref={(b) => {
              box = b;
              setBoxReady(true);
              onCleanup(() => setBoxReady(false));
              // The composer growing (an error line, the photo strip, a longer text) would cover the
              // newest message: while following, the page keeps its end in view.
              const form = b.input.closest("form");
              if (form && typeof ResizeObserver !== "undefined") {
                const ro = new ResizeObserver(() => toBottom());
                ro.observe(form);
                onCleanup(() => ro.disconnect());
              }
              // Opened to chat: the box takes focus, except on a touch-only screen, where that would
              // raise the keyboard over the conversation (as Sova's own composer).
              if (!matchMedia("(hover: none) and (pointer: coarse)").matches) requestAnimationFrame(() => b.input.focus({ preventScroll: true }));
            }}
          />
      </Show>
      <Show when={hasLines()}>
        <dialog
          ref={(el) => {
            sheet = el;
            // Native, not Solid's delegated keydown: Esc closes the sheet and stops here, so a modal
            // around the page (the operator's preview) stays open.
            const onKey = (e: KeyboardEvent) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              e.stopPropagation();
              el.close();
            };
            el.addEventListener("keydown", onKey);
            onCleanup(() => el.removeEventListener("keydown", onKey));
          }}
          class="modal owner-sheet"
          aria-labelledby="owner-sheet-title"
          onClose={() => {
            if (sheetOpener?.isConnected && !props.prefill?.()) sheetOpener.focus();
            sheetOpener = null;
          }}
          onClick={(e) => {
            // The backdrop is the dialog itself.
            if (e.target === e.currentTarget) sheet?.close();
          }}
        >
          <div class="sheet-grip" aria-hidden="true" />
          <div class="modal-head">
            <h2 class="modal-title" id="owner-sheet-title">
              What it can do for you
            </h2>
          </div>
          <div class="modal-body">
            <AbilityList lines={props.lines!} photos={props.photos} pick={suggest} />
          </div>
          <div class="modal-foot">
            <button type="button" class="button" onClick={() => sheet?.close()}>
              Close
            </button>
          </div>
        </dialog>
      </Show>
    </>
  );
}
