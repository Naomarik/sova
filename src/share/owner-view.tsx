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
  personLine,
  plainAgo,
  plainDate,
  projectChip,
  waitingLine,
} from "../lib/owner-words";
import { Dynamic } from "solid-js/web";
import { stampTime } from "../lib/format";
import { Item, LinkedText } from "./thread";
import { AssistantChat, type AssistantApi } from "./assistant-view";
import type { OwnerRequestRow, OwnerVersionRow } from "../../shared/project-assistant";

/**
 * The Owner page (§app.owner-page/page): Home, a project, a conversation. Read-only. It renders
 * what the server sends and nothing else; the share build (OwnerApp, from the link) and the
 * operator's preview (from the preview route) feed it the same answers, so they show the same page.
 */

/** Why a load failed. `unknown`/`gone`/`expired` are about the link (the whole page); `missing` is
    one project or conversation that isn't on the page; `offline` is a public gateway's 503 (the
    host it lives on is offline: the page stays and keeps trying); `failed` is anything else. */
export type OwnerProblemKind = "unknown" | "gone" | "expired" | "busy" | "missing" | "offline" | "failed";
export class OwnerLoadError extends Error {
  constructor(
    readonly kind: OwnerProblemKind,
    /** On a link that turned off unused: the owner already asked for a new one. */
    readonly asked = false,
  ) {
    super(kind);
  }
}

export type OwnerAnswer = OwnerHome | OwnerProject | OwnerConversation;

const PROBLEM: Record<Exclude<OwnerProblemKind, "missing" | "offline" | "failed">, { title: string; body: string }> = {
  expired: { title: "This link turned off after a week without use.", body: "It turns itself off so nobody else can use it later. You can ask for a new one." },
  gone: { title: "This link is no longer active.", body: "Ask the person who sent it for a new one." },
  unknown: { title: "This link doesn't open anything.", body: "Check that you copied all of it." },
  busy: { title: "Too many requests from this network.", body: "Wait a minute, then reload." },
};

/** How often the page reads again while it is visible. */
const REFRESH_MS = 60_000;
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
  /** The page's title, for the browser tab. */
  onTitle?(title: string): void;
  /** Ask for a new link, from a link that turned off unused (§app.owner-page/link); true once asked. */
  ask?(): Promise<boolean>;
  /** The Project Assistant's conversation (§app.project-assistant/chat); read only without `send`. */
  assistant?: AssistantApi;
  /** A version's Open address (`/i/<token>/v/<handle>`); absent in the preview: no Open. */
  versionHref?(handle: string): string;
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
    if ((r.kind === "home" || r.kind === "assistant") && "projects" in d) return d;
    if (r.kind === "project" && "people" in d && d.id === r.id) return d;
    if (r.kind === "conversation" && "items" in d && d.id === r.id) return d;
    return undefined;
  };
  /** A dead or unknown link: nothing of the page stays. */
  const deadLink = () => {
    const p = problem();
    return p === "unknown" || p === "gone" || p === "expired" || p === "busy" ? PROBLEM[p] : null;
  };
  createEffect(() => {
    const d = current();
    if (d) props.onTitle?.(d.org.name);
  });
  const tryAgain = (
    <button type="button" class="button empty-action" onClick={() => void read()}>
      Try Again
    </button>
  );

  return (
    <Dynamic component={props.preview ? "div" : "main"} class="owner">
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
              <Show when={props.route.kind !== "home"}>
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
                {(api) => <AssistantChat first={(d() as OwnerHome).owner.first} op={(d() as OwnerHome).operator.first} api={api()} back={link({ kind: "home" })} />}
              </Match>
              <Match when={"projects" in d()}>
                <HomeView home={d() as OwnerHome} now={now()} link={link} preview={props.preview} versionHref={props.versionHref} assistant={!!props.assistant} />
              </Match>
              <Match when={"people" in d()}>
                <ProjectView project={d() as OwnerProject} now={now()} link={link} />
              </Match>
              <Match when={true}>
                <ConversationView conv={d() as OwnerConversation} now={now()} link={link} />
              </Match>
            </Switch>
          )}
        </Show>
      </Show>
    </Dynamic>
  );
}

type Link = (r: OwnerRoute) => { href: string; onClick(e: MouseEvent): void };

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

function Section(props: { id: string; title: string; line?: JSX.Element; attention?: boolean; children: JSX.Element }) {
  return (
    <section class="owner-section" classList={{ "owner-attention": props.attention }} aria-labelledby={props.id}>
      <div class="owner-section-head">
        <h2 class="owner-h2" id={props.id}>
          {props.title}
        </h2>
        <Show when={props.line}>
          <p class="owner-note">{props.line}</p>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

function Chevron() {
  return (
    <svg class="owner-row-go" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

/** Rows waiting on the owner. Read-only in v1: they answer through the link the operator sent. */
function WaitingSection(props: { waiting: OwnerWaiting[]; op: string; now: number; link: Link; withProject: boolean }) {
  return (
    <Section id="owner-waiting" title="Waiting on you" attention line={`${waitingLine(props.waiting.length)} Answer it using the link ${props.op} sent you for it.`}>
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
const REQUEST_KIND: Record<OwnerRequestRow["kind"], string> = { bug: "Problem", outage: "App down", question: "Question", feature: "New feature", fix: "Fix", deploy: "Release" };
const REQUEST_STATUS: Record<OwnerRequestRow["status"], OwnerChipWord> = {
  "with-team": { word: "With the team", tone: "info" },
  started: { word: "Being worked on", tone: "info" },
  done: { word: "Done", tone: "success" },
  declined: { word: "Not planned", tone: undefined },
};

function RequestsSection(props: { requests: OwnerRequestRow[]; now: number }) {
  return (
    <Section id="owner-requests" title="Your requests">
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
              <ChipWord chip={REQUEST_STATUS[r.status]} />
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
      <ul class="owner-list">
        <For each={props.versions}>
          {(v) => (
            <li class="owner-row owner-row-static">
              <span class="owner-row-main">
                <span class="owner-row-title">{v.label}</span>
                <span class="owner-meta">{v.state === "running" ? v.project : `${v.project} · Not running right now`}</span>
              </span>
              <Show when={v.state === "running"}>
                <Show when={props.href} fallback={<span class="button owner-version-open" aria-disabled="true">Open</span>}>
                  {(href) => (
                    <a class="button owner-version-open" href={href()(v.handle)} target="_blank" rel="noopener noreferrer">
                      Open
                    </a>
                  )}
                </Show>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </Section>
  );
}

function HomeView(props: { home: OwnerHome; now: number; link: Link; preview?: boolean; versionHref?: (handle: string) => string; assistant?: boolean }) {
  const h = () => props.home;
  return (
    <>
      <header class="owner-head">
        <h1 class="owner-org">{h().org.name}</h1>
        <p class="owner-lead">Hi {h().owner.first}. Here's how your projects are going.</p>
        <p class="owner-meta">
          Updated <Ago at={h().updatedAt} now={props.now} />
        </p>
      </header>
      <Show when={props.assistant}>
        <div class="owner-assistant-door">
          <a class="button button-primary owner-assistant-button" {...props.link({ kind: "assistant" })}>
            Project Assistant
          </a>
          <p class="owner-meta">Ask about your projects, report a problem or ask for something new.</p>
        </div>
      </Show>
      <Show when={h().waiting.length}>
        <WaitingSection waiting={h().waiting} op={h().operator.first} now={props.now} link={props.link} withProject />
      </Show>
      <Show when={h().requests?.length}>
        <RequestsSection requests={h().requests!} now={props.now} />
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

function ConversationView(props: { conv: OwnerConversation; now: number; link: Link }) {
  const c = () => props.conv;
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
        <p class="owner-note">
          You can read this conversation. You can't write here.
          <Show when={c().yourTurn}> It's your turn in this conversation. Answer it using the link {c().operator.first} sent you.</Show>
        </p>
      </header>
      <section class="owner-thread" aria-label="Conversation">
        <For each={c().items}>{(it) => <Item item={it} reader drawings={c().drawings} />}</For>
      </section>
    </>
  );
}
