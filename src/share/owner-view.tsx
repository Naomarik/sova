import { createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import type { OwnerConversation, OwnerConversationOlder, OwnerDecision, OwnerHome, OwnerHomeConversation, OwnerNews, OwnerProject, OwnerWaiting } from "../../shared/owner";
import type { BatonViewItem } from "../../shared/baton";
import { OFFLINE_PAGE, RECONNECT_BACKOFF_MS } from "../../shared/public-links";
import {
  builtLine,
  byTopic,
  conversationChip,
  count,
  DECISION_CHIP,
  differenceLine,
  factsLine,
  type OwnerChipWord,
  type OwnerRoute,
  type OwnerTab,
  ownerTab,
  personLine,
  readsHome,
  plainAgo,
  plainDate,
  projectChip,
  waitingLine,
  conversationTabs,
  historyLine,
  ownerTabTitle,
} from "../lib/owner-words";
import { isNewSince, visitBaseline, type KeyStore } from "../lib/owner-seen";
import { emptyPaged, hasOlder, mergeNewest, prependOlder, type Paged } from "../lib/paged";
import { createOlderLoader } from "./load-older";
import { ShareBrand } from "./brand";
import { Dynamic } from "solid-js/web";
import { stampTime } from "../lib/format";
import { Item, LinkedText } from "./thread";
import { AssistantChat, type AssistantApi } from "./assistant-view";
import { VersionRows, versionsStarting } from "./versions";
import type { OwnerRequestRow, OwnerVersionRow } from "../../shared/project-assistant";
import { isDeadLink, OwnerLoadError, type OwnerProblemKind } from "../lib/owner-problem";
import { type AbilityLine, abilityLines, openCount, requestsLine } from "../lib/owner-abilities";
import { AbilityList, Chevron } from "./owner-abilities-view";
import { ShareComposer, type SendOutcome } from "./ShareComposer";
import { Reply } from "./thread";
import { batonKinds } from "./markdown";

/** The owner's own feature request chat (§app.project-assistant/feature-chats): their message and End Chat, by the
    conversation's handle; absent in the preview (read only). */
export interface FeatureApi {
  send(conversation: string, text: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  end(conversation: string): Promise<boolean>;
}

/** The owner closes and reopens their own requests (§app.project-assistant/closing); absent (the preview): no buttons. */
export interface RequestsApi {
  act(handle: string, action: "close" | "reopen"): Promise<boolean>;
}

/**
 * The Owner page (§app.owner-page/page): Home, a project, a conversation. Read-only. It renders
 * what the server sends and nothing else; the share build (OwnerApp, from the link) and the
 * operator's preview (from the preview route) feed it the same answers, so they show the same page.
 */

export { OwnerLoadError, type OwnerProblemKind };

export type OwnerAnswer = OwnerHome | OwnerProject | OwnerConversation;

const PROBLEM: Record<Exclude<OwnerProblemKind, "missing" | "offline" | "unavailable" | "failed">, { title: string; body: string }> = {
  expired: { title: "This link turned off after a week without use.", body: "It turns itself off so nobody else can use it later. You can ask for a new one." },
  gone: { title: "This link is no longer active.", body: "Ask the person who sent it for a new one." },
  unknown: { title: "This link doesn't open anything.", body: "Check that you copied all of it." },
  busy: { title: "Too many requests from this network.", body: "Wait a minute, then reload." },
};

/** How often the page reads again while it is visible. */
const REFRESH_MS = 60_000;
/** How often Home reads again while a version on it is starting (§app.project-assistant/versions). */
const STARTING_MS = 3000;
const FIRST = 5;

export function OwnerPage(props: {
  route: OwnerRoute;
  load(route: OwnerRoute): Promise<OwnerAnswer>;
  /** A route's link: the hash on the share page. */
  href(route: OwnerRoute): string;
  /** Set in the preview: follow a link in place instead of through the URL. */
  go?(route: OwnerRoute): void;
  /** The operator's preview: no refresh, no footer about the link. */
  preview?: boolean;
  /** Explicit current-conversation scope, supplied independently by public and operator hosts. */
  tourBase?(conversation: string, handle: string): string;
  /** The page's title, for the browser tab. */
  onTitle?(title: string): void;
  /** Ask for a new link, from a link that turned off unused (§app.owner-page/link); true once asked. */
  ask?(): Promise<boolean>;
  /** The Project Assistant's conversation (§app.project-assistant/chat); read only without `send`. */
  assistant?: AssistantApi;
  /** A version's Open address (`/i/<token>/v/<handle>`); absent in the preview: no Open. */
  versionHref?(handle: string): string;
  /** The owner's feature request chat writes through this; absent: read only. */
  feature?: FeatureApi;
  /** Close and Reopen on the Requests tab; absent: read only. */
  requests?: RequestsApi;
  /** A conversation's earlier items (§app.owner-page/content); absent: an older server, no paging. */
  olderItems?(conversation: string, before: number): Promise<OwnerConversationOlder>;
  /** This browser's stores for "new since your last visit"; absent (the preview): nothing is marked new. */
  seen?: { local: KeyStore; session: KeyStore };
}) {
  const key = createMemo(() => JSON.stringify(props.route));
  const [answer, setAnswer] = createSignal<OwnerAnswer | null>(null);
  const [problem, setProblem] = createSignal<OwnerProblemKind | null>(null);
  /** The ask's state on a link that turned off unused: idle, sending, asked (now or before), failed. */
  const [asking, setAsking] = createSignal<"idle" | "sending" | "asked" | "failed">("idle");
  const askNow = async () => {
    if (!props.ask || asking() === "sending") return;
    setAsking("sending");
    setAsking((await props.ask().catch(() => false)) ? "asked" : "failed");
  };
  const [now, setNow] = createSignal(Date.now());
  /** The newest Home answer: the tabs' count and the chat's suggestions, on every route. */
  const [home, setHome] = createSignal<OwnerHome | null>(null);
  /** What a tapped line starts in the chat's message box; taken once the box has it. In memory, never in the address. */
  const [prefill, setPrefill] = createSignal<{ text: string } | null>(null);
  /** The owner is typing in the chat on a touch screen: the tab bar steps aside for the keyboard. */
  const [typing, setTyping] = createSignal(false);
  let seq = 0;
  let offlineRetry: ReturnType<typeof setTimeout> | undefined;
  let offlineDelay: number = RECONNECT_BACKOFF_MS.first;
  /** Read the current route. Only the newest read lands; a failed refresh keeps what was shown. */
  const read = async () => {
    const mine = ++seq;
    const route = JSON.parse(key()) as OwnerRoute;
    try {
      const d = await props.load(route);
      if (mine !== seq) return;
      setAnswer(d);
      if ("projects" in d) setHome(d);
      setProblem(null);
      setNow(Date.now());
      offlineDelay = RECONNECT_BACKOFF_MS.first;
    } catch (err) {
      if (mine !== seq) return;
      const kind = err instanceof OwnerLoadError ? err.kind : "failed";
      if (err instanceof OwnerLoadError && err.asked) setAsking("asked");
      setProblem(kind);
      // Offline: read again from 5 s, backing off to 60 s, until the host answers.
      if (kind === "offline" && !props.preview) {
        clearTimeout(offlineRetry);
        offlineRetry = setTimeout(() => void read(), offlineDelay);
        offlineDelay = Math.min(offlineDelay * 2, RECONNECT_BACKOFF_MS.max);
      }
    }
  };
  onCleanup(() => clearTimeout(offlineRetry));
  createEffect(
    on(key, () => {
      setProblem(null);
      void read();
    }),
  );
  onMount(() => {
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(tick));
    if (props.preview) return;
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") void read();
    }, REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && void read();
    document.addEventListener("visibilitychange", onVisible);
    onCleanup(() => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisible);
    });
  });

  const link = (r: OwnerRoute) => ({
    href: props.href(r),
    onClick: (e: MouseEvent) => {
      if (!props.go || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      props.go(r);
    },
  });
  /** The answer for this route: after a route change the old one stays in the signal until the new
      one lands, so only an answer of this route's kind and handle shows. */
  const current = () => {
    const d = answer();
    if (!d) return undefined;
    const r = props.route;
    if (readsHome(r) && "projects" in d) return d;
    if (r.kind === "project" && "people" in d && d.id === r.id) return d;
    if (r.kind === "conversation" && "items" in d && d.id === r.id) return d;
    return undefined;
  };
  // A version on Home is starting: every tab of Home's family reads again every 3 s until it runs or failed.
  createEffect(
    on(
      () => !props.preview && readsHome(props.route) && versionsStarting((current() as OwnerHome | undefined)?.versions),
      (starting) => {
        if (!starting) return;
        const t = setInterval(() => {
          if (document.visibilityState === "visible") void read();
        }, STARTING_MS);
        onCleanup(() => clearInterval(t));
      },
    ),
  );
  /** A dead or unknown link: nothing of the page stays. */
  const deadLink = () => {
    const p = problem();
    return isDeadLink(p) ? PROBLEM[p] : null;
  };
  /** How many conversations wait on the owner: the Home tab's badge and the browser tab's title. */
  const waitingCount = () => home()?.waiting.length ?? 0;
  createEffect(() => {
    const d = current();
    if (d) props.onTitle?.(ownerTabTitle(d.org.name, waitingCount()));
  });
  // New since this browser's previous visit (§app.owner-page/content): its starting point, once per organization.
  const orgName = createMemo(() => home()?.org.name ?? null);
  const base = createMemo(() => {
    const name = orgName();
    return name && props.seen && !props.preview ? visitBaseline(name, props.seen.local, props.seen.session) : null;
  });
  const isNew = (at: string | undefined) => isNewSince(at, base());
  /** Follow a route from a control that isn't a link (a tapped line). */
  const navigate = (r: OwnerRoute) => {
    if (props.go) props.go(r);
    else location.hash = props.href(r);
  };
  /** A tapped line or suggestion: the chat, its message box started with the line's words. */
  const pick = (l: AbilityLine) => {
    setPrefill({ text: l.prefill });
    if (props.route.kind !== "assistant") navigate({ kind: "assistant" });
  };
  const lines = createMemo(() => {
    const h = home();
    return h && h.assistant?.ready !== false ? abilityLines(h.projects, h.abilities) : [];
  });
  const tabs = () => !!props.assistant && !deadLink();
  const touchOnly = () => typeof matchMedia === "function" && matchMedia("(hover: none) and (pointer: coarse)").matches;
  const isComposer = (t: EventTarget | null) => t instanceof HTMLTextAreaElement && !!t.closest(".owner-assistant-composer");
  const tryAgain = (
    <button type="button" class="button empty-action" onClick={() => void read()}>
      Try Again
    </button>
  );

  return (
    // The chat (#a) fills the window's height, its composer pinned at the bottom; never in the preview's modal.
    <Dynamic
      component={props.preview ? "div" : "main"}
      class="owner-page"
      classList={{ "owner-page-tabs": tabs() && !props.preview, "owner-page-preview": !!props.preview, "owner-typing": typing() }}
      onFocusIn={(e: FocusEvent) => isComposer(e.target) && touchOnly() && setTyping(true)}
      onFocusOut={(e: FocusEvent) => isComposer(e.target) && setTyping(false)}
    >
      <div class="owner-shell">
      <Show when={tabs() && props.preview}>
        <OwnerTabs tab={ownerTab(props.route)} open={openCount(home()?.requests)} waiting={waitingCount()} link={link} preview />
      </Show>
      <div class="owner" classList={{ "owner-chat": props.route.kind === "assistant" && !props.preview }}>
      <Show
        when={!deadLink()}
        fallback={
          <>
          <ShareBrand class="owner-topbar owner-topbar-always" themeSwitch={!props.preview} />
          <div class="empty owner-problem" role="alert">
            <p class="empty-title">{deadLink()!.title}</p>
            <p class="empty-body">{deadLink()!.body}</p>
            <Show when={problem() === "expired" && props.ask}>
              <Show
                when={asking() === "asked"}
                fallback={
                  <>
                    <button type="button" class="button button-primary empty-action" disabled={asking() === "sending"} onClick={() => void askNow()}>
                      Ask for a New Link
                    </button>
                    <Show when={asking() === "failed"}>
                      <p class="empty-body">That didn't go through. Try again in a minute.</p>
                    </Show>
                  </>
                }
              >
                <p class="empty-body owner-asked" role="status">
                  You asked for a new link. It will come the same way this one did.
                </p>
              </Show>
            </Show>
          </div>
          </>
        }
      >
        <Show when={!current()}>
          <ShareBrand class="owner-topbar" themeSwitch={!props.preview} />
        </Show>
        <Show when={(problem() === "failed" || problem() === "offline") && current()}>
          <div class="banner banner-warn owner-banner" role="alert">
            <span class="icon banner-icon share-icon-alert" aria-hidden="true" />
            <div class="banner-main">
              <p class="banner-body">
                {problem() === "offline" ? OFFLINE_PAGE.body : "We couldn't load this page. Your link still works. Try again in a minute."}
              </p>
            </div>
            <button type="button" class="button button-sm banner-action" onClick={() => void read()}>
              Try Again
            </button>
          </div>
        </Show>
        <Show
          when={problem() !== "missing" && current()}
          fallback={
            <Show when={problem()} fallback={<Loading />}>
              <Show when={!readsHome(props.route)}>
                <a class="owner-back" {...link({ kind: "home" })}>
                  ← All projects
                </a>
              </Show>
              <div class="empty owner-problem" role="alert">
                <Show
                  when={problem() === "missing"}
                  fallback={
                    <Show
                      when={problem() === "offline"}
                      fallback={
                        <>
                          <p class="empty-title">We couldn't load this page.</p>
                          <p class="empty-body">Your link still works. Try again in a minute.</p>
                          {tryAgain}
                        </>
                      }
                    >
                      <p class="empty-title">{OFFLINE_PAGE.heading}</p>
                      <p class="empty-body">{OFFLINE_PAGE.body}</p>
                      {tryAgain}
                    </Show>
                  }
                >
                  <p class="empty-title">This isn't on your page.</p>
                  <p class="empty-body">Go back to all your projects to see what is.</p>
                </Show>
              </div>
            </Show>
          }
        >
          {(d) => (
            // Each read reaches the view: the answers are read through `d()` (a non-keyed Show calls this once).
            <>
            {/* Its frame (§app.owner-page/content): Sova's mark small at the top, the organization's name the main heading. */}
            <header class="owner-frame">
              <ShareBrand class="owner-topbar" themeSwitch={!props.preview} />
              <h1 class="owner-org owner-org-name">{d().org.name}</h1>
            </header>
            <Switch>
              <Match when={"projects" in d() && props.route.kind === "assistant" && props.assistant}>
                {(api) => (
                  <AssistantChat
                    first={(d() as OwnerHome).owner.first}
                    op={(d() as OwnerHome).operator.first}
                    api={api()}
                    versionHref={props.versionHref}
                    lines={lines()}
                    photos={!!(d() as OwnerHome).abilities?.photos}
                    pick={pick}
                    prefill={prefill}
                    takePrefill={() => setPrefill(null)}
                    conversationLink={(id) => link({ kind: "conversation", id })}
                    onDeadLink={(err) => {
                      // The link itself failed on the chat's read: the page's own dead-link screen.
                      if (err.asked) setAsking("asked");
                      setProblem(err.kind);
                    }}
                  />
                )}
              </Match>
              <Match when={"projects" in d() && props.route.kind === "requests"}>
                <RequestsView home={d() as OwnerHome} now={now()} link={link} api={props.preview ? undefined : props.requests} reload={() => void read()} isNew={isNew} />
              </Match>
              <Match when={"projects" in d()}>
                <HomeView home={d() as OwnerHome} now={now()} link={link} preview={props.preview} versionHref={props.versionHref} assistant={!!props.assistant} lines={lines()} pick={pick} isNew={isNew} />
              </Match>
              <Match when={"people" in d()}>
                <ProjectView project={d() as OwnerProject} now={now()} link={link} isNew={isNew} versions={(home()?.versions ?? []).filter((v) => v.project === (d() as OwnerProject).name)} versionHref={props.versionHref} />
              </Match>
              <Match when={true}>
                <ConversationView
                  conv={d() as OwnerConversation}
                  now={now()}
                  link={link}
                  tourBase={props.tourBase}
                  feature={props.preview ? undefined : props.feature}
                  subscribe={props.preview ? undefined : props.assistant?.subscribe}
                  older={props.olderItems}
                  reload={() => void read()}
                />
              </Match>
            </Switch>
            </>
          )}
        </Show>
      </Show>
      </div>
      <Show when={tabs() && !props.preview}>
        <OwnerTabs tab={ownerTab(props.route)} open={openCount(home()?.requests)} waiting={waitingCount()} link={link} />
      </Show>
      </div>
    </Dynamic>
  );
}

type Link = (r: OwnerRoute) => { href: string; onClick(e: MouseEvent): void };

/** Each tab's icon (the design system's home, chat and file), drawn fresh for each use. */
const TAB_ICON: Record<OwnerTab, () => JSX.Element> = {
  home: () => <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />,
  assistant: () => <path d="M20 12a7 7 0 0 1-7 7H8l-4 3v-4.5A7 7 0 0 1 8 5h5a7 7 0 0 1 7 7z" />,
  requests: () => (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
};
const TABS: readonly { id: OwnerTab; label: string; route: OwnerRoute }[] = [
  { id: "home", label: "Home", route: { kind: "home" } },
  { id: "assistant", label: "Assistant", route: { kind: "assistant" } },
  { id: "requests", label: "Requests", route: { kind: "requests" } },
];

/** The page's three tabs (§app.owner-page/content): a bar at the bottom on a phone, a sidebar on a
    computer; in the operator's preview, a row of tabs at the top of the modal. */
function OwnerTabs(props: { tab: OwnerTab; open: number; waiting: number; link: Link; preview?: boolean }) {
  const label = (t: (typeof TABS)[number]) =>
    t.id === "requests" && props.open ? `Requests, ${props.open} open` : t.id === "home" && props.waiting ? `Home, ${props.waiting} waiting on you` : t.label;
  /** A tab's badge: Requests' open count, Home's waiting-on-you count (§app.owner-page/content). */
  const badge = (t: (typeof TABS)[number]) => (t.id === "requests" ? props.open : t.id === "home" ? props.waiting : 0);
  return (
    <Show
      when={!props.preview}
      fallback={
        <nav class="tabs owner-preview-tabs" aria-label="Page">
          <For each={TABS}>
            {(t) => (
              <a class="tab" classList={{ "tab-active": props.tab === t.id }} aria-current={props.tab === t.id ? "page" : undefined} aria-label={label(t)} {...props.link(t.route)}>
                {t.label}
                <Show when={badge(t)}>
                  <span class="owner-badge" aria-hidden="true">{badge(t)}</span>
                </Show>
              </a>
            )}
          </For>
        </nav>
      }
    >
      <nav class="owner-nav" aria-label="Page">
        {/* On a computer, the top of the sidebar carries Sova's mark and the theme switch (§app.owner-page/content). */}
        <ShareBrand class="owner-nav-brand" themeSwitch />
        <For each={TABS}>
          {(t) => (
            <a class="navitem" aria-current={props.tab === t.id ? "page" : undefined} aria-label={label(t)} {...props.link(t.route)}>
              <span class="owner-nav-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  {TAB_ICON[t.id]()}
                </svg>
                <Show when={badge(t)}>
                  <span class="owner-badge" aria-hidden="true">{badge(t)}</span>
                </Show>
              </span>
              <span class="navitem-label">{t.label}</span>
              <Show when={badge(t)}>
                <span class="owner-badge owner-badge-end" aria-hidden="true">{badge(t)}</span>
              </Show>
            </a>
          )}
        </For>
      </nav>
    </Show>
  );
}


function Loading() {
  return (
    <div class="owner-skeleton" aria-busy="true" aria-label="Loading">
      <div class="skeleton skeleton-title" />
      <div class="skeleton skeleton-line" />
      <div class="skeleton skeleton-row" />
      <div class="skeleton skeleton-row" />
    </div>
  );
}

function ChipWord(props: { chip: OwnerChipWord }) {
  return (
    <span class={`chip${props.chip.tone ? ` chip-${props.chip.tone}` : ""}`}>
      <i class="chip-dot" />
      {props.chip.word}
    </span>
  );
}

/** Changed since this browser's previous visit (§app.owner-page/content): a quiet chip, the word always. */
function NewChip(props: { when: boolean }) {
  return (
    <Show when={props.when}>
      <span class="chip chip-info owner-new">
        <i class="chip-dot" />
        New
      </span>
    </Show>
  );
}

function Ago(props: { at: string; now: number }) {
  return <time title={stampTime(props.at, props.now)}>{plainAgo(props.at, props.now)}</time>;
}

function Section(props: { id: string; title: string; line?: JSX.Element; attention?: boolean; h1?: boolean; children: JSX.Element }) {
  return (
    <section class="owner-section" classList={{ "owner-attention": props.attention }} aria-labelledby={props.id}>
      <div class="owner-section-head">
        <Dynamic component={props.h1 ? "h1" : "h2"} class="owner-h2" id={props.id}>
          {props.title}
        </Dynamic>
        <Show when={props.line}>
          <p class="owner-note">{props.line}</p>
        </Show>
      </div>
      {props.children}
    </section>
  );
}


/** Rows waiting on the owner. Read-only in v1: they answer through the link the operator sent. */
function WaitingSection(props: { waiting: OwnerWaiting[]; op: string; now: number; link: Link; withProject: boolean }) {
  return (
    <Section
      id="owner-waiting"
      title="Waiting on you"
      attention
      line={`${waitingLine(props.waiting.length)} Open it to answer here.`}
    >
      <ul class="owner-list">
        <For each={props.waiting}>
          {(w) => (
            <li>
              <a class="owner-row" {...props.link({ kind: "conversation", id: w.conversation })}>
                <span class="owner-row-main">
                  <span class="owner-row-title">{w.publicTitle}</span>
                  <span class="owner-meta">
                    {props.withProject ? `${w.projectName} · ` : ""}asked <Ago at={w.askedAt} now={props.now} />
                  </span>
                </span>
                <Chevron />
              </a>
            </li>
          )}
        </For>
      </ul>
    </Section>
  );
}

/** The kind and status words of a request (§design.copy-deck/owner-page). */
const REQUEST_KIND: Record<OwnerRequestRow["kind"], string> = { bug: "Problem", outage: "App down", question: "Question", feature: "New feature", fix: "Fix", deploy: "Release", try: "Version to try" };
const REQUEST_STATUS: Record<OwnerRequestRow["status"], OwnerChipWord> = {
  "with-team": { word: "With the team", tone: "info" },
  started: { word: "Being worked on", tone: "info" },
  done: { word: "Done", tone: "success" },
  declined: { word: "Not planned", tone: undefined },
  closed: { word: "Closed", tone: undefined },
};

const isOpenRow = (r: OwnerRequestRow): boolean => r.status === "with-team" || r.status === "started";

function RequestRow(props: { r: OwnerRequestRow; now: number; api?: RequestsApi; busy: boolean; isNew?: boolean; onClose(r: OwnerRequestRow): void; onReopen(r: OwnerRequestRow): void }) {
  const r = () => props.r;
  const closed = () => r().status === "closed";
  return (
    <li class="owner-row owner-row-static" classList={{ "owner-row-closed": closed() }}>
      <span class="owner-row-main">
        <span class="owner-row-title">{r().title}</span>
        <span class="owner-meta">
          {REQUEST_KIND[r().kind]} · {r().project} · <Show when={closed()} fallback={<Ago at={r().at} now={props.now} />}>
            {r().closedBy === "assistant" ? "Closed by your Project Assistant" : "Closed by you"} · <Ago at={r().at} now={props.now} />
          </Show>
        </span>
      </span>
      <ChipWord chip={r().plan === "planning" ? { word: "Planning with you", tone: "info" } : r().plan === "agreed" ? { word: "Plan agreed", tone: "success" } : REQUEST_STATUS[r().status]} />
      <NewChip when={!!props.isNew} />
      <Show when={props.api && isOpenRow(r())}>
        <button type="button" class="button button-ghost owner-request-act" disabled={props.busy} aria-label={`Close: ${r().title}`} onClick={() => props.onClose(r())}>
          Close
        </button>
      </Show>
      <Show when={props.api && closed()}>
        <button type="button" class="button owner-request-act" disabled={props.busy} aria-label={`Reopen: ${r().title}`} onClick={() => props.onReopen(r())}>
          Reopen
        </button>
      </Show>
    </li>
  );
}

/** The owner's requests (§app.project-assistant/requests): the rest newest first, then the ones they closed under a
    greyed Closed group, each with Reopen; an open one has Close, asked first in a sheet (§app.project-assistant/closing). */
function RequestsSection(props: { requests: OwnerRequestRow[]; now: number; heading?: boolean; api?: RequestsApi; reload?(): void; isNew?(at: string | undefined): boolean }) {
  const rest = () => props.requests.filter((r) => r.status !== "closed");
  const closed = () => props.requests.filter((r) => r.status === "closed");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [asking, setAsking] = createSignal<OwnerRequestRow | null>(null);
  let sheet: HTMLDialogElement | undefined;
  let opener: HTMLElement | null = null;
  const act = async (r: OwnerRequestRow, action: "close" | "reopen") => {
    if (!props.api || busy()) return;
    setBusy(true);
    setError(null);
    const ok = await props.api.act(r.handle, action).catch(() => false);
    setBusy(false);
    if (ok) props.reload?.();
    else setError("That didn't go through. Try again in a minute.");
  };
  const askClose = (r: OwnerRequestRow) => {
    opener = document.activeElement as HTMLElement | null;
    setAsking(r);
    sheet?.showModal();
  };
  const confirmClose = () => {
    const r = asking();
    sheet?.close();
    if (r) void act(r, "close");
  };
  const rowOf = (r: OwnerRequestRow) => <RequestRow r={r} now={props.now} api={props.api} busy={busy()} isNew={props.isNew?.(r.at)} onClose={askClose} onReopen={(x) => void act(x, "reopen")} />;
  return (
    <>
      <Section id="owner-requests" title="Your requests" h1={props.heading}>
        <Show when={rest().length} fallback={<p class="owner-empty">Nothing open right now.</p>}>
          <ul class="owner-list">
            <For each={rest()}>{rowOf}</For>
          </ul>
        </Show>
        <Show when={error()}>
          <p class="owner-note" role="alert">
            {error()}
          </p>
        </Show>
      </Section>
      <Show when={closed().length}>
        <Section id="owner-requests-closed" title="Closed">
          <ul class="owner-list owner-list-closed">
            <For each={closed()}>{rowOf}</For>
          </ul>
        </Section>
      </Show>
      <Show when={props.api}>
        <dialog
          ref={(el) => {
            sheet = el;
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
          aria-labelledby="owner-close-title"
          aria-describedby="owner-close-line"
          onClose={() => {
            setAsking(null);
            if (opener?.isConnected) opener.focus();
            opener = null;
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) sheet?.close();
          }}
        >
          <div class="sheet-grip" aria-hidden="true" />
          <div class="modal-head">
            <h2 class="modal-title" id="owner-close-title">
              Close this request?
            </h2>
          </div>
          <div class="modal-body">
            <Show when={asking()}>{(r) => <p class="owner-row-title">{r().title}</p>}</Show>
            <p class="owner-note" id="owner-close-line">
              The team will stop on it. You can reopen it later.
            </p>
          </div>
          <div class="modal-foot">
            <button type="button" class="button button-ghost" onClick={() => sheet?.close()}>
              Keep It
            </button>
            <button type="button" class="button button-primary" onClick={confirmClose}>
              Close
            </button>
          </div>
        </dialog>
      </Show>
    </>
  );
}

function VersionsSection(props: { versions: OwnerVersionRow[]; href?: (handle: string) => string }) {
  return (
    <Section id="owner-versions" title="Versions you can try" line="Open a version to try it. These links work as long as this page does.">
      <VersionRows versions={props.versions} href={props.href} />
    </Section>
  );
}

function HomeView(props: {
  home: OwnerHome;
  now: number;
  link: Link;
  preview?: boolean;
  versionHref?: (handle: string) => string;
  assistant?: boolean;
  lines: AbilityLine[];
  pick(l: AbilityLine): void;
  isNew(at: string | undefined): boolean;
}) {
  const h = () => props.home;
  return (
    <>
      <header class="owner-head">
        <h2 class="owner-greeting">Hi {h().owner.first}. Here's how your projects are going.</h2>
        <p class="owner-meta">
          Updated <Ago at={h().updatedAt} now={props.now} />
        </p>
      </header>
      <Show when={h().waiting.length}>
        <WaitingSection waiting={h().waiting} op={h().operator.first} now={props.now} link={props.link} withProject />
      </Show>
      <Show when={props.assistant}>
        <section class="owner-assistant-card" aria-labelledby="owner-assistant-h">
          <h2 class="owner-h2" id="owner-assistant-h">
            What it can do for you
          </h2>
          <Show
            when={h().assistant?.ready !== false}
            fallback={<p class="owner-note">The Project Assistant isn't ready yet. {h().operator.first} has to finish setting it up.</p>}
          >
            <AbilityList lines={props.lines} photos={h().abilities?.photos} pick={props.pick} />
          </Show>
          <a class="button button-primary owner-assistant-button" {...props.link({ kind: "assistant" })}>
            Open the Chat
          </a>
        </section>
      </Show>
      <Show when={props.assistant && h().requests?.length}>
        <a class="owner-requests-line" {...props.link({ kind: "requests" })}>
          {requestsLine(h().requests!)}
        </a>
      </Show>
      <Show when={h().versions?.length}>
        <VersionsSection versions={h().versions!} href={props.versionHref} />
      </Show>
      <section class="owner-head" aria-labelledby="owner-projects">
        <h2 class="owner-title" id="owner-projects">
          Your projects
        </h2>
      </section>
      <Show
        when={h().projects.length}
        fallback={
          <p class="owner-empty">There are no projects on this page yet. When {h().operator.first} starts one, it will show up here.</p>
        }
      >
        <ul class="owner-projects" aria-labelledby="owner-projects">
          <For each={h().projects}>
            {(p) => (
              <li>
                <a class="card card-interactive owner-project" {...props.link({ kind: "project", id: p.id })}>
                  <span class="owner-title-row">
                    <span class="owner-project-name">{p.name}</span>
                    <ChipWord chip={projectChip(p.status)} />
                    <NewChip when={props.isNew(p.lastActivityAt)} />
                  </span>
                  <Show when={p.latestNews} fallback={<span class="owner-project-news">No updates yet.</span>}>
                    {(n) => <span class="owner-project-news">{n().text}</span>}
                  </Show>
                  <span class="owner-meta">{factsLine(p)}</span>
                  <Show when={p.lastActivityAt}>
                    <span class="owner-meta">Last activity {plainAgo(p.lastActivityAt, props.now)}</span>
                  </Show>
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={h().conversations}>{(rows) => <ConversationsSection rows={rows()} now={props.now} link={props.link} isNew={props.isNew} />}</Show>
      <Show when={!props.preview}>
        <p class="owner-foot">Only people with this link can open this page. If someone else gets it, tell {h().operator.first} and they'll turn it off.</p>
      </Show>
    </>
  );
}

/** Home's Conversations (§app.owner-page/content): every shown conversation in Outstanding (on you, then someone else,
    then the team) and History (the most recently ended first), narrowed to one project when there are several. */
function ConversationsSection(props: { rows: OwnerHomeConversation[]; now: number; link: Link; isNew(at: string | undefined): boolean }) {
  const [tab, setTab] = createSignal<"outstanding" | "history">("outstanding");
  const [project, setProject] = createSignal<string>("");
  const projects = createMemo(() => {
    const seen = new Map<string, string>();
    for (const r of props.rows) if (!seen.has(r.project)) seen.set(r.project, r.projectName);
    return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  });
  const groups = createMemo(() => conversationTabs(props.rows, project() || null));
  const rows = () => (tab() === "outstanding" ? groups().outstanding : groups().history);
  const more = useMore(rows, "Conversations");
  const pickTab = (t: "outstanding" | "history", e: KeyboardEvent | MouseEvent) => {
    setTab(t);
    if (e instanceof KeyboardEvent) (document.getElementById(`owner-conv-tab-${t}`) as HTMLElement | null)?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    pickTab(tab() === "outstanding" ? "history" : "outstanding", e);
  };
  const empty = () => {
    const g = groups();
    if (tab() === "outstanding") return g.history.length ? `${count(g.history.length, "finished", "finished")} so far. Nothing is open right now.` : "No conversations yet.";
    return `${count(g.outstanding.length, "still open", "still open")}. Nothing has finished yet.`;
  };
  return (
    <Section id="owner-conversations-all" title="Conversations">
      <div class="owner-conv-bar">
        <div class="tabs owner-conv-tabs" role="tablist" aria-label="Conversations" onKeyDown={onKey}>
          {(["outstanding", "history"] as const).map((t) => (
            <button
              type="button"
              role="tab"
              id={`owner-conv-tab-${t}`}
              class="tab"
              classList={{ "tab-active": tab() === t }}
              aria-selected={tab() === t ? "true" : "false"}
              aria-controls="owner-conv-panel"
              tabindex={tab() === t ? 0 : -1}
              onClick={(e) => pickTab(t, e)}
            >
              {t === "outstanding" ? "Outstanding" : "History"}
            </button>
          ))}
        </div>
        <Show when={projects().length > 1}>
          <label class="owner-conv-filter">
            <span class="field-label">Project</span>
            <select class="select" value={project()} onChange={(e) => setProject(e.currentTarget.value)}>
              <option value="">All projects</option>
              <For each={projects()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
            </select>
          </label>
        </Show>
      </div>
      <div id="owner-conv-panel" role="tabpanel" aria-labelledby={`owner-conv-tab-${tab()}`}>
        <Show when={rows().length} fallback={<p class="owner-section-body owner-empty">{empty()}</p>}>
          <ul class="owner-list">
            <For each={more.rows()}>
              {(c) => (
                <li>
                  <a class="owner-row" {...props.link({ kind: "conversation", id: c.id })}>
                    <span class="owner-row-main">
                      <span class="owner-row-title">{c.publicTitle}</span>
                      <span class="owner-row-chips">
                        <ChipWord chip={conversationChip(c.status)} />
                        <NewChip when={props.isNew(c.lastActivityAt)} />
                      </span>
                      <span class="owner-meta">
                        {c.projectName} ·{" "}
                        <Show when={tab() === "history"} fallback={<>since <Ago at={c.since} now={props.now} /></>}>
                          {historyLine(c.status)} <Ago at={c.endedAt ?? c.since} now={props.now} />
                        </Show>
                      </span>
                    </span>
                    <Chevron />
                  </a>
                </li>
              )}
            </For>
          </ul>
          <Show when={more.rows().length < rows().length}>
            <div class="owner-section-body">{more.button()}</div>
          </Show>
        </Show>
      </div>
    </Section>
  );
}

/** The Requests tab (#r): every one of the owner's requests, newest first. */
function RequestsView(props: { home: OwnerHome; now: number; link: Link; api?: RequestsApi; reload(): void; isNew(at: string | undefined): boolean }) {
  const rs = () => props.home.requests ?? [];
  return (
    <Show
      when={rs().length}
      fallback={
        <>
          <header class="owner-head">
            <h2 class="owner-greeting">Your requests</h2>
          </header>
          <div class="empty owner-requests-empty">
            <p class="empty-body">Nothing asked yet. Ask the Project Assistant for a fix, a new feature or a release.</p>
            <a class="button button-primary empty-action" {...props.link({ kind: "assistant" })}>
              Open the Chat
            </a>
          </div>
        </>
      }
    >
      <RequestsSection requests={rs()} now={props.now} api={props.api} reload={props.reload} isNew={props.isNew} />
    </Show>
  );
}

function NewsList(props: { news: OwnerNews[]; now: number; isNew?(at: string): boolean }) {
  return (
    <div>
      <For each={props.news}>
        {(n) => (
          <article class="owner-news">
            <div class="owner-news-text">
              <LinkedText text={n.text} />
            </div>
            <span class="owner-meta owner-title-row">
              <Ago at={n.at} now={props.now} />
              <NewChip when={!!props.isNew?.(n.at)} />
            </span>
          </article>
        )}
      </For>
    </div>
  );
}

/** The first 5 rows, then `Show All {n} {what}`. */
function useMore<T>(rows: () => T[], what: string) {
  const [all, setAll] = createSignal(false);
  return {
    rows: () => (all() ? rows() : rows().slice(0, FIRST)),
    button: () => (
      <Show when={!all() && rows().length > FIRST}>
        <button type="button" class="button owner-more" onClick={() => setAll(true)}>
          Show All {rows().length} {what}
        </button>
      </Show>
    ),
  };
}

function Decision(props: { d: OwnerDecision; now: number }) {
  return (
    <div class="owner-decision">
      <div class="owner-decision-head">
        <p>{props.d.statement}</p>
        <ChipWord chip={DECISION_CHIP[props.d.state]} />
      </div>
      <span class="owner-meta">
        {props.d.by.name}, {plainDate(props.d.at, props.now)}
      </span>
      <Show when={props.d.quote}>
        <details class="owner-words">
          <summary>In {props.d.by.first}'s words</summary>
          <blockquote class="owner-quote">{props.d.quote}</blockquote>
        </details>
      </Show>
    </div>
  );
}

function ProjectView(props: { project: OwnerProject; now: number; link: Link; isNew(at: string | undefined): boolean; versions: OwnerVersionRow[]; versionHref?: (handle: string) => string }) {
  const p = () => props.project;
  const op = () => p().operator.first;
  const updates = useMore(() => p().news, "Updates");
  const decisions = useMore(() => p().decisions, "Decisions");
  const convs = useMore(() => p().conversations, "Conversations");
  return (
    <>
      <a class="owner-back" {...props.link({ kind: "home" })}>
        ← All projects
      </a>
      <header class="owner-head">
        <div class="owner-title-row">
          <h2 class="owner-title">{p().name}</h2>
          <ChipWord chip={projectChip(p().status)} />
        </div>
        <p class="owner-meta">
          <Show when={p().lastActivityAt}>Last activity {plainAgo(p().lastActivityAt, props.now)} · </Show>Updated <Ago at={p().updatedAt} now={props.now} />
        </p>
      </header>

      <Section id="owner-updates" title="Updates">
        <div class="owner-section-body">
          <Show when={p().news.length} fallback={<p class="owner-empty">{count(p().conversations.length, "conversation", "conversations")} so far. No updates yet.</p>}>
            <NewsList news={updates.rows()} now={props.now} isNew={props.isNew} />
            {updates.button()}
          </Show>
        </div>
      </Section>

      <Show when={p().waiting.length}>
        <WaitingSection waiting={p().waiting} op={op()} now={props.now} link={props.link} withProject={false} />
      </Show>

      <Section id="owner-people" title="Who we've talked to">
        <Show when={p().people.length} fallback={<p class="owner-section-body owner-empty">Nobody has been asked anything yet.</p>}>
          <ul class="owner-list">
            <For each={p().people}>
              {(x) => (
                <li class="owner-row">
                  <span class="owner-row-main">
                    <span class="owner-row-title">{x.name}</span>
                    <span class="owner-meta">{personLine(x, props.now)}</span>
                  </span>
                  <Show when={x.waitingOnThem}>
                    <ChipWord chip={x.isYou ? { word: "Waiting on you", tone: "warn" } : { word: `Waiting on ${x.first}`, tone: "info" }} />
                  </Show>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Section>

      <Section id="owner-decided" title="What's been decided">
        <div class="owner-section-body">
          <For each={p().differences}>{(d) => <p class="owner-difference">{differenceLine(d)}</p>}</For>
          <Show
            when={p().decisions.length}
            fallback={
              <Show when={!p().differences.length}>
                <p class="owner-empty">{count(p().conversations.length, "conversation", "conversations")} so far. Nothing has been decided yet.</p>
              </Show>
            }
          >
            <For each={byTopic(decisions.rows())}>
              {(g) => (
                <div class="owner-topic">
                  <span class="owner-topic-name">{g.topic}</span>
                  <For each={g.rows}>{(d) => <Decision d={d} now={props.now} />}</For>
                </div>
              )}
            </For>
            {decisions.button()}
          </Show>
        </div>
      </Section>

      <Section id="owner-built" title="What's been built">
        <div class="owner-section-body">
          <Show
            when={p().finished || p().inProgress}
            fallback={<p class="owner-empty">Nothing has been built yet.</p>}
          >
            <p class="owner-built">{builtLine(p())}</p>
          </Show>
        </div>
      </Section>

      <Show when={props.versions.length}>
        <VersionsSection versions={props.versions} href={props.versionHref} />
      </Show>

      <Section id="owner-conversations" title="Conversations">
        <Show when={p().conversations.length} fallback={<p class="owner-section-body owner-empty">No conversations yet.</p>}>
          <ul class="owner-list">
            <For each={convs.rows()}>
              {(c) => (
                <li>
                  <a class="owner-row" {...props.link({ kind: "conversation", id: c.id })}>
                    <span class="owner-row-main">
                      <span class="owner-row-title">{c.publicTitle}</span>
                      <span class="owner-row-chips">
                        <ChipWord chip={conversationChip(c.status)} />
                        <NewChip when={props.isNew(c.lastActivityAt)} />
                      </span>
                      <span class="owner-meta">
                        Started <Ago at={c.createdAt} now={props.now} /> · {count(c.messages, "message", "messages")}
                      </span>
                    </span>
                    <Chevron />
                  </a>
                </li>
              )}
            </For>
          </ul>
          <Show when={convs.rows().length < p().conversations.length}>
            <div class="owner-section-body">{convs.button()}</div>
          </Show>
        </Show>
      </Section>
    </>
  );
}

/** What a refused message says on a conversation (§design.copy-deck/owner-page). */
function answerRefusalLine(code: string, message: string, op: string, feature: boolean): string {
  if (code === "rate-limited") return "Too many messages. Wait a minute.";
  if (feature) return code === "not-holder" ? "Someone else has this chat right now. You can read along." : message || "Your message didn't go through. Try again.";
  if (code === "not-holder") return "It's not your turn in this conversation right now.";
  if (code === "taken") return "Someone else is answering right now.";
  if (code === "budget") return `This conversation has reached its message limit. ${op} has been told.`;
  if (code === "closed") return "This conversation has ended.";
  return "Your message didn't go through. Try again.";
}

/** An item's key in a paged conversation: its own id (unique within the view). */
const itemKey = (it: BatonViewItem): string => `${it.kind}:${it.id}`;

function ConversationView(props: {
  conv: OwnerConversation;
  now: number;
  link: Link;
  tourBase?(conversation: string, handle: string): string;
  feature?: FeatureApi;
  subscribe?: AssistantApi["subscribe"];
  older?(conversation: string, before: number): Promise<OwnerConversationOlder>;
  reload(): void;
}) {
  const c = () => props.conv;
  /** The owner's own feature request chat (§app.project-assistant/feature-chats): they write here while they hold it. */
  const feature = () => c().feature;
  /** They write here: their feature request chat while they hold it, or any conversation while it waits on them
      (§app.owner-page/content, Answering on the page). The same route takes both. */
  const canWrite = () => !!props.feature && (feature()?.canWrite === true || c().canAnswer === true);
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [streaming, setStreaming] = createSignal<string | null>(null);
  const [ending, setEnding] = createSignal<"idle" | "confirm" | "sending">("idle");
  // Paged (§app.owner-page/content): the newest page merged into what is loaded, never replacing earlier pages.
  const [paged, setPaged] = createSignal<Paged<BatonViewItem>>(emptyPaged());
  const items = () => paged().rows;
  const id = createMemo(() => c().id);
  const [armed, setArmed] = createSignal(false);
  createEffect(
    on(id, () => {
      setPaged(emptyPaged<BatonViewItem>());
      setArmed(false);
      setStreaming(null);
    }),
  );
  createEffect(() => {
    const conv = c();
    setPaged((p) => mergeNewest(p, { rows: conv.items, older: conv.older ?? 0 }, itemKey));
  });
  // Opened at its newest item (the page's hash change put it at the top); earlier pages only after that.
  createEffect(
    on(
      () => (items().length ? id() : null),
      (open) => {
        if (!open || armed()) return;
        requestAnimationFrame(() => {
          if (!props.subscribe) {
            setArmed(true);
            return;
          }
          window.scrollTo(0, document.documentElement.scrollHeight);
          requestAnimationFrame(() => setArmed(true));
        });
      },
    ),
  );
  const [sentinelEl, setSentinelEl] = createSignal<HTMLDivElement>();
  const older = createOlderLoader({
    sentinel: sentinelEl,
    more: () => armed() && !!props.older && hasOlder(paged()),
    async load() {
      if (!props.older) return true;
      const page = await props.older(c().id, paged().older);
      setPaged((p) => prependOlder(p, { rows: page.items, older: page.older }, itemKey));
      return true;
    },
  });
  // Live: the page's socket says when this conversation changed (read it again) and carries its reply as it is written.
  createEffect(
    on(
      () => (props.subscribe ? id() : null),
      (open) => {
        if (!open || !props.subscribe) return;
        const off = props.subscribe((m) => {
          if (m.type === "conversation" && m.conversation === open) {
            setStreaming(null);
            props.reload();
          } else if (m.type === "conversation-streaming" && m.conversation === open) setStreaming(m.text);
        });
        onCleanup(off);
      },
    ),
  );
  // Without a socket frame (a dropped socket), a feature chat's reply in flight is read again every 3 s while the owner waits.
  createEffect(
    on(
      () => (feature() && !canWrite() && c().state === "open" ? id() : null),
      (open) => {
        if (!open) return;
        const t = setInterval(() => document.visibilityState === "visible" && props.reload(), 3000);
        onCleanup(() => clearInterval(t));
      },
    ),
  );
  // After a send, read again every 3 s until the reply is in (or 3 minutes passed): the socket's frame may never
  // come (a dropped socket, a gateway that doesn't pass /ws/i).
  const [awaiting, setAwaiting] = createSignal<string | null>(null);
  createEffect(
    on(awaiting, (sentAfter) => {
      if (sentAfter === null) return;
      const startedAt = Date.now();
      const t = setInterval(() => {
        const last = items()[items().length - 1];
        const replied = !!last && itemKey(last) !== sentAfter && !(last.kind === "message" && last.by === "you");
        if (replied || c().state !== "open" || Date.now() - startedAt > 180_000) setAwaiting(null);
        else if (document.visibilityState === "visible") props.reload();
      }, 3000);
      onCleanup(() => clearInterval(t));
    }),
  );
  const say = async (text: string): Promise<boolean> => {
    if (!props.feature || sending()) return false;
    setSending(true);
    setError(null);
    try {
      const out = await props.feature.send(c().id, text);
      if (out.ok) {
        const last = items()[items().length - 1];
        setAwaiting(last ? itemKey(last) : "");
        props.reload();
        requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight));
        return true;
      }
      setError(answerRefusalLine(out.code, out.message, c().operator.first, !!feature()));
      if (out.code !== "rate-limited") props.reload();
      return false;
    } finally {
      setSending(false);
    }
  };
  const send = async (text: string): Promise<SendOutcome> => ((await say(text)) ? "sent" : "kept");
  const end = async () => {
    if (!props.feature) return;
    setEnding("sending");
    const ok = await props.feature.end(c().id).catch(() => false);
    setEnding("idle");
    if (ok) props.reload();
    else setError("That didn't go through. Try again in a minute.");
  };
  const note = () => {
    const f = feature();
    if (!f) return c().canAnswer && props.feature ? "It's your turn in this conversation. Answer it here." : null;
    if (c().status.kind === "plan-agreed") return `You agreed this plan. ${c().operator.first} decides when it's built.`;
    if (c().status.kind === "closed") return "This chat has ended.";
    if (f.canWrite) return `Plan it here with the assistant. Nothing is built until ${c().operator.first} decides.`;
    const s = c().status;
    return `${"first" in s ? s.first : c().operator.first} has it right now. You can read along.`;
  };
  return (
    <>
      <a class="owner-back" {...props.link({ kind: "project", id: c().project })}>
        ← {c().projectName}
      </a>
      <header class="owner-head">
        <h2 class="owner-title">{c().publicTitle}</h2>
        <div class="owner-row-chips">
          <ChipWord chip={conversationChip(c().status)} />
        </div>
        <Show when={note()} fallback={<p class="owner-note">You can read this conversation. You can't write here.</p>}>
          <p class="owner-note">{note()}</p>
        </Show>
      </header>
      <section class="owner-thread" aria-label="Conversation">
        <div class="owner-older" ref={setSentinelEl}>
          <Show when={older.loading()}>
            <p class="owner-meta" role="status">
              Loading earlier messages…
            </p>
          </Show>
          <Show when={older.failed()}>
            <p class="owner-meta" role="alert">
              Earlier messages didn't load.{" "}
              <button type="button" class="button button-sm" onClick={() => older.retry()}>
                Try Again
              </button>
            </p>
          </Show>
        </div>
        <For each={items()}>
          {(it) => (
            <Item
              item={it}
              reader
              drawings={c().drawings}
              tour={props.tourBase ? { base: (handle) => props.tourBase!(c().id, handle) } : undefined}
              answerPlan={canWrite() && feature() ? say : undefined}
            />
          )}
        </For>
        <Show when={streaming()}>
          <article class="share-msg share-msg-reply" aria-label="Facilitator" aria-busy="true">
            <span class="share-who">Facilitator</span>
            <Reply text={streaming()!} streaming kinds={batonKinds(c().drawings?.html === true)} />
          </article>
        </Show>
      </section>
      <Show when={canWrite()}>
        <ShareComposer
          class="owner-assistant-composer owner-feature-composer"
          id="owner-feature-text"
          label="Your message"
          placeholder="Write a message"
          maxLength={4000}
          sendKey="mod-enter"
          draft={draft}
          setDraft={setDraft}
          error={error}
          photos={() => null}
          uploadPhoto={() => {
            throw new Error("Photos can't be sent here.");
          }}
          sending={sending}
          send={(text) => send(text)}
        />
      </Show>
      <Show when={!canWrite() && error()}>
        <p class="owner-note" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={props.feature && feature()?.canEnd}>
        <div class="owner-feature-end">
          <Show
            when={ending() !== "idle"}
            fallback={
              <button type="button" class="button button-ghost" onClick={() => setEnding("confirm")}>
                End Chat
              </button>
            }
          >
            <p class="owner-note">End this chat? You can't write in it after.</p>
            <button type="button" class="button" disabled={ending() === "sending"} onClick={() => void end()}>
              End Chat
            </button>
            <button type="button" class="button button-ghost" onClick={() => setEnding("idle")}>
              Cancel
            </button>
          </Show>
        </div>
      </Show>
    </>
  );
}
