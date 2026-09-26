import { createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { OPERATOR, type BatonStartResult, type BatonView, type BatonViewItem, type OfferLink } from "../../shared/baton";
import type { NamedChange, OrgDetail, Person, PersonInput, ProfileChange } from "../../shared/orgs";
import {
  addOrgProject,
  addPerson,
  ApiError,
  approvePerson,
  declinePerson,
  attachOrg,
  commitOrg,
  createOrg,
  getOrg,
  getOrgs,
  openProjectOverseer,
  patchPerson,
  personHistory,
  revertPersonChange,
  setOperatorName,
  setOrgRemote,
  startBaton,
} from "../lib/api";
import { duration, relativeTime, stampTime } from "../lib/format";
import { needsYouCount, needsYouLabel, orgCountsLine } from "../lib/org-cards";
import { proposedAreasLine } from "../lib/baton-strip";
import { groupChanges, revertible, valueText } from "../lib/profile-changes";
import { orgPageRoute } from "../lib/org-page-route";
import { createOrgSource } from "../lib/org-source";
import { orgHref, orgTabHref, projectHref, startForHref, takeStartParent, type OrgsRoute, type OrgTab } from "../lib/orgs-route";
import { orgTabsOf } from "../lib/org-tabs";
import { toast } from "../lib/ui-state";
import { InsightsPage } from "./InsightsPage";
import { LinksBanner } from "./LinksBanner";
import { ProjectPage } from "./ProjectPage";
import { Banner, Chip, Icon } from "./ui";
import "../orgs.css";
import "../projects.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sessionHref = (path: string) => `#/s/${encodeURIComponent(path)}`;
/** Who wrote a profile change, in words. */
const WRITER: Record<ProfileChange["by"]["kind"], string> = { operator: "you", wrapup: "wrap-up", referral: "referral", overseer: "overseer" };

const STATE_WORDS: Record<string, { word: string; tone: "info" | "warn" | "success" | undefined }> = {
  open: { word: "Open", tone: "info" },
  "needs-you": { word: "Needs you", tone: "warn" },
  done: { word: "Done", tone: "success" },
  closed: { word: "Closed", tone: undefined },
};

/** The organizations page: `#/orgs`, `#/orgs/<id>[/<tab>|/start/<person>]`,
    `#/orgs/<id>/projects/<project>[/overseer]`. */
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
    (info) => (info.path ? location.replace(`#/s/${encodeURIComponent(info.path)}`) : setFailed("It has no conversation yet.")),
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
          if (attachDir().trim()) void act(async () => {
            const org = await attachOrg(attachDir().trim());
            location.hash = orgHref(org.id);
          }, "Organization attached.");
        }}
      >
        <h2 class="orgs-h2">Attach a Restored Repo</h2>
        <label class="field">
          <span class="field-label">Workspace repo</span>
          <input class="input input-mono" value={attachDir()} onInput={(e) => setAttachDir(e.currentTarget.value)} placeholder="/path/to/cloned/workspace" />
          <span class="field-hint">A clone of an organization's workspace repo. Links are not in the repo: send new ones after attaching. Its project overseers start paused at L0 until you set their level here.</span>
        </label>
        <div class="button-row">
          <button type="submit" class="button">
            Attach Repo
          </button>
        </div>
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
  const act = async (fn: () => Promise<OrgDetail | unknown>, done?: string): Promise<boolean> => {
    try {
      const r = await fn();
      org.set(r && typeof r === "object" && "roster" in r ? (r as OrgDetail) : await getOrg(props.id));
      setError(null);
      if (done) toast(done);
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
            <For each={o().problems}>{(p) => <Banner tone="warn" title="The workspace repo has a problem." body={p} />}</For>
            <Show when={links()}>{(l) => <LinksBanner links={l()} onDismiss={() => setLinks(null)} />}</Show>
            <OrgTabs org={o()} tab={tab()} />
            <div class="org-tabpanel" role="tabpanel" id="org-tabpanel" aria-labelledby={`org-tab-${tab()}`}>
              <Switch>
                <Match when={tab() === "sessions"}>
                  <BatonSection org={o()} start={props.start} act={act} onLinks={setLinks} />
                </Match>
                <Match when={tab() === "people"}>
                  <PeopleSection org={o()} act={act} />
                  <ChangesSection org={o()} act={act} />
                </Match>
                <Match when={tab() === "projects"}>
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

type Act = (fn: () => Promise<OrgDetail | unknown>, done?: string) => Promise<boolean>;

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
        <button type="button" class="button button-sm" onClick={() => void props.act(() => commitOrg(props.org.id), "Committed.")}>
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

function BatonSection(props: { org: OrgDetail; start?: string; act: Act; onLinks(l: OfferLink[] | null): void }) {
  const active = () => props.org.roster.filter((p) => p.status === "active");
  const [projectId, setProjectId] = createSignal("");
  const [to, setTo] = createSignal<string[]>([]);
  const [title, setTitle] = createSignal("");
  const [question, setQuestion] = createSignal("");
  const [briefing, setBriefing] = createSignal("");
  const [goal, setGoal] = createSignal("");
  const [model, setModel] = createSignal("");
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
  const pid = () => projectId() || props.org.projectList[0]?.id || "";
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
        ...(parent() ? { parentSessionId: parent() } : {}),
      });
    }, Array.isArray(who) ? `Offered to ${who.length} people.` : "Hand-off session started.");
    if (!ok || !started) return;
    const s = started as BatonStartResult;
    if (s.links?.length) props.onLinks(s.links);
    else if (s.link && typeof who === "string") props.onLinks([{ personId: who, name: nameOf(who), link: s.link }]);
    setTitle("");
    setQuestion("");
    setBriefing("");
    setGoal("");
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
                  <a class="list-title" href={sessionHref(b.path)}>
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
        when={props.org.projectList.length}
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
              <select class="select" value={pid()} onChange={(e) => setProjectId(e.currentTarget.value)}>
                <For each={props.org.projectList}>{(p) => <option value={p.id} selected={p.id === pid()}>{p.name}</option>}</For>
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
          <For each={props.org.roster}>{(p) => <PersonCard org={props.org} person={p} act={props.act} />}</For>
        </ul>
      </Show>
    </section>
  );
}

const STATUS_CHIP: Record<string, { word: string; tone?: "success" | "warn" }> = {
  active: { word: "Active", tone: "success" },
  proposed: { word: "Proposed", tone: "warn" },
  left: { word: "Left" },
};

function PersonCard(props: { org: OrgDetail; person: Person; act: Act }) {
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
            <span class="orgs-person-name">{p().name}</span>
            <Chip tone={STATUS_CHIP[p().status]?.tone}>{STATUS_CHIP[p().status]?.word ?? p().status}</Chip>
          </span>
          <Show when={[p().role, p().language].filter(Boolean).join(" · ")}>{(meta) => <span class="orgs-person-meta">{meta()}</span>}</Show>
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
          onSubmit={async (input) => {
            const ok = await props.act(() => patchPerson(props.org.id, p().id, input), "Saved.");
            if (ok) setEditing(false);
          }}
        />
      </Show>
      <History orgId={props.org.id} person={p()} act={props.act} />
    </li>
  );
}

function History(props: { orgId: string; person: Person; act: Act }) {
  const [open, setOpen] = createSignal(false);
  const [lines, { refetch }] = createResource(
    () => (open() ? { org: props.orgId, pid: props.person.id, v: JSON.stringify(props.person) } : null),
    (k) => personHistory(k.org, k.pid),
  );
  return (
    <details class="orgs-history" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>History</summary>
      <Show when={lines()} fallback={<p class="orgs-empty">Loading history.</p>}>
        <ul class="orgs-history-list">
          <For each={lines()}>
            {(c: ProfileChange) => (
              <li class="orgs-change">
                <span class="orgs-change-main">
                  <span class="orgs-change-field">{c.field}</span> {valueText(c.field, c.from)} → {valueText(c.field, c.to)}
                  <span class="list-meta">
                    {" "}
                    · {WRITER[c.by.kind] ?? c.by.kind}
                    {c.by.quote ? ` · “${c.by.quote}”` : ""}
                    {c.revertOf ? " · a revert" : ""} · <time title={c.at}>{relativeTime(c.at)}</time>
                  </span>
                </span>
                <Show when={c.field !== "name" || c.from !== null}>
                  <button
                    type="button"
                    class="button button-sm button-ghost"
                    onClick={async () => {
                      if (await props.act(() => revertPersonChange(props.orgId, props.person.id, c.at), `Reverted ${c.field}.`)) void refetch();
                    }}
                  >
                    <Icon name="undo" small /> Revert
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </details>
  );
}

function PersonForm(props: { person?: Person; submitLabel: string; onSubmit(input: PersonInput): void; onCancel(): void }) {
  const p = props.person;
  const [name, setName] = createSignal(p?.name ?? "");
  const [status, setStatus] = createSignal<Person["status"]>(p?.status ?? "active");
  const [role, setRole] = createSignal(p?.role ?? "");
  const [decides, setDecides] = createSignal(p?.decides.join(", ") ?? "");
  const [skills, setSkills] = createSignal(p?.skills.join(", ") ?? "");
  const [language, setLanguage] = createSignal(p?.language ?? "");
  const [voice, setVoice] = createSignal(p?.voice ?? "");
  const [email, setEmail] = createSignal(p?.contact.email ?? "");
  const [phone, setPhone] = createSignal(p?.contact.phone ?? "");
  const [whatsapp, setWhatsapp] = createSignal(p?.contact.whatsapp ?? "");
  const [why, setWhy] = createSignal(p?.referral?.why ?? "");
  const [by, setBy] = createSignal(p?.referral?.referredBy ?? "");
  const text = (label: string, get: () => string, set: (v: string) => void, extra: JSX.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label class="field">
      <span class="field-label">{label}</span>
      <input class="input" value={get()} onInput={(e) => set(e.currentTarget.value)} {...extra} />
    </label>
  );
  return (
    <form
      class="orgs-form orgs-subform"
      onSubmit={(e) => {
        e.preventDefault();
        const contact = { ...(email().trim() ? { email: email().trim() } : {}), ...(phone().trim() ? { phone: phone().trim() } : {}), ...(whatsapp().trim() ? { whatsapp: whatsapp().trim() } : {}) };
        props.onSubmit({
          name: name().trim(),
          status: status(),
          role: role().trim(),
          decides: list(decides()),
          skills: list(skills()),
          language: language().trim(),
          voice: voice().trim(),
          contact,
          ...(status() === "proposed" || why().trim() || by().trim() ? { referral: { why: why().trim(), referredBy: by().trim() } } : {}),
        });
      }}
    >
      <div class="orgs-fields">
        {text("Name", name, setName, { maxlength: 80, required: true })}
        <label class="field">
          <span class="field-label">Status</span>
          <select class="select" value={status()} onChange={(e) => setStatus(e.currentTarget.value as Person["status"])}>
            <option value="active">Active</option>
            <option value="proposed">Proposed</option>
            <option value="left">Left</option>
          </select>
        </label>
        {text("Role", role, setRole, { maxlength: 300 })}
        {text("Language", language, setLanguage, { placeholder: "es-CO", maxlength: 35 })}
        {text("Decides", decides, setDecides, { placeholder: "invoicing, bank access" })}
        {text("Skills", skills, setSkills, { placeholder: "Excel, SQL" })}
        {text("Email", email, setEmail, { type: "email" })}
        {text("Phone", phone, setPhone)}
        {text("WhatsApp", whatsapp, setWhatsapp)}
      </div>
      <label class="field">
        <span class="field-label">Voice</span>
        <textarea class="input textarea" rows={2} maxlength={300} value={voice()} onInput={(e) => setVoice(e.currentTarget.value)} />
        <span class="field-hint">How to talk to them. Never shown to them or anyone else outside this page.</span>
      </label>
      <Show when={status() === "proposed"}>
        <div class="orgs-fields">
          {text("Why referred", why, setWhy, { maxlength: 300, required: true })}
          {text("Referred by", by, setBy, { maxlength: 80, required: true })}
        </div>
        <p class="field-hint">A proposed person needs a name, a contact, a role, and who referred them and why.</p>
      </Show>
      <div class="button-row">
        <button type="submit" class="button button-primary">
          {props.submitLabel}
        </button>
        <button type="button" class="button button-ghost" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </form>
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
                    <span class="orgs-person-name">{g.name}</span>
                    {g.added ? " added" : ""}
                    <span class="list-meta">
                    {" "}
                    · by {WRITER[g.by.kind] ?? g.by.kind} · <time title={g.key}>{relativeTime(g.key)}</time>
                    <Show when={pathOf(g.by.sessionId)}>
                      {(path) => (
                        <>
                          {" · "}
                          <a href={sessionHref(path())}>Session</a>
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

function ProjectsSection(props: { org: OrgDetail; act: Act }) {
  const [name, setName] = createSignal("");
  const [root, setRoot] = createSignal("");
  return (
    <section class="card orgs-section" aria-labelledby="orgs-projects">
      <h2 class="orgs-h2" id="orgs-projects">
        Projects
      </h2>
      <Show when={props.org.projectList.length} fallback={<p class="orgs-empty">No projects yet. A project is a folder that hand-off sessions and its overseer work in.</p>}>
        <ul class="list orgs-project-list">
          <For each={props.org.projectList}>
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
                  <Icon name="chevron-right" class="orgs-row-go" />
                </a>
              </li>
            )}
          </For>
        </ul>
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
