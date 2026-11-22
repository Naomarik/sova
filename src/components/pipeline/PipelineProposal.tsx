import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import type { SetupChange, SetupMap, SetupMapAnswer } from "../../../shared/merge-queue-setup-map";
import type { SetupStatus } from "../../../shared/setup-chat";
import { getSetupHistory, mergeSetupProposal } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { noteMergeChanged } from "../../lib/merge-queue-client";
import { CHANGE_WORD, changedStages, queueStages, releaseStages, type Stage } from "../../lib/pipeline";
import { projectSessionHref, type PipelineScope } from "../../lib/projects-route";
import { announce, toast } from "../../lib/ui-state";
import type { SetupPoll } from "../SetupChat";
import { ToneChip } from "./PipelineParts";

export interface ProposalState {
  state: "none" | "drafting" | "ready";
  /** The band's line. */
  line: string;
  /** Why Confirm waits, while drafting. */
  why?: string;
}

const changesWord = (n: number) => `${n} ${n === 1 ? "change" : "changes"}`;

/**
 * Where the Setup chat's proposal stands: none; drafting (the chat is working, or its working copy holds edits it
 * hasn't committed, or a commit its proposal doesn't show yet: Confirm waits); ready (the working copy is exactly the
 * proposal's commit, which Confirm lands).
 */
export function proposalState(map: SetupMapAnswer | undefined, setup: SetupStatus | undefined, scope: PipelineScope = "queue"): ProposalState {
  const p = map?.proposal;
  if (!p) return { state: "none", line: "" };
  const n = map.changes.filter((c) => (scope === "releases" ? c.stage === "release" : c.stage !== "release")).length;
  // A proposal that changes only the other scope proposes nothing here (one that doesn't parse shows in both).
  if (!n && !p.problem) return { state: "none", line: "" };
  const committed = setup?.chat?.proposal;
  const why =
    map.chat?.state === "working"
      ? "The Setup chat is still working."
      : p.dirty
        ? "The Setup chat has edits it hasn’t committed yet."
        : !committed
          ? "The Setup chat hasn’t proposed it yet."
          : committed.commit !== p.commit
            ? "The proposal shown in the Setup chat is from an earlier commit."
            : !committed.land.can
              ? (committed.land.why ?? "It can’t land yet.")
              : undefined;
  if (why) return { state: "drafting", line: `${changesWord(n)} written so far. You can read what’s there; Confirm waits for the chat.`, why };
  return { state: "ready", line: `${changesWord(n)} from the Setup chat. Nothing changes until you confirm.` };
}

/** One column of the side by side: each stage's name, marked where a change touches it, with the change's line. */
function Column(props: { head: string; stages: Stage[]; changes: SetupChange[]; isNew?: boolean }) {
  const marked = createMemo(() => changedStages(props.changes));
  const subOf = (id: string) => props.changes.filter((c) => (c.stage === "rules" ? "checks" : c.stage) === id);
  return (
    <div class="pl-prop-col" classList={{ "is-new": !!props.isNew }}>
      <div class="pl-prop-col-head">{props.head}</div>
      <ol class="pl-prop-stages">
        <For each={props.stages}>
          {(s, i) => (
            <li class="pl-prop-stage" classList={{ "is-change": !!props.isNew && marked().has(s.id) }}>
              <span class="pl-n">{i() + 1}</span>
              <span>
                {s.name}
                <Show when={props.isNew && marked().has(s.id)}>
                  <span class="pl-prop-tilde" aria-label="changed">
                    ~
                  </span>
                  <For each={subOf(s.id)}>
                    {(c) => (
                      <span class="pl-sub">
                        {c.tag === "add" ? "+" : c.tag === "remove" ? "−" : "~"} {c.name}
                      </span>
                    )}
                  </For>
                </Show>
              </span>
            </li>
          )}
        </For>
      </ol>
    </div>
  );
}

/**
 * The Proposal view: the Setup chat's proposed setup beside the one in force, read live from the chat's working copy
 * (it moves while the chat writes), every difference listed, and Confirm, which lands the setup branch the way the
 * Setup chat's own proposal card does.
 */
export function ProposalView(props: { projectId: string; scope: PipelineScope; map: SetupMapAnswer | undefined; setup: SetupPoll; state: ProposalState; onChanged(): void }) {
  const m = () => props.map;
  const v = () => m()?.version?.n ?? 0;
  const changes = () => (m()?.changes ?? []).filter((c) => (props.scope === "releases" ? c.stage === "release" : c.stage !== "release"));
  const stagesOf = (x: SetupMap) => (props.scope === "releases" ? releaseStages(x) : queueStages(x));
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const chat = () => props.setup.data()?.chat;
  const confirm = async () => {
    const p = chat()?.proposal;
    if (!p?.hash) return;
    setBusy(true);
    try {
      const r = await mergeSetupProposal(props.projectId, p.hash, p.commit);
      noteMergeChanged();
      props.setup.set(r.setup);
      props.onChanged();
      setConfirming(false);
      const msg = r.queued ? `Setup v${v() + 1} joined the merge queue; it lands like any branch.` : `Setup v${v() + 1} is in force.`;
      toast(msg);
      announce(msg);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show
      when={m()?.proposal}
      fallback={
        <div class="empty">
          <p class="empty-title">Setup v{v() || 1} is in force</p>
          <p class="empty-body">
            {m()?.chat ? "The Setup chat proposes no change right now. When it edits the setup, the proposal shows here as it writes." : "No Setup chat is open. Open one from the Merge Queue tab to change the setup; its proposal shows here as it writes."}
          </p>
        </div>
      }
    >
      {(p) => (
        <>
          <header class="pl-detail-head">
            <div class="cluster">
              <ToneChip tone={props.state.state === "ready" ? "accent" : "neutral"}>{props.state.state === "ready" ? "Ready" : "Drafting"}</ToneChip>
              <span class="pl-kicker">From the Setup chat · {props.scope === "releases" ? "release pipeline" : "merge queue"}</span>
            </div>
            <h3 class="pl-title">Setup v{v() + 1}</h3>
            <p class="pl-detail-lead">
              {props.state.state === "drafting" ? `The Setup chat has written ${changesWord(changes().length)} so far. You can read what’s there; Confirm waits for the rest.` : `${changesWord(changes().length)} to the ${props.scope === "releases" ? "release pipeline" : "merge queue"}. Every difference is marked below; nothing changes until you confirm.`}
            </p>
            <Show when={p().problem}>
              <p class="pl-factbox is-error">
                <b>The proposed setup doesn’t parse.</b> {p().problem}
              </p>
            </Show>
            <Show when={m()!.behind === "overlaps"}>
              <p class="pl-factbox is-warn">
                <b>The Setup chat’s edits overlap newer setup changes on {m()!.main.target ?? "the target"}.</b> This shows the chat’s copy as it is, so it may seem to undo them. The merge thread judges the overlap when its branch lands.
              </p>
            </Show>
          </header>
          <section>
            <h3 class="pl-section-title" style={{ "font-size": "var(--fs-heading-s)" }}>
              The pipeline, side by side
            </h3>
            <div class="pl-prop-diagram" style={{ "margin-top": "var(--space-3)" }}>
              <Column head={`Current · v${v() || 1} · in force`} stages={stagesOf(m()!.main)} changes={[]} />
              <Column head={`Proposed · v${v() + 1}${p().dirty ? " · being written" : ""}`} stages={stagesOf(p())} changes={changes()} isNew />
            </div>
          </section>
          <section>
            <h3 class="pl-section-title" style={{ "font-size": "var(--fs-heading-s)" }}>
              What changes
            </h3>
            <Show when={changes().length} fallback={<p class="pl-hint">Nothing in this part changes{props.scope === "releases" ? " (the proposal changes the merge queue only)" : " (the proposal changes releases only)"}.</p>}>
              <ul class="pl-changes" style={{ "margin-top": "var(--space-3)" }}>
                <For each={changes()}>
                  {(c) => (
                    <li class="pl-change">
                      <div class="pl-change-top">
                        <span class={`pl-change-tag is-${c.tag}`}>{CHANGE_WORD[c.tag]}</span>
                        <p class="pl-change-name">{c.name}</p>
                      </div>
                      <p class="pl-change-why">{c.detail}</p>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
          <p class="pl-confirm-note">
            <b>Branches already in the queue finish under v{v() || 1}.</b> New runs use v{v() + 1} once it lands. Nothing is merged differently while you decide.
          </p>
          <div class="pl-card pl-actions-card">
            <div class="pl-card-body">
              <p class="pl-hint" style={{ margin: "0" }}>
                {props.state.state === "drafting" ? `${props.state.why} Confirm waits; nothing changes yet.` : confirming() ? `Confirm Setup v${v() + 1}? Its branch lands through the merge queue like any branch. The setup in force stays until it does.` : "Read the changes, then confirm. The Setup chat can still change it before you do."}
              </p>
            </div>
            <div class="pl-card-foot">
              <Show when={chat()?.path}>
                <a class="button" href={projectSessionHref(props.projectId, chat()!.path!)}>
                  Back to Setup Chat
                </a>
              </Show>
              <span class="pl-spacer" />
              <Show
                when={confirming()}
                fallback={
                  <button type="button" class="button button-primary" disabled={props.state.state !== "ready"} aria-disabled={props.state.state !== "ready" ? "true" : undefined} title={props.state.why} onClick={() => setConfirming(true)}>
                    Confirm Setup v{v() + 1}
                  </button>
                }
              >
                <button type="button" class="button" onClick={() => setConfirming(false)}>
                  Cancel
                </button>
                <button type="button" class="button button-primary" disabled={busy() || props.state.state !== "ready"} onClick={() => void confirm()}>
                  Land Setup v{v() + 1}
                </button>
              </Show>
            </div>
          </div>
        </>
      )}
    </Show>
  );
}

/** Setup history: each version of the setup on the main branch, when it came into force, and what it changed. */
export function SetupHistoryView(props: { projectId: string; scope: PipelineScope }) {
  const [hist] = createResource(() => props.projectId, (id) => getSetupHistory(id, 30));
  const versions = () => (hist()?.versions ?? []).filter((x, i, all) => props.scope === "queue" || x.changes.some((c) => c.stage === "release") || i === all.length - 1);
  return (
    <>
      <div>
        <h2 class="pl-section-title">{props.scope === "releases" ? "Release setup history" : "Setup history"}</h2>
        <p class="pl-section-sub">Each version, when it came into force on the main branch, and what it changed. New versions arrive from the Setup chat.</p>
      </div>
      <Show when={!hist.loading} fallback={<p class="pl-hint">Reading the setup’s history.</p>}>
        <Show when={versions().length} fallback={<p class="pl-hint">{hist.error ? `Couldn’t read the history. ${String(hist.error)}` : "No version of the setup is on the main branch yet."}</p>}>
          <ol class="pl-versions">
            <For each={versions()}>
              {(ver, i) => (
                <li class="pl-version" classList={{ "is-current": i() === 0 }}>
                  <div class="pl-version-head">
                    <span class="pl-version-tag">v{ver.n}</span>
                    <Show when={i() === 0}>
                      <ToneChip tone="success">In force</ToneChip>
                    </Show>
                    <span class="pl-mono pl-muted">{ver.commit.slice(0, 7)}</span>
                    <span class="pl-version-when" title={ver.at}>
                      {relativeTime(ver.at)}
                    </span>
                  </div>
                  <p class="pl-version-summary">{ver.subject}</p>
                  <Show when={ver.changes.length} fallback={<p class="pl-version-summary pl-muted">{ver.n === 1 ? "The first setup." : "No difference the screen draws."}</p>}>
                    <ul class="pl-version-list">
                      <For each={ver.changes.filter((c) => props.scope === "queue" ? c.stage !== "release" : c.stage === "release")}>
                        {(c) => (
                          <li>
                            {CHANGE_WORD[c.tag]} {c.name}: {c.detail}
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </li>
              )}
            </For>
          </ol>
          <Show when={hist()?.more}>
            <p class="pl-hint">Older versions are on the main branch’s history of .sova/project.json.</p>
          </Show>
        </Show>
      </Show>
    </>
  );
}
