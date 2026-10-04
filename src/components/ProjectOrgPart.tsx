import { createEffect, createMemo, createResource, createSignal, createUniqueId, For, type JSX, on, onCleanup, Show } from "solid-js";
import { withOffHours } from "../lib/working-hours";
import { OWNER_AREA_NONE, type Conflict, type DecisionRow, type DecisionsInfo, type PromoteResult } from "../../shared/decisions";
import type { OrgDetail, OrgProject } from "../../shared/orgs";
import type { ItemSendResult } from "../../shared/project-overseer";
import {
  ApiError,
  getDecisions,
  getOrg,
  promoteDecisions,
  reconcileProject,
  redraftProject,
  resolveConflict,
  routeConflict,
  sendProjectItem,
  setOwnerArea,
  settleSpecText,
  setProjectStakeholder,
  setSpecFrozen,
} from "../lib/api";
import { alsoCarriesLine, areaGroups, BUILD_CHIP, builtLine, conflictSides, DECISION_STATE, decisionsLine, emptySelection, outsideTheirArea, promotable, type PromoteSelection, refName, refreshSelection, selectAllReady, toggleSelection } from "../lib/decisions-view";
import { promotionCommitLine } from "../lib/coding-worktrees";
import { relativeTime } from "../lib/format";
import { hostLabel, orgHostOf } from "../lib/mesh";
import { orgSessionHref, orgTabHref } from "../lib/orgs-route";
import { itemSendInput } from "../lib/project-overseer-view";
import { attentionLine, emptySectionsLine } from "../lib/project-page";
import { stakeholderView } from "../lib/stakeholder";
import { offHoursNote } from "../lib/working-hours";
import { announce, toast } from "../lib/ui-state";
import { unchangedError } from "../lib/unchanged-error";
import { OwnerProjectCard } from "./OwnerProjectCard";
import { PipelineCard } from "./PipelineCard";
import { IdeasCard, type ItemSendForm } from "./ProjectOverseerPanel";
import type { ProjectOrgPart, ProjectPartContext } from "./ProjectPage";
import { Banner, Chip, Icon } from "./ui";
import "../orgs.css";
import "../projects.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const RUNNING_POLL_MS = 3000;

/**
 * What an organization adds to a project's page while it places the project
 * (§app.organizations/project-page): the org on the head's meta line, the Requirements tab — the
 * decisions its hand-off sessions recorded (§app/requirements), the conflicts the reconciler found,
 * the pipeline, the gaps and the main stakeholder —, the Owner Page card on Settings, and Send to
 * Person on the overseer's ideas and to-dos. The route composes it; the project page never imports it.
 */
export function createProjectOrgPart(orgId: string, ctx: ProjectPartContext): ProjectOrgPart {
  const projectId = ctx.projectId;
  const [org, { refetch: refetchOrg, mutate: mutateOrg }] = createResource(() => orgId, getOrg);
  const [info, { refetch, mutate }] = createResource(() => ({ o: orgId, p: projectId }), (k) => getDecisions(k.o, k.p));
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const project = () => org()?.projectList.find((p) => p.id === projectId);
  // A reconcile runs in the background (the reconciler also starts one on its own): look again
  // every few seconds until it reports done, so its conflicts and drafts arrive without a click.
  // The overseer acts on the same data (it reconciles and promotes): read it while it works, and
  // once more when its run ends, so what it did shows without a refresh.
  const running = createMemo(() => !!info()?.running || ctx.overseerBusy());
  createEffect(
    on(running, (r, was) => {
      if (!r) {
        if (was) void refetch();
        return;
      }
      const t = setInterval(() => void refetch(), RUNNING_POLL_MS);
      onCleanup(() => clearInterval(t));
    }),
  );

  /** One write: adopt the info it answers with, or say what failed with nothing changed. */
  const act = async (what: string, fn: () => Promise<DecisionsInfo | void>, done?: string): Promise<boolean> => {
    if (busy()) return false;
    setBusy(what);
    try {
      const next = await fn();
      if (next) mutate(next);
      else await refetch();
      setError(null);
      if (done) {
        toast(done);
        announce(done);
      }
      return true;
    } catch (err) {
      // As it is: the page's banner (InsightsPage) already says "Nothing was changed." before it.
      setError(errText(err));
      return false;
    } finally {
      setBusy(null);
    }
  };

  const openConflicts = createMemo(() => info()?.conflicts.filter((c) => c.state === "open").length ?? 0);
  const ready = createMemo(() => info()?.decisions.filter(promotable).length ?? 0);

  // ---- Requirements: which sections have something (the rest are one counts line) -----------------
  const [pipelineEmpty, setPipelineEmpty] = createSignal<boolean | null>(null);
  const [addingIdea, setAddingIdea] = createSignal(false);
  const openIdeaCount = () => ctx.openIdeas();
  const emptyLine = createMemo(() => {
    const i = info();
    if (!i) return null;
    return emptySectionsLine({
      conflicts: !i.conflicts.length,
      decisions: !i.decisions.length,
      pipeline: pipelineEmpty() === true,
      ideas: ctx.ideasRead() && !openIdeaCount() && !addingIdea(),
    });
  });

  const send: ItemSendForm = (p) => (
    <Show when={org()}>{(o) => <SendToPerson org={o()} projectId={projectId} item={p.item} onCancel={p.close} onSent={p.sent} />}</Show>
  );

  return {
    back: () => ({ href: orgTabHref(orgId, "projects"), label: `Back to ${org()?.name ?? "the organization"}` }),
    attachedWho: "This organization",
    orgLink: () => (
      <Show when={org()}>
        {(o) => (
          <a class="orgs-meta-link" href={orgTabHref(o().id, "projects")}>
            {o().name}
          </a>
        )}
      </Show>
    ),
    counts: () => {
      const i = info();
      return i ? { conflicts: openConflicts(), decisions: { total: i.decisions.filter((d) => d.state !== "superseded").length, ready: ready() } } : {};
    },
    attention: () => ({ count: openConflicts() + ready(), line: attentionLine(openConflicts(), ready()) }),
    send,
    refresh: () => {
      void refetch();
      void refetchOrg();
    },
    error: () => error() ?? (info.error ? errText(info.error) : org.error ? errText(org.error) : null),
    loading: () => info.loading && !info(),
    requirements: () => (
      <Show when={info()} fallback={<p class="orgs-empty">Reading the decisions.</p>}>
        {(i) => (
          <>
            <SpecCard info={i()} orgId={orgId} projectId={projectId} busy={busy()} act={act} onSpec={(spec) => mutate({ ...i(), spec })}>
              <Show when={org() && project()}>
                <Stakeholder
                  org={org()!}
                  project={project()!}
                  onSet={async (id) => {
                    mutateOrg(await setProjectStakeholder(orgId, projectId, id));
                    // Who owns which area changed: the decisions' "outside their area" marks follow.
                    void refetch();
                  }}
                />
              </Show>
            </SpecCard>
            <Show when={emptyLine()}>
              {(line) => (
                <div class="project-empty-line">
                  <p class="orgs-empty">{line()}</p>
                  <Show when={!openIdeaCount() && !addingIdea()}>
                    <button type="button" class="button button-sm button-ghost" onClick={() => setAddingIdea(true)}>
                      <Icon name="plus" small /> Idea
                    </button>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={i().conflicts.length}>
              <ConflictsCard info={i()} org={org()} orgId={orgId} projectId={projectId} busy={busy()} act={act} />
            </Show>
            <Show when={i().decisions.length}>
              <DecisionsCard info={i()} orgId={orgId} projectId={projectId} busy={busy()} act={act} />
            </Show>
            <PipelineCard orgId={orgId} projectId={projectId} onEmpty={setPipelineEmpty} />
            <Show when={openIdeaCount() || addingIdea()}>
              <IdeasCard po={ctx.po} title="Gaps and ideas" empty="No open ideas. Gaps it finds between the decisions and who decides them land here." send={send} archived={ctx.archived()} adding={addingIdea()} onAdding={setAddingIdea} />
            </Show>
          </>
        )}
      </Show>
    ),
    // Only while the org has an owner (§app.owner-page/controls).
    settings: () => (
      <Show when={org()?.ownerPage?.person && project()}>
        <OwnerProjectCard org={org()!} project={project()!} onOrg={mutateOrg} />
      </Show>
    ),
  };
}

// ---- Send to Person: an idea or to-do item passed to roster people (§app.project-overseer/ideas-and-todos) ----

function SendToPerson(props: { org: OrgDetail; projectId: string; item: { ideaId?: string; todoId?: string }; onCancel(): void; onSent(r: ItemSendResult): void }) {
  const active = () => props.org.roster.filter((x) => x.status === "active");
  const [to, setTo] = createSignal<string[]>([]);
  // Empty on purpose: the item's title is the overseer's own wording, never for outsiders (itemSendInput).
  const [title, setTitle] = createSignal("");
  const [question, setQuestion] = createSignal("");
  const [working, setWorking] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const send = async (e: Event) => {
    e.preventDefault();
    const input = itemSendInput(props.item, { to: to(), publicTitle: title(), question: question() });
    if (working() || !input) return;
    setWorking(true);
    try {
      const r = await sendProjectItem(props.org.id, props.projectId, input);
      setErr(null);
      setTo([]);
      const one = r.links.length === 1 ? r.links[0]! : null;
      toast(r.links.length > 1 ? `Offered to ${r.links.length} people.` : withOffHours("Hand-off session started.", one?.name ?? "Their", r.offHours, Date.now()));
      props.onSent(r);
    } catch (x) {
      setErr(unchangedError(errText(x), "Nothing was sent."));
    } finally {
      setWorking(false);
    }
  };
  return (
    <form class="orgs-form orgs-subform" onSubmit={send}>
      <Show when={err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
      <fieldset class="project-people">
        <legend class="field-label">Send to</legend>
        <Show when={active().length} fallback={<p class="orgs-empty">Nobody active on the roster yet.</p>}>
          <For each={active()}>
            {(person) => (
              <label class="toggle">
                <input
                  type="checkbox"
                  checked={to().includes(person.id)}
                  onChange={(e) => setTo((cur) => (e.currentTarget.checked ? [...cur, person.id] : cur.filter((x) => x !== person.id)))}
                />
                <span class="toggle-box" />
                <span>{`${person.name}${person.role ? ` — ${person.role}` : ""}`}</span>
              </label>
            )}
          </For>
        </Show>
        <p class="field-hint">Pick 2 or more to offer it: the first to answer takes it.</p>
        {/* r7: yours goes at once; say so for each ticked person who is off hours now. */}
        <For each={active().filter((x) => to().includes(x.id))}>
          {(x) => <Show when={offHoursNote(x, Date.now())}>{(note) => <p class="field-hint person-off-hours">{note()}</p>}</Show>}
        </For>
      </fieldset>
      <label class="field">
        <span class="field-label">Public title</span>
        <input class="input" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} maxlength={120} required placeholder="What the person sees as the title" />
        <span class="field-hint">All they see of the goal. The item's own words stay private: they go to the model as the goal.</span>
      </label>
      <label class="field">
        <span class="field-label">First question</span>
        <input class="input" value={question()} onInput={(e) => setQuestion(e.currentTarget.value)} maxlength={1000} required placeholder="What you ask them, in your words" />
        <span class="field-hint">They see it at the top of their page.</span>
      </label>
      <div class="button-row">
        <button type="submit" class="button button-primary" aria-disabled={!to().length || !title().trim() || !question().trim() || working() ? "true" : undefined}>
          {to().length > 1 ? `Offer to ${to().length}` : "Start Session"}
        </button>
        <button type="button" class="button button-ghost" onClick={() => props.onCancel()}>
          Cancel
        </button>
      </div>
    </form>
  );
}

type Act = (what: string, fn: () => Promise<DecisionsInfo | void>, done?: string) => Promise<boolean>;
interface CardProps {
  info: DecisionsInfo;
  orgId: string;
  projectId: string;
  busy: string | null;
  act: Act;
}

// ---- the project's main stakeholder (§app.organizations/projects) ---------------------------------------

const NONE = "";

/**
 * Who decides every area of this project that no one else on the roster decides by name
 * (§app.organizations/stakeholder). The operator picks and changes it here; a stakeholder who
 * leaves the org is cleared, and the page says so until someone (or None) is chosen.
 */
function Stakeholder(props: { org: OrgDetail; project: OrgProject; onSet(id: string | null): Promise<void> }) {
  const v = createMemo(() => stakeholderView(props.project, props.org.roster));
  const [saving, setSaving] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  let select: HTMLSelectElement | undefined;
  const nameOf = (id: string) => props.org.roster.find((p) => p.id === id)?.name ?? id;
  const set = async (id: string | null) => {
    if (saving()) return;
    setSaving(true);
    try {
      await props.onSet(id);
      setErr(null);
      const done = id ? `${nameOf(id)} is this project's main stakeholder.` : "This project has no main stakeholder.";
      toast(done);
      announce(done);
    } catch (x) {
      setErr(errText(x));
      if (select) select.value = v().current?.id ?? NONE;
    } finally {
      setSaving(false);
    }
  };
  return (
    <div class="project-stakeholder">
      <Show when={v().cleared}>
        {(c) => <Banner tone="warn" title={`${c().name} was this project's main stakeholder until they left the organization ${relativeTime(c().at)}. Pick someone else, or choose None.`} />}
      </Show>
      <Show when={v().suggestion}>
        {(p) => (
          <Banner
            tone="info"
            title={`${p().name} is the only person on the roster. Make them this project's main stakeholder?`}
            action={
              <button type="button" class="button button-sm" aria-disabled={saving() ? "true" : undefined} onClick={() => void set(p().id)}>
                Make Main Stakeholder
              </button>
            }
          />
        )}
      </Show>
      <label class="field project-stakeholder-field">
        <span class="field-label">Main stakeholder</span>
        <select ref={select} class="select" aria-describedby="project-stakeholder-hint" disabled={saving()} onChange={(e) => void set(e.currentTarget.value || null)}>
          <option value={NONE} selected={!v().current}>
            None
          </option>
          <For each={v().options}>
            {(p) => (
              <option value={p.id} selected={p.id === v().current?.id}>
                {p.name}
              </option>
            )}
          </For>
        </select>
        <span class="field-hint" id="project-stakeholder-hint">
          Decides every area of this project that no one on the roster decides by name.
        </span>
        {/* Read through l() each time: a re-pick changes the latest line in place (the Show stays shown). */}
        <Show when={v().latest}>
          {(l) => (
            <span class="field-hint">
              {(() => {
                const x = l();
                return x.why === "left" ? (
                  <>
                    Cleared <time title={x.at}>{relativeTime(x.at)}</time>: {x.name} left the organization.
                  </>
                ) : (
                  <>
                    Set by you{x.via === "overseer" ? ", via the Overseer" : ""} <time title={x.at}>{relativeTime(x.at)}</time>.
                  </>
                );
              })()}
            </span>
          )}
        </Show>
        <Show when={err()}>{(e) => <span class="field-error">{e()}</span>}</Show>
      </label>
    </div>
  );
}

// ---- the project's spec: frozen, counts, the reconciler's last run -----------------------------------

function SpecCard(props: CardProps & { onSpec(spec: DecisionsInfo["spec"]): void; children?: JSX.Element }) {
  const s = () => props.info.spec;
  const run = () => props.info.lastRun;
  const [freezing, setFreezing] = createSignal(false);
  const freeze = async (frozen: boolean) => {
    setFreezing(true);
    try {
      props.onSpec(await setSpecFrozen(props.orgId, props.projectId, frozen));
      announce(frozen ? "Spec frozen. Only promotion writes it now." : "Spec unfrozen.");
    } catch (err) {
      toast(`Frozen unchanged. ${errText(err)}`);
    } finally {
      setFreezing(false);
    }
  };
  return (
    <section class="card orgs-section" aria-labelledby="project-spec">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-spec">
          Requirements
        </h2>
        {/* One group: narrow, both buttons wrap below the heading together. */}
        <div class="cluster">
          <button
            type="button"
            class="button button-sm"
            aria-disabled={props.busy || props.info.running ? "true" : undefined}
            title="Compare every pending decision with the rest of its area, route any conflict, and draft the clean ones."
            onClick={() => void props.act("reconcile", () => reconcileProject(props.orgId, props.projectId), "Reconciled.")}
          >
            {props.busy === "reconcile" || props.info.running ? "Reconciling" : "Reconcile Now"}
          </button>
          <button
            type="button"
            class="button button-sm button-ghost"
            aria-disabled={props.busy ? "true" : undefined}
            title="Rewrite the project's draft from the decisions as they stand."
            onClick={() => void props.act("draft", () => redraftProject(props.orgId, props.projectId), "Draft rewritten.")}
          >
            Rewrite Draft
          </button>
        </div>
      </div>
      <div class="project-spec-strip">
        {props.children}
        <div class="project-frozen-field">
          <label class="toggle toggle-switch project-frozen">
            <span>Frozen</span>
            <input type="checkbox" checked={s().frozen} disabled={freezing()} aria-describedby="project-frozen-hint" onChange={(e) => void freeze(e.currentTarget.checked)} />
            <span class="toggle-box" />
          </label>
          <p class="field-hint" id="project-frozen-hint">
            Only promotion writes the spec. A coding session's own tools can still edit it; the overseer flags any edit it finds.
          </p>
        </div>
      </div>
      <div class="project-spec-facts">
        <p class="orgs-line">{decisionsLine(props.info)}</p>
        <p class="orgs-line project-spec-line">
          <Show when={s().exists} fallback="No spec in this project yet. The first promotion starts one.">
            {s().promoted} promoted · {s().drafted} in the draft
            {builtLine(s())}
            <Show when={s().draft}>
              {(d) => (
                <>
                  {" "}
                  <span class="orgs-mono">{d()}</span>
                </>
              )}
            </Show>
          </Show>
        </p>
        {/* The folder on a line of its own: glued to the sentence above with a "·", it read as part of it. */}
        <p class="orgs-line orgs-mono project-muted project-spec-root" title="The spec folder">
          {s().specRoot}
        </p>
        <p class="orgs-line project-muted">
          <Show when={run()} fallback="Never reconciled.">
            {(r) => (
              <>
                Last reconciled <time title={r().at}>{relativeTime(r().at)}</time>: {r().compared} {r().compared === 1 ? "pair" : "pairs"} compared, {r().found} new{" "}
                {r().found === 1 ? "conflict" : "conflicts"}.
              </>
            )}
          </Show>
        </p>
      </div>
      <Show when={s().frozen && s().editedOutside}>
        <Banner
          tone="warn"
          title="The spec changed outside promotion."
          body="Someone edited its claims directly since the reconciler last wrote them. Nothing was undone. Check the project's history, then reconcile again."
        />
      </Show>
      <Show when={run()?.error}>{(e) => <Banner tone="error" title="The last reconcile stopped." body={`${e()} Pending decisions stay pending. Reconcile again.`} />}</Show>
    </section>
  );
}

// ---- conflicts: both sides, who it went to, and the operator's own ruling ---------------------------

function ConflictsCard(props: CardProps & { org: OrgDetail | undefined }) {
  const open = () => props.info.conflicts.filter((c) => c.state === "open");
  const resolved = () => props.info.conflicts.filter((c) => c.state === "resolved");
  return (
    <section class="card orgs-section" aria-labelledby="project-conflicts">
      <h2 class="orgs-h2" id="project-conflicts">
        Conflicts
      </h2>
      <Show when={open().length} fallback={<p class="orgs-empty">{props.info.decisions.length ? "No open conflict. Every compared decision agrees with its area." : "No decisions recorded yet, so nothing to compare."}</p>}>
        <ul class="project-conflicts">
          <For each={open()}>{(c) => <ConflictItem conflict={c} {...props} />}</For>
        </ul>
      </Show>
      <Show when={resolved().length}>
        <details class="orgs-history">
          <summary>
            {resolved().length} resolved {resolved().length === 1 ? "conflict" : "conflicts"}
          </summary>
          <ul class="project-conflicts">
            <For each={resolved()}>{(c) => <ConflictItem conflict={c} {...props} />}</For>
          </ul>
        </details>
      </Show>
    </section>
  );
}

const OUTCOME: Record<NonNullable<Conflict["outcome"]>, string> = {
  a: "The first side stands.",
  b: "The second side stands.",
  both: "Both stand: not a contradiction.",
  neither: "A new decision replaced both.",
};

function ConflictItem(props: CardProps & { org: OrgDetail | undefined; conflict: Conflict }) {
  const c = () => props.conflict;
  const sides = createMemo(() => conflictSides(props.info, c()));
  const batonPath = () => c().batonPath ?? (c().batonSessionId ? props.org?.batons.find((b) => b.sessionId === c().batonSessionId)?.path : undefined);
  const [ruling, setRuling] = createSignal(false);
  const [statement, setStatement] = createSignal("");
  const [to, setTo] = createSignal("");
  const people = () => props.org?.roster.filter((p) => p.status === "active") ?? [];
  const resolve = (input: Parameters<typeof resolveConflict>[3], done: string) =>
    props.act("resolve", () => resolveConflict(props.orgId, props.projectId, c().id, input), done);
  return (
    <li class="project-conflict">
      <div class="orgs-head">
        <span class="project-conflict-area">
          <span class="orgs-mono">{c().areaKey}</span>
        </span>
        <Chip tone={c().state === "open" ? "warn" : "success"}>{c().state === "open" ? "Open" : "Resolved"}</Chip>
      </div>
      <div class="project-sides">
        <Side orgId={props.orgId} label="First" row={sides().a} kept={c().outcome === "a" || c().outcome === "both"} />
        <Side orgId={props.orgId} label="Second" row={sides().b} kept={c().outcome === "b" || c().outcome === "both"} />
      </div>
      <p class="orgs-line project-muted">
        <span class="orgs-mono" title="How likely the two contradict, from the decision model.">
          p {c().p.toFixed(2)}
        </span>{" "}
        · Sent to {refName(props.info.names, c().routedTo)}: {c().routeReason}
        {c().selfAsserted ? " (their say over this area is self-asserted)" : ""}
        <Show when={batonPath()}>
          {(path) => (
            <>
              {" · "}
              <a href={orgSessionHref(props.orgId, path())}>Open Its Session</a>
            </>
          )}
        </Show>
        <Show when={c().state === "resolved"}>
          {" · "}
          {c().outcome ? OUTCOME[c().outcome!] : "Resolved."} <Show when={c().resolvedAt}>{(t) => <time title={t()}>{relativeTime(t())}</time>}</Show>
        </Show>
      </p>
      <Show when={c().state === "open"}>
        <div class="button-row project-actions">
          <button type="button" class="button button-sm" aria-disabled={props.busy ? "true" : undefined} onClick={() => void resolve({ keep: "a" }, "Kept the first side.")}>
            Keep First
          </button>
          <button type="button" class="button button-sm" aria-disabled={props.busy ? "true" : undefined} onClick={() => void resolve({ keep: "b" }, "Kept the second side.")}>
            Keep Second
          </button>
          <button type="button" class="button button-sm button-ghost" aria-disabled={props.busy ? "true" : undefined} onClick={() => void resolve({ keep: "both" }, "Kept both.")}>
            Keep Both
          </button>
          <button type="button" class="button button-sm button-ghost" aria-expanded={ruling()} onClick={() => setRuling(!ruling())}>
            Decide It Yourself
          </button>
        </div>
        <Show when={ruling()}>
          <form
            class="orgs-form orgs-subform"
            onSubmit={async (e) => {
              e.preventDefault();
              if (statement().trim() && (await resolve({ statement: statement().trim() }, "Your decision replaced both."))) setRuling(false);
            }}
          >
            <label class="field">
              <span class="field-label">Your decision</span>
              <textarea class="input textarea" rows={3} maxlength={1000} value={statement()} onInput={(e) => setStatement(e.currentTarget.value)} required />
              <span class="field-hint">It replaces both sides and is recorded as yours.</span>
            </label>
            <div class="button-row">
              <button type="submit" class="button button-primary">
                Save Decision
              </button>
              <button type="button" class="button button-ghost" onClick={() => setRuling(false)}>
                Cancel
              </button>
            </div>
          </form>
        </Show>
        <Show when={!c().batonSessionId}>
          <form
            class="orgs-inline"
            onSubmit={(e) => {
              e.preventDefault();
              // r7: routed to someone off hours, it still went at once; the done line says when their hours start.
              let offHours: string | undefined;
              const who = refName(props.info.names, to() || c().routedTo);
              void props
                .act("route", async () => {
                  const r = await routeConflict(props.orgId, props.projectId, c().id, to() || undefined);
                  offHours = r.offHours;
                  return r;
                })
                .then((ok) => {
                  if (!ok) return;
                  const done = withOffHours("Sent. A hand-off session asks them to settle it.", who, offHours, Date.now());
                  toast(done);
                  announce(done);
                });
            }}
          >
            <label class="field orgs-grow">
              <span class="field-label">Ask someone to settle it</span>
              <select class="select" value={to()} onChange={(e) => setTo(e.currentTarget.value)}>
                <option value="">{`${refName(props.info.names, c().routedTo)} (suggested)`}</option>
                <For each={people()}>{(p) => <option value={p.id}>{`${p.name}${p.role ? ` — ${p.role}` : ""}`}</option>}</For>
              </select>
            </label>
            <button type="submit" class="button" aria-disabled={props.busy ? "true" : undefined}>
              Start Session
            </button>
          </form>
        </Show>
      </Show>
    </li>
  );
}

function Side(props: { orgId: string; label: string; row: DecisionRow | null; kept: boolean }) {
  return (
    <div class="project-side" classList={{ "project-side-kept": props.kept }}>
      <span class="project-side-label">
        {props.label}
        {props.kept ? " · kept" : ""}
      </span>
      <Show when={props.row} fallback={<p class="orgs-empty">This decision is no longer in the index.</p>}>
        {(r) => <Provenance orgId={props.orgId} row={r()} />}
      </Show>
    </div>
  );
}

/** A decision in the words it was recorded with: the statement, the quote, who, when, where. */
function Provenance(props: { orgId: string; row: DecisionRow }) {
  const r = () => props.row;
  const host = () => orgHostOf(props.orgId);
  return (
    <>
      <p class="project-statement">{r().statement}</p>
      <blockquote class="project-quote">{r().quote}</blockquote>
      <p class="project-by">
        {r().name} · <time title={r().at}>{relativeTime(r().at)}</time>
        <Show when={r().sessionPath} fallback={<span title={`The session isn't on ${host() ? hostLabel(host()!) : "this host"}.`}> · session elsewhere</span>}>
          {(p) => (
            <>
              {" · "}
              <a href={orgSessionHref(undefined, p())}>Open Session</a>
            </>
          )}
        </Show>
      </p>
    </>
  );
}

/** A promoted decision whose record's prose was edited in the spec (§app.requirements/decisions):
    it stays promoted; the operator keeps the spec's words or promotes the person's again. */
function EditedInSpec(props: CardProps & { row: DecisionRow }) {
  const run = (action: "keep" | "restore") =>
    props.act("spec-text", () => settleSpecText(props.orgId, props.projectId, props.row.id, action), action === "keep" ? "Kept the spec's words." : `Restored ${props.row.name}'s words.`);
  return (
    <div class="project-edited">
      <p class="field-hint">Edited in the spec since it was promoted.</p>
      <div class="cluster">
        <button type="button" class="button button-sm button-ghost" aria-disabled={props.busy ? "true" : undefined} onClick={() => void run("keep")}>
          Keep Spec's Words
        </button>
        <button type="button" class="button button-sm button-ghost" aria-disabled={props.busy ? "true" : undefined} onClick={() => void run("restore")}>
          Restore Their Words
        </button>
      </div>
    </div>
  );
}

/** Who decides a decision (§app.requirements/owner-area): the operator changes it here, and the
    server re-routes a conflict it is in. */
function OwnerAreaField(props: CardProps & { row: DecisionRow }) {
  const id = createUniqueId();
  let select: HTMLSelectElement | undefined;
  const current = () => props.row.ownerArea ?? "";
  // A roster area removed since it was picked still shows as picked.
  const choices = createMemo(() => {
    const all = props.info.ownerAreas;
    const cur = props.row.ownerArea;
    return cur && cur !== OWNER_AREA_NONE && !all.includes(cur) ? [...all, cur] : all;
  });
  const last = () => props.row.ownerAreaHistory?.at(-1);
  const set = async (value: string) => {
    const label = value === OWNER_AREA_NONE ? "None" : value;
    const ok = await props.act("owner-area", () => setOwnerArea(props.orgId, props.projectId, props.row.id, value), `Owner area set to ${label}.`);
    if (!ok && select) select.value = current();
  };
  return (
    <div class="field project-owner-area">
      <label class="field-label" for={id}>
        Owner area
      </label>
      <div class="select-wrap">
        <select ref={select} id={id} class="select" disabled={!!props.busy} onChange={(e) => void set(e.currentTarget.value)}>
          <Show when={!props.row.ownerArea}>
            <option value="" selected disabled>
              Not set
            </option>
          </Show>
          <option value={OWNER_AREA_NONE} selected={props.row.ownerArea === OWNER_AREA_NONE}>
            None
          </option>
          <For each={choices()}>
            {(a) => (
              <option value={a} selected={a === props.row.ownerArea}>
                {a}
              </option>
            )}
          </For>
        </select>
        <span class="select-caret" aria-hidden="true">
          ▾
        </span>
      </div>
      <Show when={last()}>
        {(l) => (
          <span class="field-hint">
            Changed by {l().name} <time title={l().at}>{relativeTime(l().at)}</time>.
          </span>
        )}
      </Show>
    </div>
  );
}

// ---- decisions by area, with piecemeal promotion -----------------------------------------------------

function DecisionsCard(props: CardProps) {
  const [showSuperseded, setShowSuperseded] = createSignal(false);
  const [selection, setSelection] = createSignal<PromoteSelection>(emptySelection());
  const selected = () => selection().ids;
  const [refused, setRefused] = createSignal<{ id: string; reason: string }[]>([]);
  /** The last promotion's commit in the project root, or why it made none. */
  const [commit, setCommit] = createSignal<ReturnType<typeof promotionCommitLine>>(null);
  // A refresh may promote, conflict or drop a selected decision: keep only what can still go.
  createEffect(on(() => props.info.decisions, (d) => setSelection((s) => refreshSelection(s, d)), { defer: true }));
  const groups = createMemo(() => areaGroups(props.info.decisions, { superseded: showSuperseded() }));
  const byId = createMemo(() => new Map(props.info.decisions.map((d) => [d.id, d])));
  const ready = createMemo(() => props.info.decisions.filter(promotable));
  /** What Select All Ready would take, and the promotable ones it leaves to a tick of their own. */
  const bulkReady = createMemo(() => selectAllReady(props.info.decisions).ids);
  const outside = () => ready().length - bulkReady().size;
  const superseded = () => props.info.decisions.filter((d) => d.state === "superseded").length;
  const toggle = (id: string, on: boolean) => setSelection((s) => toggleSelection(s, id, on));
  const promote = async (ids: string[], bulk: boolean) => {
    if (!ids.length) return;
    let result: PromoteResult | null = null;
    const ok = await props.act("promote", async () => {
      const r = await promoteDecisions(props.orgId, props.projectId, ids, bulk);
      result = r;
      return r.info;
    });
    if (!ok || !result) return;
    const r = result as PromoteResult;
    setRefused(r.refused);
    const line = r.promoted.length ? promotionCommitLine(r.commit) : null;
    setCommit(line && { ...line, text: `Promoted ${r.promoted.length}. ${line.text}` });
    const words = `Promoted ${r.promoted.length}${r.refused.length ? `; ${r.refused.length} refused` : ""}.${line ? ` ${line.text}` : ""}`;
    toast(words);
    announce(words);
  };
  const statementOf = (id: string) => props.info.decisions.find((d) => d.id === id)?.statement ?? id;
  return (
    <section class="card orgs-section" aria-labelledby="project-decisions">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-decisions">
          Decisions
        </h2>
        <Show when={superseded()}>
          <label class="toggle project-superseded">
            <input type="checkbox" checked={showSuperseded()} onChange={(e) => setShowSuperseded(e.currentTarget.checked)} />
            <span class="toggle-box" />
            <span>Show {superseded()} superseded</span>
          </label>
        </Show>
      </div>
      <Show when={commit()}>{(c) => <p class="orgs-line" classList={{ "project-muted": c().tone === "success" }} role="status">{c().text}</p>}</Show>
      <Show when={refused().length}>
        <Banner
          tone="warn"
          title={`${refused().length} ${refused().length === 1 ? "decision wasn't" : "decisions weren't"} promoted.`}
          body={
            <For each={refused()}>
              {(x) => (
                <>
                  “{statementOf(x.id)}”: {x.reason}
                  <br />
                </>
              )}
            </For>
          }
        />
      </Show>
      <Show when={groups().length} fallback={<p class="orgs-empty">No decisions yet. They appear here as hand-off sessions in this project record them.</p>}>
        <For each={groups()}>
          {(g) => (
            <div class="project-area">
              <h3 class="orgs-h3">
                {g.area} <span class="orgs-mono project-muted">§requirements/{g.areaKey}</span>
              </h3>
              <ul class="project-decisions">
                <For each={g.decisions}>
                  {(d) => (
                    <li class="project-decision" id={`decision-${d.id}`} tabIndex={-1} classList={{ "project-decision-old": d.state === "superseded" }}>
                      <Show when={promotable(d)} fallback={<span class="project-check-space" aria-hidden="true" />}>
                        <label class="toggle project-check" title="Select to promote">
                          <input
                            type="checkbox"
                            checked={selected().has(d.id)}
                            aria-label={`Select to promote: ${d.statement}`}
                            onChange={(e) => toggle(d.id, e.currentTarget.checked)}
                          />
                          <span class="toggle-box" />
                        </label>
                      </Show>
                      <div class="project-decision-main">
                        <Provenance orgId={props.orgId} row={d} />
                        <Show when={alsoCarriesLine(d, byId())}>{(line) => <p class="project-by">{line()}</p>}</Show>
                        <Show when={d.recordId}>
                          {(id) => <p class="orgs-mono project-muted">{id()}</p>}
                        </Show>
                      </div>
                      <div class="project-chips">
                        <Chip tone={DECISION_STATE[d.state].tone} title={DECISION_STATE[d.state].hint}>
                          {DECISION_STATE[d.state].word}
                        </Chip>
                        <Show when={d.state === "promoted" && d.build}>
                          {(b) => (
                            <Chip tone={BUILD_CHIP[b()].tone} title={BUILD_CHIP[b()].hint}>
                              {BUILD_CHIP[b()].word}
                            </Chip>
                          )}
                        </Show>
                        <Show when={outsideTheirArea(d)}>
                          <Chip tone="warn" title={`${d.name} doesn't decide ${d.ownerArea && d.ownerArea !== OWNER_AREA_NONE ? d.ownerArea : d.area}. Select All Ready leaves it out; tick it to promote it anyway.`}>
                            Outside their area
                          </Chip>
                        </Show>
                      </div>
                      <Show when={d.state === "promoted" && d.editedInSpec}>
                        <EditedInSpec {...props} row={d} />
                      </Show>
                      <Show when={d.state !== "superseded"}>
                        <OwnerAreaField {...props} row={d} />
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          )}
        </For>
      </Show>
      <Show when={ready().length}>
        <div class="button-row project-promote">
          <button
            type="button"
            class="button button-primary"
            aria-disabled={!selected().size || props.busy ? "true" : undefined}
            onClick={() => void promote([...selected()], selection().bulk)}
          >
            {selected().size ? `Promote ${selected().size} Selected` : "Promote Selected"}
          </button>
          <Show when={bulkReady().size}>
            <button
              type="button"
              class="button button-ghost"
              aria-disabled={props.busy ? "true" : undefined}
              title={outside() ? `Leaves out ${outside()} outside their author's area: tick those one by one.` : undefined}
              onClick={() => setSelection(selectAllReady(props.info.decisions))}
            >
              Select All {bulkReady().size} Ready
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}
