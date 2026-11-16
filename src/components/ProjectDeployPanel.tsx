import { createEffect, createMemo, createResource, createSignal, For, type JSX, Show } from "solid-js";
import type { ReleaseHistoryItem } from "../../shared/release";
import type { DeployPlanView, DeployRecordView, DeployReport, DeployReview, DeployTargetView, LogLine, VerbResult } from "../../shared/project-contract";
import { ApiError, runDeployVerb } from "../lib/api";
import { relativeTime } from "../lib/format";
import { createPoll } from "../lib/poll";
import { checksLine, DEPLOY_STANDING_CHIP, DEPLOY_STATE_CHIP, deployHistory, deployProgress, hash12, historyResult, overridesAsked, stepCaption, planDeadline, progressLine, recordLine, rollbackWord, shipConfirmLine, short } from "../lib/project-deploy";
import { announce, toast } from "../lib/ui-state";
import { deployHandOff, takeDeployHandOff } from "../lib/releases-client";
import { releaseAt, releaseOfTarget } from "../lib/releases";
import { createSetupPoll, SetupChatButton, SetupChatState, SetupNotSetUp, type SetupPoll } from "./SetupChat";
import { Chip } from "./ui";

/** A deploy's record changes step by step: read often enough to follow one. */
const DEPLOY_POLL_MS = 5_000;
const LOG_LINES = 200;
/** The History list's length: deploy.status keeps 20 per target. */
const HISTORY_SHOWN = 20;

// The plans this page shipped, by plan id: a running deploy's record names only the steps that ended, its plan the rest.
const [shipped, setShipped] = createSignal<Record<string, DeployPlanView>>({});

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

const LIST_WORD: Record<string, string> = { credentials: "Credential check", plan: "Plan step", build: "Build", steps: "Step", rollback: "Rollback step" };

/**
 * A deploy recipe as Sova renders it (§app.project-runtime/run-report): every target's steps with this host's values
 * in place and an unset one named, then its verify and its rollback.
 */
export function DeployRecipeSteps(props: { recipe: DeployReview }) {
  // One row per step: what it is on one line, and what runs (mono, wrapping in its own block) under it.
  const step = (kind: () => JSX.Element, body: () => JSX.Element) => (
    <li class="deploy-step">
      <span class="deploy-step-kind">{kind()}</span> {body()}
    </li>
  );
  return (
    <div class="deploy-recipe" role="group" aria-label="Deploy recipe">
      <For each={props.recipe.targets}>
        {(t) => (
          <div class="deploy-recipe-target">
            <p class="deploy-target-head">
              <span class="project-software-name">{t.name}</span> <span class="project-card-note">{t.about}</span>
            </p>
            <p class="project-card-note">
              Ships from <span class="text-mono">{t.branch}</span> · tests: {t.tests === "none" ? "none required" : t.tests === "full" ? "the full suite" : "the smoke selection"}
            </p>
            <ul class="deploy-steps">
              <For each={t.steps}>
                {(s) =>
                  step(
                    () => (
                      <>
                        {LIST_WORD[s.list] ?? s.list} {s.id}
                        <Show when={s.unset.length}>
                          {" "}
                          <Chip tone="warn" title="Set it in Sova's host.json on this host before a plan.">
                            Unset here: {s.unset.join(", ")}
                          </Chip>
                        </Show>
                      </>
                    ),
                    () => <code class="deploy-cmd">{s.argv.join(" ")}</code>,
                  )
                }
              </For>
              <Show when={t.verify}>
                {(v) =>
                  step(
                    () => <>Verify</>,
                    () => (
                      <>
                        <code class="deploy-cmd">GET {v().url}</code> <span class="deploy-step-note">answers {v().expect}</span>
                      </>
                    ),
                  )
                }
              </Show>
              {step(
                () => <>Rollback</>,
                () => (
                  <span class="deploy-step-text">
                    {t.rollback === "steps" ? "its rollback steps above" : t.rollback === "redeploy-previous" ? "the last verified commit, deployed again" : `none: ${(t.rollback as { none: string }).none}`}
                  </span>
                ),
              )}
            </ul>
          </div>
        )}
      </For>
    </div>
  );
}

/** One target's plan as deploy.plan answered it: each check, what will run, its deadline. */
function PlanView(props: { plan: DeployPlanView }) {
  // The checks fold to one line; one let through opens them, so it is never folded away.
  const checks = () => checksLine(props.plan.checks);
  return (
    <div class="deploy-plan">
      <details class="orgs-history deploy-checks" open={checks().open}>
        <summary>{checks().line}</summary>
        <ul class="deploy-check-list">
          <For each={props.plan.checks}>
            {(c) => (
              <li class="deploy-check">
                <Chip tone={c.ok ? "success" : "warn"}>{c.ok ? "Passed" : "Let through"}</Chip> <span class="deploy-check-detail">{c.detail}</span>
              </li>
            )}
          </For>
        </ul>
      </details>
      <p class="project-card-note">Runs, in a fresh checkout of {short(props.plan.commit)}:</p>
      <ul class="deploy-cmds">
        <For each={props.plan.steps}>{(s) => <li><code class="text-mono">{s.argv.join(" ")}</code></li>}</For>
      </ul>
      <Show when={props.plan.verify}>
        {(v) => (
          <p class="project-card-note">
            then verifies <code class="text-mono">GET {v().url}</code>
          </p>
        )}
      </Show>
      <p class="project-card-note">{planDeadline(props.plan.expiresAt, Date.now())}</p>
    </div>
  );
}

/**
 * The project's Deploy panel (§app.project-runtime/deploy-panel): each target's standing and last deploy; per
 * target Plan Deploy, then Deploy Now after a confirm; Roll Back; the last deploy's log; an overseer's request. Only the operator sees it.
 */
export function ProjectDeployPanel(props: {
  projectId: string;
  root: string;
  archived: boolean;
  /** The project's numbered releases: each row says which one it runs. */
  releases?: () => readonly ReleaseHistoryItem[] | undefined;
  /** The page's read of the project's Setup chat (one of its own when absent). */
  setup?: SetupPoll;
  /** Each read of deploy.status, for the page's tab dot. */
  onStatus?(report: DeployReport | undefined): void;
}) {
  const poll = createPoll(() => runDeployVerb(props.root, "deploy.status", {}), DEPLOY_POLL_MS);
  createEffect(() => {
    const d = poll.data();
    if (d) props.onStatus?.(d.deploy);
  });
  const setup = props.setup ?? createSetupPoll(props.projectId);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [plans, setPlans] = createSignal<Record<string, DeployPlanView | { refused: VerbResult["error"] }>>({});
  const [reasons, setReasons] = createSignal<Record<string, { tests?: string; dirty?: string }>>({});
  const [confirm, setConfirm] = createSignal<{ target: string; what: "deploy" | "rollback" } | null>(null);
  const [logs, setLogs] = createSignal<Record<string, LogLine[]>>({});

  const report = () => poll.data()?.deploy;
  // A hand-off (Plan Deploy of vX on Releases opened this tab) waits until the targets are read, then plans once.
  createEffect(() => {
    if (!deployHandOff() || !report()?.targets) return;
    const h = takeDeployHandOff(props.projectId);
    const t = h && report()!.targets!.find((x) => x.name === h.target);
    if (!h || !t) return;
    setPinned((p) => ({ ...p, [t.name]: { commit: h.commit, version: h.version } }));
    void plan(t);
  });
  const act = async (key: string, fn: () => Promise<string | null>) => {
    if (busy()) return;
    setBusy(key);
    setError(null);
    try {
      const done = await fn();
      if (done) {
        toast(done);
        announce(done);
      }
    } catch (err) {
      setError(errText(err));
      announce(errText(err));
    } finally {
      setBusy(null);
      poll.refetch();
    }
  };
  const failed = (r: VerbResult): string | null => (r.error ? r.error.message : null);

  // Plan Deploy of vX from the Releases tab: the target's plan at that release's commit, kept for Plan Again.
  const [pinned, setPinned] = createSignal<Record<string, { commit: string; version: string }>>({});
  const plan = (t: DeployTargetView) =>
    act(`plan:${t.name}`, async () => {
      const why = reasons()[t.name] ?? {};
      const pin = pinned()[t.name];
      const r = await runDeployVerb(props.root, "deploy.plan", { target: t.name, ...(pin ? { commit: pin.commit } : {}), ...(why.tests ? { overrideTests: why.tests } : {}), ...(why.dirty ? { overrideDirty: why.dirty } : {}) });
      setPlans((p) => ({ ...p, [t.name]: r.deploy?.plan ?? { refused: r.error } }));
      return r.deploy?.plan ? `Planned ${short(r.deploy.plan.commit)} to ${t.name}.` : null;
    });
  const ship = (t: DeployTargetView, p: DeployPlanView) =>
    act(`run:${t.name}`, async () => {
      const r = await runDeployVerb(props.root, "deploy.run", { plan: p.planId, confirm: true });
      setConfirm(null);
      if (!r.error) setShipped((x) => ({ ...x, [p.planId]: p }));
      setPlans((x) => ({ ...x, [t.name]: undefined as never }));
      const why = failed(r);
      if (why) throw new Error(why);
      return `Deploying ${short(p.commit)} to ${t.name}.`;
    });
  const rollBack = (t: DeployTargetView) =>
    act(`rollback:${t.name}`, async () => {
      const r = await runDeployVerb(props.root, "deploy.rollback", { target: t.name, confirm: true });
      setConfirm(null);
      const why = failed(r);
      if (why) throw new Error(why);
      return `Rolling ${t.name} back to ${short(r.deploy!.record!.commit)}.`;
    });
  const readLogs = (t: DeployTargetView) =>
    act(`logs:${t.name}`, async () => {
      if (logs()[t.name]) {
        setLogs((l) => ({ ...l, [t.name]: undefined as never }));
        return null;
      }
      const r = await runDeployVerb(props.root, "deploy.logs", { target: t.name, lines: LOG_LINES });
      const why = failed(r);
      if (why) throw new Error(why);
      setLogs((l) => ({ ...l, [t.name]: r.lines ?? [] }));
      return null;
    });
  const dismiss = (t: DeployTargetView) =>
    act(`dismiss:${t.name}`, async () => {
      const why = failed(await runDeployVerb(props.root, "deploy.request", { target: t.name, dismiss: true }));
      if (why) throw new Error(why);
      return `Dismissed the request to deploy ${t.name}.`;
    });
  // What runs now, one progress card per target deploying.
  const runningNow = () => (report()?.targets ?? []).flatMap((t) => (t.last?.state === "running" ? [t.last] : []));
  // History: every target's records (deploy.status keeps them per target), read again when any target's last one changes.
  const historyKey = createMemo(() => {
    const ts = report()?.targets;
    return ts ? ts.map((t) => `${t.name}:${t.last?.id ?? ""}:${t.last?.state ?? ""}`).join("|") : null;
  });
  const [history] = createResource(historyKey, async () => {
    const names = (report()?.targets ?? []).map((t) => t.name);
    const per = await Promise.all(names.map((target) => runDeployVerb(props.root, "deploy.status", { target }).then((r) => r.deploy?.history ?? [])));
    return deployHistory(per).slice(0, HISTORY_SHOWN);
  });
  return (
    <>
    <div class="project-tab-head">
      <div class="project-tab-head-text">
        <h2 class="project-tab-h2" id="project-deploy">
          Deploy
        </h2>
        <p class="project-tab-lede">Plans from Releases land here.</p>
      </div>
      <span class="cluster">
        <Show when={report()?.deployHash}>
          {(h) => (
            <span class="list-meta deploy-setup-hash" title="The deploy section's hash on main: it changes when the setup does">
              Setup <span class="text-mono">{hash12(h())}</span>
            </span>
          )}
        </Show>
        <Show when={!props.archived && report()?.targets?.length}>
          <SetupChatButton projectId={props.projectId} setUp from="deploy" poll={setup} />
        </Show>
      </span>
    </div>
    <For each={runningNow()}>{(r) => <DeployProgress record={r} />}</For>
    <section class="card orgs-section project-card" aria-label="Deploy targets">
      <Show
        when={report()}
        fallback={
          // No definition on main at all is a project with nothing set up: the same words and button as no deploy.
          <Show when={!poll.error() && poll.data()?.error?.code === "not-found"} fallback={<p class="orgs-empty">{poll.error() ? `Couldn't read the deploy targets. ${poll.error()}` : poll.data()?.error ? poll.data()!.error!.message : "Reading the deploy targets."}</p>}>
            <SetupNotSetUp projectId={props.projectId} surface="deploy" archived={props.archived} poll={setup} />
          </Show>
        }
      >
        {(d) => (
          <>
            <Show when={d().targets?.length}>
              <SetupChatState projectId={props.projectId} poll={setup} proposalOnly />
            </Show>
            <Show when={!d().targets?.length}>
              <SetupNotSetUp projectId={props.projectId} surface="deploy" archived={props.archived} poll={setup} />
            </Show>
            <ul class="deploy-targets">
              <For each={d().targets ?? []}>
                {(t) => {
                  const p = () => plans()[t.name];
                  const planned = () => (p() && "planId" in p()! ? (p() as DeployPlanView) : null);
                  const refused = () => (p() && "refused" in p()! ? (p() as { refused: VerbResult["error"] }).refused : null);
                  const running = () => t.last?.state === "running";
                  const can = () => t.standing === "declared" && !props.archived;
                  // The numbered release it runs (the one deployed to it, else the one at its verified commit).
                  const rel = () => releaseOfTarget(props.releases?.(), t.name) ?? releaseAt(props.releases?.(), t.verifiedCommit);
                  return (
                    <li class="deploy-target">
                      {/* The target's facts: what it is, what it runs now, and its last deploy. */}
                      <dl class="deploy-facts">
                        <dt>Target</dt>
                        <dd>
                          <span class="project-software-name text-mono">{t.name}</span> <Chip tone={DEPLOY_STANDING_CHIP[t.standing].tone}>{DEPLOY_STANDING_CHIP[t.standing].word}</Chip>
                          <span class="project-card-note deploy-about">{t.about}</span>
                        </dd>
                        <Show when={rel() || t.verifiedCommit}>
                          <dt>Running now</dt>
                          <dd class="deploy-release" title={rel()?.withdrawn ? `Withdrawn: ${rel()!.withdrawn!.why}` : undefined}>
                            <Show when={rel()}>
                              {(x) => (
                                <>
                                  Runs <span class="text-mono">{x().tag}</span>
                                  {x().withdrawn ? " (withdrawn)" : ""}{" "}
                                </>
                              )}
                            </Show>
                            <Show when={t.verifiedCommit}>{(c) => <span class="text-mono project-card-note">{short(c())}</span>}</Show>
                          </dd>
                        </Show>
                        <Show when={t.last}>
                          {(r) => (
                            <>
                              <dt>Last deploy</dt>
                              <dd class="deploy-last">
                                <Chip tone={DEPLOY_STATE_CHIP[r().state].tone} live={r().state === "running"}>
                                  {DEPLOY_STATE_CHIP[r().state].word}
                                </Chip>{" "}
                                <span class="deploy-last-line">
                                  {recordLine(r())} <span class="deploy-when">· <time title={r().startedAt}>{relativeTime(r().startedAt)}</time></span>
                                </span>
                              </dd>
                            </>
                          )}
                        </Show>
                      </dl>
                      <div class="deploy-target-body">
                        <Show when={t.request}>
                          {(q) => (
                            <p class="orgs-line deploy-request">
                              The overseer asks: deploy {q().commit ? short(q().commit!) : "the branch's tip"} to {t.name}? <span class="list-meta">{q().why}</span>
                            </p>
                          )}
                        </Show>
                        <Show when={refused()}>
                          {(e) => (
                            <div class="deploy-refused">
                              <p class="field-error" role="status">{e()!.message}</p>
                              <Show when={e()!.code === "needs-override"}>
                                <Show when={overridesAsked(e()!.message).tests}>
                                  <label class="field">
                                    <span class="field-label">Let it through without passing tests, because</span>
                                    <input class="input" value={reasons()[t.name]?.tests ?? ""} onInput={(ev) => setReasons((r) => ({ ...r, [t.name]: { ...r[t.name], tests: ev.currentTarget.value } }))} />
                                  </label>
                                </Show>
                                <Show when={overridesAsked(e()!.message).dirty}>
                                  <label class="field">
                                    <span class="field-label">Let it through with main's tree dirty, because</span>
                                    <input class="input" value={reasons()[t.name]?.dirty ?? ""} onInput={(ev) => setReasons((r) => ({ ...r, [t.name]: { ...r[t.name], dirty: ev.currentTarget.value } }))} />
                                  </label>
                                </Show>
                              </Show>
                            </div>
                          )}
                        </Show>
                        <Show when={pinned()[t.name]}>
                          {(pin) => (
                            <p class="project-card-note deploy-pinned">
                              Planning release <span class="text-mono">{pin().version}</span> ({short(pin().commit)}).{" "}
                              <button type="button" class="button button-sm button-ghost" onClick={() => setPinned((p) => { const { [t.name]: _, ...rest } = p; return rest; })}>
                                Plan the Branch Tip Instead
                              </button>
                            </p>
                          )}
                        </Show>
                        <Show when={planned()}>{(pl) => <PlanView plan={pl()} />}</Show>
                        {/* One primary per state; Roll Back sits apart at the row's end, and its confirm replaces the row. */}
                        <Show when={confirm()?.target === t.name} fallback={
                          <div class="deploy-actions">
                            <Show when={can() && !running()}>
                              <Show when={planned()} fallback={
                                <button type="button" class="button button-sm button-primary" aria-disabled={busy() ? "true" : undefined} onClick={() => void plan(t)}>
                                  {busy() === `plan:${t.name}` ? "Planning…" : refused() ? "Plan Again" : t.request ? "Open Plan" : "Plan Deploy"}
                                </button>
                              }>
                                {(pl) => (
                                  <button type="button" class="button button-sm button-primary" aria-disabled={busy() ? "true" : undefined} onClick={() => setConfirm({ target: t.name, what: "deploy" })}>
                                    Deploy {short(pl().commit)}
                                  </button>
                                )}
                              </Show>
                            </Show>
                            <Show when={t.last}>
                              <button type="button" class="button button-sm" aria-expanded={logs()[t.name] ? "true" : "false"} onClick={() => void readLogs(t)}>
                                {logs()[t.name] ? "Hide Log" : "Read Log"}
                              </button>
                            </Show>
                            <Show when={t.request}>
                              <button type="button" class="button button-sm" onClick={() => void dismiss(t)}>
                                Dismiss Request
                              </button>
                            </Show>
                            <Show when={can() && !running() && t.last && rollbackWord(t)}>
                              <button type="button" class="button button-sm button-destructive deploy-rollback" aria-disabled={busy() ? "true" : undefined} title={rollbackWord(t)!} onClick={() => setConfirm({ target: t.name, what: "rollback" })}>
                                Roll Back
                              </button>
                            </Show>
                          </div>
                        }>
                          <div class="deploy-confirm">
                            <p class="orgs-line" role="status">
                              {confirm()!.what === "deploy"
                                ? shipConfirmLine(planned()?.commit ?? "", t.name, t.about)
                                : `${rollbackWord(t) ?? ""} ${t.name} changes for everyone using it.`}
                            </p>
                            <div class="deploy-actions">
                              <Show when={confirm()!.what === "deploy" && planned()} fallback={
                                <button type="button" class="button button-sm button-destructive" aria-disabled={busy() ? "true" : undefined} onClick={() => void rollBack(t)}>
                                  Roll Back Now
                                </button>
                              }>
                                {(pl) => (
                                  <button type="button" class="button button-sm button-primary" aria-disabled={busy() ? "true" : undefined} onClick={() => void ship(t, pl())}>
                                    Deploy Now
                                  </button>
                                )}
                              </Show>
                              <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(null)}>
                                Cancel
                              </button>
                            </div>
                          </div>
                        </Show>
                        {/* The log keeps its own scroll, so a long one never stretches the card. */}
                        <Show when={logs()[t.name]}>
                          {(ls) => (
                            <pre class="deploy-log" tabindex="0" aria-label={`${t.name} deploy log`}>
                              {ls().length ? ls().map((l) => `${l.t.slice(11, 19)} [${l.service}] ${l.text}`).join("\n") : "The log is empty."}
                            </pre>
                          )}
                        </Show>
                      </div>
                    </li>
                  );
                }}
              </For>
            </ul>
            <Show when={error()}>{(e) => <p class="field-error" role="status">{e()}</p>}</Show>
          </>
        )}
      </Show>
    </section>
    <Show when={report()?.targets?.length}>
      <DeployHistory records={history.latest} error={history.error ? errText(history.error) : null} />
    </Show>
    </>
  );
}

/** A deploy running now (§app.project-runtime/deploy-panel): its line and its steps, done, now and waiting. */
function DeployProgress(props: { record: DeployRecordView }) {
  const steps = () => deployProgress(props.record, shipped()[props.record.planId]);
  return (
    <section class="card deploy-progress" aria-label={`${props.record.kind === "rollback" ? "Rollback" : "Deploy"} of ${props.record.target} in progress`}>
      <p class="deploy-progress-line">
        <Chip tone="accent" live>
          {DEPLOY_STATE_CHIP.running.word}
        </Chip>{" "}
        <span>{progressLine(props.record, steps())}</span>
      </p>
      <ol class="deploy-stepper">
        <For each={steps()}>
          {(s, i) => (
            <li class="deploy-stepper-step" data-state={s.state} aria-current={s.state === "now" ? "step" : undefined}>
              {stepCaption(s, i())}
              <span class="visually-hidden">{s.state === "done" ? ", done" : s.state === "failed" ? ", failed" : s.state === "now" ? ", running" : ", waiting"}</span>
            </li>
          )}
        </For>
      </ol>
    </section>
  );
}

/** Every target's deploys and rollbacks, newest first: commit, target, what came of it, when. */
function DeployHistory(props: { records: readonly DeployRecordView[] | undefined; error: string | null }) {
  return (
    <section class="card orgs-section project-card" aria-labelledby="project-deploy-history">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-deploy-history">
          History
        </h2>
      </div>
      <Show when={props.records} fallback={<p class="orgs-empty">{props.error ? `Couldn't read the deploy history. ${props.error}` : "Reading the deploy history."}</p>}>
        {(rs) => (
          <Show when={rs().length} fallback={<p class="orgs-empty">No deploys yet. Each one lists here with its commit and result.</p>}>
            <ul class="deploy-history">
              <For each={rs()}>
                {(r) => {
                  const res = () => historyResult(r);
                  return (
                    <li class="deploy-history-row" title={r.detail}>
                      <span class="text-mono deploy-history-commit">{short(r.commit)}</span>
                      <span class="text-mono deploy-history-target">{r.target}</span>
                      <span class="deploy-history-result">
                        <Show when={r.kind === "rollback"}>
                          <span class="project-card-note">Rollback · </span>
                        </Show>
                        <Show when={res().chip}>{(c) => <Chip tone={c().tone} live={r.state === "running"}>{c().word}</Chip>}</Show>
                        <Show when={res().text}>
                          {" "}
                          <span class="project-card-note">{res().text}</span>
                        </Show>{" "}
                        <span class="text-mono project-card-note">{r.id}</span>
                      </span>
                      <time class="deploy-history-when" datetime={r.startedAt} title={r.startedAt}>
                        {relativeTime(r.startedAt)}
                      </time>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        )}
      </Show>
    </section>
  );
}
