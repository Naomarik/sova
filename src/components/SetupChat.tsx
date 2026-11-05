import { createSignal, createUniqueId, For, type JSX, Show } from "solid-js";
import { ApiError, getSetupChat, mergeProjectRun, openSetupChat } from "../lib/api";
import { relativeTime } from "../lib/format";
import { landBranch, refusal, trySetupBranch } from "../lib/merge-queue-client";
import { queueRow } from "../lib/merge-queue";
import { createPoll, type Poll } from "../lib/poll";
import { createProjectQueue } from "../lib/project-queue";
import { mergeRunHref, projectSessionHref } from "../lib/projects-route";
import { requestListRefresh } from "../lib/list-refresh";
import { chatLine, durationWords, landState, notSetUpWords, setupButtonLabel, trialChip, trialLine, trialStale, type SetupChatView, type SetupProposal, type SetupSurface } from "../lib/setup-chat";
import { announce, toast } from "../lib/ui-state";
import { DeployRecipeSteps } from "./ProjectDeployPanel";
import { ReleaseSetupSteps } from "./ReleasesTab";
import type { MergeSetupReview } from "../../shared/project-runtime";
import { Banner, Chip, Icon } from "./ui";
import { QueueChip } from "./WorktreesModal";

/** The chat's state moves by the minute; a trial's checks by the second while one runs. */
const POLL_MS = 5000;

export type SetupPoll = Poll<Awaited<ReturnType<typeof getSetupChat>>>;

/** One read of a project's Setup chat, shared by every surface of its page through the page cache. */
export const createSetupPoll = (projectId: string): SetupPoll => createPoll(() => getSetupChat(projectId), POLL_MS, { cacheKey: `project:${projectId}:setup` });

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

/**
 * Set Up with a Chat / Change Setup: opens the project's one standing Setup chat (started the first time) and goes to
 * it. A refusal is said beside the button.
 */
export function SetupChatButton(props: { projectId: string; setUp: boolean; from: SetupSurface; poll?: SetupPoll; primary?: boolean; class?: string; onOpen?(): void }) {
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const why = () => (props.poll?.data()?.can.open === false ? (props.poll.data()!.can.why ?? "The setup chat can't open now.") : undefined);
  const open = async () => {
    if (busy() || why()) return;
    setBusy(true);
    setError(null);
    try {
      const out = await openSetupChat(props.projectId, { from: props.from });
      announce(out.reopened ? "Opened the setup chat." : "Started the setup chat.");
      props.poll?.refetch();
      props.onOpen?.();
      location.hash = projectSessionHref(props.projectId, out.path);
    } catch (err) {
      const m = errText(err);
      setError(m);
      announce(m);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span class="setup-chat-act">
      <button
        type="button"
        class={`button button-sm${props.primary ? " button-primary" : ""}${props.class ? ` ${props.class}` : ""}`}
        aria-disabled={busy() || why() ? "true" : undefined}
        title={why()}
        onClick={() => void open()}
      >
        <Icon name="chat" small />
        {busy() ? "Opening…" : setupButtonLabel(props.setUp)}
      </button>
      <Show when={error()}>{(m) => <span class="field-error" role="status">{m()}</span>}</Show>
    </span>
  );
}

/**
 * A surface whose part isn't set up: what the part does and what setting up changes, Set Up with a Chat, then the
 * chat's own state and its proposal once it has one.
 */
export function SetupNotSetUp(props: { projectId: string; surface: SetupSurface; target?: string; archived?: boolean; poll: SetupPoll; extra?: JSX.Element; onOpen?(): void }) {
  const words = () => notSetUpWords(props.surface, props.target ?? "main");
  const chat = () => props.poll.data()?.chat ?? null;
  return (
    <div class="stack-2 setup-unset" data-surface={props.surface}>
      <Banner
        tone="info"
        title={words().title}
        body={words().body}
        action={
          <Show when={!props.archived}>
            <SetupChatButton projectId={props.projectId} setUp={false} from={props.surface} poll={props.poll} primary={!chat()?.proposal} onOpen={props.onOpen} />
          </Show>
        }
      />
      {props.extra}
      <SetupChatState projectId={props.projectId} poll={props.poll} />
    </div>
  );
}

/**
 * The chat's line (state, when it started, Open Setup Chat) and its proposal card when it proposes one. Nothing when
 * there's no chat. `proposalOnly`: a set-up part's place shows the proposal alone, the chat's line staying on the
 * Merge Queue tab.
 */
export function SetupChatState(props: { projectId: string; poll: SetupPoll; fresh?: boolean; proposalOnly?: boolean }) {
  const chat = () => props.poll.data()?.chat ?? null;
  return (
    <Show when={chat()}>
      {(c) => (
        <>
          <Show when={!props.proposalOnly}>
            <SetupChatLine projectId={props.projectId} chat={c()} poll={props.poll} fresh={props.fresh} />
          </Show>
          <Show when={c().proposal}>{(p) => <SetupProposalCard projectId={props.projectId} chat={c()} proposal={p()} onDone={() => props.poll.refetch()} />}</Show>
        </>
      )}
    </Show>
  );
}

/** The Setup chat's card line: its state, when it started, Open Chat, and (on a set-up project) Start Fresh. */
function SetupChatLine(props: { projectId: string; chat: SetupChatView; poll: SetupPoll; fresh?: boolean }) {
  const line = () => chatLine(props.chat);
  const [confirm, setConfirm] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const fresh = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await openSetupChat(props.projectId, { fresh: true });
      const done = "Started fresh: the next Change Setup starts a new setup chat.";
      toast(done);
      announce(done);
      setConfirm(false);
      props.poll.refetch();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="mq-thread-card stack-2 setup-chat-card" data-state={props.chat.state} aria-label="Setup chat">
      <div class="spread">
        <div class="cluster">
          <p class="list-title">{props.chat.title}</p>
          <Show when={line()}>{(l) => <QueueChip row={{ label: l().word, tone: l().tone, live: l().live }} />}</Show>
        </div>
        <div class="button-row">
          <Show when={props.chat.path}>
            {(p) => (
              <a class="button button-sm button-ghost" href={projectSessionHref(props.projectId, p())}>
                <Icon name="chat" small />
                Open Setup Chat
              </a>
            )}
          </Show>
          <Show when={props.fresh}>
            <button type="button" class="button button-sm button-ghost" disabled={busy() || confirm()} onClick={() => setConfirm(true)}>
              Start Fresh…
            </button>
          </Show>
        </div>
      </div>
      <p class="list-meta text-muted">Started {relativeTime(props.chat.startedAt)}. It reads the project and asks what it can't tell; nothing it proposes changes {props.chat.proposal?.target ?? "anything"} until you land it.</p>
      <Show when={confirm()}>
        <div class="mq-confirm" role="group" aria-label="Start a fresh setup chat">
          <p class="field-hint">This chat is archived once its turn ends, and what it learned goes with it. Its setup branch and an open proposal stay; the next Set Up with a Chat or Change Setup starts a new chat that carries on from them.</p>
          <span class="button-row">
            <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(false)}>
              Cancel
            </button>
            <button type="button" class="button button-sm button-destructive" aria-disabled={busy() ? "true" : undefined} onClick={() => void fresh()}>
              Start Fresh
            </button>
          </span>
        </div>
      </Show>
      <Show when={error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
    </div>
  );
}

/**
 * The Setup chat's proposal, read from its branch (never the chat's words): the services, the merge checks, the
 * release settings and steps, the deploy recipe, each proposed check's trial result, then Land (a served project,
 * once a trial of the branch's head passed) or Merge Branch, and Read Report.
 */
export function SetupProposalCard(props: { projectId: string; chat: SetupChatView; proposal: SetupProposal; onDone(): void }) {
  const p = () => props.proposal;
  const t = () => p().trial;
  return (
    <div class="mq-card setup-proposal stack-2" role="group" aria-label="Setup proposal" data-branch={p().branch}>
      <div class="spread">
        <div class="cluster">
          <h3 class="text-heading-s">Proposed setup</h3>
          <span class="mq-branch text-mono">{p().branch}</span>
          <span class="text-mono text-muted">{p().commit.slice(0, 7)}</span>
        </div>
      </div>
      <p class="orgs-line">The setup chat proposes this on its branch. Read it, then land it: nothing changes on {p().target} until you do.</p>
      <Show when={p().problem}>{(m) => <p class="orgs-line project-software-failed">The setup on its branch doesn't read: {m()}</p>}</Show>
      <Section title="Services">
        <Show when={p().services.length} fallback={<p class="project-card-note">None declared: the checks run with nothing started beside them.</p>}>
          <ul class="deploy-steps">
            <For each={p().services}>
              {(s) => (
                <li class="deploy-step">
                  <span class="deploy-step-kind">{s.name}</span> <span class="text-muted">{s.start === "up" ? "starts with the copy" : "starts when a check needs it"}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Section>
      <Section title="Merge checks">
        <Show when={p().merge} fallback={<p class="project-card-note">No merge queue in this proposal.</p>}>
          {(m) => (
            <Show
              when={Array.isArray(m().checks) && (m().checks as unknown[]).length ? (m().checks as Exclude<MergeSetupReview["checks"], "none" | null>) : null}
              fallback={<p class="project-card-note">No automated tests declared: each branch lands once it merges cleanly, said as "No checks declared".</p>}
            >
              {(checks) => (
                <ul class="deploy-steps setup-checks">
                  <For each={checks()}>
                    {(c) => (
                      <CheckRow
                        projectId={props.projectId}
                        name={c.label}
                        id={c.id}
                        command={c.run.join(" ")}
                        limit={c.timeoutSec ? Math.round(c.timeoutSec / 60) : undefined}
                        optional={c.optional}
                        requires={c.requires}
                        proposal={p()}
                        kind="merge"
                      />
                    )}
                  </For>
                </ul>
              )}
            </Show>
          )}
        </Show>
      </Section>
      <Section title="Releases">
        <Show when={p().release} fallback={<p class="project-card-note">No release setup in this proposal.</p>}>
          {(r) => (
            <>
              <ReleaseSetupSteps setup={r()} />
              <Show when={t()?.checks.some((c) => c.kind === "release")}>
                <p class="project-card-note">Release checks, trial-run on the branch</p>
                <ul class="deploy-steps setup-checks">
                  <For each={t()!.checks.filter((c) => c.kind === "release")}>{(c) => <CheckRow projectId={props.projectId} name={c.name} command={c.command} proposal={p()} kind="release" />}</For>
                </ul>
              </Show>
              <p class="project-card-note">Tag, push, publish and after-publish steps are drawn only; the trial never runs them.</p>
            </>
          )}
        </Show>
      </Section>
      <Section title="Deploy">
        <Show when={p().deploy} fallback={<p class="project-card-note">No deploy recipe in this proposal.</p>}>{(d) => <DeployRecipeSteps recipe={d()} />}</Show>
      </Section>
      <Show when={p().files?.length}>
        <p class="project-card-note">
          Changes <span class="text-mono">{p().files!.join(", ")}</span>
        </p>
      </Show>
      <p class="text-caption setup-trial-line" role="status">
        <Show when={trialLine(p())} fallback={<span class="text-muted">No trial yet. A trial runs the proposed checks on the branch in the merge copy; it saves and merges nothing.</span>}>
          {(l) => (
            <>
              <span>{l()}</span>
              <span class="text-muted">
                {" "}
                · {relativeTime(t()!.at)}
                {trialStale(p()) ? ", an older commit than the branch's head" : ""}
              </span>
            </>
          )}
        </Show>
      </p>
      <div class="deploy-actions">
        <SetupLandButton projectId={props.projectId} proposal={p()} onDone={props.onDone} />
        <Show when={props.chat.path}>
          {(path) => (
            <>
              <a class="button button-sm button-ghost" href={projectSessionHref(props.projectId, path())}>
                Read Report
              </a>
              <a class="button button-sm button-ghost" href={projectSessionHref(props.projectId, path())}>
                Open Setup Chat
              </a>
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

/** A trial chip's tone as the Chip takes it: neutral is no tone. */
const toneOf = (t: "success" | "error" | "accent" | "neutral") => (t === "neutral" ? undefined : t);

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="setup-section stack-2">
      <h4 class="text-eyebrow">{props.title}</h4>
      {props.children}
    </div>
  );
}

/** One proposed check with its command and its trial result: "{label} · {time}", its chip, View Log. */
function CheckRow(props: { projectId: string; name: string; id?: string; command?: string; limit?: number; optional?: boolean; requires?: string[]; proposal: SetupProposal; kind: "merge" | "release" }) {
  const res = () => props.proposal.trial?.checks.find((c) => c.kind === props.kind && (c.name === props.name || (!!props.id && c.name === props.id)));
  return (
    <li class="deploy-step setup-check" data-check={props.name}>
      <span class="setup-check-head">
        <span class="deploy-step-kind">
          {props.name}
          <Show when={durationWords(res()?.durationMs)}>{(d) => <span class="text-mono"> · {d()}</span>}</Show>
        </span>
        <Show when={props.limit || props.optional || props.requires?.length}>
          <span class="text-caption text-muted">
            {[props.limit ? `${props.limit} min limit` : "", props.optional ? "optional" : "", props.requires?.length ? `starts ${props.requires.join(", ")} first` : ""].filter(Boolean).join(" · ")}
          </span>
        </Show>
        <span class="setup-check-result">
          <Show when={res()} fallback={<Chip>Not tried</Chip>}>
            {(r) => {
              const chip = () => trialChip(r());
              return (
                <>
                  <Chip tone={toneOf(chip().tone)} live={chip().live}>
                    {chip().word}
                  </Chip>
                  <Show when={r().run}>
                    {(run) => (
                      <a class="button button-sm button-ghost" href={mergeRunHref(props.projectId, run())} aria-label={`View the log of ${props.name}`}>
                        View Log
                      </a>
                    )}
                  </Show>
                </>
              );
            }}
          </Show>
        </span>
      </span>
      <Show when={props.command ?? res()?.command}>{(c) => <code class="deploy-cmd">{c()}</code>}</Show>
    </li>
  );
}

/**
 * Land (a project the queue serves: the branch joins the queue at the commit the card read) or Merge Branch (one it
 * doesn't), once a trial of that exact commit passed. Until then Run Trial stands in their place, with why.
 */
function SetupLandButton(props: { projectId: string; proposal: SetupProposal; onDone(): void }) {
  const p = () => props.proposal;
  const st = () => landState(p());
  const queue = createProjectQueue(() => props.projectId);
  const whyId = createUniqueId();
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const queued = () => {
    const e = queue.info(p().branch);
    return e && e.state !== "needs-fix" && e.state !== "drafts-changed" ? e : undefined;
  };
  const label = () => {
    const a = st().action;
    if (busy()) return a === "land" ? "Landing…" : a === "merge" ? "Merging…" : "Starting…";
    return a === "land" ? "Land" : a === "merge" ? "Merge Branch" : "Run Trial";
  };
  const go = async () => {
    if (busy() || !st().can) return;
    const action = st().action;
    setBusy(true);
    setError(null);
    try {
      let done: string;
      if (action === "merge") {
        if (!p().hash) throw new Error("The proposal's hash isn't read yet. Try again in a moment.");
        await mergeProjectRun(props.projectId, p().hash!, p().commit);
        done = `Merged the setup into ${p().target}.`;
      } else {
        const root = queue.root();
        if (!root) throw new Error("The project's queue isn't read yet. Try again in a moment.");
        const no = refusal(action === "land" ? await landBranch(root, p().branch, { commit: p().commit }) : await trySetupBranch(root, p().branch, p().commit));
        if (no) throw new Error(no);
        done = action === "land" ? `Queued ${p().branch} to land on ${p().target}.` : `Started a trial of ${p().commit.slice(0, 7)}.`;
      }
      toast(done);
      announce(done);
      props.onDone();
    } catch (err) {
      const m = errText(err);
      setError(m);
      announce(m);
      // A refusal can mean the branch moved ("…newer commit than the one shown: look again."): read it afresh.
      props.onDone();
    } finally {
      setBusy(false);
      requestListRefresh();
    }
  };
  return (
    <span class="playbook-review-act">
      <Show
        when={queued()}
        fallback={
          <button
            type="button"
            class={`button button-sm${st().action === "trial" || st().action === "wait" ? "" : " button-primary"}`}
            aria-label={st().action === "land" ? `Land ${p().branch}` : st().action === "merge" ? `Merge ${p().branch}` : `Run a trial of ${p().branch}`}
            aria-disabled={busy() || !st().can ? "true" : undefined}
            aria-describedby={st().why ? whyId : undefined}
            title={st().action === "land" ? `Queues ${p().branch}: checked on ${p().target} first, then ${p().target} moves to it.` : st().action === "trial" ? "Runs the branch's own checks in the merge copy. Nothing is saved or merged." : undefined}
            onClick={() => void go()}
          >
            {label()}
          </button>
        }
      >
        {(q) => {
          const qr = () => queueRow({ status: "active", exists: true, readiness: undefined, branch: p().branch, queue: q(), mergeServed: true });
          return (
            <span class="cluster playbook-review-queue">
              <QueueChip row={qr()} />
              <Show when={qr().detail}>{(d) => <span class="text-caption text-mono">{d()}</span>}</Show>
            </span>
          );
        }}
      </Show>
      <Show when={!queued() && st().why}>
        {(w) => (
          <span class="text-caption text-muted" id={whyId}>
            {w()}
          </span>
        )}
      </Show>
      <Show when={error()}>{(e) => <span class="field-error" role="status">{e()}</span>}</Show>
    </span>
  );
}
