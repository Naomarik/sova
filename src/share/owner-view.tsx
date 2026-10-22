import { createEffect, createMemo, createSignal, For, type JSX, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import type { OwnerConversation, OwnerDecision, OwnerHome, OwnerNews, OwnerProject, OwnerWaiting } from "../../shared/owner";
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
} from "../lib/owner-words";
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
  createEffect(() => {
    const d = current();
    if (d) props.onTitle?.(d.org.name);
  });
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
        <OwnerTabs tab={ownerTab(props.route)} open={openCount(home()?.requests)} link={link} preview />
      </Show>
      <div class="owner" classList={{ "owner-chat": props.route.kind === "assistant" && !props.preview }}>
      <Show
        when={!deadLink()}
        fallback={
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
        }
      >
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
                <RequestsView home={d() as OwnerHome} now={now()} link={link} />
              </Match>
              <Match when={"projects" in d()}>
                <HomeView home={d() as OwnerHome} now={now()} link={link} preview={props.preview} versionHref={props.versionHref} assistant={!!props.assistant} lines={lines()} pick={pick} />
              </Match>
              <Match when={"people" in d()}>
                <ProjectView project={d() as OwnerProject} now={now()} link={link} />
              </Match>
              <Match when={true}>
                <ConversationView
                  conv={d() as OwnerConversation}
                  now={now()}
                  link={link}
                  tourBase={props.tourBase}
                  feature={props.preview ? undefined : props.feature}
                  subscribe={props.preview ? undefined : props.assistant?.subscribe}
                  reload={() => void read()}
                />
              </Match>
            </Switch>
          )}
        </Show>
      </Show>
      </div>
      <Show when={tabs() && !props.preview}>
        <OwnerTabs tab={ownerTab(props.route)} open={openCount(home()?.requests)} link={link} />
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
function OwnerTabs(props: { tab: OwnerTab; open: number; link: Link; preview?: boolean }) {
  const label = (t: (typeof TABS)[number]) => (t.id === "requests" && props.open ? `Requests, ${props.open} open` : t.label);
  return (
    <Show
      when={!props.preview}
      fallback={
        <nav class="tabs owner-preview-tabs" aria-label="Page">
          <For each={TABS}>
            {(t) => (
              <a class="tab" classList={{ "tab-active": props.tab === t.id }} aria-current={props.tab === t.id ? "page" : undefined} aria-label={label(t)} {...props.link(t.route)}>
                {t.label}
                <Show when={t.id === "requests" && props.open}>
                  <span class="owner-badge" aria-hidden="true">{props.open}</span>
                </Show>
              </a>
            )}
          </For>
        </nav>
      }
    >
      <nav class="owner-nav" aria-label="Page">
        <For each={TABS}>
          {(t) => (
            <a class="navitem" aria-current={props.tab === t.id ? "page" : undefined} aria-label={label(t)} {...props.link(t.route)}>
              <span class="owner-nav-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  {TAB_ICON[t.id]()}
                </svg>
                <Show when={t.id === "requests" && props.open}>
                  <span class="owner-badge" aria-hidden="true">{props.open}</span>
                </Show>
              </span>
              <span class="navitem-label">{t.label}</span>
              <Show when={t.id === "requests" && props.open}>
                <span class="owner-badge owner-badge-end" aria-hidden="true">{props.open}</span>
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
      line={`${waitingLine(props.waiting.length)}${props.waiting.some((w) => !w.feature) ? ` Answer it using the link ${props.op} sent you for it.` : " Open it to answer here."}`}
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
};

function RequestsSection(props: { requests: OwnerRequestRow[]; now: number; heading?: boolean }) {
  return (
    <Section id="owner-requests" title="Your requests" h1={props.heading}>
      <ul class="owner-list">
        <For each={props.requests}>
          {(r) => (
            <li class="owner-row owner-row-static">
              <span class="owner-row-main">
                <span class="owner-row-title">{r.title}</span>
                <span class="owner-meta">
                  {REQUEST_KIND[r.kind]} · {r.project} · <Ago at={r.at} now={props.now} />
                </span>
              </span>
              <ChipWord chip={r.plan === "planning" ? { word: "Planning with you", tone: "info" } : r.plan === "agreed" ? { word: "Plan agreed", tone: "success" } : REQUEST_STATUS[r.status]} />
            </li>
          )}
        </For>
      </ul>
    </Section>
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
}) {
  const h = () => props.home;
  return (
    <>
      <header class="owner-head">
        <h1 class="owner-greeting">Hi {h().owner.first}. Here's how your projects are going.</h1>
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
      <Show when={!props.preview}>
        <p class="owner-foot">Only people with this link can open this page. If someone else gets it, tell {h().operator.first} and they'll turn it off.</p>
      </Show>
    </>
  );
}

/** The Requests tab (#r): every one of the owner's requests, newest first. */
function RequestsView(props: { home: OwnerHome; now: number; link: Link }) {
  const rs = () => props.home.requests ?? [];
  return (
    <Show
      when={rs().length}
      fallback={
        <>
          <header class="owner-head">
            <h1 class="owner-greeting">Your requests</h1>
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
      <RequestsSection requests={rs()} now={props.now} heading />
    </Show>
  );
}

function NewsList(props: { news: OwnerNews[]; now: number }) {
  return (
    <div>
      <For each={props.news}>
        {(n) => (
          <article class="owner-news">
            <div class="owner-news-text">
              <LinkedText text={n.text} />
            </div>
            <span class="owner-meta">
              <Ago at={n.at} now={props.now} />
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

function ProjectView(props: { project: OwnerProject; now: number; link: Link }) {
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
          <h1 class="owner-org">{p().name}</h1>
          <ChipWord chip={projectChip(p().status)} />
        </div>
        <p class="owner-meta">
          <Show when={p().lastActivityAt}>Last activity {plainAgo(p().lastActivityAt, props.now)} · </Show>Updated <Ago at={p().updatedAt} now={props.now} />
        </p>
      </header>

      <Section id="owner-updates" title="Updates">
        <div class="owner-section-body">
          <Show when={p().news.length} fallback={<p class="owner-empty">{count(p().conversations.length, "conversation", "conversations")} so far. No updates yet.</p>}>
            <NewsList news={updates.rows()} now={props.now} />
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

function ConversationView(props: {
  conv: OwnerConversation;
  now: number;
  link: Link;
  tourBase?(conversation: string, handle: string): string;
  feature?: FeatureApi;
  subscribe?: AssistantApi["subscribe"];
  reload(): void;
}) {
  const c = () => props.conv;
  /** The owner's own feature request chat (§app.project-assistant/feature-chats): they write here while they hold it. */
  const feature = () => c().feature;
  const canWrite = () => !!props.feature && feature()?.canWrite === true;
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [streaming, setStreaming] = createSignal<string | null>(null);
  const [ending, setEnding] = createSignal<"idle" | "confirm" | "sending">("idle");
  // Live: the page's socket says when this chat changed (read it again) and carries its reply as it is written.
  createEffect(
    on(
      () => (feature() && props.subscribe ? c().id : null),
      (id) => {
        if (!id || !props.subscribe) return;
        const off = props.subscribe((m) => {
          if (m.type === "conversation" && m.conversation === id) {
            setStreaming(null);
            props.reload();
          } else if (m.type === "conversation-streaming" && m.conversation === id) setStreaming(m.text);
        });
        onCleanup(off);
      },
    ),
  );
  // Without a socket frame (a dropped socket), a reply in flight is read again every 3 s while the owner waits.
  createEffect(
    on(
      () => (feature() && !canWrite() && c().state === "open" ? c().id : null),
      (id) => {
        if (!id) return;
        const t = setInterval(() => document.visibilityState === "visible" && props.reload(), 3000);
        onCleanup(() => clearInterval(t));
      },
    ),
  );
  // After a send, read again every 3 s until the reply is in (or 3 minutes passed): the socket's frame may never
  // come (a dropped socket, a gateway that doesn't pass /ws/i).
  const [awaiting, setAwaiting] = createSignal<number | null>(null);
  createEffect(
    on(awaiting, (since) => {
      if (since === null) return;
      const t = setInterval(() => {
        const items = c().items;
        const last = items[items.length - 1];
        const replied = items.length > since && !!last && !(last.kind === "message" && last.by === "you");
        if (replied || c().state !== "open" || Date.now() - startedAt > 180_000) setAwaiting(null);
        else if (document.visibilityState === "visible") props.reload();
      }, 3000);
      const startedAt = Date.now();
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
        setAwaiting(c().items.length + 1);
        props.reload();
        return true;
      }
      setError(out.code === "rate-limited" ? "Too many messages. Wait a minute." : out.code === "not-holder" ? "Someone else has this chat right now. You can read along." : out.message || "Your message didn't go through. Try again.");
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
    if (!f) return null;
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
        <h1 class="owner-title">{c().publicTitle}</h1>
        <div class="owner-row-chips">
          <ChipWord chip={conversationChip(c().status)} />
        </div>
        <Show
          when={note()}
          fallback={
            <p class="owner-note">
              You can read this conversation. You can't write here.
              <Show when={c().yourTurn}> It's your turn in this conversation. Answer it using the link {c().operator.first} sent you.</Show>
            </p>
          }
        >
          <p class="owner-note">{note()}</p>
        </Show>
      </header>
      <section class="owner-thread" aria-label="Conversation">
        <For each={c().items}>
          {(it) => (
            <Item
              item={it}
              reader
              drawings={c().drawings}
              tour={props.tourBase ? { base: (handle) => props.tourBase!(c().id, handle) } : undefined}
              answerPlan={canWrite() ? say : undefined}
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
