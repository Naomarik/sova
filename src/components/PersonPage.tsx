import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { OPERATOR, type BatonView, type BatonViewItem } from "../../shared/baton";
import type { Person, PersonInput, PersonPage as PersonPageData, PersonSessionRow, ProfileChange, VisitRow } from "../../shared/orgs";
import { ApiError, approvePerson, batonLink, declinePerson, getOrg, getPersonPage, inviteeLink, patchPerson, previewAsPerson, revertPersonChange, revokePersonLinks } from "../lib/api";
import { proposedAreasLine } from "../lib/baton-strip";
import { DECISION_STATE } from "../lib/decisions-view";
import { relativeIn, relativeTime, stampTime } from "../lib/format";
import { useMinuteNow } from "../lib/minute-clock";
import { ORG_POLL_MS } from "../lib/org-source";
import { orgHref, orgSessionHref, orgTabHref, projectHref, startForHref } from "../lib/orgs-route";
import {
  canPreview,
  firstName,
  holdLine,
  leftAt,
  LINK_STATE,
  linkLive,
  messagesLine,
  relationWords,
  sinceWords,
  VISITS_FOLDED,
  visitsSummary,
  visitWords,
} from "../lib/person-page";
import { createPoll } from "../lib/poll";
import { STATUS_CHIP, valueText, WRITER } from "../lib/profile-changes";
import { announce, toast } from "../lib/ui-state";
import { InsightsPage } from "./InsightsPage";
import { LinksBanner } from "./LinksBanner";
import { PersonForm } from "./PersonForm";
import { Banner, Chip, Icon, trapFocus } from "./ui";
import type { OfferLink } from "../../shared/baton";
import "../orgs.css";
import "../projects.css";
import "../person.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** The exact stamp a relative time carries as its title: `2026-09-27 14:06`, local, 24-hour. */
const exact = (at: string) => {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const SESSION_STATE: Record<PersonSessionRow["state"], { word: string; tone?: "info" | "warn" | "success" }> = {
  open: { word: "Open", tone: "info" },
  "needs-you": { word: "Needs you", tone: "warn" },
  done: { word: "Done", tone: "success" },
  closed: { word: "Closed" },
};

type Act = (fn: () => Promise<unknown>, done?: string) => Promise<boolean>;

/**
 * One roster person (`#/orgs/<id>/people/<pid>`, §app.organizations/person-page): their profile,
 * every hand-off session they took part in across the org's projects, their decisions and the
 * conflicts routed to them, their links on this host with the visit log, and their profile history
 * with Revert. Re-read every 10 s while the tab shows, reconciled in place.
 */
export function PersonPage(props: { orgId: string; personId: string; titleRef(el: HTMLHeadingElement): void }) {
  /** The org has no such person (a 404): the page says so instead of an error banner. */
  const [missing, setMissing] = createSignal(false);
  const page = createPoll(
    () =>
      getPersonPage(props.orgId, props.personId).then(
        (d) => (setMissing(false), d),
        (err) => {
          setMissing(err instanceof ApiError && err.status === 404);
          throw err;
        },
      ),
    ORG_POLL_MS,
  );
  const now = useMinuteNow();
  const [error, setError] = createSignal<string | null>(null);
  const [links, setLinks] = createSignal<OfferLink[] | null>(null);
  const [linkWarning, setLinkWarning] = createSignal<string | undefined>();
  const [editing, setEditing] = createSignal(false);
  /** The session being previewed, by id: rows are reconciled in place and may move under a poll. */
  const [preview, setPreview] = createSignal<string | null>(null);
  const person = () => page.data()?.person;
  // Only for a referrer's name (the page names people by id there): read once, and re-read when
  // they are proposed or referred, which is rare. A failure leaves "Someone".
  const [org] = createResource(
    () => page.data()?.person.referral?.referredBy,
    () => getOrg(props.orgId).catch(() => null),
  );
  const roster = () => org()?.roster ?? [];
  const name = () => person()?.name ?? "";

  /** One write: adopt the page it answers with (or re-read), or say what failed. */
  const act: Act = async (fn, done) => {
    try {
      const r = await fn();
      if (r && typeof r === "object" && "person" in r && "sessions" in r) page.set(r as PersonPageData);
      else page.refetch();
      setError(null);
      if (done) {
        toast(done);
        announce(done);
      }
      return true;
    } catch (err) {
      setError(errText(err));
      return false;
    }
  };

  return (
    <InsightsPage
      title={name() || "Person"}
      meta={
        <Show when={page.data()}>
          {(d) => (
            <>
              <a class="orgs-meta-link" href="#/orgs">
                Organizations
              </a>{" "}
              · <a class="orgs-meta-link" href={orgHref(d().org.id)}>{d().org.name}</a> ·{" "}
              <a class="orgs-meta-link" href={orgTabHref(d().org.id, "people")}>
                People
              </a>
            </>
          )}
        </Show>
      }
      titleAfter={
        <Show when={person()}>
          {(p) => <Chip tone={STATUS_CHIP[p().status]?.tone}>{STATUS_CHIP[p().status]?.word ?? p().status}</Chip>}
        </Show>
      }
      back={{ href: orgTabHref(props.orgId, "people"), label: "People" }}
      refreshLabel="Refresh Person"
      onRefresh={() => page.refetch()}
      error={error() ?? (missing() ? null : page.error())}
      errorTitle="Couldn't update this person's page."
      busy={page.pending()}
      titleRef={props.titleRef}
      class="person-page"
    >
      <Show when={missing()}>
        <div class="card orgs-section">
          <p class="orgs-empty">This organization has no person with that id.</p>
          <div class="button-row">
            <a class="button" href={orgTabHref(props.orgId, "people")}>
              People
            </a>
          </div>
        </div>
      </Show>
      <Show when={!missing() && page.data()}>
        {(d) => (
          <>
            <Show when={links()}>{(l) => <LinksBanner links={l()} warning={linkWarning()} onDismiss={() => setLinks(null)} />}</Show>
            <StatusBanner data={d()} now={now()} roster={roster()} />
            <Head data={d()} act={act} editing={editing()} onEdit={() => setEditing(!editing())} roster={roster()} />
            <Show when={editing()}>
              <section class="card orgs-section" aria-label={`Edit ${name()}`}>
                <PersonForm
                  person={d().person}
                  submitLabel="Save Changes"
                  onCancel={() => setEditing(false)}
                  onSubmit={async (input: Partial<PersonInput>) => {
                    if (await act(() => patchPerson(props.orgId, props.personId, input), "Saved.")) setEditing(false);
                  }}
                />
              </section>
            </Show>
            <Sessions data={d()} now={now()} onPreview={(row) => setPreview(row.sessionId)} />
            <Decisions data={d()} now={now()} />
            <LinksAndVisits
              data={d()}
              now={now()}
              act={act}
              onLinks={(l, warning) => {
                setLinkWarning(warning);
                setLinks(l);
              }}
            />
            <History data={d()} now={now()} act={act} />
            <Show when={d().sessions.find((s) => s.sessionId === preview())}>
              {(row) => <Preview data={d()} row={row()} onClose={() => setPreview(null)} />}
            </Show>
          </>
        )}
      </Show>
    </InsightsPage>
  );
}

// ---- head and banners --------------------------------------------------------------------------------

/** Who referred them, in words: a roster person (by the org's roster, or a session's relation),
    "You", or the free-text name the referral carries. */
function referrerName(data: PersonPageData, roster: readonly { id: string; name: string }[] = []): string {
  const by = data.person.referral?.referredBy ?? "";
  if (by === OPERATOR) return "You";
  const onRoster = roster.find((p) => p.id === by);
  if (onRoster) return onRoster.name;
  for (const s of data.sessions) for (const r of s.relations) if (r.kind === "referred-here" && r.by.id === by) return r.by.name;
  return /^p_[A-Za-z0-9]+$/.test(by) ? "Someone" : by || "Someone";
}

function StatusBanner(props: { data: PersonPageData; now: number; roster: readonly Person[] }) {
  const p = () => props.data.person;
  const left = createMemo(() => leftAt(props.data.history));
  /** When they were proposed: their oldest history line (the one that added them). */
  const proposedAt = () => props.data.history[props.data.history.length - 1]?.at;
  const referralSession = () => {
    const sid = p().referral?.sessionId;
    return sid ? props.data.sessions.find((s) => s.sessionId === sid) : undefined;
  };
  return (
    <>
      <Show when={p().status === "left"}>
        <Banner
          tone="info"
          title={`${p().name} left the organization${left() ? ` ${sinceWords(left()!, props.now)}` : ""}. Their links no longer open, and nothing they send is accepted.`}
        />
      </Show>
      <Show when={p().status === "proposed" && p().referral}>
        {(r) => (
          <Banner
            tone="info"
            title={
              <>
                {referrerName(props.data, props.roster)} proposed {p().name}
                {proposedAt() ? ` ${sinceWords(proposedAt()!, props.now)}` : ""}
                <Show when={referralSession()}>
                  {(s) => (
                    <>
                      {" in "}
                      <Show when={s().path} fallback={s().publicTitle}>
                        {(path) => <a href={orgSessionHref(props.data.org.id, path())}>{s().publicTitle}</a>}
                      </Show>
                    </>
                  )}
                </Show>
                : {r().why}
              </>
            }
            body={proposedAreasLine(p().name, p().decides.length ? p().decides : undefined) ?? undefined}
          />
        )}
      </Show>
    </>
  );
}

function Head(props: { data: PersonPageData; act: Act; editing: boolean; onEdit(): void; roster: readonly Person[] }) {
  const p = () => props.data.person;
  const orgId = () => props.data.org.id;
  const contact = () =>
    Object.entries(p().contact)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v}`)
      .join(" · ");
  const competence = () =>
    Object.entries(p().competence ?? {})
      .map(([skill, c]) => `${skill}: level ${c.level} of 5 · ${plural(c.n, "session")}`)
      .join("; ");
  return (
    <section class="card orgs-section person-head" aria-label="Profile">
      <div class="orgs-person-head">
        <div class="orgs-person-main">
          <Show when={[p().role, p().language].filter(Boolean).join(" · ")}>
            {(meta) => <span class="orgs-person-meta person-head-meta">{meta()}</span>}
          </Show>
        </div>
        <div class="orgs-person-actions">
          <Show when={p().status === "proposed"}>
            <button type="button" class="button button-sm" onClick={() => void props.act(() => approvePerson(orgId(), p().id), `${p().name} is on the roster now.`)}>
              Approve {p().name}
            </button>
            <button type="button" class="button button-sm button-ghost" onClick={() => void props.act(() => declinePerson(orgId(), p().id), `Declined ${p().name}. The referral stays in their history.`)}>
              Decline {p().name}
            </button>
          </Show>
          <Show when={p().status === "active"}>
            <a class="button button-sm button-ghost" href={startForHref(orgId(), p().id)} aria-label={`Start a session with ${p().name}`}>
              Start a Session
            </a>
          </Show>
          <button type="button" class="button button-sm button-ghost" aria-expanded={props.editing} aria-label={`Edit ${p().name}`} onClick={() => props.onEdit()}>
            <Icon name="pencil" small /> Edit
          </button>
        </div>
      </div>
      <dl class="orgs-facts">
        <Show when={p().decides.length}>
          <dt>Decides</dt>
          <dd>{p().decides.join(", ")}</dd>
        </Show>
        <Show when={props.data.stakeholderOf?.length}>
          <dt>Main stakeholder of</dt>
          <dd>
            <For each={props.data.stakeholderOf}>
              {(x, i) => (
                <>
                  {i() ? ", " : ""}
                  <a href={projectHref(orgId(), x.projectId)}>{x.name}</a>
                </>
              )}
            </For>
          </dd>
        </Show>
        <Show when={p().skills.length}>
          <dt>Skills</dt>
          <dd>{p().skills.join(", ")}</dd>
        </Show>
        <Show when={competence()}>
          <dt>Competence</dt>
          <dd>{competence()}</dd>
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
                by {referrerName(props.data, props.roster).replace(/^You$/, "you")}: {r().why}
                {r().quote ? ` · “${r().quote}”` : ""}
              </dd>
            </>
          )}
        </Show>
      </dl>
    </section>
  );
}

// ---- sessions ----------------------------------------------------------------------------------------

function Sessions(props: { data: PersonPageData; now: number; onPreview(row: PersonSessionRow): void }) {
  const p = () => props.data.person;
  return (
    <section class="card orgs-section" aria-labelledby="person-sessions">
      <h2 class="orgs-h2" id="person-sessions">
        Sessions · <span class="text-num">{props.data.sessions.length}</span>
      </h2>
      <Show
        when={props.data.sessions.length}
        fallback={
          <>
            <p class="orgs-empty">{p().status === "left" ? `${p().name} took part in 0 hand-off sessions before leaving.` : `${p().name} is on the roster, with 0 hand-off sessions so far.`}</p>
            <Show when={p().status === "active"}>
              <div class="button-row">
                <a class="button" href={startForHref(props.data.org.id, p().id)}>
                  Start a Session with {p().name}
                </a>
              </div>
            </Show>
          </>
        }
      >
        <ul class="list person-list">
          <For each={props.data.sessions}>
            {(s) => (
              <li class="person-row">
                <div class="person-row-head">
                  <span class="person-row-title">
                    <Show when={s.path} fallback={<span class="list-title">{s.publicTitle}</span>}>
                      {(path) => (
                        <a class="list-title" href={orgSessionHref(props.data.org.id, path())}>
                          {s.publicTitle}
                        </a>
                      )}
                    </Show>
                  </span>
                  <Chip tone={SESSION_STATE[s.state]?.tone}>{SESSION_STATE[s.state]?.word ?? s.state}</Chip>
                </div>
                <span class="list-meta person-row-meta">
                  <a class="orgs-meta-link" href={projectHref(props.data.org.id, s.projectId)}>
                    {s.projectName}
                  </a>
                  <Show when={holdLine(s)}>{(h) => <> · {h()}</>}</Show> · {messagesLine(s, props.now)}
                  <Show when={s.lastWroteAt}>{(at) => <time class="visually-hidden">{stampTime(at())}</time>}</Show>
                </span>
                <Show when={s.relations.length}>
                  <span class="person-row-relations">{s.relations.map(relationWords).join(" · ")}</span>
                </Show>
                <Show when={s.parent}>
                  {(parent) => {
                    const ppath = () => props.data.sessions.find((x) => x.sessionId === parent().sessionId)?.path;
                    return (
                      <span class="list-meta">
                        Started from{" "}
                        <Show when={ppath()} fallback={parent().publicTitle}>
                          {(path) => <a href={orgSessionHref(props.data.org.id, path())}>{parent().publicTitle}</a>}
                        </Show>
                      </span>
                    );
                  }}
                </Show>
                <Show when={canPreview(s)}>
                  <div class="button-row person-row-actions">
                    <button type="button" class="button button-sm button-ghost" onClick={() => props.onPreview(s)}>
                      <Icon name="eye" small /> Preview as {firstName(p().name)}
                    </button>
                  </div>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

// ---- decisions and conflicts ---------------------------------------------------------------------------

function Decisions(props: { data: PersonPageData; now: number }) {
  const p = () => props.data.person;
  /** A session's file on this host, from their session rows. */
  const pathOf = (sid?: string) => (sid ? props.data.sessions.find((s) => s.sessionId === sid)?.path ?? undefined : undefined);
  const orgId = () => props.data.org.id;
  return (
    <section class="card orgs-section" aria-labelledby="person-decisions">
      <h2 class="orgs-h2" id="person-decisions">
        Decisions · <span class="text-num">{props.data.decisions.length}</span>
      </h2>
      <Show when={props.data.decisions.length} fallback={<p class="orgs-empty">{p().name} has recorded 0 decisions so far.</p>}>
        <ul class="list person-list">
          <For each={props.data.decisions}>
            {(d) => (
              <li class="person-row">
                <div class="person-row-head">
                  <span class="person-row-title">
                    <span class="orgs-change-field">{d.area}</span> {d.statement}
                  </span>
                  <Chip tone={DECISION_STATE[d.state]?.tone} title={DECISION_STATE[d.state]?.hint}>
                    {DECISION_STATE[d.state]?.word ?? d.state}
                  </Chip>
                </div>
                <Show when={d.quote}>
                  <blockquote class="project-quote">{d.quote}</blockquote>
                </Show>
                <span class="list-meta person-row-meta">
                  <time title={exact(d.at)}>{relativeTime(d.at, props.now)}</time>
                  <Show when={d.publicTitle}>
                    {" · in "}
                    <Show when={d.sessionPath ?? pathOf(d.sessionId)} fallback={d.publicTitle}>
                      {(path) => <a href={orgSessionHref(props.data.org.id, path())}>{d.publicTitle}</a>}
                    </Show>
                  </Show>
                  {" · "}
                  <a href={projectHref(orgId(), d.projectId)}>{d.projectName}</a>
                  <Show when={!d.authorOwnsArea}> · outside their decision areas</Show>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.data.conflicts.length}>
        <h3 class="orgs-h3">Conflicts routed to {firstName(p().name)}</h3>
        <ul class="list person-list">
          <For each={props.data.conflicts}>
            {(c) => (
              <li class="person-row">
                <div class="person-row-head">
                  <span class="person-row-title">Asked to settle {c.area}</span>
                  <Chip tone={c.state === "open" ? "warn" : "success"}>{c.state === "open" ? "Open" : "Settled"}</Chip>
                </div>
                <span class="list-meta person-row-meta">
                  <time title={exact(c.createdAt)}>{relativeTime(c.createdAt, props.now)}</time>
                  <Show when={c.publicTitle}>
                    {" · in "}
                    <Show when={c.batonPath ?? pathOf(c.batonSessionId)} fallback={c.publicTitle}>
                      {(path) => <a href={orgSessionHref(props.data.org.id, path())}>{c.publicTitle}</a>}
                    </Show>
                  </Show>
                  {" · "}
                  <a href={projectHref(orgId(), c.projectId)}>{c.projectName}</a>
                  {c.routeReason ? ` · ${c.routeReason}` : ""}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

// ---- links and visits ------------------------------------------------------------------------------------

function LinksAndVisits(props: { data: PersonPageData; now: number; act: Act; onLinks(l: OfferLink[], warning?: string): void }) {
  const p = () => props.data.person;
  const live = createMemo(() => props.data.links.filter((l) => linkLive(l.state)));
  const [confirmAll, setConfirmAll] = createSignal(false);
  const [all, setAll] = createSignal(false);
  const summary = () => visitsSummary({ opened: props.data.opened, lastOpenedAt: props.data.lastOpenedAt, linksEver: props.data.links.length }, props.now);
  const shown = createMemo(() => (all() ? props.data.visits : props.data.visits.slice(0, VISITS_FOLDED)));
  const otherHostVisits = () => props.data.visits.some((v) => v.otherHost);
  /** A new link for this person on the row's session (the current hand-off, or its open offer). */
  const newLink = (sid: string, offer: boolean) =>
    props.act(async () => {
      const r = offer ? await inviteeLink(sid, p().id) : await batonLink(sid);
      props.onLinks([{ personId: p().id, name: p().name, link: r.link }], r.linkWarning);
    }, `New link for ${p().name} ready above.`);
  return (
    <section class="card orgs-section" aria-labelledby="person-links">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="person-links">
          Links and Visits
        </h2>
        <Show when={live().length >= 2 && !confirmAll()}>
          <button type="button" class="button button-sm button-destructive" onClick={() => setConfirmAll(true)}>
            Turn Off All {live().length} Links
          </button>
        </Show>
      </div>
      <Show when={confirmAll()}>
        <div class="person-confirm" role="group" aria-label="Turn off all links">
          <p class="orgs-line">
            {p().name}'s {live().length} links stop opening at once. Their sessions, messages and visits stay.
          </p>
          <div class="button-row">
            <button
              type="button"
              class="button button-sm button-destructive"
              onClick={async () => {
                const n = live().length;
                if (await props.act(() => revokePersonLinks(props.data.org.id, p().id), `Turned off ${n} links.`)) setConfirmAll(false);
              }}
            >
              Turn Off All {live().length} Links
            </button>
            <button type="button" class="button button-sm button-ghost" onClick={() => setConfirmAll(false)}>
              Cancel
            </button>
          </div>
        </div>
      </Show>
      <Show when={summary()}>{(s) => <p class="orgs-line person-summary">{s()}</p>}</Show>
      <Show
        when={props.data.links.length}
        fallback={
          <p class="orgs-empty">
            No links for {p().name} on this host.
            <Show when={otherHostVisits()}> Links sent from another host don't open here.</Show>
          </p>
        }
      >
        <ul class="list person-list">
          <For each={props.data.links}>
            {(l) => {
              const st = () => LINK_STATE[l.state];
              const session = () => props.data.sessions.find((s) => s.sessionId === l.sessionId);
              /** Get New Link: the current hand-off while they hold it, or the current offer that
                  includes them (a link for anyone else would be the holder's), while they're active. */
              const renew = (): "holder" | "offer" | null => {
                if (!l.current || l.state === "closed" || p().status !== "active") return null;
                if (session()?.holdsNow) return "holder";
                return session()?.offer?.includesThem ? "offer" : null;
              };
              return (
                <li class="person-row">
                  <div class="person-row-head">
                    <span class="person-row-title">
                      <Show when={session()?.path} fallback={l.publicTitle}>
                        {(path) => (
                          <a class="list-title" href={orgSessionHref(props.data.org.id, path())}>
                            {l.publicTitle}
                          </a>
                        )}
                      </Show>
                    </span>
                    <Chip tone={st()?.tone}>{st()?.word ?? l.state}</Chip>
                  </div>
                  <span class="list-meta person-row-meta">
                    hand-off #{l.n} · sent <time title={exact(l.createdAt)}>{relativeTime(l.createdAt, props.now)}</time>
                    <Show when={linkLive(l.state) && relativeIn(l.expiresAt, props.now)}>
                      {(inRel) => (
                        <>
                          {" · expires "}
                          <time title={exact(l.expiresAt)}>{inRel()}</time>
                        </>
                      )}
                    </Show>
                    {" · "}
                    {plural(l.visits, "visit")}
                  </span>
                  <Show when={linkLive(l.state) || renew()}>
                    <div class="button-row person-row-actions">
                      <Show when={renew()}>
                        <button type="button" class="button button-sm" title="Makes a new link and turns off the one you sent before" onClick={() => void newLink(l.sessionId, renew() === "offer")}>
                          Get New Link
                        </button>
                      </Show>
                      <Show when={linkLive(l.state)}>
                        <button type="button" class="button button-sm button-ghost" onClick={() => void props.act(() => revokePersonLinks(props.data.org.id, p().id, { sessionId: l.sessionId, n: l.n }), "Link turned off.")}>
                          Turn Off Link
                        </button>
                      </Show>
                    </div>
                  </Show>
                </li>
              );
            }}
          </For>
        </ul>
      </Show>
      <h3 class="orgs-h3">Visits</h3>
      <Show when={props.data.visits.length} fallback={<p class="orgs-empty">{p().status === "left" ? `${p().name} opened no links before leaving.` : `Nothing yet: visits show here once ${p().name} opens a link.`}</p>}>
        <ul class="list person-list person-visits">
          <For each={shown()}>{(v) => <VisitItem visit={v} now={props.now} />}</For>
        </ul>
        <Show when={!all() && props.data.visits.length > VISITS_FOLDED}>
          <div class="button-row">
            <button type="button" class="button button-sm button-ghost" onClick={() => setAll(true)}>
              Show All {props.data.visits.length} Visits
            </button>
          </div>
        </Show>
      </Show>
    </section>
  );
}

function VisitItem(props: { visit: VisitRow; now: number }) {
  const w = () => visitWords(props.visit);
  return (
    <li class="person-visit" classList={{ "person-visit-muted": w().muted }}>
      <span class="person-visit-text">{w().text}</span>
      <time class="person-visit-time" datetime={props.visit.at} title={exact(props.visit.at)}>
        {relativeTime(props.visit.at, props.now)}
      </time>
    </li>
  );
}

// ---- profile changes ---------------------------------------------------------------------------------------

function History(props: { data: PersonPageData; now: number; act: Act }) {
  const p = () => props.data.person;
  return (
    <section class="card orgs-section" aria-labelledby="person-history">
      <h2 class="orgs-h2" id="person-history">
        Profile Changes
      </h2>
      <Show when={props.data.history.length} fallback={<p class="orgs-empty">No changes since {p().name} was added.</p>}>
        <ul class="orgs-history-list">
          <For each={props.data.history}>
            {(c: ProfileChange) => (
              <li class="orgs-change">
                <span class="orgs-change-main">
                  <span class="orgs-change-field">{c.field}</span> {valueText(c.field, c.from)} → {valueText(c.field, c.to)}
                  <span class="list-meta">
                    {" "}
                    · {WRITER[c.by.kind] ?? c.by.kind}
                    {c.by.quote ? ` · “${c.by.quote}”` : ""}
                    {c.revertOf ? " · a revert" : ""} · <time title={exact(c.at)}>{relativeTime(c.at, props.now)}</time>
                  </span>
                </span>
                <Show when={c.field !== "name" || c.from !== null}>
                  <button
                    type="button"
                    class="button button-sm button-ghost"
                    aria-label={`Revert ${c.field}`}
                    onClick={() => void props.act(() => revertPersonChange(props.data.org.id, p().id, c.at), `Reverted ${c.field}.`)}
                  >
                    <Icon name="undo" small /> Revert
                  </button>
                </Show>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

// ---- preview as {name} ---------------------------------------------------------------------------------------

let previewSeq = 0;

/** A session as their link shows it, read-only: no token, no visit, no composer. */
function Preview(props: { data: PersonPageData; row: PersonSessionRow; onClose(): void }) {
  const titleId = `person-preview-${++previewSeq}`;
  const first = () => firstName(props.data.person.name);
  // Read once per session: a poll that reconciles the page must not fetch the preview again.
  const sid = createMemo(() => props.row.sessionId);
  const [view] = createResource(sid, (s) => previewAsPerson(props.data.org.id, props.data.person.id, s));
  let close!: HTMLButtonElement;
  onMount(() => close.focus());
  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal person-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key !== "Escape" || e.defaultPrevented) return;
          e.preventDefault();
          props.onClose();
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id={titleId}>
            {props.row.publicTitle}, as {first()} sees it
          </h2>
        </div>
        <div class="modal-body person-preview-body" tabindex="0" aria-label="Preview">
          <p class="orgs-line project-muted">Read-only. Nothing you do here reaches {first()}, and no visit is recorded.</p>
          <Show when={view() && !view()!.linkOpens}>
            <p class="orgs-line project-muted">{first()}'s links don't open this session now.</p>
          </Show>
          <Show when={view.error}>
            <Banner tone="error" title="Couldn't load the preview." body={errText(view.error)} />
          </Show>
          <Show when={view()} fallback={<Show when={!view.error}><p class="orgs-empty">Loading the conversation.</p></Show>}>
            {(v) => <PreviewView view={v()} />}
          </Show>
        </div>
        <div class="modal-foot">
          <button type="button" class="button" ref={close} onClick={() => props.onClose()}>
            Close
          </button>
        </div>
      </div>
    </Portal>
  );
}

/** The share page's status line, as the person would read it. */
function viewStatus(v: BatonView): string {
  if (v.state === "done") return "This conversation is done.";
  if (v.state === "closed") return "This conversation was closed.";
  if (v.state === "open" && v.holder === null) return "Open to a few people. The first to answer takes it.";
  if (v.viewer && v.holder === v.viewer.name) return `Their turn, ${v.viewer.name}.`;
  if (v.viewer?.reason === "budget") return "This conversation has reached its message limit.";
  if (v.viewer?.reason === "taken") return "Someone else is answering right now.";
  if (v.viewer?.reason === "withdrawn") return "This question went to someone else.";
  return v.holder ? `Waiting on ${v.holder}.` : "Waiting.";
}

function PreviewView(props: { view: BatonView }) {
  return (
    <div class="person-preview-thread">
      <p class="orgs-line">{viewStatus(props.view)}</p>
      <For each={props.view.items}>{(it) => <PreviewItem item={it} />}</For>
    </div>
  );
}

function PreviewItem(props: { item: BatonViewItem }) {
  const it = props.item;
  switch (it.kind) {
    case "message":
      return (
        <article class="person-preview-msg" classList={{ "person-preview-own": it.by === "you" }}>
          <span class="person-preview-who">{it.by === "you" ? "They wrote" : it.name}</span>
          <div class="person-preview-text">{it.text}</div>
        </article>
      );
    case "reply":
      return (
        <article class="person-preview-msg">
          <span class="person-preview-who">Facilitator</span>
          <div class="person-preview-text">{it.text}</div>
          <Show when={it.cutOff}>
            <span class="field-hint">This reply was cut off.</span>
          </Show>
        </article>
      );
    case "handoff":
      return (
        <aside class="baton-card">
          <span class="baton-card-head">{it.n === 1 ? `For ${it.to}` : `Passed from ${it.from} to ${it.to}`}</span>
          <div class="baton-card-body">{it.question}</div>
          <Show when={it.briefing}>
            <div class="baton-card-brief">{it.briefing}</div>
          </Show>
        </aside>
      );
    case "offer":
      return (
        <aside class="baton-card">
          <span class="baton-card-head">{it.invited > 1 ? `Open to them and ${plural(it.invited - 1, "other person", "other people")}` : "Open to them"}</span>
          <div class="baton-card-body">{it.question}</div>
          <Show when={it.briefing}>
            <div class="baton-card-brief">{it.briefing}</div>
          </Show>
        </aside>
      );
    case "decision":
      return (
        <aside class="baton-card">
          <span class="baton-card-head">Noted · {it.area}</span>
          <div class="baton-card-body">{it.statement}</div>
        </aside>
      );
    case "done":
      return (
        <aside class="baton-card">
          <span class="baton-card-head">Done</span>
          <div class="baton-card-body">{it.summary}</div>
        </aside>
      );
  }
}
