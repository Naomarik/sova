import { createEffect, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js";
import type { ReleaseHistoryItem, ReleaseRecord, ReleaseStep, ReleaseView } from "../../shared/release";
import type { ReleaseSetupReview } from "../../shared/project-runtime";
import { runReleaseSetup } from "../lib/api";
import { relativeTime } from "../lib/format";
import { createPoll, type Poll } from "../lib/poll";
import { mergeRunHref, projectSessionHref, projectTabHref } from "../lib/projects-route";
import {
  abandonConfirmLine,
  cardLine as cardLineOf,
  countdown,
  previousRelease,
  progressLine,
  publishBlocked,
  publishConfirmLine,
  RELEASE_CHIP,
  releaseName,
  shortSha,
  shownRecord,
  sinceLine,
  startedByWord,
  PHASE_WORD,
  STEP_CHIP,
  stepActions,
  visibleSteps,
  withdrawConfirmLine,
  type ChipWord,
} from "../lib/releases";
import { askDeployPlan, noteReleaseChanged, readReleases, releaseChanged, releaseFeed, releaseRefusal, runReleaseVerb } from "../lib/releases-client";
import { announce, toast } from "../lib/ui-state";
import { CancelHeldButton } from "./HeldAct";
import { Banner, Chip, Icon } from "./ui";

/** A release's steps move by the minute; the checks by the second, on the Merge Queue tab. */
const POLL_MS = 5000;

/** The page's one read of a project's releases: the Releases tab, the Overview card and the Deploy card share it. */
export function createReleasesPoll(projectId: string, root: () => string): Poll<ReleaseView> {
  const poll = createPoll(() => readReleases(root()), POLL_MS, { cacheKey: `project:${projectId}:releases` });
  createEffect(on(releaseChanged, () => poll.refetch(), { defer: true }));
  // What the feed pushes for this project is the newest view: adopt it as is.
  createEffect(
    on(releaseFeed, (f) => {
      if (f && (f.project === projectId || f.project === root())) poll.set(f.view);
    }, { defer: true }),
  );
  return poll;
}

const chip = (c: ChipWord, title?: string) => (
  <Chip tone={c.tone} live={c.live} title={title}>
    {c.word}
  </Chip>
);

/** One action with its pending state; a refusal shows where it was pressed and is announced. */
function useAct() {
  const [busy, setBusy] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const run = async (key: string, call: () => Promise<{ ok: boolean; error?: { message: string } }>, done: string): Promise<boolean> => {
    if (busy()) return false;
    setBusy(key);
    setError(null);
    try {
      const no = releaseRefusal(await call());
      if (no) {
        setError(no);
        announce(no);
        return false;
      }
      toast(done);
      announce(done);
      noteReleaseChanged();
      return true;
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      setError(why);
      announce(why);
      return false;
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run };
}

/**
 * A project's Releases tab (§app.release): the release in progress with its steps, Publish and Abandon; then every
 * numbered release from its tags, newest first, with its notes, channel badges, where it runs and Withdraw. A
 * project whose releases aren't set up gets the note on how, with Set Up Releases.
 */
export function ReleasesTab(props: { projectId: string; root: string; name: string; archived: boolean; poll: Poll<ReleaseView> }) {
  const view = () => props.poll.data();
  return (
    <section class="card orgs-section rel-tab" aria-labelledby="rel-title">
      <Show
        when={view()}
        fallback={<p class="orgs-empty">{props.poll.error() ? `Couldn't read this project's releases. ${props.poll.error()}` : "Reading the releases."}</p>}
      >
        {(v) => <ReleasesBody projectId={props.projectId} name={props.name} archived={props.archived} view={v()} targets={v().deployTargets} />}
      </Show>
    </section>
  );
}

function ReleasesBody(props: { projectId: string; name: string; archived: boolean; view: ReleaseView; targets: string[] }) {
  const v = () => props.view;
  const head = useAct();
  const shown = () => shownRecord(v());
  const canStart = () => v().initialized && !v().problem && !v().open && !props.archived;
  const start = () => void head.run("start", () => runReleaseVerb(v().project, "release.start"), "Started a release. Its chat follows the release playbook.");
  return (
    <div class="stack mq-body rel-body">
      <div class="spread mq-head">
        <div class="cluster">
          <h2 class="orgs-h2" id="rel-title">
            Releases
          </h2>
          <Show when={!v().initialized}>{chip({ word: "Not set up", tone: "warn" })}</Show>
        </div>
        <Show when={canStart()}>
          <button type="button" class="button button-sm button-primary" aria-disabled={head.busy() ? "true" : undefined} onClick={start}>
            {head.busy() === "start" ? "Starting…" : "Start Release"}
          </button>
        </Show>
      </div>
      <div class="mq-strip rel-strip" role="group" aria-label="Latest release">
        <div class="mq-cell">
          <p class="text-eyebrow">Latest release</p>
          <p class="mq-cell-value text-mono">{v().latest ?? "None yet"}</p>
        </div>
        <div class="mq-cell">
          <p class="text-eyebrow">Since then</p>
          <p class="mq-cell-value">{sinceLine(v()) ?? (v().latest ? "—" : "Every landing so far")}</p>
          <p class="text-caption text-muted">
            On {v().target}
            {v().remote ? ", published to origin" : ", on this machine only"}
          </p>
        </div>
      </div>
      <Show when={head.error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
      <Show when={v().problem}>
        {(p) => <Banner tone="error" title="This project's release settings don't read." body={`${p().trim().replace(/[.]$/, "")}. Fix it on ${v().target}, or land a branch that fixes it; no release starts until it reads.`} />}
      </Show>
      <Show when={!v().initialized}>
        <NotSetUp projectId={props.projectId} name={props.name} archived={props.archived} target={v().target} />
      </Show>
      <Show when={shown()}>{(r) => <InProgress projectId={props.projectId} view={v()} record={r()} targets={props.targets} />}</Show>
      <Show when={v().initialized && !shown() && !v().problem}>
        <p class="mq-empty text-caption">
          {props.archived
            ? `${props.name} is archived: no release starts.`
            : `No release open. Start Release opens a chat that follows ${props.name}'s release playbook; ${v().target} waits on it until you publish or abandon.`}
        </p>
      </Show>
      <History projectId={props.projectId} view={v()} archived={props.archived} targets={props.targets} />
    </div>
  );
}

/** Releases aren't set up: what that means, how to set them up, and Set Up Releases (the maker, a chat). */
function NotSetUp(props: { projectId: string; name: string; archived: boolean; target: string }) {
  const act = useAct();
  const [started, setStarted] = createSignal<{ path: string; branch?: string } | null>(null);
  const setup = async () => {
    if (act.busy()) return;
    await act.run(
      "setup",
      async () => {
        const out = await runReleaseSetup(props.projectId);
        setStarted({ path: out.path, branch: out.worktree?.branch });
        return { ok: true };
      },
      "Set Up Releases started a chat.",
    );
  };
  return (
    <div class="stack-2 rel-unset">
      <Banner
        tone="info"
        title="Releases aren't set up for this project"
        body={
          <>
            Until they are, nothing here starts a release. Set Up Releases opens a chat that reads {props.name}, asks you how it releases (the version rule, the notes, each step, the channel that moves), then proposes a release playbook
            and a <code class="text-mono">release</code> section in <code class="text-mono">.sova/project.json</code> on a branch for you to land on {props.target}. Every part of it stays yours to change.
          </>
        }
        action={
          <Show when={!props.archived}>
            <button type="button" class="button button-sm button-primary" aria-disabled={act.busy() ? "true" : undefined} onClick={() => void setup()}>
              {act.busy() === "setup" ? "Starting…" : "Set Up Releases"}
            </button>
          </Show>
        }
      />
      <Show when={started()}>
        {(s) => (
          <p class="text-caption">
            The set-up chat started{s().branch ? <> on <span class="text-mono">{s().branch}</span></> : null}. <a href={projectSessionHref(props.projectId, s().path)}>Open the Chat</a>
          </p>
        )}
      </Show>
      <Show when={act.error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
    </div>
  );
}

/** The release in progress (or one published whose after-publish steps still run): its steps, gates and actions. */
function InProgress(props: { projectId: string; view: ReleaseView; record: ReleaseRecord; targets: string[] }) {
  const r = () => props.record;
  const v = () => props.view;
  const act = useAct();
  const [confirm, setConfirm] = createSignal<"publish" | "abandon" | null>(null);
  const [why, setWhy] = createSignal("");
  const open = () => r().state === "preparing" || r().state === "checking" || r().state === "ready" || r().state === "publishing";
  const blocked = () => publishBlocked(v(), r());
  const name = () => releaseName(r());
  const publish = async () => {
    if (await act.run("publish", () => runReleaseVerb(v().project, "release.publish", { release: r().id, confirm: true }), `Publishing ${name()}.`)) setConfirm(null);
  };
  const abandon = async () => {
    if (await act.run("abandon", () => runReleaseVerb(v().project, "release.abandon", { release: r().id, why: why().trim(), confirm: true }), `Abandoned ${name()}.`)) setConfirm(null);
  };
  return (
    <div class="mq-card rel-card" role="group" aria-label="Release in progress" data-release={r().id} data-state={r().state}>
      <div class="spread">
        <div class="cluster">
          <h3 class="text-heading-s">{open() ? "Release in progress" : r().state === "withdrawn" ? "Withdrawn, finishing" : "Published, finishing"}</h3>
          {chip(RELEASE_CHIP[r().state])}
        </div>
        <div class="button-row mq-row-act">
          <Show when={r().thread}>
            {(t) => (
              <a class="button button-sm button-ghost" href={projectSessionHref(props.projectId, t().session)}>
                <Icon name="chat" small />
                Open Release Chat
              </a>
            )}
          </Show>
        </div>
      </div>
      <p class="mq-card-title text-mono">{name()}</p>
      <p class="mq-facts">
        <span>
          Started {relativeTime(r().startedAt)} by {startedByWord(r().startedBy)} · from <span class="text-mono">{shortSha(r().base)}</span>
          <Show when={r().commit && r().commit !== r().base}>
            {" "}
            · release commit <span class="text-mono">{shortSha(r().commit)}</span>
          </Show>
          <Show when={r().lastReportAt}>{(t) => <> · last report {relativeTime(t())}</>}</Show>
        </span>
      </p>
      <p class="text-caption mq-now">{progressLine(r())}</p>
      <Show when={open()}>
        <p class="text-caption text-muted">Other landings wait in the queue until {name()} is published or abandoned.</p>
      </Show>
      <Show when={open() && v().quiet}>
        {(q) => (
          <Banner
            tone="warn"
            title={`No word from the release chat for ${q().minutes} min`}
            body={`${v().target} stays frozen on it meanwhile. Open the chat to see where it is, or abandon the release.`}
            action={
              <Show when={r().thread}>
                {(t) => (
                  <a class="button button-sm" href={projectSessionHref(props.projectId, t().session)}>
                    Open Chat
                  </a>
                )}
              </Show>
            }
          />
        )}
      </Show>
      <ol class="mq-steps rel-steps" aria-label={`Steps of ${name()}`}>
        <For each={visibleSteps(r())}>{(s) => <StepRow projectId={props.projectId} view={v()} record={r()} step={s} />}</For>
      </ol>
      <Show when={r().notes}>
        {(n) => (
          <details class="rel-notes">
            <summary>Release notes</summary>
            <pre class="rel-notes-text">{n()}</pre>
          </details>
        )}
      </Show>
      <Show when={r().artifacts.length}>
        <ul class="rel-artifacts" aria-label="Built files">
          <For each={r().artifacts}>
            {(a) => (
              <Show when={a}>
                {(x) => (
                  <li class="text-caption">
                    Built: <span class="text-mono">{x().path}</span>
                    {x().size !== undefined ? ` · ${formatBytes(x().size!)}` : ""}
                    {x().sha256 ? <> · sha256 <span class="text-mono">{x().sha256!.slice(0, 12)}</span></> : null}
                  </li>
                )}
              </Show>
            )}
          </For>
        </ul>
      </Show>
      <Show when={open() && r().power}>
        {(p) => <PowerHold projectId={props.projectId} name={name()} until={p().heldUntil} act={p().act} />}
      </Show>
      <Show when={act.error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
      <Show when={open()}>
        <Show
          when={confirm()}
          fallback={
            <div class="deploy-actions rel-actions">
              <Show when={!blocked()} fallback={<p class="text-caption text-muted rel-why">{blocked()}</p>}>
                <button type="button" class="button button-sm button-primary" aria-disabled={act.busy() ? "true" : undefined} onClick={() => setConfirm("publish")}>
                  Publish {name()}
                </button>
              </Show>
              <button type="button" class="button button-sm button-destructive rel-abandon" aria-disabled={act.busy() ? "true" : undefined} onClick={() => setConfirm("abandon")}>
                Abandon Release
              </button>
            </div>
          }
        >
          {(c) => (
            <div class="deploy-confirm" role="group" aria-label={c() === "publish" ? `Confirm publishing ${name()}` : `Confirm abandoning ${name()}`}>
              <Show
                when={c() === "publish"}
                fallback={
                  <>
                    <p class="orgs-line">{abandonConfirmLine(r())}</p>
                    <label class="field">
                      <span class="field-label">Why (kept with the release)</span>
                      <input class="input" value={why()} onInput={(e) => setWhy(e.currentTarget.value)} />
                    </label>
                  </>
                }
              >
                <p class="orgs-line">{publishConfirmLine(r(), v())}</p>
              </Show>
              <div class="deploy-actions">
                <Show
                  when={c() === "publish"}
                  fallback={
                    <button type="button" class="button button-sm button-destructive" aria-disabled={act.busy() || !why().trim() ? "true" : undefined} title={why().trim() ? undefined : "Say why first."} onClick={() => why().trim() && void abandon()}>
                      {act.busy() === "abandon" ? "Abandoning…" : "Abandon Release"}
                    </button>
                  }
                >
                  <button type="button" class="button button-sm button-primary" aria-disabled={act.busy() ? "true" : undefined} onClick={() => void publish()}>
                    {act.busy() === "publish" ? "Publishing…" : "Publish Now"}
                  </button>
                </Show>
                <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </Show>
      </Show>
      <Show when={r().state === "published" && r().tag && r().commit}>
        <DeployHandOff projectId={props.projectId} version={r().tag!} commit={r().commit!} targets={props.targets} />
      </Show>
    </div>
  );
}

/** One step: its state, label, summary, Sova's own check when it disagrees, its detail, Continue / Retry Step. */
function StepRow(props: { projectId: string; view: ReleaseView; record: ReleaseRecord; step: ReleaseStep }) {
  const s = () => props.step;
  const act = useAct();
  const [open, setOpen] = createSignal(false);
  const can = () => stepActions(props.record, s());
  const run = (verb: "release.continue" | "release.retry", done: string) => void act.run(verb, () => runReleaseVerb(props.view.project, verb, { release: props.record.id, step: s().id }), done);
  const kind = () => PHASE_WORD[s().phase];
  return (
    <li class={`mq-step rel-step rel-step-${s().state}`} data-step={s().id} data-state={s().state}>
      <span class="mq-mark" title={STEP_CHIP[s().state].word}>
        <span class="mq-pos">{visibleSteps(props.record).indexOf(s()) + 1}</span>
      </span>
      <div class="mq-step-main">
        <p class="cluster mq-step-name">
          <span>{s().label}</span>
          {chip(STEP_CHIP[s().state])}
          <Show when={kind()}>{(k) => <span class="text-caption text-muted">{k()}</span>}</Show>
        </p>
        <Show when={s().summary}>{(t) => <p class="text-caption rel-summary">{t()}</p>}</Show>
        <Show when={s().fact && !s().fact!.ok}>
          <p class="text-caption mq-fail-line" role="status">
            Sova's own check disagrees: {s().fact!.why}
          </p>
        </Show>
        <Show when={s().facts?.artifact}>
          {(a) => (
            <p class="text-caption">
              Built: <span class="text-mono">{a().path}</span>
            </p>
          )}
        </Show>
        <Show when={s().facts?.url}>
          {(u) => (
            <p class="text-caption">
              <a href={u()} target="_blank" rel="noreferrer">
                {u()}
              </a>
            </p>
          )}
        </Show>
        <Show when={open() && s().detail}>
          <pre class="mq-log text-mono rel-detail" tabindex="0" aria-label={`Detail of ${s().label}`}>
            {s().detail}
          </pre>
        </Show>
        <Show when={act.error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
      </div>
      <div class="mq-step-end">
        <Show when={s().at}>{(t) => <span class="text-caption text-muted">{relativeTime(t())}</span>}</Show>
        <Show when={s().id === "checks" && s().run}>
          {(run) => (
            <a class="button button-sm button-ghost" href={mergeRunHref(props.projectId, run())}>
              View Checks
            </a>
          )}
        </Show>
        <Show when={s().detail}>
          <button type="button" class="button button-sm button-ghost" aria-expanded={open() ? "true" : "false"} aria-label={`${open() ? "Hide" : "Show"} the detail of ${s().label}`} onClick={() => setOpen(!open())}>
            Detail
          </button>
        </Show>
        <Show when={can().continue}>
          <button type="button" class="button button-sm button-primary" aria-label={`Continue after ${s().label}`} aria-disabled={act.busy() ? "true" : undefined} onClick={() => run("release.continue", `Continued after ${s().label}.`)}>
            Continue
          </button>
        </Show>
        <Show when={can().retry}>
          <button type="button" class="button button-sm" aria-label={`Retry ${s().label}`} aria-disabled={act.busy() ? "true" : undefined} onClick={() => run("release.retry", `Retrying ${s().label}.`)}>
            Retry Step
          </button>
        </Show>
      </div>
    </li>
  );
}

/** The release power's waiting period before it publishes: a live countdown and the same Cancel as Needs you. */
function PowerHold(props: { projectId: string; name: string; until: string; act: string }) {
  const [now, setNow] = createSignal(Date.now());
  const t = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(t));
  return (
    <Banner
      tone="warn"
      title={`The release power publishes ${props.name} when its waiting period ends.`}
      body={
        <span role="timer" aria-live="off">
          {countdown(props.until, now())}. Cancel stops it; you can still publish it yourself.
        </span>
      }
      action={<CancelHeldButton projectId={props.projectId} holdId={props.act} what={`Publishing ${props.name}`} onDone={noteReleaseChanged} />}
    />
  );
}

/** Plan Deploy of vX: one button per declared target, each opening the Deploy card's plan at the release's commit. */
function DeployHandOff(props: { projectId: string; version: string; commit: string; targets: string[] }) {
  return (
    <Show when={props.targets.length}>
      <div class="deploy-actions rel-handoff" role="group" aria-label={`Deploy ${props.version}`}>
        <For each={props.targets}>
          {(t) => (
            <button
              type="button"
              class="button button-sm"
              onClick={() => {
                askDeployPlan({ projectId: props.projectId, target: t, commit: props.commit, version: props.version });
                location.hash = projectTabHref(props.projectId, "overview");
              }}
            >
              Plan Deploy of {props.version}
              {props.targets.length > 1 ? ` to ${t}` : ""}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}

/** Every numbered release, newest first: its notes, channel badges, where it runs, and Withdraw. */
function History(props: { projectId: string; view: ReleaseView; archived: boolean; targets: string[] }) {
  return (
    <div class="stack-2">
      <h3 class="text-heading-s">History</h3>
      <Show
        when={props.view.history.length > 0}
        fallback={<p class="text-caption text-muted">No numbered release yet. Each one shows here from its tag, with its notes.</p>}
      >
        <ul class="list mq-list rel-history">
          <For each={props.view.history}>{(h) => <HistoryRow projectId={props.projectId} view={props.view} item={h} newest={h.tag === props.view.latest} archived={props.archived} targets={props.targets} />}</For>
        </ul>
      </Show>
    </div>
  );
}

function HistoryRow(props: { projectId: string; view: ReleaseView; item: ReleaseHistoryItem; newest: boolean; archived: boolean; targets: string[] }) {
  const h = () => props.item;
  const act = useAct();
  const [asking, setAsking] = createSignal(false);
  const [why, setWhy] = createSignal("");
  const prev = () => previousRelease(props.view.history, h().tag);
  // Withdraw is offered on a release that isn't withdrawn, with no release open (the queue is frozen then).
  const canWithdraw = () => !h().withdrawn && !props.archived && !props.view.open;
  const withdraw = async () => {
    if (await act.run("withdraw", () => runReleaseVerb(props.view.project, "release.withdraw", { tag: h().tag, ...(h().record ? { release: h().record } : {}), why: why().trim(), confirm: true }), `Withdrew ${h().tag}.`)) {
      setAsking(false);
      setWhy("");
    }
  };
  return (
    <li class="list-row mq-row rel-row" data-tag={h().tag} data-state={h().withdrawn ? "withdrawn" : "published"}>
      <div class="list-main">
        <p class="list-title mq-branch text-mono cluster">
          <span>{h().tag}</span>
          <For each={h().channels}>{(c) => <Chip tone="accent">{c}</Chip>}</For>
          <Show when={h().withdrawn}>{chip(RELEASE_CHIP.withdrawn)}</Show>
        </p>
        <p class="mq-facts">
          <span class="text-mono text-muted">{shortSha(h().sha)}</span>
          <span>
            · <time title={h().date}>{relativeTime(h().date)}</time>
            <Show when={h().deployedTo.length}> · Runs on {h().deployedTo.join(", ")}</Show>
          </span>
        </p>
        <Show when={h().withdrawn}>
          {(w) => (
            <p class="list-meta">
              Withdrawn {relativeTime(w().at)}: {w().why}
            </p>
          )}
        </Show>
        <Show when={h().notes}>
          {(n) => (
            <details class="rel-notes">
              <summary>Notes</summary>
              <pre class="rel-notes-text">{n()}</pre>
            </details>
          )}
        </Show>
        <Show when={asking()}>
          <div class="deploy-confirm" role="group" aria-label={`Confirm withdrawing ${h().tag}`}>
            <p class="orgs-line">{withdrawConfirmLine(h(), prev(), props.view.remote)}</p>
            <label class="field">
              <span class="field-label">Why (added to its notes)</span>
              <input class="input" value={why()} onInput={(e) => setWhy(e.currentTarget.value)} />
            </label>
            <div class="deploy-actions">
              <button type="button" class="button button-sm button-destructive" aria-disabled={act.busy() || !why().trim() ? "true" : undefined} title={why().trim() ? undefined : "Say why first."} onClick={() => why().trim() && void withdraw()}>
                {act.busy() === "withdraw" ? "Withdrawing…" : `Withdraw ${h().tag}`}
              </button>
              <button type="button" class="button button-sm button-ghost" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          </div>
        </Show>
        <Show when={act.error()}>{(m) => <p class="list-meta mq-error" role="alert">{m()}</p>}</Show>
      </div>
      <div class="button-row mq-row-act">
        <Show when={props.newest && !h().withdrawn && !props.archived}>
          <DeployHandOff projectId={props.projectId} version={h().tag} commit={h().sha} targets={props.targets} />
        </Show>
        <Show when={canWithdraw() && !asking()}>
          <button type="button" class="button button-sm button-destructive" aria-label={`Withdraw ${h().tag}`} onClick={() => setAsking(true)}>
            Withdraw
          </button>
        </Show>
      </div>
    </li>
  );
}

const formatBytes = (n: number): string => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

/** The Overview's small card: the latest release and what landed since, or the open release; opens the tab. */
export function ReleasesCard(props: { projectId: string; poll: Poll<ReleaseView> }): JSX.Element {
  const v = () => props.poll.data();
  return (
    <section class="card orgs-section project-card rel-mini" aria-labelledby="project-releases">
      <div class="orgs-head">
        <h2 class="orgs-h2" id="project-releases">
          Releases
        </h2>
        <a class="button button-sm" href={projectTabHref(props.projectId, "releases")}>
          Open Releases
        </a>
      </div>
      <Show when={v()} fallback={<p class="orgs-empty">{props.poll.error() ? `Couldn't read the releases. ${props.poll.error()}` : "Reading the releases."}</p>}>
        {(x) => (
          <p class="orgs-line cluster">
            <Show when={x().open}>{(o) => chip(RELEASE_CHIP[o().state])}</Show>
            <span>{cardLineOf(x())}</span>
          </p>
        )}
      </Show>
    </section>
  );
}

/**
 * What a Set Up Releases run proposes on its branch (§app.project-runtime/run-report): the `release` settings Sova acts on
 * and the playbook's steps in their order, Sova's own checks and Publish between them, before you land it.
 */
export function ReleaseSetupSteps(props: { setup: ReleaseSetupReview }) {
  const s = () => props.setup;
  const PHASES = ["prepare", "check", "after", "withdraw"] as const;
  const HEAD: Record<(typeof PHASES)[number], string> = { prepare: "Before the checks", check: "After the checks, before Publish", after: "After Publish", withdraw: "After a Withdraw" };
  return (
    <div class="deploy-recipe rel-setup" role="group" aria-label="Release setup">
      <Show when={s().problem}>{(p) => <p class="orgs-line project-software-failed">The release setup on its branch doesn't read: {p()}</p>}</Show>
      <Show when={s().settings}>
        {(st) => (
          <p class="project-card-note">
            Tags <span class="text-mono">{st().tag}</span> ({st().scheme})
            {st().channels.length ? <> · moves <span class="text-mono">{st().channels.join(", ")}</span></> : " · no channel moves"}
            {st().commit ? " · makes a release commit" : " · tag-only"}
            {st().checks.length ? <> · gating checks {st().checks.join(", ")}</> : " · the landing checks only"}
            {` · quiet after ${st().quietMin} min`} · playbook <span class="text-mono">{st().playbook}</span>
          </p>
        )}
      </Show>
      <For each={PHASES.filter((ph) => s().steps.some((x) => x.phase === ph))}>
        {(ph) => (
          <>
            <p class="project-card-note">{HEAD[ph]}</p>
            <ol class="deploy-steps">
              <For each={s().steps.filter((x) => x.phase === ph)}>
                {(x) => (
                  <li class="deploy-step">
                    <span class="deploy-step-kind">{x.label}</span> <span class="text-mono text-muted">{x.id}</span>
                    {x.held ? <> · <Chip tone="warn">Held for you</Chip></> : null}
                    {x.artifact ? " · reports a built file" : ""}
                  </li>
                )}
              </For>
            </ol>
          </>
        )}
      </For>
      <Show when={s().files.length}>
        <p class="project-card-note">
          Files: <span class="text-mono">{s().files.join(", ")}</span>
        </p>
      </Show>
    </div>
  );
}
