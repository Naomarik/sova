import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { AUTOMATIC_ABILITIES, MESSAGES_CAP, MESSAGES_DEFAULT, MESSAGES_MIN, OPERATOR, type BatonStartResult, type GatheringAbilities, type BatonView, type BatonViewItem, type OfferLink } from "../../shared/baton";
import { ORG_ABOUT_MAX, type NamedChange, type OrgChange, type OrgDetail, type Person, type PersonInput, type ProfileChange } from "../../shared/orgs";
import {
  addOrgProject,
  unarchiveOrgProject,
  addPerson,
  ApiError,
  approvePerson,
  declinePerson,
  attachOrg,
  commitOrg,
  createOrg,
  getOrg,
  getOrgs,
  getOrgCosts,
  openProjectOverseer,
  patchOrg,
  patchPerson,
  revertOrgAbout,
  revertPersonChange,
  setOperatorName,
  setOrgRemote,
  startBaton,
  getBatonSettings,
  getProjectOverseer,
} from "../lib/api";
import { commitNowWords } from "../lib/commit-now";
import { usd } from "../lib/costs";
import { duration, relativeTime, stampTime } from "../lib/format";
import { needsYouCount, needsYouLabel, orgCountsLine } from "../lib/org-cards";
import { proposedAreasLine } from "../lib/baton-strip";
import { groupChanges, revertible, STATUS_CHIP, valueText, writerWord } from "../lib/profile-changes";
import { aboutChangeWord, aboutCount, aboutLength, aboutOverCap, aboutPreview } from "../lib/org-about";
import { orgPageRoute } from "../lib/org-page-route";
import { createOrgSource } from "../lib/org-source";
import { useMinuteNow } from "../lib/minute-clock";
import { orgHref, orgSessionHref, orgTabHref, personHref, projectHref, startForHref, takeStartParent, type OrgsRoute, type OrgTab } from "../lib/orgs-route";
import { orgTabsOf } from "../lib/org-tabs";
import { toast } from "../lib/ui-state";
import { InsightsPage } from "./InsightsPage";
import { meshPeers, orgHostOf } from "../lib/mesh";
import { orgHostOffline } from "../lib/org-host-offline";
import { LinksBanner } from "./LinksBanner";
import { OwnerCard } from "./OwnerCard";
import { PersonForm } from "./PersonForm";
import { PersonPage } from "./PersonPage";
import { ProjectPage } from "./ProjectPage";
import { Banner, Chip, Icon } from "./ui";
import "../orgs.css";
import "../projects.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const STATE_WORDS: Record<string, { word: string; tone: "info" | "warn" | "success" | undefined }> = {
  open: { word: "Open", tone: "info" },
  "needs-you": { word: "Needs you", tone: "warn" },
  done: { word: "Done", tone: "success" },
  closed: { word: "Closed", tone: undefined },
};

/** The organizations page: `#/orgs`, `#/orgs/<id>[/<tab>|/start/<person>]`,
    `#/orgs/<id>/projects/<project>[/overseer]`, `#/orgs/<id>/people/<person>`. */
export function OrgsView(props: { route: OrgsRoute; titleRef(el: HTMLHeadingElement): void }) {
  // Memos, not ternaries in the props below: the start form reads `start` from its Cancel handler.
  const page = orgPageRoute(() => props.route);
  return (
    <Switch>
      <Match when={props.route.kind === "list"}>
        <OrgList titleRef={props.titleRef} />
      </Match>
      <Match when={props.route.kind === "project" && props.route} keyed>
        {(r) => <ProjectPage orgId={r.id} projectId={r.projectId} titleRef={props.titleRef} />}
      </Match>
      <Match when={props.route.kind === "person" && props.route} keyed>
        {(r) => <PersonPage orgId={r.id} personId={r.personId} titleRef={props.titleRef} />}
      </Match>
      <Match when={props.route.kind === "overseer" && props.route} keyed>
        {(r) => <OverseerDoor orgId={r.id} projectId={r.projectId} titleRef={props.titleRef} />}
      </Match>
      {/* Keyed on the id alone: a tab change keeps the page (and its fetched org). */}
      <Match when={props.route.kind === "org" && props.route.id} keyed>
        {(id) => (
          <OrgPage
            id={id}
            start={page.start()}
            tab={page.tab()}
            titleRef={props.titleRef}
          />
        )}
      </Match>
    </Switch>
  );
}

/** `…/projects/<pid>/overseer`: open (or start) the project's overseer and go to its conversation;
    on failure, the project page with the reason. */
function OverseerDoor(props: { orgId: string; projectId: string; titleRef(el: HTMLHeadingElement): void }) {
  const [failed, setFailed] = createSignal<string | null>(null);
  openProjectOverseer(props.orgId, props.projectId).then(
    (info) => (info.path ? location.replace(orgSessionHref(props.orgId, info.path)) : setFailed("It has no conversation yet.")),
    (err) => setFailed(errText(err)),
  );
  return (
    <Show when={failed()} fallback={<p class="orgs-empty">Opening the overseer.</p>}>
      {(e) => (
        <>
          <Banner tone="error" title="Couldn't open the overseer." body={e()} />
          <ProjectPage orgId={props.orgId} projectId={props.projectId} titleRef={props.titleRef} />
        </>
      )}
    </Show>
  );
}

// ---- the list --------------------------------------------------------------------------------------

function OrgList(props: { titleRef(el: HTMLHeadingElement): void }) {
  const [info, { refetch }] = createResource(getOrgs);
  const [error, setError] = createSignal<string | null>(null);
  const [name, setName] = createSignal("");
  const [dir, setDir] = createSignal("");
  const [attachDir, setAttachDir] = createSignal("");
  /** Another host holds the repo being attached: its sentence, until Attach Anyway or Cancel (§app.organizations/holder). */
  const [held, setHeld] = createSignal<string | null>(null);
  const attach = (confirm: boolean) =>
    void act(async () => {
      try {
        const org = await attachOrg(attachDir().trim(), confirm);
        setHeld(null);
        toast("Organization attached.");
        location.hash = orgHref(org.id);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409 && (err.body as { code?: unknown } | undefined)?.code === "held") {
          setHeld(err.message);
          return;
        }
        throw err;
      }
    }, undefined);
  const [operator, setOperator] = createSignal("");
  let nameInput: HTMLInputElement | undefined;
  createEffect(on(() => info()?.operator.name, (n) => n && setOperator(n)));
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      setError(null);
      if (done) toast(done);
      await refetch();
    } catch (err) {
      setError(errText(err));
    }
  };
  return (
    <InsightsPage
      title="Organizations"
      meta={info() ? `${info()!.orgs.length} on this host` : undefined}
      refreshLabel="Refresh Organizations"
      onRefresh={() => void refetch()}
      error={error() ?? (info.error ? errText(info.error) : null)}
      errorTitle="Couldn't update the organizations."
      busy={info.loading}
      titleRef={props.titleRef}
    >
      <Show
        when={info()?.orgs.length}
        fallback={
          <Show when={info()}>
            <div class="card orgs-section org-empty">
              <h2 class="orgs-h2">Create your first organization</h2>
              <p class="orgs-empty">Each organization keeps its roster, projects and hand-off sessions in its own git repo.</p>
              <div class="button-row">
                <button type="button" class="button" onClick={() => nameInput?.focus()}>
                  <Icon name="plus" />
                  New Organization
                </button>
              </div>
            </div>
          </Show>
        }
      >
        <ul class="org-grid">
          <For each={info()!.orgs}>
            {(o) => {
              const waiting = () => needsYouCount(o.needsYou);
              return (
                <li>
                  <a class="card org-card" classList={{ "org-card-needs": waiting() > 0 }} href={orgHref(o.id)}>
                    <div class="org-card-head">
                      <h3 class="org-card-name">{o.name}</h3>
                      <Show when={waiting()}>
                        <Chip tone="warn" title={needsYouLabel(o.needsYou)}>
                          Needs you · <span class="text-num">{waiting()}</span>
                        </Chip>
                      </Show>
                    </div>
                    <p class="org-card-line">{orgCountsLine(o)}</p>
                    <Show when={waiting()}>
                      <p class="org-card-waiting">{needsYouLabel(o.needsYou)}</p>
                    </Show>
                    <Show when={o.lastActivityAt}>
                      {(at) => (
                        <p class="org-card-meta" title={stampTime(at())}>
                          Active {relativeTime(at())}
                        </p>
                      )}
                    </Show>
                  </a>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>

      <form
        class="card orgs-section orgs-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name().trim()) return;
          void act(async () => {
            const org = await createOrg(name().trim(), dir().trim() || undefined);
            location.hash = orgHref(org.id);
          }, "Organization created.");
        }}
      >
        <h2 class="orgs-h2">New Organization</h2>
        <div class="orgs-fields">
          <label class="field">
            <span class="field-label">Name</span>
            <input ref={nameInput} class="input" value={name()} onInput={(e) => setName(e.currentTarget.value)} maxlength={80} required />
          </label>
          <label class="field">
            <span class="field-label">Workspace repo</span>
            <input class="input input-mono" value={dir()} onInput={(e) => setDir(e.currentTarget.value)} placeholder={info()?.defaultDir ?? ""} />
            <span class="field-hint">An absolute folder outside Sova's own repo. Empty: under the default folder shown.</span>
          </label>
        </div>
        <div class="button-row">
          <button type="submit" class="button button-primary">
            Create Organization
          </button>
        </div>
      </form>

      <form
        class="card orgs-section orgs-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (attachDir().trim()) attach(false);
        }}
      >
        <h2 class="orgs-h2">Attach a Restored Repo</h2>
        <label class="field">
          <span class="field-label">Workspace repo</span>
          <input
            class="input input-mono"
            value={attachDir()}
            onInput={(e) => {
              setAttachDir(e.currentTarget.value);
              setHeld(null);
            }}
            placeholder="/path/to/cloned/workspace"
          />
          <span class="field-hint">A clone of an organization's workspace repo. Links are not in the repo: send new ones after attaching. Its project overseers start paused at L0 until you set their level here.</span>
        </label>
        <Show
          when={held()}
          fallback={
            <div class="button-row">
              <button type="submit" class="button">
                Attach Repo
              </button>
            </div>
          }
        >
          {(h) => (
            <>
              <Banner tone="warn" title={h()} />
              <div class="button-row">
                <button type="button" class="button button-destructive" onClick={() => attach(true)}>
                  Attach Anyway
                </button>
                <button type="button" class="button button-ghost" onClick={() => setHeld(null)}>
                  Cancel
                </button>
              </div>
            </>
          )}
        </Show>
      </form>

      <form
        class="card orgs-section orgs-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (operator().trim()) void act(() => setOperatorName(operator().trim()), "Name saved.");
        }}
      >
        <h2 class="orgs-h2">Your Name</h2>
        <label class="field">
          <span class="field-label">Shown to the people you hand sessions to</span>
          <input class="input" value={operator()} onInput={(e) => setOperator(e.currentTarget.value)} maxlength={80} />
        </label>
        <div class="button-row">
          <button type="submit" class="button">
            Save Name
          </button>
        </div>
      </form>
    </InsightsPage>
  );
}

// ---- one org -------------------------------------------------------------------------------------

function OrgPage(props: { id: string; start?: string; tab?: OrgTab; titleRef(el: HTMLHeadingElement): void }) {
  const org = createOrgSource(props.id);
  const [error, setError] = createSignal<string | null>(null);
  const [links, setLinks] = createSignal<OfferLink[] | null>(null);
  const [linkWarning, setLinkWarning] = createSignal<string | undefined>();
  const act = async (fn: () => Promise<OrgDetail | unknown>, done?: string | ((r: unknown) => string)): Promise<boolean> => {
    try {
      const r = await fn();
      org.set(r && typeof r === "object" && "roster" in r ? (r as OrgDetail) : await getOrg(props.id));
      setError(null);
      if (done) toast(typeof done === "string" ? done : done(r));
      return true;
    } catch (err) {
      setError(errText(err));
      return false;
    }
  };
  /** A start link opens Sessions whatever tab was named; no tab is Sessions too. */
  const tab = (): OrgTab => (props.start ? "sessions" : (props.tab ?? "sessions"));
  return (
    <InsightsPage
      title={org.data()?.name ?? "Organization"}
      meta={
        org.data() ? (
          <>
            <a class="orgs-meta-link" href="#/orgs">Organizations</a> · <span class="orgs-mono orgs-meta-path" title={org.data()!.dir}>{org.data()!.dir}</span>
          </>
        ) : undefined
      }
      refreshLabel="Refresh Organization"
      onRefresh={() => org.refetch()}
      error={error() ?? org.error()}
      errorTitle="Couldn't update this organization."
      busy={org.pending()}
      titleRef={props.titleRef}
    >
      <Show when={org.data()}>
        {(o) => (
          <>
            <Show when={orgHostOffline(orgHostOf(props.id), meshPeers())}>{(w) => <Banner tone="warn" title={w()} />}</Show>
            <For each={o().problems}>{(p) => <Banner tone="warn" title="The workspace repo has a problem." body={p} />}</For>
            <Show when={links()}>{(l) => <LinksBanner links={l()} warning={linkWarning()} onDismiss={() => setLinks(null)} />}</Show>
            <OrgTabs org={o()} tab={tab()} />
            <div class="org-tabpanel" role="tabpanel" id="org-tabpanel" aria-labelledby={`org-tab-${tab()}`}>
              <Switch>
                <Match when={tab() === "sessions"}>
                  <BatonSection
                    org={o()}
                    start={props.start}
                    act={act}
                    onLinks={(l, warning) => {
                      setLinkWarning(warning);
                      setLinks(l);
                    }}
                  />
                </Match>
                <Match when={tab() === "people"}>
                  <OwnerCard org={o()} act={act} />
                  <PeopleSection org={o()} act={act} />
                  <ChangesSection org={o()} act={act} />
                </Match>
                <Match when={tab() === "projects"}>
                  <AboutCard org={o()} act={act} />
                  <ProjectsSection org={o()} act={act} />
                </Match>
                <Match when={tab() === "workspace"}>
                  <GitCard org={o()} act={act} />
                </Match>
              </Switch>
            </div>
          </>
        )}
      </Show>
    </InsightsPage>
  );
}

/** `done`: the toast, or how to say it from the answer (Commit Now says what it did). */
type Act = (fn: () => Promise<OrgDetail | unknown>, done?: string | ((r: unknown) => string)) => Promise<boolean>;

/** The org page's tab strip: a link per tab (the tab is in the URL), a count, a dot for what waits.
    Left/Right move focus along the strip (wrapping), Home/End jump; Enter or Space selects. */
function OrgTabs(props: { org: OrgDetail; tab: OrgTab }) {
  const tabs = createMemo(() => orgTabsOf(props.org));
  const els: HTMLButtonElement[] = [];
  // Past the strip's width it scrolls: keep the selected tab whole in view.
  createEffect(
    on(
      () => props.tab,
      (tab) => queueMicrotask(() => els[tabs().findIndex((t) => t.id === tab)]?.scrollIntoView({ block: "nearest", inline: "nearest" })),
    ),
  );
  const onKey = (e: KeyboardEvent, i: number) => {
    const last = tabs().length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    els[next]?.focus();
  };
  return (
    <div class="tabs org-tabs" role="tablist" aria-label="Organization">
      <For each={tabs()}>
        {(t, i) => (
          <button
            type="button"
            role="tab"
            class="tab"
            id={`org-tab-${t.id}`}
            aria-selected={props.tab === t.id ? "true" : "false"}
            aria-controls={props.tab === t.id ? "org-tabpanel" : undefined}
            tabindex={props.tab === t.id ? 0 : -1}
            title={t.waitingText || undefined}
            ref={(el) => (els[i()] = el)}
            onClick={() => location.replace(orgTabHref(props.org.id, t.id))}
            onKeyDown={(e) => onKey(e, i())}
          >
            {t.label}
            <Show when={t.count !== null}>
              <span class="text-num org-tab-count">{t.count}</span>
            </Show>
            <Show when={t.waiting}>
              <span class="org-tab-dot" aria-hidden="true" />
              <span class="visually-hidden">, needs you: {t.waitingText}</span>
            </Show>
          </button>
        )}
      </For>
    </div>
  );
}

/** "hourly", or the test-only interval an older or shortened server reports. */
const commitCadence = (ms: number | undefined): string => (!ms || ms === 3_600_000 ? "hourly" : `every ${duration(ms)}`);

function GitCard(props: { org: OrgDetail; act: Act }) {
  const [remote, setRemote] = createSignal(props.org.git.remote ?? "");
  const g = () => props.org.git;
  return (
    <section class="card orgs-section" aria-labelledby="orgs-git">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="orgs-git">
          Workspace Repo
        </h2>
        <button type="button" class="button button-sm" onClick={() => void props.act(() => commitOrg(props.org.id), (r) => commitNowWords((r as OrgDetail | undefined)?.commit))}>
          Commit Now
        </button>
      </div>
      <p class="orgs-line">
        Changes are committed {commitCadence(g().commitEveryMs)}
        {g().remote ? " and pushed to the remote" : ""}, when there are any. Commit Now does it at once.
      </p>
      <p class="orgs-line">
        <Show when={g().lastCommit} fallback="No commits yet.">
          {(c) => (
            <>
              Last commit <time title={stampTime(c().at)}>{relativeTime(c().at)}</time> (<span class="orgs-mono">{c().sha}</span>): {c().message}
            </>
          )}
        </Show>
        {g().dirty ? " · uncommitted changes" : ""}
      </p>
      <Show when={g().lastError}>{(e) => <Banner tone="error" title="The last commit or push failed." body={e()} />}</Show>
      <form
        class="orgs-inline"
        onSubmit={(e) => {
          e.preventDefault();
          void props.act(() => setOrgRemote(props.org.id, remote().trim()), remote().trim() ? "Remote saved. Commits push there from now on." : "Remote removed. Commits stay local.");
        }}
      >
        <label class="field orgs-grow">
          <span class="field-label">Push to remote</span>
          <input class="input input-mono" value={remote()} onInput={(e) => setRemote(e.currentTarget.value)} placeholder="git@host:you/private-repo.git" aria-describedby="orgs-remote-hint" />
        </label>
        <button type="submit" class="button">
          Save Remote
        </button>
      </form>
      {/* Under the row, not in the field: inside it, the button would line up with the hint. */}
      <p class="field-hint orgs-inline-hint" id="orgs-remote-hint">
        Profiles are personal data: only a private repo. Empty: local commits only.
      </p>
    </section>
  );
}

function BatonSection(props: { org: OrgDetail; start?: string; act: Act; onLinks(l: OfferLink[] | null, warning?: string): void }) {
  const active = () => props.org.roster.filter((p) => p.status === "active");
  const [projectId, setProjectId] = createSignal("");
  const [to, setTo] = createSignal<string[]>([]);
  const [title, setTitle] = createSignal("");
  const [question, setQuestion] = createSignal("");
  const [briefing, setBriefing] = createSignal("");
  const [goal, setGoal] = createSignal("");
  const [model, setModel] = createSignal("");
  /** This session's message limit; blank = Settings' default. */
  const [limit, setLimit] = createSignal("");
  const [defaults] = createResource(() => getBatonSettings().catch(() => null));
  // Closed behind its button, except when a start link ("Start a session for Bob") brought us here.
  const [starting, setStarting] = createSignal(false);
  /** The baton session a start link came from (the new one records it as its parent). */
  const [parent, setParent] = createSignal<string | undefined>();
  let formEl: HTMLFormElement | undefined;
  // "started 5m ago" moves on while the page stays open.
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 30_000);
  onCleanup(() => clearInterval(tick));
  // "Start a session for Bob" (`…/start/<person>`, on first load or any later hash change) opens the
  // form with Bob ticked (and, from a baton session, that session as parent). Not an active person:
  // the form opens with nobody ticked.
  createEffect(
    on(
      () => props.start,
      (start) => {
        if (!start) return;
        const who = props.org.roster.some((p) => p.id === start && p.status === "active") ? start : undefined;
        setTo(who ? [who] : []);
        setParent(who ? takeStartParent(props.org.id, who) : undefined);
        setStarting(true);
        queueMicrotask(() => formEl?.scrollIntoView({ block: "start" }));
      },
    ),
  );
  /** Leave `…/start/<person>` once the form closes, so a reload doesn't reopen it. */
  const closeForm = () => {
    setStarting(false);
    setParent(undefined);
    if (props.start) location.replace(orgTabHref(props.org.id, "sessions"));
  };
  // A select with no matching option shows blank: the first option is the default, as it looks.
  // Archived projects are not offered (§app.organizations/archive).
  const liveProjects = () => props.org.projectList.filter((p) => !p.archived);
  const pid = () => projectId() || liveProjects()[0]?.id || "";
  /** What it can do (§app.baton/abilities): the project's set until the operator ticks otherwise. */
  const [chosen, setChosen] = createSignal<Partial<GatheringAbilities>>({});
  // Read while the form is open, for the project it names.
  const [projectSet] = createResource(
    () => (starting() && pid() ? { o: props.org.id, p: pid() } : false),
    ({ o, p }) => getProjectOverseer(o, p).then((i) => i.gatheringAbilitiesNow).catch(() => null),
  );
  const ability = (k: keyof GatheringAbilities): boolean => chosen()[k] ?? projectSet()?.[k] ?? AUTOMATIC_ABILITIES[k];
  /** Nobody ticked = you start; 1 = a hand-off; 2 or more = an offer. */
  const target = (): string | string[] => (to().length === 0 ? OPERATOR : to().length === 1 ? to()[0]! : to());
  const nameOf = (id: string) => props.org.roster.find((p) => p.id === id)?.name ?? "Their";
  const submit = async (e: Event) => {
    e.preventDefault();
    const who = target();
    let started: BatonStartResult | null = null;
    const ok = await props.act(async () => {
      started = await startBaton({
        orgId: props.org.id,
        projectId: pid(),
        to: who,
        publicTitle: title().trim(),
        goal: goal().trim(),
        ...(question().trim() ? { question: question().trim() } : {}),
        ...(briefing().trim() ? { briefing: briefing().trim() } : {}),
        ...(model().trim() ? { model: model().trim() } : {}),
        ...(limit().trim() ? { messagesMax: Number(limit()) } : {}),
        ...(parent() ? { parentSessionId: parent() } : {}),
        abilities: { draw: ability("draw"), readLinks: ability("readLinks") },
      });
    }, Array.isArray(who) ? `Offered to ${who.length} people.` : "Hand-off session started.");
    if (!ok || !started) return;
    const s = started as BatonStartResult;
    if (s.links?.length) props.onLinks(s.links, s.linkWarning);
    else if (s.link && typeof who === "string") props.onLinks([{ personId: who, name: nameOf(who), link: s.link }], s.linkWarning);
    setTitle("");
    setQuestion("");
    setBriefing("");
    setGoal("");
    setLimit("");
    setChosen({});
    setTo([]);
    closeForm();
  };
  return (
    <section class="card orgs-section" aria-labelledby="orgs-batons">
      <h2 class="orgs-h2" id="orgs-batons">
        Hand-off Sessions
      </h2>
      <Show when={props.org.batons.length} fallback={<p class="orgs-empty">{plural(props.org.people, "person", "people")} on the roster. No hand-off session yet.</p>}>
        <ul class="list">
          <For each={props.org.batons}>
            {(b) => (
              <li class="list-row orgs-row">
                <span class="list-main">
                  <a class="list-title" href={orgSessionHref(props.org.id, b.path)}>
                    {b.publicTitle}
                  </a>
                  <span class="list-meta">
                    {b.holder ? `With ${b.holder} · ` : ""}started {relativeTime(b.createdAt, now())}
                  </span>
                </span>
                {/* Open, but nobody has a link to it yet: that is the operator's to do. */}
                <Show when={b.waiting === "link"} fallback={<Chip tone={STATE_WORDS[b.state]?.tone}>{STATE_WORDS[b.state]?.word ?? b.state}</Chip>}>
                  <Chip tone="warn">Link to send</Chip>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show
        when={liveProjects().length}
        fallback={
          <p class="orgs-empty">
            Add a project on the <a href={orgTabHref(props.org.id, "projects")}>Projects</a> tab to start a hand-off session in it.
          </p>
        }
      >
        <Show
          when={starting()}
          fallback={
            <div class="button-row">
              <button type="button" class="button" aria-expanded="false" onClick={() => setStarting(true)}>
                <Icon name="plus" small /> Start a Hand-off Session
              </button>
            </div>
          }
        >
          <form class="orgs-form orgs-subform" onSubmit={submit} ref={formEl}>
            <h3 class="orgs-h3">Start a Hand-off Session</h3>
            <label class="field">
              <span class="field-label">Project</span>
              <select
                class="select"
                value={pid()}
                onChange={(e) => {
                  setProjectId(e.currentTarget.value);
                  setChosen({});
                }}
              >
                <For each={liveProjects()}>{(p) => <option value={p.id} selected={p.id === pid()}>{p.name}</option>}</For>
              </select>
            </label>
            <fieldset class="baton-strip-people">
              <legend class="field-label">Starts with</legend>
              <For each={active()} fallback={<p class="orgs-empty">Nobody active on the roster: it starts with you.</p>}>
                {(p) => (
                  <label class="toggle">
                    <input type="checkbox" checked={to().includes(p.id)} onChange={(e) => setTo((cur) => (e.currentTarget.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))} />
                    <span class="toggle-box" />
                    <span>{`${p.name}${p.role ? ` — ${p.role}` : ""}`}</span>
                  </label>
                )}
              </For>
              <p class="field-hint">
                {to().length === 0
                  ? "Nobody ticked: it starts with you."
                  : to().length === 1
                    ? `Starts with ${nameOf(to()[0]!)}.`
                    : `Offered to ${to().length} people: the first to answer takes it, for as long as they keep answering.`}
                {parent() ? " Started from the session you came from." : ""}
              </p>
            </fieldset>
            <label class="field">
              <span class="field-label">Public title</span>
              <input class="input" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} maxlength={120} required />
              <span class="field-hint">All they see of the goal.</span>
            </label>
            <label class="field">
              <span class="field-label">First question</span>
              <input class="input" value={question()} onInput={(e) => setQuestion(e.currentTarget.value)} maxlength={1000} placeholder="Default: the public title" />
            </label>
            <label class="field">
              <span class="field-label">Briefing</span>
              <textarea class="input textarea" rows={2} maxlength={2000} value={briefing()} onInput={(e) => setBriefing(e.currentTarget.value)} />
              <span class="field-hint">What the first person needs to know. Only they see it.</span>
            </label>
            <label class="field">
              <span class="field-label">Goal</span>
              <textarea class="input textarea" rows={4} value={goal()} onInput={(e) => setGoal(e.currentTarget.value)} maxlength={2000} required />
              <span class="field-hint">Private to the model. It works toward it and never shows it.</span>
            </label>
            <label class="field">
              <span class="field-label">Model</span>
              <input class="input input-mono" value={model()} onInput={(e) => setModel(e.currentTarget.value)} placeholder="Default: the new-session default" />
            </label>
            <label class="field">
              <span class="field-label">Message limit</span>
              <input
                class="input"
                type="number"
                min={MESSAGES_MIN}
                max={MESSAGES_CAP}
                step="1"
                value={limit()}
                onInput={(e) => setLimit(e.currentTarget.value)}
                placeholder={`Default: ${defaults()?.messagesMax ?? MESSAGES_DEFAULT}`}
              />
              <span class="field-hint">Messages in, from everyone. At the limit the session comes back to you, and you can extend it.</span>
            </label>
            <fieldset class="baton-strip-people">
              <legend class="field-label">It can:</legend>
              <label class="toggle">
                <input type="checkbox" checked={ability("draw")} onChange={(e) => setChosen((c) => ({ ...c, draw: e.currentTarget.checked }))} />
                <span class="toggle-box" />
                <span>Draw</span>
              </label>
              <label class="toggle">
                <input type="checkbox" checked={ability("readLinks")} onChange={(e) => setChosen((c) => ({ ...c, readLinks: e.currentTarget.checked }))} />
                <span class="toggle-box" />
                <span>Read links</span>
              </label>
            </fieldset>
            <div class="button-row">
              <button type="submit" class="button button-primary">
                {to().length > 1 ? `Offer to ${to().length}` : "Start Session"}
              </button>
              <button type="button" class="button button-ghost" onClick={closeForm}>
                Cancel
              </button>
            </div>
          </form>
        </Show>
      </Show>
    </section>
  );
}

// ---- people ---------------------------------------------------------------------------------------

function PeopleSection(props: { org: OrgDetail; act: Act }) {
  const [adding, setAdding] = createSignal(false);
  const now = useMinuteNow();
  return (
    <section class="card orgs-section" aria-labelledby="orgs-people">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="orgs-people">
          People
        </h2>
        <button type="button" class="button button-sm" aria-expanded={adding()} onClick={() => setAdding(!adding())}>
          <Icon name="plus" small /> Add Person
        </button>
      </div>
      <Show when={adding()}>
        <PersonForm
          submitLabel="Add Person"
          onCancel={() => setAdding(false)}
          onSubmit={async (input) => {
            const ok = await props.act(() => addPerson(props.org.id, input), `${input.name} added.`);
            if (ok) setAdding(false);
          }}
        />
      </Show>
      <Show when={props.org.roster.length} fallback={<p class="orgs-empty">Nobody on the roster yet.</p>}>
        <ul class="orgs-people">
          <For each={props.org.roster}>{(p) => <PersonCard org={props.org} person={p} act={props.act} now={now()} />}</For>
        </ul>
      </Show>
    </section>
  );
}

function PersonCard(props: { org: OrgDetail; person: Person; act: Act; now: number }) {
  const [editing, setEditing] = createSignal(false);
  const p = () => props.person;
  const contact = () =>
    Object.entries(p().contact)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
  return (
    <li class="orgs-person">
      {/* Name, status and role take the row; the actions wrap under them as one group when the
          card is narrow, so a name never breaks to fit a button. */}
      <div class="orgs-person-head">
        <div class="orgs-person-main">
          <span class="orgs-person-title">
            <a class="orgs-person-name orgs-person-link" href={personHref(props.org.id, p().id)}>
              {p().name}
            </a>
            <Chip tone={STATUS_CHIP[p().status]?.tone}>{STATUS_CHIP[p().status]?.word ?? p().status}</Chip>
          </span>
          <Show when={[p().role, p().language].filter(Boolean).join(" · ")}>{(meta) => <span class="orgs-person-meta">{meta()}</span>}</Show>
          {/* The newest time they opened one of their links (§app.baton/visits); nothing when no
              link was ever sent from this host. */}
          <Show when={props.org.lastOpened?.[p().id]}>
            {(o) => (
              <Show when={o().at} fallback={<Show when={o().minted}><span class="orgs-person-meta">Hasn't opened a link yet</span></Show>}>
                {(at) => (
                  <span class="orgs-person-meta">
                    Last opened <time title={stampTime(at())}>{relativeTime(at(), props.now)}</time>
                  </span>
                )}
              </Show>
            )}
          </Show>
        </div>
        <div class="orgs-person-actions">
        <Show when={p().status === "proposed"}>
          <button type="button" class="button button-sm" aria-label={`Approve ${p().name}`} onClick={() => void props.act(() => approvePerson(props.org.id, p().id), `${p().name} is on the roster now.`)}>
            Approve
          </button>
          <button type="button" class="button button-sm button-ghost" aria-label={`Decline ${p().name}`} onClick={() => void props.act(() => declinePerson(props.org.id, p().id), `Declined ${p().name}. The referral stays in their history.`)}>
            Decline
          </button>
        </Show>
        <Show when={p().status === "active"}>
          <a class="button button-sm button-ghost" href={startForHref(props.org.id, p().id)} aria-label={`Start a session with ${p().name}`}>
            Start a Session
          </a>
        </Show>
        <button type="button" class="button button-sm button-ghost" aria-expanded={editing()} aria-label={`Edit ${p().name}`} onClick={() => setEditing(!editing())}>
          <Icon name="pencil" small /> Edit
        </button>
        </div>
      </div>
      {/* What Approve grants, next to it. With no decision areas it grants none, and the facts
          show no Decides row, so there is no line to add. */}
      <Show when={p().status === "proposed" && !editing() && p().decides.length}>
        <p class="baton-strip-areas">{proposedAreasLine(p().name, p().decides)}</p>
      </Show>
      <Show when={!editing()}>
        <dl class="orgs-facts">
          <Show when={p().decides.length}>
            <dt>Decides</dt>
            <dd>{p().decides.join(", ")}</dd>
          </Show>
          <Show when={p().skills.length}>
            <dt>Skills</dt>
            <dd>{p().skills.join(", ")}</dd>
          </Show>
          <Show when={p().voice}>
            <dt>Voice</dt>
            <dd>{p().voice}</dd>
          </Show>
          <Show when={contact()}>
            <dt>Contact</dt>
            <dd>{contact()}</dd>
          </Show>
          <Show when={p().referral}>
            {(r) => (
              <>
                <dt>Referred</dt>
                <dd>
                  by {props.org.roster.find((x) => x.id === r().referredBy)?.name ?? (r().referredBy === OPERATOR ? "you" : r().referredBy)}: {r().why}
                  {r().quote ? ` · “${r().quote}”` : ""}
                </dd>
              </>
            )}
          </Show>
        </dl>
      </Show>
      <Show when={editing()}>
        <PersonForm
          person={p()}
          submitLabel="Save Changes"
          onCancel={() => setEditing(false)}
          onSubmit={async (input: Partial<PersonInput>) => {
            const ok = await props.act(() => patchPerson(props.org.id, p().id, input), "Saved.");
            if (ok) setEditing(false);
          }}
        />
      </Show>
    </li>
  );
}

// ---- recent profile changes: what the wrap-ups, referrals and you changed, each revertible -----------

type WriterFilter = "all" | ProfileChange["by"]["kind"];
const WRITER_FILTERS: { value: WriterFilter; label: string }[] = [
  { value: "all", label: "Every writer" },
  { value: "wrapup", label: "Wrap-ups" },
  { value: "referral", label: "Referrals" },
  { value: "overseer", label: "Overseer" },
  { value: "operator", label: "You" },
];

function ChangesSection(props: { org: OrgDetail; act: Act }) {
  const [writer, setWriter] = createSignal<WriterFilter>("all");
  const changes = () => (props.org.recentChanges ?? []).filter((c) => writer() === "all" || c.by.kind === writer());
  const groups = createMemo(() => groupChanges(changes()));
  const pathOf = (sid?: string) => (sid ? props.org.batons.find((b) => b.sessionId === sid)?.path : undefined);
  const undone = createMemo(() => new Set((props.org.recentChanges ?? []).flatMap((c) => (c.revertOf ? [c.revertOf] : []))));
  const revert = (c: NamedChange) => void props.act(() => revertPersonChange(props.org.id, c.personId, c.at), `Reverted ${c.name}'s ${c.field}.`);
  return (
    <section class="card orgs-section" aria-labelledby="orgs-changes">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="orgs-changes">
          Recent Profile Changes
        </h2>
        <label class="field orgs-changes-filter">
          <span class="visually-hidden">Show changes by</span>
          <select class="select" value={writer()} onChange={(e) => setWriter(e.currentTarget.value as WriterFilter)}>
            <For each={WRITER_FILTERS}>{(f) => <option value={f.value}>{f.label}</option>}</For>
          </select>
        </label>
      </div>
      <p class="orgs-line project-muted">Wrap-ups write skills, competence, language and voice on their own. Each change keeps the words it came from.</p>
      <Show
        when={groups().length}
        fallback={<p class="orgs-empty">{`${plural(props.org.people, "person", "people")} on the roster. ${writer() === "all" ? "No profile change yet." : "No change by this writer in the recent ones."}`}</p>}
      >
        <ul class="orgs-history-list">
          <For each={groups()}>
            {(g) => (
              <li class="orgs-change orgs-change-group">
                <div class="orgs-change-main">
                  <span>
                    <a class="orgs-person-name orgs-person-link" href={personHref(props.org.id, g.personId)}>
                      {g.name}
                    </a>
                    {g.added ? " added" : ""}
                    <span class="list-meta">
                    {" "}
                    · by {writerWord(g.by)} · <time title={g.key}>{relativeTime(g.key)}</time>
                    <Show when={pathOf(g.by.sessionId)}>
                      {(path) => (
                        <>
                          {" · "}
                          <a href={orgSessionHref(props.org.id, path())}>Session</a>
                        </>
                      )}
                    </Show>
                    </span>
                  </span>
                  <Show when={g.by.quote}>{(q) => <blockquote class="project-quote">{q()}</blockquote>}</Show>
                  <ul class="orgs-change-fields">
                    <For each={g.changes}>
                      {(c) => (
                        <li class="orgs-change">
                          <span class="orgs-change-main">
                            <span class="orgs-change-field">{c.field}</span> {g.added ? "" : `${valueText(c.field, c.from)} → `}
                            {valueText(c.field, c.to)}
                            {c.revertOf ? <span class="list-meta"> · a revert</span> : ""}
                          </span>
                          <Show when={revertible(c, undone())}>
                            <button type="button" class="button button-sm button-ghost" aria-label={`Revert ${c.name}'s ${c.field}`} onClick={() => revert(c)}>
                              <Icon name="undo" small /> Revert
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

// ---- projects ---------------------------------------------------------------------------------------

/** About this organization (§app.organizations/about): the operator's text every project overseer of
    the org reads. `draft` is null while nothing is typed, so the page's re-reads show the saved text
    and never overwrite one being edited. */
function AboutCard(props: { org: OrgDetail; act: Act }) {
  const [draft, setDraft] = createSignal<string | null>(null);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);
  const saved = () => props.org.about ?? "";
  const text = () => draft() ?? saved();
  const dirty = () => draft() !== null && draft() !== saved();
  const history = () => props.org.aboutHistory ?? [];
  const save = async () => {
    setSaving(true);
    // Said before the draft goes: after it, text() is the saved text again.
    const done = text().trim() ? "Saved. Project overseers read it at their next run." : "Cleared.";
    try {
      const next = await patchOrg(props.org.id, { about: text() });
      setProblem(null);
      setDraft(null);
      await props.act(async () => next, done);
    } catch (err) {
      setProblem(errText(err));
    } finally {
      setSaving(false);
    }
  };
  const revert = (c: OrgChange) => void props.act(() => revertOrgAbout(props.org.id, c.at), "Reverted.");
  return (
    <section class="card orgs-section" aria-labelledby="orgs-about">
      <h2 class="orgs-h2" id="orgs-about">
        About this organization
      </h2>
      <p class="orgs-line project-muted" id="orgs-about-hint">
        Every project overseer in this organization reads this at its next run, and the Overseer when it looks it up for you. Nothing else does: not hand-off sessions, share pages, wrap-ups or
        coding sessions.
      </p>
      <form
        class="orgs-about-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty() && !saving()) void save();
        }}
      >
        <textarea
          class="input textarea orgs-about-text"
          rows={6}
          maxlength={ORG_ABOUT_MAX}
          value={text()}
          aria-labelledby="orgs-about"
          aria-describedby={problem() ? "orgs-about-hint orgs-about-error" : "orgs-about-hint"}
          aria-invalid={problem() ? "true" : undefined}
          placeholder="Who they are, how they work, what to be careful with."
          onInput={(e) => {
            setDraft(e.currentTarget.value);
            setProblem(null);
          }}
        />
        <Show when={problem()}>
          {(p) => (
            <p class="field-error" id="orgs-about-error">
              {p()}
            </p>
          )}
        </Show>
        <div class="orgs-about-foot">
          <span class="field-hint orgs-mono">{aboutCount(text())}</span>
          <Show when={aboutOverCap(text())}>
            <span class="field-hint orgs-about-over">Only the first 4,000 characters are used.</span>
          </Show>
          <span class="orgs-grow" />
          <button
            type="button"
            class="button button-ghost"
            disabled={!dirty() || saving()}
            onClick={() => {
              setDraft(null);
              setProblem(null);
            }}
          >
            Cancel
          </button>
          <button type="submit" class="button button-primary" disabled={!dirty() || saving()}>
            Save
          </button>
        </div>
      </form>
      <Show when={history().length}>
        <details class="orgs-history orgs-history-section">
          <summary>History ({history().length})</summary>
          <ul class="orgs-history-list">
            <For each={history()}>
              {(c) => (
                <li class="orgs-change orgs-change-group">
                  <div class="orgs-change-main">
                    <span>
                      {aboutChangeWord(c)}
                      <span class="list-meta">
                        {" · "}
                        <time title={stampTime(c.at)}>{relativeTime(c.at)}</time>
                        {` · ${aboutLength(c.to)}`}
                        {c.by.via === "overseer" ? " · by you, via the Overseer" : ""}
                      </span>
                    </span>
                    <span class="orgs-about-preview">{aboutPreview(c.to)}</span>
                    <details class="orgs-history">
                      <summary>Before and after</summary>
                      <div class="orgs-about-diff">
                        <span class="field-label">Before</span>
                        <p class="orgs-about-full">{c.from || "(empty)"}</p>
                        <span class="field-label">After</span>
                        <p class="orgs-about-full">{c.to || "(empty)"}</p>
                      </div>
                    </details>
                  </div>
                  <button
                    type="button"
                    class="button button-sm button-ghost"
                    disabled={c.from === saved()}
                    title={c.from === saved() ? "The text is already this." : undefined}
                    aria-label={`Revert the change of ${stampTime(c.at)}`}
                    onClick={() => revert(c)}
                  >
                    <Icon name="undo" small /> Revert
                  </button>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
    </section>
  );
}

function ProjectsSection(props: { org: OrgDetail; act: Act }) {
  const [name, setName] = createSignal("");
  const [root, setRoot] = createSignal("");
  // Each project's cost at API prices (§app/project-costs/org-rollup); the list stands without it.
  const orgId = createMemo(() => props.org.id);
  const [costs] = createResource(orgId, (id) => getOrgCosts(id).catch(() => null));
  const costOf = (pid: string) => costs()?.projects.find((c) => c.projectId === pid);
  // Archived projects leave the list for a disclosure under it (§app.organizations/archive).
  const live = () => props.org.projectList.filter((p) => !p.archived);
  const archived = () => props.org.projectList.filter((p) => p.archived);
  return (
    <section class="card orgs-section" aria-labelledby="orgs-projects">
      <h2 class="orgs-h2" id="orgs-projects">
        Projects
      </h2>
      <Show when={props.org.projectList.length > 0 && costs()}>
        {(c) => (
          <p class="orgs-line orgs-projects-cost">
            All projects: <span class="cost-figure">{usd(c().totalUsd)}</span> at API prices.
          </p>
        )}
      </Show>
      <Show
        when={live().length}
        fallback={
          <p class="orgs-empty">
            {archived().length
              ? `${archived().length === 1 ? "The 1 project here is" : `All ${archived().length} projects here are`} archived. Unarchive one below, or add a project.`
              : "No projects yet. A project is a folder that hand-off sessions and its overseer work in."}
          </p>
        }
      >
        <ul class="list orgs-project-list">
          <For each={live()}>
            {(p) => (
              <li>
                {/* The whole row opens the project page: its overseer, requirements and decisions. */}
                <a class="list-row list-row-interactive orgs-row orgs-project-row" href={projectHref(props.org.id, p.id)}>
                  <Icon name="folder" />
                  <span class="list-main">
                    <span class="list-title">{p.name}</span>
                    <span class="list-meta orgs-mono" title={p.root}>
                      {p.root}
                    </span>
                  </span>
                  <Show when={costOf(p.id)}>
                    {(c) => (
                      <span class="cost-figure text-muted orgs-project-cost">{usd(c().totalUsd)}</span>
                    )}
                  </Show>
                  <Icon name="chevron-right" class="orgs-row-go" />
                </a>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={archived().length}>
        <details class="orgs-history orgs-history-section">
          <summary>Archived Projects ({archived().length})</summary>
          <ul class="list orgs-project-list">
            <For each={archived()}>
              {(p) => (
                <li class="orgs-archived-row">
                  <a class="list-row list-row-interactive orgs-row orgs-project-row" href={projectHref(props.org.id, p.id)}>
                    <Icon name="folder" />
                    <span class="list-main">
                      <span class="list-title">{p.name}</span>
                      <span class="list-meta">
                        archived <time title={p.archived!.at}>{relativeTime(p.archived!.at)}</time>
                      </span>
                    </span>
                  </a>
                  <button type="button" class="button button-sm button-ghost" onClick={() => void props.act(() => unarchiveOrgProject(props.org.id, p.id), `${p.name} is back.`)}>
                    Unarchive
                  </button>
                </li>
              )}
            </For>
          </ul>
        </details>
      </Show>
      <form
        class="orgs-inline orgs-project-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await props.act(() => addOrgProject(props.org.id, name().trim(), root().trim()), "Project added.")) {
            setName("");
            setRoot("");
          }
        }}
      >
        <label class="field">
          <span class="field-label">Project name</span>
          <input class="input" value={name()} onInput={(e) => setName(e.currentTarget.value)} maxlength={80} required />
        </label>
        <label class="field orgs-grow">
          <span class="field-label">Folder</span>
          <input class="input input-mono" value={root()} onInput={(e) => setRoot(e.currentTarget.value)} placeholder="/path/to/project" required />
        </label>
        <button type="submit" class="button">
          Add Project
        </button>
      </form>
    </section>
  );
}
