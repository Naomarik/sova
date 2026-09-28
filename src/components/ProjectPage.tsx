import { createEffect, createMemo, createResource, createSignal, For, type JSX, on, onCleanup, Show } from "solid-js";
import { OWNER_AREA_NONE, type Conflict, type DecisionRow, type DecisionsInfo, type PromoteResult } from "../../shared/decisions";
import type { OrgDetail, OrgProject } from "../../shared/orgs";
import { ApiError, getDecisions, getOrg, promoteDecisions, reconcileProject, redraftProject, resolveConflict, routeConflict, setOwnerArea, setProjectStakeholder, setSpecFrozen } from "../lib/api";
import { alsoCarriesLine, areaGroups, conflictSides, DECISION_STATE, decisionsLine, emptySelection, outsideTheirArea, promotable, type PromoteSelection, refName, refreshSelection, selectAllReady, toggleSelection } from "../lib/decisions-view";
import { promotionCommitLine } from "../lib/coding-worktrees";
import { relativeTime } from "../lib/format";
import { hostLabel, orgHostOf } from "../lib/mesh";
import { orgSessionHref, orgTabHref } from "../lib/orgs-route";
import { stakeholderView } from "../lib/stakeholder";
import { announce, toast } from "../lib/ui-state";
import { InsightsPage } from "./InsightsPage";
import { OwnerProjectCard } from "./OwnerProjectCard";
import { ProjectCostCard } from "./ProjectCostCard";
import { ProjectOverseerPanel } from "./ProjectOverseerPanel";
import { Banner, Chip } from "./ui";
import "../orgs.css";
import "../projects.css";

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));
const RUNNING_POLL_MS = 3000;

/**
 * One org project (`#/orgs/<id>/projects/<pid>`): its overseer (§app/project-overseer), and the
 * decisions its hand-off sessions recorded (§app/requirements) — each with who said it, their
 * words and where; the conflicts the reconciler found and who they went to; and promotion into
 * the project's own spec, one decision at a time.
 */
export function ProjectPage(props: { orgId: string; projectId: string; titleRef(el: HTMLHeadingElement): void }) {
  const [org, { refetch: refetchOrg, mutate: mutateOrg }] = createResource(() => props.orgId, getOrg);
  const key = () => ({ o: props.orgId, p: props.projectId });
  const [info, { refetch, mutate }] = createResource(key, (k) => getDecisions(k.o, k.p));
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const project = () => org()?.projectList.find((p) => p.id === props.projectId);
  // A reconcile runs in the background (the reconciler also starts one on its own): look again
  // every few seconds until it reports done, so its conflicts and drafts arrive without a click.
  // The overseer acts on the same data (it reconciles and promotes): read it while it works, and
  // once more when its run ends, so what it did shows without a refresh.
  const [overseerBusy, setOverseerBusy] = createSignal(false);
  // Refresh Project recounts the cost too.
  const [costTick, setCostTick] = createSignal(0);
  const running = createMemo(() => !!info()?.running || overseerBusy());
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

  return (
    <InsightsPage
      title={project()?.name ?? "Project"}
      titleTip
      meta={
        <Show when={org()}>
          {(o) => (
            <>
              <a class="orgs-meta-link" href={orgTabHref(o().id, "projects")}>{o().name}</a>
              <Show when={project()}>
                {(p) => (
                  <>
                    {" "}
                    · <span class="orgs-mono orgs-meta-path" title={p().root}>{p().root}</span>
                  </>
                )}
              </Show>
            </>
          )}
        </Show>
      }
      refreshLabel="Refresh Project"
      onRefresh={() => {
        void refetch();
        void refetchOrg();
        setCostTick((n) => n + 1);
      }}
      error={error() ?? (info.error ? errText(info.error) : org.error ? errText(org.error) : null)}
      errorTitle="Couldn't update this project."
      busy={info.loading && !info()}
      titleRef={props.titleRef}
    >
      <Show when={org()}>{(o) => <ProjectOverseerPanel org={o()} projectId={props.projectId} onBusy={setOverseerBusy} />}</Show>
      <Show when={`${props.orgId}/${props.projectId}`} keyed>
        <ProjectCostCard orgId={props.orgId} projectId={props.projectId} tick={costTick()} />
      </Show>
      {/* Only while the org has an owner (§app.owner-page/controls). */}
      <Show when={org()?.ownerPage?.person && project()}>
        <OwnerProjectCard org={org()!} project={project()!} onOrg={mutateOrg} />
      </Show>
      <Show when={info()}>
        {(i) => (
          <>
            <SpecCard info={i()} orgId={props.orgId} projectId={props.projectId} busy={busy()} act={act} onSpec={(spec) => mutate({ ...i(), spec })}>
              <Show when={org() && project()}>
                <Stakeholder
                  org={org()!}
                  project={project()!}
                  onSet={async (id) => {
                    mutateOrg(await setProjectStakeholder(props.orgId, props.projectId, id));
                    // Who owns which area changed: the decisions' "outside their area" marks follow.
                    void refetch();
                  }}
                />
              </Show>
            </SpecCard>
            <ConflictsCard info={i()} org={org()} orgId={props.orgId} projectId={props.projectId} busy={busy()} act={act} />
            <DecisionsCard info={i()} orgId={props.orgId} projectId={props.projectId} busy={busy()} act={act} />
          </>
        )}
      </Show>
    </InsightsPage>
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
                    Set by you <time title={x.at}>{relativeTime(x.at)}</time>.
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
      {props.children}
      <p class="orgs-line">{decisionsLine(props.info)}</p>
      <p class="orgs-line project-spec-line">
        <Show when={s().exists} fallback="No spec in this project yet. The first promotion starts one.">
          {s().promoted} promoted · {s().drafted} in the draft
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
      <p class="orgs-line orgs-mono project-muted" title="The spec folder">
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
      <Show when={s().frozen && s().editedOutside}>
        <Banner
          tone="warn"
          title="The spec changed outside promotion."
          body="Someone edited its claims directly since the reconciler last wrote them. Nothing was undone. Check the project's history, then reconcile again."
        />
      </Show>
      <Show when={run()?.error}>{(e) => <Banner tone="error" title="The last reconcile stopped." body={`${e()} Pending decisions stay pending. Reconcile again.`} />}</Show>
      <div>
        <label class="toggle toggle-switch project-frozen">
          <span>Frozen</span>
          <input type="checkbox" checked={s().frozen} disabled={freezing()} aria-describedby="project-frozen-hint" onChange={(e) => void freeze(e.currentTarget.checked)} />
          <span class="toggle-box" />
        </label>
        <p class="field-hint" id="project-frozen-hint">
          Only promotion writes the spec. A coding session's own tools can still edit it; the overseer flags any edit it finds.
        </p>
      </div>
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
              void props.act("route", () => routeConflict(props.orgId, props.projectId, c().id, to() || undefined), "Sent. A hand-off session asks them to settle it.");
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

/** Who decides a decision (§app.requirements/owner-area): the operator changes it here, and the
    server re-routes a conflict it is in. */
function OwnerAreaField(props: CardProps & { row: DecisionRow }) {
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
    <label class="field project-owner-area">
      <span class="field-label">Owner area</span>
      <select ref={select} class="select" disabled={!!props.busy} onChange={(e) => void set(e.currentTarget.value)}>
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
      <Show when={last()}>
        {(l) => (
          <span class="field-hint">
            Changed by {l().name} <time title={l().at}>{relativeTime(l().at)}</time>.
          </span>
        )}
      </Show>
    </label>
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
                    <li class="project-decision" classList={{ "project-decision-old": d.state === "superseded" }}>
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
                        <Show when={d.state !== "superseded"}>
                          <OwnerAreaField {...props} row={d} />
                        </Show>
                      </div>
                      <div class="project-chips">
                        <Chip tone={DECISION_STATE[d.state].tone} title={DECISION_STATE[d.state].hint}>
                          {DECISION_STATE[d.state].word}
                        </Chip>
                        <Show when={outsideTheirArea(d)}>
                          <Chip tone="warn" title={`${d.name} doesn't decide ${d.ownerArea && d.ownerArea !== OWNER_AREA_NONE ? d.ownerArea : d.area}. Select All Ready leaves it out; tick it to promote it anyway.`}>
                            Outside their area
                          </Chip>
                        </Show>
                      </div>
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
