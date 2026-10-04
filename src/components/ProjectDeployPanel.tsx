import { createSignal, For, type JSX, Show } from "solid-js";
import type { DeployPlanView, DeployReview, DeployTargetView, LogLine, VerbResult } from "../../shared/project-contract";
import { ApiError, approveDeployRecipe, runDeploySetup, runDeployVerb } from "../lib/api";
import { relativeTime } from "../lib/format";
import { createPoll } from "../lib/poll";
import { checksLine, DEPLOY_STANDING_CHIP, DEPLOY_STATE_CHIP, hash12, overridesAsked, planDeadline, recordLine, rollbackWord, shipConfirmLine, short, tickProgress } from "../lib/project-deploy";
import { announce, toast } from "../lib/ui-state";
import { Chip } from "./ui";

/** A deploy's record changes step by step: read often enough to follow one. */
const DEPLOY_POLL_MS = 5_000;
const LOG_LINES = 200;

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

const LIST_WORD: Record<string, string> = { credentials: "Credential check", plan: "Plan step", build: "Build", steps: "Step", rollback: "Rollback step" };

/**
 * The review the operator ticks (§app.project-services/deploy-trust): every target's steps as Sova renders them, with
 * this host's values in place and an unset one named, then its verify and its rollback. Each is a checkbox;
 * `onTick` reports one key. The parent holds the ticks and enables Approve once every key is ticked.
 */
export function DeployReviewTicks(props: { review: DeployReview; ticked: ReadonlySet<string>; onTick(key: string, on: boolean): void }) {
  // One row per tick: the box, then what it is on one line and what runs (mono, wrapping in its own block) under it.
  const tick = (key: string, kind: () => JSX.Element, body: () => JSX.Element) => (
    <li>
      <label class="toggle deploy-tick">
        <input type="checkbox" checked={props.ticked.has(key)} onChange={(e) => props.onTick(key, e.currentTarget.checked)} />
        <span class="toggle-box" />
        <span class="deploy-tick-body">
          <span class="deploy-tick-kind">{kind()}</span> {body()}
        </span>
      </label>
    </li>
  );
  return (
    <div class="deploy-review" role="group" aria-label="Deploy recipe to review">
      <For each={props.review.targets}>
        {(t) => (
          <div class="deploy-review-target">
            <p class="deploy-target-head">
              <span class="project-software-name">{t.name}</span> <span class="project-card-note">{t.about}</span>
            </p>
            <p class="project-card-note">
              Ships from <span class="text-mono">{t.branch}</span> · tests: {t.tests === "none" ? "none required" : t.tests === "full" ? "the full suite" : "the smoke selection"}
            </p>
            <ul class="deploy-ticks">
              <For each={t.steps}>
                {(s) =>
                  tick(
                    `${t.name}/${s.key}`,
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
                  tick(
                    `${t.name}/verify`,
                    () => <>Verify</>,
                    () => (
                      <>
                        <code class="deploy-cmd">GET {v().url}</code> <span class="deploy-tick-note">answers {v().expect}</span>
                      </>
                    ),
                  )
                }
              </Show>
              {tick(
                `${t.name}/rollback`,
                () => <>Rollback</>,
                () => (
                  <span class="deploy-tick-text">
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
 * The project's Deploy panel (§app.project-runtime/deploy-panel): each target's standing and last deploy; while
 * main's recipe waits for approval, its review to tick and Approve Deploy; per target Plan Deploy, then Deploy
 * Now after a confirm; Roll Back; the last deploy's log; an overseer's request. Only the operator sees it.
 */
export function ProjectDeployPanel(props: { projectId: string; root: string; archived: boolean }) {
  const poll = createPoll(() => runDeployVerb(props.root, "deploy.status", {}), DEPLOY_POLL_MS);
  const [ticked, setTicked] = createSignal<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [plans, setPlans] = createSignal<Record<string, DeployPlanView | { refused: VerbResult["error"] }>>({});
  const [reasons, setReasons] = createSignal<Record<string, { tests?: string; dirty?: string }>>({});
  const [confirm, setConfirm] = createSignal<{ target: string; what: "deploy" | "rollback" } | null>(null);
  const [logs, setLogs] = createSignal<Record<string, LogLine[]>>({});

  const report = () => poll.data()?.deploy;
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

  const approve = (review: DeployReview) =>
    act("approve", async () => {
      await approveDeployRecipe(props.root, review.deployHash, [...ticked()]);
      setTicked(new Set<string>());
      return `Approved the deploy recipe ${hash12(review.deployHash)} on this host.`;
    });
  const plan = (t: DeployTargetView) =>
    act(`plan:${t.name}`, async () => {
      const why = reasons()[t.name] ?? {};
      const r = await runDeployVerb(props.root, "deploy.plan", { target: t.name, ...(why.tests ? { overrideTests: why.tests } : {}), ...(why.dirty ? { overrideDirty: why.dirty } : {}) });
      setPlans((p) => ({ ...p, [t.name]: r.deploy?.plan ?? { refused: r.error } }));
      return r.deploy?.plan ? `Planned ${short(r.deploy.plan.commit)} to ${t.name}.` : null;
    });
  const ship = (t: DeployTargetView, p: DeployPlanView) =>
    act(`run:${t.name}`, async () => {
      const r = await runDeployVerb(props.root, "deploy.run", { plan: p.planId, confirm: true });
      setConfirm(null);
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
  const setup = () =>
    act("setup", async () => {
      const out = await runDeploySetup(props.projectId);
      return out.worktree ? `The Project deploy playbook started on ${out.worktree.branch}.` : "The Project deploy playbook started.";
    });

  return (
    <section class="card orgs-section project-card" aria-labelledby="project-deploy">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-deploy">
          Deploy
        </h2>
        <Show when={report()?.deployHash}>{(h) => <span class="list-meta text-mono">{hash12(h())}</span>}</Show>
      </div>
      <Show when={report()} fallback={<p class="orgs-empty">{poll.error() ? `Couldn't read the deploy targets. ${poll.error()}` : poll.data()?.error ? poll.data()!.error!.message : "Reading the deploy targets."}</p>}>
        {(d) => (
          <>
            <Show when={!d().targets?.length}>
              <p class="orgs-empty">Main declares no deploy yet. Set Up Deploy asks you how each target ships, then proposes a recipe for you to tick and approve.</p>
            </Show>
            <Show when={d().review}>
              {(review) => {
                const progress = () => tickProgress(review(), ticked());
                return (
                  <div class="deploy-approve">
                    <p class="orgs-line">This recipe runs on your targets once you approve it. Tick each step as you read it.</p>
                    <DeployReviewTicks review={review()} ticked={ticked()} onTick={(k, on) => setTicked((cur) => { const n = new Set(cur); if (on) n.add(k); else n.delete(k); return n; })} />
                    <div class="deploy-approve-bar">
                      <button
                        type="button"
                        class="button button-sm button-primary"
                        aria-disabled={progress().left || busy() ? "true" : undefined}
                        title={progress().left ? `Tick every step first: ${progress().left} left.` : undefined}
                        onClick={() => !progress().left && void approve(review())}
                      >
                        Approve Deploy {hash12(review().deployHash)}
                      </button>
                      <span class="deploy-progress" role="status">{progress().line}</span>
                    </div>
                  </div>
                );
              }}
            </Show>
            <ul class="deploy-targets">
              <For each={d().targets ?? []}>
                {(t) => {
                  const p = () => plans()[t.name];
                  const planned = () => (p() && "planId" in p()! ? (p() as DeployPlanView) : null);
                  const refused = () => (p() && "refused" in p()! ? (p() as { refused: VerbResult["error"] }).refused : null);
                  const running = () => t.last?.state === "running";
                  const can = () => d().approved && t.standing === "approved" && !props.archived;
                  return (
                    <li class="deploy-target">
                      {/* Two rows on one grid: the target and its standing, then its last deploy and its state, chips in one column. */}
                      <div class="deploy-target-facts">
                        <span class="project-software-name">{t.name}</span>
                        <span class="deploy-fact">
                          <Chip tone={DEPLOY_STANDING_CHIP[t.standing].tone}>{DEPLOY_STANDING_CHIP[t.standing].word}</Chip> <span class="project-card-note">{t.about}</span>
                        </span>
                        <Show when={t.last}>
                          {(r) => (
                            <span class="deploy-fact deploy-last">
                              <Chip tone={DEPLOY_STATE_CHIP[r().state].tone} live={r().state === "running"}>
                                {DEPLOY_STATE_CHIP[r().state].word}
                              </Chip>{" "}
                              <span class="deploy-last-line">
                                {recordLine(r())} <span class="deploy-when">· <time title={r().startedAt}>{relativeTime(r().startedAt)}</time></span>
                              </span>
                            </span>
                          )}
                        </Show>
                      </div>
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
            <Show when={!props.archived && !d().targets?.length}>
              <div class="deploy-actions">
                <button type="button" class="button button-sm button-primary" aria-disabled={busy() ? "true" : undefined} onClick={() => void setup()}>
                  Set Up Deploy
                </button>
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
